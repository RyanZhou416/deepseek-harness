/**
 * The prepared-request recording seam through a real Loader composition.
 *
 * Every case boots a test-only composition through the shipped Loader: the Session store, the
 * shipped JSONL persistence over a private root this file owns, the Host `llm` service, the
 * Host's recording service with its required bound, and the recording assembly the snapshot
 * composition also mounts. That assembly applies the real plugin module's own `apply` with the
 * non-serializable internals a deterministic test must state — the Messages transport, the two
 * independent read transports and the credential-source reader — so the Claude route under test
 * is the one the shipped plugin registered on this composition's `llm` service. Attempts are
 * dispatched through `ctx.llm.stream`: this file constructs no adapter, no port, no service and
 * no record of its own.
 *
 * The Loader resolves each entry from this file's own `builtins` registry instead of from
 * `node_modules`, so the modules under test are exactly the ones this spec imported and no
 * published copy of a package can stand in for them. Everything else is the Loader's: entry
 * creation, config validation against the plugin's own schema, dependency injection, fiber
 * lifecycle and disposal. The assembly stores the synthetic account inside its own `apply`
 * before calling the real `apply`, and an entry's apply is part of its fiber's inertia, so
 * `ctx.loader.await()` is the ordering barrier for both. Loading the plugin by its own package
 * name through the composition's own module resolution is the separate end-to-end gate, not
 * something this file claims.
 *
 * The probe fixture is located through this package's own exported manifest
 * (`dsh-plugin-subscriptions/package.json`), so one fixture serves the source run and the
 * compiled `lib-test` run alike, with no mode-dependent fallback.
 *
 * Two cases, and they are the opposite sides of one contract:
 *  - success: each attempt's record is already in the session's log when its POST arrives, its
 *    `systemBlocks` are exactly the system text of the body that went out, and after the write
 *    handle closes a SECOND Context that mounts only the JSONL backend reads each attempt back
 *    from disk by its own `preparedId`;
 *  - a refusing durability listener: the same route and the same attempt, zero Messages
 *    requests, a `forbid` refusal, and the appended record still retained in the session's log.
 *    A refused checkpoint promises no durability, so that case claims retention only.
 *
 * Egress is closed as the probe states it: the Messages POST and the adapter's identity-profile
 * read go through the injected transport, the policy and organization reads through their
 * injected transports, anything reaching the process-global fetch is refused by a guard the
 * probe installs before the seed and the real `apply` and owns through the composition's
 * context, and a published outbound proxy policy fails the composition outright. Because Node
 * samples `NODE_USE_ENV_PROXY` at process start, the launcher must clear the ambient proxy
 * environment before this spec runs; the probe's refusal is the in-run check that no policy
 * survived. The account is synthetic and written into the private home this file owns; no real
 * credential file, Keychain, helper, grant, socket or provider endpoint is touched.
 *
 * Mounting is gated on the plugin's own fibers rather than on `ctx.loader.await()`, which settles
 * rejected startup work without reporting it: the assembly entry is looked up after creation, its
 * fiber and the production fiber it mounted are both awaited so a failed seed or apply is
 * rethrown, and the registered-route assertion plus the first real stream are the evidence that
 * the composition serving the request is the shipped plugin's own.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type {} from '@deepseek-ai/dsh-session-persistence'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionRequestRecordProvider, { reconstructRequestSystem } from '@deepseek-ai/dsh-llm-request-record'

/** The composition entry every case mounts; the package's own manifest locates its fixture. */
const PROBE_MODULE = join(
  dirname(fileURLToPath(import.meta.resolve('dsh-plugin-subscriptions/package.json'))),
  'test', 'fixtures', 'claude-request-recording-probe.mjs',
)

/** The session every case writes and reopens. */
const SESSION = SessionId('claude-request-recording')

/** Private roots this file owns; each is removed once the whole file settles. */
const roots: string[] = []

/** The harness home this file replaced, restored once the whole file settles. */
const PREVIOUS_HOME = process.env.DSH_HOME

