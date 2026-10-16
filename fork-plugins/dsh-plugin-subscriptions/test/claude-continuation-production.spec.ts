/**
 * The first real-entry continuation case: two shipped headless wakes over one private home.
 *
 * Wake one is `dsh --profile headless --json <task>` under a narrow overlay that mounts the real
 * subscription plugin through the continuation probe and points the agent loop at the `claude`
 * route. The app's own runner creates the Agent, so the request the Host sends is produced by the
 * real loop and answered by the real route; the probe only states the Messages transport and the
 * account store. Wake two resumes that Session with `--json --session-id <id> <task>` in the same
 * private cwd and home, so the same wire identity must be restored and the first wake's response
 * `request-id` must be the second request's `cc_prev_req`.
 *
 * Nothing here manufactures a login, appends a message or writes the session: the account is
 * stored once (wake one), the success metadata is written by the Host's own terminal path, and
 * every claim below is read back either from the answered POSTs the probe reported or from the
 * persisted JSONL after both children exited.
 *
 * The overlay is written into the private cwd this case owns, so no shared profile or snapshot
 * file changes. Both children run with a private home, a private Claude Code config directory and
 * a private user home, with telemetry disabled and no published proxy environment.
 *
 * The launcher plane decides where the product modules these wakes exercise come from: the unbuilt
 * `src` checkout by default, or the installed artifact root `DSH_SUBSCRIPTIONS_ARTIFACT_ROOT` names
 * under `DSH_EXAMPLE_MODE=lib`. The probe reports the plane and the entry URL it loaded in every
 * wake marker, and each case checks that report against the plane this run launched; the cases
 * themselves are the same work on either plane.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveExampleMode, runLoaderSmoke, type ExampleMode } from '@deepseek-ai/dsh-loader-smoke'

/** The package's own manifest locates this copy and its fixtures, whatever the layout. */
const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.resolve('dsh-plugin-subscriptions/package.json')))
const COPY_ROOT = dirname(dirname(PLUGIN_ROOT))
const CONTINUATION_PROBE = join(PLUGIN_ROOT, 'test', 'fixtures', 'claude-continuation-probe.mjs')

/** The fixture that guards the safe-exit wake's process-global fetch and reports what it saw. */
const SAFE_DISABLE_PROBE = join(PLUGIN_ROOT, 'test', 'fixtures', 'claude-safe-disable-probe.mjs')

/** The row a private overlay disables by id, and the line that row's replacement guard writes. */
const CONTINUATION_PROBE_ID = 'claude-continuation-probe'
const SAFE_DISABLE_MARKER = 'CLAUDE_SAFE_DISABLE'

/** The task the safe-exit wake drives at a route the disabled composition no longer serves. */
const SAFE_EXIT_TASK = 'Continue after the subscription plugin was disabled.'

/**
 * The plugin's private continuation documents the first wake publishes below the same home: the
 * salt, the spans the wire identity is read from, and the identity generation record.
 */
const IDENTITY_FILES: readonly string[] = ['salt.json', 'spans.json', 'identity-generation.json']

/** The documented launch: the shipped CLI source entry over the headless profile. */
const BIN_SCRIPT = join(COPY_ROOT, 'apps', 'cli', 'src', 'bin.ts')
const TSCONFIG = join(COPY_ROOT, 'tsconfig.json')

/**
 * The plane this run launches in, stated by the launcher's own environment. The bin stays the
 * documented source entry: `lib` mode derives `apps/cli/lib/bin.js` from it inside the launcher.
 */
const MODE: ExampleMode = resolveExampleMode()

/** The installed candidate this run loads product modules from; absent selects the source plane. */
const ARTIFACT_ROOT = MODE === 'lib' ? requireArtifactRoot() : undefined

/**
 * The product entry the artifact plane must load: the installed root's own built `lib/index.js`.
 * The source plane's entry is an absolute path in this checkout, which is diagnostics rather than
 * a fact under test, so only the plane itself is asserted there.
 */
const ARTIFACT_ENTRY_URL = ARTIFACT_ROOT === undefined
  ? undefined
  : pathToFileURL(join(realpathSync(ARTIFACT_ROOT), 'lib', 'index.js')).href

/**
 * The absolute installed root this run was pointed at.
 * @returns the root the artifact child must load its product modules from.
 */
function requireArtifactRoot(): string {
  const root = process.env.DSH_SUBSCRIPTIONS_ARTIFACT_ROOT
  if (root === undefined || !isAbsolute(root)) {
    throw new Error(`DSH_EXAMPLE_MODE=lib needs DSH_SUBSCRIPTIONS_ARTIFACT_ROOT as an absolute path, got ${String(root)}`)
  }
  return root
}

