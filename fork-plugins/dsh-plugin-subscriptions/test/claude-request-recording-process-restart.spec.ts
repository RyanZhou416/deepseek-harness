/**
 * Second-OS-process read-back of the prepared-request records (P1 real-chain evidence).
 *
 * The first process is the shipped `dsh --profile headless` composition the keyless snapshot
 * scenario already uses: the base composition patch, the scenario's replay patch, the model
 * patch, and the recorded session as the replay script. It persists two `llm/request-record`
 * events into the private `DSH_HOME` the launcher owns, and exits.
 *
 * The second process is a separate `dsh --profile headless` run over the SAME private cwd and
 * home, with a test-only patch that mounts one reader fixture and disables the app's startup and
 * runner rows. It mounts no probe, states no task, requests no model and runs no turn: the reader
 * opens the persisted session through the shipped JSONL persistence, derives each record's `seq`
 * the way that reader does, projects it with `reconstructRequestSystem`, compares it with the
 * record the first process persisted, prints one JSON line per record, and exits.
 *
 * The expected values are the first run's own persisted records, so this case adds no second
 * oracle and does not read the scenario fixture's normalized `{{system}}` tokens. Nothing here
 * guesses a session id, a sequence number or a caller text: the id comes from the persisted
 * header line and the sequence numbers from the reader's own persistence read.
 *
 * The launcher owns each child's 30-second deadline and closes its stdin; this case's timeout is
 * the outer budget for both runs. Both runs share one `mkdtemp` cwd, which this case removes
 * after both children settled.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/** The package's own manifest locates every path below, in a source or a compiled run alike. */
const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.resolve('dsh-plugin-subscriptions/package.json')))
const COPY_ROOT = dirname(dirname(PLUGIN_ROOT))
const SCENARIO_DIR = join(COPY_ROOT, 'snapshots', 'session', 'claude-request-recording')
const BASE_COMPOSITION_DIR = join(COPY_ROOT, 'snapshots', 'session', 'text-turn')
const READER_FIXTURE = join(PLUGIN_ROOT, 'test', 'fixtures', 'claude-request-recording-reader.mjs')
const SESSION_FILE = join(SCENARIO_DIR, 'session.v4.jsonl')

/** The documented launch: the shipped CLI source entry over the headless profile. */
const BIN_SCRIPT = join(COPY_ROOT, 'apps', 'cli', 'src', 'bin.ts')
const TSCONFIG = join(COPY_ROOT, 'tsconfig.json')

/** One persisted JSONL record; only the members this case reads are stated. */
interface LogRecord {
  readonly type?: string
  readonly id?: string
  readonly data?: {
    readonly systemBlocks?: readonly string[]
    readonly systemDigest?: string
    readonly header?: { readonly config?: { readonly provider?: string; readonly model?: string } }
    readonly inserted?: readonly {
      readonly source?: { readonly kind?: string }
      readonly content?: readonly { readonly type?: string; readonly text?: string }[]
    }[]
    readonly source?: { readonly kind?: string }
    readonly content?: readonly { readonly type?: string; readonly text?: string }[]
  }
}

/** One line of the reader's stdout: its run line, then one line per record. */
interface ReaderLine {
  readonly pid?: number
  readonly sessionId?: string
  readonly records?: number
  readonly preparedId?: number
  readonly systemBlocks?: readonly string[]
  readonly systemDigest?: string
}

/** One expected record: the text and digest the first process persisted. */
interface ExpectedRecord {
  readonly systemBlocks: readonly string[]
  readonly systemDigest: string
}

/** Parse one persisted log's rows, in file order. */
function recordsIn(text: string): LogRecord[] {
  return text
    .split('\n')
    .filter(line => line.length > 0)
    .map((line): LogRecord => JSON.parse(line))
}

/**
 * The task the recorded session carries, derived the way the snapshot lane derives it: the first
 * canonical user text spliced into the inbox, otherwise the first user message.
 * @param records - the recorded session's rows.
 * @returns the task text, or undefined when the fixture carries none.
 */