after(async () => {
  try {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  } finally {
    // The environment this file mutated is restored whether or not the temporary roots could be
    // removed: a Windows handle this process still holds must not leave DSH_HOME redirected.
    if (PREVIOUS_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = PREVIOUS_HOME
  }
})

/** The session log as one reader returned it, with its prepared records called out. */
interface ReadBack {
  readonly events: readonly SessionEvent[]
  readonly records: readonly SessionEvent<'llm/request-record'>[]
}

/** One admitted Messages request, as the scripted transport observed it. */
interface Posted {
  readonly preparedId: number
  readonly systemTexts: readonly string[]
}

/** One attempt's terminal outcome, as the registered route reported it. */
interface Finish {
  readonly kind: string
  readonly code?: string
  readonly retryDisposition?: string
}

/** What one driven sequence produced. */
interface Observation {
  readonly posts: readonly Posted[]
  readonly finishes: readonly Finish[]
  readonly readBack: ReadBack
}

/** The scripted transports and the requests they refused for one composition. */
interface Capture {
  readonly posts: readonly Posted[]
  readonly refused: readonly string[]
  readonly productionFiber?: Fiber
  /** The outbound proxy policy the probe read at the entry; both fields must be absent. */
  readonly proxy?: {
    readonly claudeRoute?: string | undefined
    readonly httpsProxy?: string | undefined
  }
}

/** The assembly a composition mounts, and the capture its transports fill. */
interface Assembly {
  readonly name: string
  readonly inject: string[]
  readonly capture: Capture
  apply(ctx: Context, config: unknown): Promise<void>
}

/** The probe's exported calls, as this spec uses them. */
interface RecordingProbe {
  readonly MODEL: string
  readonly ATTEMPTS: readonly string[]
  readonly REFUSED_ATTEMPT: string
  createCapture(): Capture
  createRecordingAssembly(capture: Capture): Assembly
  driveRecordedAttempts(ctx: Context, sessionId: SessionId, texts: readonly string[], capture: Capture): Promise<Observation>
  requireRecordedAttempts(observed: Observation, texts: readonly string[]): void
}

/**
 * The probe fixture is JavaScript, so its calls are stated here instead of being resolved from
 * a declaration file. The interfaces above are the whole surface this spec uses.
 */
const probe = await import(pathToFileURL(PROBE_MODULE).href) as RecordingProbe

/** A recorded log position, branded the way the Session log declares it. */
const preparedSeq = (seq: number): SessionSeq => seq as SessionSeq

/** One mounted composition, with the one release that closes its write handle and disposes it. */
interface Composition {
  readonly ctx: Context
  readonly capture: Capture
  readonly sessionId: SessionId
  release(): Promise<void>
}

/**
 * Mount the test composition through the shipped Loader.
 *
 * The private home is stated before any entry exists, so no plugin or store read can resolve a
 * path outside it. A mount that fails part way releases the fiber and any writer it acquired
 * before reporting the failure, and a cleanup failure is reported beside the primary one rather
 * than replacing or hiding it.
 * @param home - the private harness home this composition reads and writes.
 * @param root - the private JSONL root this composition persists into.
 * @returns the mounted composition.
 */
async function mount(home: string, root: string): Promise<Composition> {
  process.env.DSH_HOME = home
  const capture = probe.createCapture()
  const assembly = probe.createRecordingAssembly(capture)
  const ctx = new Context()
  let writer: { close(): Promise<void> } | undefined
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins['dsh-session'] = SessionStore
    ctx.loader.builtins['dsh-session-persistence-jsonl'] = JsonlSessionPersistence
    ctx.loader.builtins['dsh-llm'] = LlmRuntime
    ctx.loader.builtins['dsh-llm-request-record'] = SessionRequestRecordProvider
    ctx.loader.builtins[assembly.name] = assembly

    await ctx.loader.create({ name: 'cordis:dsh-session' })
    await ctx.loader.create({
      name: 'cordis:dsh-session-persistence-jsonl',
      config: { root, compression: 'none' },
    })
    await ctx.loader.create({ name: 'cordis:dsh-llm' })
    await ctx.loader.create({
      name: 'cordis:dsh-llm-request-record',
      config: { flushTimeoutMs: 2_000 },
    })
    await ctx.loader.create({
      name: `cordis:${assembly.name}`,
      inject: assembly.inject,
      // An explicit catalog turns the route's own model discovery off, so the composition
      // assembles no discovery request at all.
      config: { providers: ['claude'], models: { claude: [{ id: probe.MODEL }] }, pool: { enabled: false } },
    })
    const assemblyEntry = [...ctx.loader.entries()]
      .find(entry => entry.options.name === `cordis:${assembly.name}`)
    assert.ok(assemblyEntry !== undefined, 'the Loader holds the recording assembly entry')
    assert.ok(assemblyEntry.fiber !== undefined, 'the recording assembly entry owns a fiber')
    // `loader.await()` is a `Promise.allSettled` over entry tasks, so it settles a rejected seed
    // or apply without reporting it. Awaiting the fibers themselves rethrows that failure, and
    // the route assertion plus the first real stream below are the positive evidence that the
    // composition which ran is the shipped plugin's own.
    await ctx.loader.await()
    await assemblyEntry.fiber.await()
    assert.ok(capture.productionFiber !== undefined, 'the assembly mounted the production plugin fiber')
    await capture.productionFiber.await()
    assert.equal(capture.proxy?.claudeRoute, undefined, 'no mandatory Claude proxy route is published')
    assert.equal(capture.proxy?.httpsProxy, undefined, 'no scheme proxy is published for the Claude origin')

    const session = ctx.sessions.create(SESSION, { meta: { cwd: root } })
    // The backend publishes this session's `session/event` batches and `session/flush` barriers
    // through the write handle; without one, a flush has no participating listener and the
    // recording service could never report a durable record.
    writer = await ctx.sessionPersistence.create(session.header)
    assert.ok(
      ctx.llm.listProviders().some(provider => provider.id === 'claude'),
      'the shipped plugin registered its Claude route on the composition llm service',
    )
    const acquired = writer
    let released = false
    return {
      ctx,
      capture,
      sessionId: session.id,
      async release() {
        if (released) return
        released = true
        // The write handle's own failure is reported after the fiber is disposed, so a close
        // error neither skips disposal nor gets replaced by it.
        try {
          await acquired.close()
        } finally {
          await ctx.fiber.dispose()
        }
      },
    }
  } catch (failure) {
    const cleanup: unknown[] = []
    if (writer !== undefined) {
      try {
        await writer.close()
      } catch (error) {
        cleanup.push(error)
      }
    }
    try {
      await ctx.fiber.dispose()
    } catch (error) {
      cleanup.push(error)
    }
    if (cleanup.length > 0) {
      throw new AggregateError([failure, ...cleanup], 'the composition failed to mount and its cleanup also failed')
    }
    throw failure
  }
}