/**
 * The Node flags every wake's child runs with.
 *
 * The value this file controls may inherit the parent's own `NODE_OPTIONS`, but never a
 * script-loading hook: the source plane's tsx launch is the launcher's `--import`, so an inherited
 * `--import`, `--loader` or tsx entry would put the child on a plane this file did not state. The
 * artifact plane additionally states that it strips no types, which is what makes its own
 * `process.features.typescript` check meaningful.
 * @returns the child's `NODE_OPTIONS` value.
 */
function nodeOptions(): string {
  const inherited = process.env.NODE_OPTIONS ?? ''
  if (/--import|--loader|--experimental-loader|tsx/.test(inherited)) {
    throw new Error(`the inherited NODE_OPTIONS names a script-loading hook: ${inherited}`)
  }
  return [
    inherited,
    '--disable-warning=ExperimentalWarning',
    ARTIFACT_ROOT === undefined ? undefined : '--no-experimental-strip-types',
  ].filter(Boolean).join(' ')
}

/**
 * The child environment every wake of this case runs under, on either plane.
 *
 * `TSX_TSCONFIG_PATH` is cleared so the source plane gets exactly the launcher's own value, and the
 * artifact root is stated only in the artifact plane, so one process never carries both.
 * @param cwd - the private root this case owns.
 * @returns the environment overrides the launcher layers over the parent's.
 */
function wakeEnv(cwd: string): Readonly<NodeJS.ProcessEnv> {
  return {
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: nodeOptions(),
    NODE_USE_ENV_PROXY: undefined,
    TSX_TSCONFIG_PATH: undefined,
    DSH_SUBSCRIPTIONS_ARTIFACT_ROOT: ARTIFACT_ROOT,
    HOME: join(cwd, 'user-home'),
    USERPROFILE: join(cwd, 'user-home'),
    CLAUDE_CONFIG_DIR: join(cwd, 'claude-config'),
  }
}

/** The two static catalogue models these cases state: A answers first, B is the switch. */
const MODEL_A = 'claude-opus-4-5'
const MODEL_B = 'claude-sonnet-4-5'

/** The turns this file drives. */
const FIRST_TASK = 'Record the first continuation wake.'
const SECOND_TASK = 'Continue from the first continuation wake.'
const SWITCH_TASK = 'Continue after the model switch.'
const RECOVER_TASK = 'Continue after the refused attempt.'

/** The marker line the probe writes once per answered POST. */
const MARKER = 'CLAUDE_CONTINUATION_WAKE'

/** One answered POST, as the probe reported it. */
interface WakeMarker {
  readonly pid?: number
  readonly post?: number
  /** The product-module plane the probe's process loaded, and the entry it loaded it from. */
  readonly mode?: 'src' | 'artifact'
  readonly entryUrl?: string
  readonly sessionId?: string
  readonly wireSessionId?: string
  readonly spanEpoch?: number
  readonly accountRef?: { readonly kind?: string; readonly version?: number; readonly ref?: string }
  readonly saltPresent?: boolean
  readonly generation?: number
  readonly atis?: string | null
  readonly promptId?: string
  readonly previousRequestId?: string | null
  readonly requestId?: string
  readonly model?: string
  readonly responseKind?: string
  readonly thinkingBlocks?: number
  readonly signedThinkingBlocks?: number
  readonly signedThinkingDigest?: string | null
}

/** One line of the runner's `--json` stream. */
interface RunEvent {
  readonly type?: string
  readonly sessionId?: string
  readonly text?: string
  readonly message?: string
  readonly phase?: string
  /** A `turn/end` status carries the turn's own end reason, whose kind is a closed set. */
  readonly reason?: {
    readonly kind?: string
    readonly error?: { readonly code?: string; readonly retryDisposition?: string }
  }
}

/** One recorded stream entry the Host persists beside an attempt. */
interface StreamRecord {
  readonly type?: string
  readonly time?: number
  readonly chunk?: { readonly type?: string; readonly reason?: { readonly kind?: string } }
}

/** The continuation envelope one persisted assistant message carries. */
interface Continuation {
  readonly v?: number
  readonly spanEpoch?: number
  readonly harnessSessionId?: string
  readonly wireSessionId?: string
  readonly requestId?: string
  readonly accountRef?: { readonly kind?: string; readonly version?: number; readonly ref?: string }
}

/** One persisted JSONL record; only the members this case reads are stated. */
interface LogRecord {
  readonly type?: string
  readonly id?: string
  readonly data?: {
    /** The recorded chunks one failed attempt delivered, which is where its finish reason lives. */
    readonly stream?: readonly StreamRecord[]
    readonly message?: {
      readonly content?: readonly { readonly type?: string; readonly text?: string }[]
      readonly source?: {
        readonly replayState?: {
          readonly response?: {
            readonly kind?: string
            readonly version?: number
            readonly requestId?: string
            readonly continuation?: Continuation
          }
        }
      }
    }
  }
}