function taskFromSession(records: readonly LogRecord[]): string | undefined {
  const text = (value: LogRecord['data']): string | undefined => {
    if (value?.source?.kind !== 'user' || !Array.isArray(value.content)) return undefined
    const blocks = value.content
    return blocks.length === 1 && blocks[0]?.type === 'text' && typeof blocks[0].text === 'string'
      ? blocks[0].text
      : undefined
  }
  for (const record of records) {
    if (record.type !== 'agent/inbox/spliced') continue
    for (const message of record.data?.inserted ?? []) {
      const task = text(message)
      if (task !== undefined) return task
    }
  }
  for (const record of records) {
    if (record.type !== 'user/message') continue
    const task = text(record.data)
    if (task !== undefined) return task
  }
  return undefined
}

/**
 * The provider and model the recorded session's request header states.
 * @param records - the recorded session's rows.
 * @returns the recorded route.
 */
function routeOf(records: readonly LogRecord[]): { provider: string; model: string } {
  for (const record of records) {
    if (record.type !== 'request/header') continue
    const config = record.data?.header?.config
    if (typeof config?.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
  }
  throw new Error('the recorded session states no request model')
}

test('a second OS process reads both prepared records back from the persisted session', { timeout: 75_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-request-recording-restart-'))
  try {
    const fixture = recordsIn(await readFile(SESSION_FILE, 'utf8'))
    const task = taskFromSession(fixture)
    assert.ok(task !== undefined, 'the recorded session carries the task the replay drives')
    const route = routeOf(fixture)
    const spillRoot = join(cwd, '.spill')

    // The first process: the shipped composition persists the two prepared records and exits.
    const first = await runLoaderSmoke({
      label: 'claude-request-recording first process',
      binScript: BIN_SCRIPT,
      configPath: join(BASE_COMPOSITION_DIR, 'cordis.yml'),
      tsconfigPath: TSCONFIG,
      sourceImport: 'tsx/esm',
      cwd,
      binArgs: [
        '--profile', 'headless',
        '--patch', join(BASE_COMPOSITION_DIR, 'cordis.yml'),
        '--patch', join(SCENARIO_DIR, 'cordis.snapshot.yml'),
        '--patch', join(BASE_COMPOSITION_DIR, 'model.cordis.yml'),
        task,
      ],
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_SNAPSHOT_PROVIDER: route.provider,
        DSH_SNAPSHOT_MODEL: route.model,
        DSH_SNAPSHOT_FILE: SESSION_FILE,
        DSH_SNAPSHOT_OVERRIDE: join(SCENARIO_DIR, 'replay.override.json'),
        DSH_SNAPSHOT_SPILL_ROOT: spillRoot,
        DSH_SNAPSHOT_SPILL_LOCATOR_ROOT: join(spillRoot, 'locators'),
        DSH_TELEMETRY_DISABLED: '1',
        // Keeps the child's own diagnostics on the controlled spill root and composes the
        // inherited options instead of replacing them, so a host guard that set them survives.
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
        // The launcher clears the published proxy names; Node samples this switch at process
        // start, so the child must not inherit it.
        NODE_USE_ENV_PROXY: undefined,
      },
    })
    assert.equal(first.stderr, '', 'the recording composition writes no diagnostic')

    // The private sessions root the launcher's DSH_HOME owns; this scenario persists one log.
    const sessionsRoot = join(cwd, '.dsh', 'sessions')
    const logs = (await readdir(sessionsRoot, { recursive: true })).filter(name => name.endsWith('.jsonl'))
    assert.equal(logs.length, 1, 'the first process persisted exactly one session log')
    const logPath = join(sessionsRoot, logs[0] as string)
    const before = await readFile(logPath, 'utf8')
    const persisted = recordsIn(before)
    const sessionId = persisted[0]?.id
    assert.equal(persisted[0]?.type, 'session', 'the persisted log starts with its header')
    assert.ok(typeof sessionId === 'string' && sessionId.length > 0, 'the header states the session id')
    const stored = persisted.filter(record => record.type === 'llm/request-record')
    assert.equal(stored.length, 2, 'the first process persisted two prepared records')
    const expectRecords: ExpectedRecord[] = stored.map(record => ({
      systemBlocks: record.data?.systemBlocks ?? [],
      systemDigest: record.data?.systemDigest ?? '',
    }))
    assert.ok(expectRecords.every(record => record.systemBlocks.length > 0), 'each record carries its system text')
    assert.ok(expectRecords.every(record => record.systemDigest.length > 0), 'each record carries its digest')
    assert.notDeepEqual(
      expectRecords[0]?.systemBlocks,
      expectRecords[1]?.systemBlocks,
      'the two attempts carry different system text',
    )

    // The second process: one reader fixture, no startup, no runner, no task, no model route.
    const patch = join(cwd, 'second-process.cordis.yml')
    await writeFile(patch, JSON.stringify([
      { id: 'headless-startup', disabled: true },
      { id: 'headless-runner', disabled: true },
      { id: 'llm-deepseek', disabled: true },
      { id: 'plugin-package-inventory-deepseek', disabled: true },
      { id: 'session-title-llm', disabled: true },
      {
        id: 'session-persistence-jsonl',
        name: '@deepseek-ai/dsh-session-persistence-jsonl',
        config: { root: sessionsRoot, compression: 'none' },
      },
      {
        insert: [{
          id: 'claude-request-recording-reader',
          name: pathToFileURL(READER_FIXTURE).href,
          inject: ['sessionPersistence', 'appReady', 'appExit'],
          config: { sessionId, expectRecords },
        }],
      },
    ], null, 2), 'utf8')

    const second = await runLoaderSmoke({
      label: 'claude-request-recording second process',
      binScript: BIN_SCRIPT,
      configPath: join(BASE_COMPOSITION_DIR, 'cordis.yml'),
      tsconfigPath: TSCONFIG,
      sourceImport: 'tsx/esm',
      cwd,
      binArgs: [
        '--profile', 'headless',
        '--patch', join(BASE_COMPOSITION_DIR, 'cordis.yml'),
        '--patch', patch,
      ],
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_TELEMETRY_DISABLED: '1',
        // Composed from the inherited value, never a replacement, so a host guard survives.
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
        NODE_USE_ENV_PROXY: undefined,
      },
    })

    assert.equal(second.stderr, '', 'the reader process writes no diagnostic')
    const lines = second.stdout
      .split('\n')
      .filter(line => line.length > 0)
      .map((line): ReaderLine => JSON.parse(line))
    assert.equal(lines.length, 3, 'the reader prints its run line and one line per record')
    assert.equal(lines[0]?.sessionId, sessionId, 'the reader read the session the first process persisted')
    assert.equal(lines[0]?.records, 2, 'the reader found two prepared records')
    assert.ok(Number.isSafeInteger(lines[0]?.pid) && lines[0]?.pid !== process.pid,
      'the reader ran as its own OS process, not in this test process')
    const readRecords = lines.slice(1)
    assert.deepEqual(readRecords.map(record => record.systemBlocks), expectRecords.map(record => record.systemBlocks),
      'the second process reads back the exact system text the first process persisted')
    assert.deepEqual(readRecords.map(record => record.systemDigest), expectRecords.map(record => record.systemDigest),
      'the second process reads back the digest the first process persisted')
    assert.ok(readRecords.every(record => Number.isSafeInteger(record.preparedId)),
      'each record states the preparedId the persistence reader derived')
    assert.notEqual(readRecords[0]?.preparedId, readRecords[1]?.preparedId,
      'the two records keep their own identities')

    assert.equal(await readFile(logPath, 'utf8'), before, 'the second process appended nothing to the persisted log')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