/** One private home and JSONL root for a case. */
async function privateRoots(): Promise<{ home: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'claude-request-recording-'))
  roots.push(root)
  return { home: join(root, 'home'), root: join(root, 'sessions') }
}

/**
 * Open the same private root from a context that mounts only the JSONL backend.
 *
 * No Session store, no recording service and none of the first run's objects exist here, so a
 * record this reader returns can only have come from the file.
 * @param root - the private root the first composition wrote.
 * @returns every event of the session's log, in log order.
 */
async function readFromDisk(root: string): Promise<ReadBack> {
  const reader = new Context()
  try {
    await reader.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const handle = await reader.sessionPersistence.open(SESSION, 'read')
    try {
      const { events } = await handle.read()
      return {
        events,
        records: events.filter((event): event is SessionEvent<'llm/request-record'> =>
          event.type === 'llm/request-record'),
      }
    } finally {
      await handle.close()
    }
  } finally {
    await reader.fiber.dispose()
  }
}

test('every attempt is recorded and flushed before it is posted, and both read back after the writer closes', async () => {
  const { home, root } = await privateRoots()
  const composition = await mount(home, root)
  try {
    // The independent participation marker: `SessionStore.flush` reports durability only when at
    // least one listener participated, so counting this composition's own barrier shows the
    // record service's success came from a participating checkpoint, not an empty listener set.
    let flushes = 0
    const stopCounting = composition.ctx.on('session/flush', () => { flushes += 1 })
    const observed = await probe.driveRecordedAttempts(
      composition.ctx, composition.sessionId, probe.ATTEMPTS, composition.capture,
    )
    stopCounting()

    probe.requireRecordedAttempts(observed, probe.ATTEMPTS)
    assert.equal(observed.posts.length, probe.ATTEMPTS.length, 'one Messages request per attempt')
    assert.ok(flushes >= 1, 'a durability listener participated in the checkpoint the route awaited')
    assert.deepEqual(composition.capture.refused, [], 'nothing outside the stated transports was reached')

    // The durable side of the same contract: the write handle is closed and the composition is
    // gone before this reader exists, so every record below comes from the file.
    await composition.release()
    const durable = await readFromDisk(root)

    assert.equal(durable.records.length, probe.ATTEMPTS.length, 'the durable log carries one record per attempt')
    assert.deepEqual(
      durable.records.map(record => record.seq),
      observed.posts.map(post => preparedSeq(post.preparedId)),
      'the records on disk are the ones the attempts were recorded under',
    )
    const first = reconstructRequestSystem(durable.events, preparedSeq(observed.posts[0]!.preparedId))
    const second = reconstructRequestSystem(durable.events, preparedSeq(observed.posts[1]!.preparedId))
    assert.deepEqual(first, observed.posts[0]!.systemTexts, 'the first attempt reads back its own posted text')
    assert.deepEqual(second, observed.posts[1]!.systemTexts, 'the second attempt reads back its own posted text')
    assert.equal(first?.at(-1), probe.ATTEMPTS[0], 'the first record ends with the first attempt\'s caller text')
    assert.equal(second?.at(-1), probe.ATTEMPTS[1], 'the second record ends with the second attempt\'s caller text')
    assert.notDeepEqual(first, second, 'selecting one attempt does not return the other')
  } finally {
    await composition.release()
  }
})