/**
 * The narrow overlay one wake runs under, written into the private cwd.
 * @param cwd - the private root this case owns.
 * @param model - the model the agent default states for this wake.
 * @param catalogue - the static Claude catalogue this overlay declares.
 * @returns the patch rows, as JSON the Loader reads as YAML.
 */
function overlayRows(cwd: string, model: string = MODEL_A, catalogue: readonly string[] = [MODEL_A]): unknown[] {
  return [
    { id: 'agent-default-model', config: { provider: 'claude', model } },
    { id: 'llm-deepseek', disabled: true },
    { id: 'plugin-package-inventory-deepseek', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'session-log-deepseek', config: { enabled: false } },
    {
      id: 'session-persistence-jsonl',
      name: '@deepseek-ai/dsh-session-persistence-jsonl',
      config: { root: join(cwd, '.dsh', 'sessions'), compression: 'none' },
    },
    {
      insert: [{
        id: 'claude-continuation-probe',
        name: pathToFileURL(CONTINUATION_PROBE).href,
        inject: ['llm', 'sessionPersistence'],
        config: { providers: ['claude'], models: { claude: catalogue.map(id => ({ id })) }, pool: { enabled: false } },
      }],
    },
  ]
}

/** The runner's events, parsed from the lines that carry no marker. */
function eventsIn(stdout: string): RunEvent[] {
  return stdout
    .split('\n')
    .filter(line => line.length > 0 && !line.startsWith(MARKER))
    .map((line): RunEvent => JSON.parse(line))
}

/** The probe's markers, parsed from their own lines. */
function markersIn(stdout: string): WakeMarker[] {
  return stdout
    .split('\n')
    .filter(line => line.startsWith(`${MARKER} `))
    .map((line): WakeMarker => JSON.parse(line.slice(MARKER.length + 1)))
}

/** One persisted log's rows, in file order. */
function recordsIn(text: string): LogRecord[] {
  return text
    .split('\n')
    .filter(line => line.length > 0)
    .map((line): LogRecord => JSON.parse(line))
}

/**
 * Check one wake's report of the product-module plane it loaded against this run's plane.
 * @param marker - the wake marker the probe wrote.
 */
function assertProductPlane(marker: WakeMarker | undefined): void {
  assert.ok(marker !== undefined)
  if (ARTIFACT_ENTRY_URL === undefined) {
    assert.equal(marker.mode, 'src', 'the wake loaded the unbuilt source product modules')
    return
  }
  assert.equal(marker.mode, 'artifact', 'the wake loaded the installed artifact product modules')
  assert.equal(marker.entryUrl, ARTIFACT_ENTRY_URL,
    'the artifact plane loaded its product entry from the installed root\'s own lib/index.js')
}