test('a refusing durability listener sends zero Messages and still retains the prepared record', async () => {
  const { home, root } = await privateRoots()
  const composition = await mount(home, root)
  try {
    // The controlled failure: a real listener on this session's flush barrier that refuses. The
    // shipped JSONL listener participates in the same dispatch and settles before that refusal
    // surfaces, so the appended record is what the session's log carries.
    const stopRefusing = composition.ctx.on('session/flush', () => {
      throw new Error('synthetic: this durability listener refused the checkpoint')
    })
    const observed = await probe.driveRecordedAttempts(
      composition.ctx, composition.sessionId, [probe.REFUSED_ATTEMPT], composition.capture,
    )
    stopRefusing()

    assert.equal(observed.posts.length, 0, 'no Messages request was sent')
    assert.equal(observed.finishes.length, 1)
    assert.equal(observed.finishes[0]!.kind, 'error', 'the attempt failed instead of streaming')
    assert.equal(observed.finishes[0]!.code, 'REQUEST_RECORD_UNAVAILABLE')
    assert.equal(observed.finishes[0]!.retryDisposition, 'forbid', 'and nothing may resend it')
    assert.deepEqual(composition.capture.refused, [], 'nothing outside the stated transports was reached')
    // Retention only: the route appends the record, and a refused checkpoint promises no
    // durability. This does not claim the refused flush persisted anything.
    assert.equal(observed.readBack.records.length, 1, 'the prepared record is retained in the session log')
    assert.equal(observed.readBack.records[0]!.data.systemBlocks.at(-1), probe.REFUSED_ATTEMPT,
      'the retained record states the system text of the request that was refused')
  } finally {
    await composition.release()
  }
})