test('two real headless wakes keep one durable continuation chain', { timeout: 75_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-continuation-'))
  try {
    const overlay = join(cwd, 'claude-continuation.patch.yml')
    const expectation = join(cwd, '.claude-continuation-expect.json')
    const env = wakeEnv(cwd)
    await writeFile(overlay, JSON.stringify(overlayRows(cwd), null, 2), 'utf8')

    // Wake one: the app's own runner drives the first turn through the real route.
    await writeFile(expectation, JSON.stringify({ seed: true, expectedPreviousRequestId: null }), 'utf8')
    const first = await runLoaderSmoke({
      label: 'claude continuation first wake',
      cwd,
      mode: MODE,
      binScript: BIN_SCRIPT,
      configPath: overlay,
      binArgs: ['--profile', 'headless', '--patch', overlay, '--json', FIRST_TASK],
      tsconfigPath: TSCONFIG,
      env,
    })
    assert.equal(first.stderr, '', 'the first wake writes no diagnostic')
    const firstEvents = eventsIn(first.stdout)
    const firstMarkers = markersIn(first.stdout)
    const sessionId = firstEvents[0]?.sessionId
    assert.equal(firstEvents[0]?.type, 'session', 'the run reports its Session first')
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('the first wake reported no Session identity')
    }
    assert.equal(firstMarkers.length, 1, 'the first turn sent exactly one Messages request')
    assert.match(firstEvents.at(-1)?.text ?? '', /continuation observed/, 'the run reports the turn the route answered')
    const firstMarker = firstMarkers[0]
    assert.ok(firstMarker !== undefined)
    assertProductPlane(firstMarker)
    assert.equal(firstMarker.previousRequestId, null, 'the first turn chains no previous request')
    assert.equal(firstMarker.atis, null, 'this account states no ATIS fact, so no ATIS header rides the request')
    assert.equal(firstMarker.saltPresent, true, 'the request was served over a stored salt')
    assert.match(firstMarker.wireSessionId ?? '', /^[0-9a-f-]{36}$/, 'the request carried a wire session identity')
    assert.ok(Number.isSafeInteger(firstMarker.generation), 'the request was served under a durable generation')
    assert.equal(firstMarker.generation, firstMarker.spanEpoch,
      'the generation record and the stored span state the same generation')

    // Wake two: the shipped runner resumes that Session in the same private world.
    await writeFile(
      expectation,
      JSON.stringify({ seed: false, expectedPreviousRequestId: firstMarker.requestId }),
      'utf8',
    )
    const second = await runLoaderSmoke({
      label: 'claude continuation second wake',
      cwd,
      mode: MODE,
      binScript: BIN_SCRIPT,
      configPath: overlay,
      binArgs: ['--profile', 'headless', '--patch', overlay, '--json', '--session-id', sessionId, SECOND_TASK],
      tsconfigPath: TSCONFIG,
      env,
    })
    assert.equal(second.stderr, '', 'the resume wake writes no diagnostic')
    const secondMarkers = markersIn(second.stdout)
    const secondMarker = secondMarkers[0]
    assert.equal(secondMarkers.length, 1, 'the resumed turn sent exactly one Messages request')
    assert.ok(secondMarker !== undefined)
    assertProductPlane(secondMarker)
    assert.equal(secondMarker.sessionId, sessionId, 'the resume wake served the same harness Session')
    assert.equal(secondMarker.previousRequestId, firstMarker.requestId,
      'the second request chains the first response request id')
    assert.equal(secondMarker.wireSessionId, firstMarker.wireSessionId,
      'the resumed request carries the identity the first wake persisted')
    assert.equal(secondMarker.spanEpoch, firstMarker.spanEpoch, 'the resume keeps the stored span epoch')
    assert.equal(secondMarker.atis, null, 'and still rides no ATIS header')
    assert.notEqual(secondMarker.promptId, firstMarker.promptId, 'a new turn derives its own prompt id')
    assert.notEqual(secondMarker.requestId, firstMarker.requestId,
      'the two wakes answered under distinct response request ids')
    assert.ok(Number.isSafeInteger(secondMarker.generation), 'the resume was served under a durable generation')
    assert.equal(secondMarker.generation, secondMarker.spanEpoch,
      'the generation record and the stored span state the same generation')
    assert.equal(secondMarker.generation, firstMarker.generation,
      'two wakes without a lifecycle action publish no new identity generation')

    // The Host's own terminal writes, read after both children exited.
    const sessionsRoot = join(cwd, '.dsh', 'sessions')
    const logs = (await readdir(sessionsRoot, { recursive: true })).filter(name => name.endsWith('.jsonl'))
    assert.equal(logs.length, 1, 'the two wakes wrote one Session log')
    const records = recordsIn(await readFile(join(sessionsRoot, logs[0] as string), 'utf8'))
    assert.ok(records.some(record => record.type === 'llm/request-record'), 'the log holds the prepared records')
    const assistants = records.filter(record => record.type === 'assistant/message')
    assert.equal(assistants.length, 2, 'both turns completed with an assistant message the Host wrote')
    const responses = assistants.map(record => record.data?.message?.source?.replayState?.response)
    const continuations = responses.map(response => response?.continuation)
    assert.ok(continuations.every(continuation => continuation !== undefined),
      'each terminal message carries the continuation metadata')
    assert.ok(responses.every(response =>
      response !== undefined && response.kind === 'claude' && response.version === 1),
    'each envelope states the v1 Claude continuation')
    assert.equal(responses[0]?.requestId, firstMarker.requestId, 'the first envelope records the answered request id')
    assert.equal(continuations[0]?.requestId, firstMarker.requestId,
      'the first continuation names the request id its own send was answered under')
    assert.equal(continuations[1]?.requestId, secondMarker.requestId,
      'the resumed continuation names the request id its own send was answered under')
    assert.equal(continuations[0]?.v, 1)
    assert.equal(continuations[1]?.v, 1)
    assert.equal(continuations[0]?.harnessSessionId, sessionId)
    assert.equal(continuations[1]?.harnessSessionId, sessionId)
    assert.equal(continuations[0]?.wireSessionId, firstMarker.wireSessionId)
    assert.equal(continuations[1]?.wireSessionId, firstMarker.wireSessionId,
      'both turns persisted the same wire session identity')
    assert.equal(continuations[0]?.spanEpoch, firstMarker.spanEpoch)
    assert.equal(continuations[1]?.spanEpoch, secondMarker.spanEpoch)
    assert.equal(continuations[0]?.accountRef?.kind, 'salt-sha256')
    assert.equal(continuations[0]?.accountRef?.version, 1)
    assert.match(continuations[0]?.accountRef?.ref ?? '', /^[0-9a-f]{64}$/,
      'the terminal metadata names the account by a salted reference')
    assert.equal(continuations[1]?.accountRef?.ref, continuations[0]?.accountRef?.ref,
      'both turns name the same account reference')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

/** The one persisted Session log of a private root, in file order. */
async function persistedRecords(cwd: string): Promise<LogRecord[]> {
  const sessionsRoot = join(cwd, '.dsh', 'sessions')
  const logs = (await readdir(sessionsRoot, { recursive: true })).filter(name => name.endsWith('.jsonl'))
  assert.equal(logs.length, 1, 'the wakes wrote one Session log')
  return recordsIn(await readFile(join(sessionsRoot, logs[0] as string), 'utf8'))
}

test('a model switch keeps the successful chain and drops the first model\'s signed thinking', { timeout: 105_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-continuation-switch-'))
  try {
    const overlay = join(cwd, 'claude-continuation.patch.yml')
    const expectation = join(cwd, '.claude-continuation-expect.json')
    const env = wakeEnv(cwd)
    const catalogue = [MODEL_A, MODEL_B]

    // Wake one: model A answers a full turn whose thinking carries a signature.
    await writeFile(overlay, JSON.stringify(overlayRows(cwd, MODEL_A, catalogue), null, 2), 'utf8')
    await writeFile(expectation, JSON.stringify({
      seed: true,
      responseKind: 'thinking-success',
      responseRequestId: 'req_synth_success_1',
      expectedPreviousRequestId: null,
    }), 'utf8')
    const first = await runLoaderSmoke({
      label: 'claude continuation switch first wake',
      cwd,
      mode: MODE,
      binScript: BIN_SCRIPT,
      configPath: overlay,
      binArgs: ['--profile', 'headless', '--patch', overlay, '--json', FIRST_TASK],
      tsconfigPath: TSCONFIG,
      env,
    })
    assert.equal(first.stderr, '', 'the first wake writes no diagnostic')
    const firstEvents = eventsIn(first.stdout)
    const sessionId = firstEvents[0]?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('the first wake reported no Session identity')
    }
    const firstMarkers = markersIn(first.stdout)
    assert.equal(firstMarkers.length, 1, 'the first turn sent exactly one Messages request')
    const firstMarker = firstMarkers[0]
    assert.ok(firstMarker !== undefined)
    assertProductPlane(firstMarker)
    assert.equal(firstMarker.model, MODEL_A, 'the first wake asked model A')
    assert.equal(firstMarker.responseKind, 'thinking-success', 'the first wake was answered a signed thinking turn')
    assert.equal(firstMarker.requestId, 'req_synth_success_1')
    assert.equal(firstMarker.previousRequestId, null, 'the first turn chains no previous request')

    // Wake two: the resumed agent states model B, so A's signed thinking must not ride the request.
    await writeFile(overlay, JSON.stringify(overlayRows(cwd, MODEL_B, catalogue), null, 2), 'utf8')
    await writeFile(expectation, JSON.stringify({
      seed: false,
      responseKind: 'partial-error',
      responseRequestId: 'req_synth_failed_2',
      expectedPreviousRequestId: 'req_synth_success_1',
    }), 'utf8')
    const second = await runLoaderSmoke({
      label: 'claude continuation switch refused wake',
      cwd,
      mode: MODE,
      binScript: BIN_SCRIPT,
      configPath: overlay,
      binArgs: ['--profile', 'headless', '--patch', overlay, '--json', '--session-id', sessionId, SWITCH_TASK],
      tsconfigPath: TSCONFIG,
      expectedExitCode: 1,
      env,
    })
    const secondMarkers = markersIn(second.stdout)
    assert.equal(secondMarkers.length, 1, 'the switched turn sent exactly one Messages request')
    const secondMarker = secondMarkers[0]
    assert.ok(secondMarker !== undefined)
    assertProductPlane(secondMarker)
    assert.equal(secondMarker.model, MODEL_B, 'the switched request asked model B')
    assert.equal(secondMarker.previousRequestId, 'req_synth_success_1',
      'the switched request still chains the successful request id')
    assert.equal(secondMarker.signedThinkingBlocks, 0, 'another model\'s signed thinking is not replayed')
    assert.equal(secondMarker.thinkingBlocks, 0, 'and no thinking block of that turn rides this request')
    assert.equal(secondMarker.requestId, 'req_synth_failed_2')
    assert.equal(secondMarker.responseKind, 'partial-error')
    assert.match(second.stderr, /busy/, 'the recorded failure reaches the run diagnostics')
    assert.doesNotMatch(second.stderr, /claude-continuation-probe:/,
      'no refusal of this composition was reached')
    assert.ok(eventsIn(second.stdout).some(event =>
      event.type === 'status'
      && event.phase === 'turn_end'
      && event.reason !== undefined
      && event.reason.kind === 'error'
      && event.reason.error?.retryDisposition === 'forbid'),
    'the JSON stream ends the turn as an error whose automatic resend is forbidden')

    // Before the third request the log already holds the failed attempt, and no message for it.
    const afterFailure = await persistedRecords(cwd)
    const messagesAfterFailure = afterFailure.filter(record => record.type === 'assistant/message')
    assert.equal(messagesAfterFailure.length, 1, 'the refused turn appended no assistant message')
    assert.ok(afterFailure.filter(record => record.type === 'assistant/attempt').length >= 1,
      'the refused turn left a real attempt')
    assert.ok(messagesAfterFailure.every(record =>
      record.data?.message?.source?.replayState?.response?.continuation?.requestId !== 'req_synth_failed_2'),
    'the refused request id is no selectable continuation')

    // Wake three: the same model B continues, and the chain still names the first success.
    await writeFile(expectation, JSON.stringify({
      seed: false,
      responseKind: 'success',
      responseRequestId: 'req_synth_success_3',
      expectedPreviousRequestId: 'req_synth_success_1',
    }), 'utf8')
    const third = await runLoaderSmoke({
      label: 'claude continuation switch recovering wake',
      cwd,
      mode: MODE,
      binScript: BIN_SCRIPT,
      configPath: overlay,
      binArgs: ['--profile', 'headless', '--patch', overlay, '--json', '--session-id', sessionId, RECOVER_TASK],
      tsconfigPath: TSCONFIG,
      env,
    })
    assert.equal(third.stderr, '', 'the recovering wake writes no diagnostic')
    const thirdMarkers = markersIn(third.stdout)
    assert.equal(thirdMarkers.length, 1, 'the recovering turn sent exactly one Messages request')
    const thirdMarker = thirdMarkers[0]
    assert.ok(thirdMarker !== undefined)
    assertProductPlane(thirdMarker)
    assert.equal(thirdMarker.previousRequestId, 'req_synth_success_1',
      'the recovering request still chains the successful request id')
    assert.notEqual(thirdMarker.previousRequestId, 'req_synth_failed_2',
      'and never the refused attempt\'s response id')
    assert.equal(thirdMarker.requestId, 'req_synth_success_3')

    // Every wake rode one durable identity, and no lifecycle action moved its generation.
    for (const marker of [secondMarker, thirdMarker]) {
      assert.ok(marker !== undefined)
      assert.equal(marker.sessionId, sessionId, 'every wake served the same harness Session')
      assert.equal(marker.wireSessionId, firstMarker.wireSessionId,
        'the wire identity is the one the first wake committed')
      assert.equal(marker.spanEpoch, firstMarker.spanEpoch, 'the span epoch held across initial and resume')
      assert.equal(marker.accountRef?.ref, firstMarker.accountRef?.ref, 'and so did the account reference')
      assert.equal(marker.generation, firstMarker.generation, 'no lifecycle action advanced the identity generation')
    }

    // The Host's own terminal writes for the two completed turns.
    const records = await persistedRecords(cwd)
    const assistants = records.filter(record => record.type === 'assistant/message')
    assert.equal(assistants.length, 2, 'two turns completed with a Host-written assistant message')
    const attempts = records.filter(record => record.type === 'assistant/attempt')
    assert.ok(attempts.length >= 1, 'the refused turn stayed an attempt')
    assert.ok(attempts.some(record => (record.data?.stream ?? []).some(entry =>
      entry.type === 'chunk' && entry.chunk?.type === 'finish' && entry.chunk.reason?.kind === 'error')),
    'the attempt records the failed finish it reached')
    const continuations = assistants.map(record => record.data?.message?.source?.replayState?.response?.continuation)
    assert.deepEqual(continuations.map(continuation => continuation?.requestId).sort(),
      ['req_synth_success_1', 'req_synth_success_3'],
      'only the two successful turns are selectable continuations')
    assert.equal(continuations[0]?.wireSessionId, continuations[1]?.wireSessionId)
    assert.equal(continuations[0]?.accountRef?.ref, continuations[1]?.accountRef?.ref)
    assert.equal(continuations[0]?.spanEpoch, continuations[1]?.spanEpoch)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

/** The one line the no-egress guard fixture writes at the end of its wake's turn. */
interface SafeDisableReport {
  readonly pid?: number
  /** How many times the composition reached the process-global fetch that fixture guards. */
  readonly fetchCalls?: number
  /** Whether any adapter registered the route the resumed run asked for. */
  readonly claudeRoutePresent?: boolean
  /** Whether the composition still provides the persistence reader the restored records are read through. */
  readonly recordReaderAvailable?: boolean
}

/** One stored Claude session, in the members this case rewrites. */
interface StoredClaudeSession {
  accessToken: string
  refreshToken: string
  /** The ownership mode `src/auth/claude-credential-ownership.ts` defines; another value fails the store read. */
  credentialOwnershipMode?: 'legacy-writeback' | 'read-only-import' | 'independent-oauth'
}

/** The private credential store, in the members this case rewrites; every other member is preserved. */
interface AuthStoreDocument {
  claude?: { accounts: Record<string, StoredClaudeSession> }
}

/** The synthetic access token this case states for the credential it rotated between the two wakes. */
const ROTATED_ACCESS_TOKEN = 'synthetic-rotated-access'
/** The synthetic refresh token of that same rotation. */
const ROTATED_REFRESH_TOKEN = 'synthetic-rotated-refresh'

/**
 * The overlay the safe-exit wake runs under: the same headless world, with the Loader disabling the
 * subscription plugin row and the no-egress guard mounted in its place.
 *
 * The disable patch is a later entry of the same patch list, and the patch algorithm indexes an
 * earlier `insert` as it adds it, so the row keeps its identity and is never started; no branch
 * inside the disabled probe decides this.
 * @param cwd - the private root this case owns.
 * @returns the patch rows, as JSON the Loader reads as YAML.
 */
function safeExitRows(cwd: string): unknown[] {
  return [
    ...overlayRows(cwd),
    { id: CONTINUATION_PROBE_ID, disabled: true },
    {
      insert: [{
        id: 'claude-safe-disable-probe',
        name: pathToFileURL(SAFE_DISABLE_PROBE).href,
        inject: ['llm', 'sessionPersistence'],
      }],
    },
  ]
}

/**
 * The store document the safe-exit wake must find untouched, carrying a credential its owner
 * rotated between the two runs.
 *
 * This rewrite is TEST INPUT, not a product write: it stands in for a rotation performed by
 * whoever owns this credential while no composition was running, so the safe exit has a rotated
 * credential to preserve rather than the one this case's own first wake seeded. It states the
 * ownership mode the shipped store schema defines for a credential this plugin only reads
 * (`src/auth/claude-credential-ownership.ts`), and it deliberately leaves `revisions` alone: no
 * credential transaction, and therefore no revision, is performed here.
 * @param text - the store document the first wake left.
 * @returns the same document with its one synthetic account's tokens replaced.
 */
function rotateSyntheticCredential(text: string): string {
  const store: AuthStoreDocument = JSON.parse(text)
  const accounts = Object.entries(store.claude?.accounts ?? {})
  if (accounts.length !== 1) {
    throw new Error(`the private store states ${accounts.length} Claude accounts; this case owns one`)
  }
  const account = accounts[0]
  if (account === undefined) throw new Error('the private store states no Claude account')
  const session = account[1]
  session.accessToken = ROTATED_ACCESS_TOKEN
  session.refreshToken = ROTATED_REFRESH_TOKEN
  session.credentialOwnershipMode = 'read-only-import'
  return JSON.stringify(store, null, 2)
}

/** The one guard line the safe-exit wake wrote. */
function safeDisableIn(stdout: string): SafeDisableReport {
  const lines = stdout.split('\n').filter(line => line.startsWith(`${SAFE_DISABLE_MARKER} `))
  assert.equal(lines.length, 1, 'the no-egress guard reported exactly once')
  const line = lines[0]
  assert.ok(line !== undefined)
  return JSON.parse(line.slice(SAFE_DISABLE_MARKER.length + 1))
}

/** The runner's own `--json` output, with the guard fixture's report removed. */
function runnerStdout(stdout: string): string {
  return stdout.split('\n').filter(line => !line.startsWith(SAFE_DISABLE_MARKER)).join('\n')
}

test('a disabled subscription row leaves the resumed Session, its store and its identity files untouched', { timeout: 75_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-safe-disable-'))
  try {
    const overlay = join(cwd, 'claude-safe-disable.patch.yml')
    const expectation = join(cwd, '.claude-continuation-expect.json')
    const env = wakeEnv(cwd)
    const sessionsRoot = join(cwd, '.dsh', 'sessions')
    const subscriptionRoot = join(cwd, '.dsh', 'plugins', 'subscriptions')

    // Wake one: the shipped runner drives one real turn through the subscription probe, so the
    // world the safe exit must preserve is the world that probe published.
    await writeFile(overlay, JSON.stringify(overlayRows(cwd), null, 2), 'utf8')
    await writeFile(expectation, JSON.stringify({ seed: true, expectedPreviousRequestId: null }), 'utf8')
    const first = await runLoaderSmoke({
      label: 'claude safe disable first wake',
      cwd,
      mode: MODE,
      binScript: BIN_SCRIPT,
      configPath: overlay,
      binArgs: ['--profile', 'headless', '--patch', overlay, '--json', FIRST_TASK],
      tsconfigPath: TSCONFIG,
      env,
    })
    assert.equal(first.stderr, '', 'the first wake writes no diagnostic')
    const firstEvents = eventsIn(first.stdout)
    const sessionId = firstEvents[0]?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('the first wake reported no Session identity')
    }
    const firstMarkers = markersIn(first.stdout)
    assert.equal(firstMarkers.length, 1, 'the first wake sent exactly one Messages request through the subscription route')
    const firstMarker = firstMarkers[0]
    assertProductPlane(firstMarker)
    assert.equal(firstMarker.previousRequestId, null, 'the first turn chains no previous request')

    // Everything wake one left, read before anything else touches it.
    const logs = (await readdir(sessionsRoot, { recursive: true })).filter(name => name.endsWith('.jsonl'))
    assert.equal(logs.length, 1, 'the first wake wrote one Session log')
    const logName = logs[0]
    assert.ok(logName !== undefined)
    const logPath = join(sessionsRoot, logName)
    const logBefore = await readFile(logPath, 'utf8')
    const storePath = join(subscriptionRoot, 'auth.json')
    const identityRoot = join(subscriptionRoot, 'claude-continuation')
    const storeBefore = await readFile(storePath, 'utf8')
    const identityBefore: Record<string, string> = {}
    for (const name of IDENTITY_FILES) identityBefore[name] = await readFile(join(identityRoot, name), 'utf8')

    // Test input, not a product write: the credential's owner rotated it while nothing ran.
    const rotatedStore = rotateSyntheticCredential(storeBefore)
    assert.notEqual(rotatedStore, storeBefore, 'the test input rotated the stored synthetic credential')
    await writeFile(storePath, rotatedStore, 'utf8')

    // Wake two: the same private world, with the Loader disabling the whole subscription row.
    await writeFile(overlay, JSON.stringify(safeExitRows(cwd), null, 2), 'utf8')
    const second = await runLoaderSmoke({
      label: 'claude safe disable resumed wake',
      cwd,
      mode: MODE,
      binScript: BIN_SCRIPT,
      configPath: overlay,
      binArgs: ['--profile', 'headless', '--patch', overlay, '--json', '--session-id', sessionId, SAFE_EXIT_TASK],
      tsconfigPath: TSCONFIG,
      expectedExitCode: 1,
      env,
    })

    // The disabled row answered nothing, and the resumed turn ended on the llm service's own
    // published failure for a provider with no adapter.
    assert.equal(markersIn(second.stdout).length, 0, 'the disabled row answered no Messages request')
    const observed = safeDisableIn(second.stdout)
    assert.ok(Number.isSafeInteger(observed.pid) && observed.pid !== process.pid,
      'the guard ran as its own OS process, not in this test process')
    assert.equal(observed.fetchCalls, 0, 'the whole resumed wake reached no process-global fetch')
    assert.equal(observed.claudeRoutePresent, false,
      'the disabled row registered no Claude route for the resumed run to reach')
    assert.equal(observed.recordReaderAvailable, true,
      'the composition still provides the reader the restored records are read through')
    const secondEvents = eventsIn(runnerStdout(second.stdout))
    assert.equal(secondEvents[0]?.sessionId, sessionId, 'the resumed run served the Session the first wake created')
    assert.ok(secondEvents.some(event =>
      event.type === 'status'
      && event.phase === 'turn_end'
      && event.reason !== undefined
      && event.reason.kind === 'error'
      && event.reason.error?.code === 'NO_ADAPTER'),
    'the resumed turn ends on the llm service\'s own failure code for an unregistered provider')
    assert.match(second.stderr, /NO_ADAPTER/, 'the shipped runner reports the failure code its turn reached')

    // The credential the safe exit preserved, rotation included, byte for byte.
    assert.equal(await readFile(storePath, 'utf8'), rotatedStore,
      'the disabled row wrote nothing to the credential store')
    for (const name of IDENTITY_FILES) {
      assert.equal(await readFile(join(identityRoot, name), 'utf8'), identityBefore[name],
        `the disabled row wrote nothing to ${name}`)
    }

    // The same log, still led by every row the first wake persisted.
    const logsAfter = (await readdir(sessionsRoot, { recursive: true })).filter(name => name.endsWith('.jsonl'))
    assert.deepEqual(logsAfter, logs, 'the resumed wake appended to the one log the first wake wrote')
    const logAfter = await readFile(logPath, 'utf8')
    assert.ok(logAfter.startsWith(logBefore),
      'the rows the first wake persisted are still the leading rows of that log')
    const recordsBefore = recordsIn(logBefore)
    const recordsAfter = recordsIn(logAfter)
    assert.ok(recordsAfter.length > recordsBefore.length, 'the resumed wake appended its own events')
    const messagesBefore = recordsBefore.filter(record => record.type === 'assistant/message')
    assert.equal(messagesBefore.length, 1, 'the first wake completed exactly one assistant message')
    assert.deepEqual(recordsAfter.filter(record => record.type === 'assistant/message'), messagesBefore,
      'the message that carries the continuation is unchanged, member for member')
    const requestRecords = recordsBefore.filter(record => record.type === 'llm/request-record')
    assert.ok(requestRecords.length >= 1, 'the first wake persisted the prepared request records')
    assert.deepEqual(recordsAfter.filter(record => record.type === 'llm/request-record'), requestRecords,
      'the restored prepared records are still exactly the records the first wake persisted')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
