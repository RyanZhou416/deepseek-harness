/**
 * Startup tests for the Bun transport: the child's entry guard and the shared bridge's
 * start lifecycle.
 *
 * The entry-guard cases run the real child entry — the artifact the parent compiler
 * emitted beside this spec, or the source a runtime transpiles — from a private directory
 * whose name needs URL escaping, and read the frame the child answers with. The lifecycle
 * cases replace `node:child_process.spawn` for this file, so the bridge runs its real
 * start, replacement and teardown paths against a frame-speaking child double. No request
 * reaches the network in any case: the entry guard is exercised with a frame the child
 * refuses before fetching, and the double answers the bridge itself.
 */

import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { after, beforeEach, test, type TestContext } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BridgeError, childEnvironment, DEFAULT_MAX_QUEUED_BYTES } from '../src/transport/bridge.js'
import { isMainEntry } from '../src/transport/bun-child.js'
import { claudeApiFetch, configureClaudeTransport, stopBridge } from '../src/transport/claude-fetch.js'
import { encodeBody, encodeControl, FrameDecoder, type Frame } from '../src/transport/frames.js'
import { BUN_PATH_ENV, resolveBunRuntime } from '../src/transport/bun-runtime.js'

/**
 * Bound on every wait for a state this file awaits.
 *
 * The awaited state decides, never this bound: a process needs real time only to start and
 * end, and the bridge's work is promise continuations. The case budget sits above it so a
 * stalled wait reports the precise state it waited for.
 */
const WAIT_BOUND_MS = 20_000

/** Case budget for a case that spawns a runtime process, above the wait bound. */
const CASE_BOUND_MS = 30_000

/** The Messages request the bridge carries, and the only URL that reaches it. */
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'

/** Marker the import fixture writes once the entry module has been imported. */
const IMPORT_MARKER = 'transport-startup:imported\n'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The builtin `spawn`, captured before any case replaces it. */
const childProcessModule = createRequire(import.meta.url)('node:child_process')

/** The unpatched spawn, so the entry-guard cases are immune to the lifecycle cases' patch. */
const realSpawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess =
  childProcessModule.spawn

/** The process's own fetch, captured before this file replaces it. */
const realFetch = globalThis.fetch

/** Every URL a case sent to the process's own fetch, which is the Node transport. */
const fallbackUrls: string[] = []

globalThis.fetch = (async (input: RequestInfo | URL) => {
  fallbackUrls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  return new Response('{}', { status: 200 })
}) as typeof fetch

/**
 * Finds the plugin root above a directory.
 *
 * @param start - Directory to search from.
 * @returns The nearest ancestor holding a `package.json`.
 */
function findPluginRoot(start: string): string {
  let current = start
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(join(current, 'package.json'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`no package.json above ${start}`)
}

const PLUGIN_ROOT = findPluginRoot(HERE)

/** Directory whose sibling `src` tree the parent compiler emits when this spec is compiled. */
const COMPILED_ROOT = dirname(HERE)

/** The child entry to exercise, and whether a runtime must transpile it. */
interface ChildArtifact {
  /** Absolute path of the entry module. */
  readonly entry: string
  /** Whether the entry is TypeScript, which is what makes the runtime the transpiler. */
  readonly typescript: boolean
}

/**
 * Locates the child entry this run should exercise.
 *
 * A compiled run executes `lib-test/test`, and the parent `test` script's `tsc` emits the
 * sibling `lib-test/src` tree in the same command, so that artifact always matches the
 * source under test. A run from the source tree exercises the TypeScript the runtime
 * transpiles in place, and the deployed `lib` build is the last resort. Nothing is
 * compiled here: a test that emitted would race the parent's own emit.
 *
 * @returns The entry path and whether the runtime must transpile TypeScript.
 */
function childArtifact(): ChildArtifact {
  const compiled = join(COMPILED_ROOT, 'src', 'transport', 'bun-child.js')
  if (existsSync(compiled)) return { entry: compiled, typescript: false }
  const source = join(PLUGIN_ROOT, 'src', 'transport', 'bun-child.ts')
  if (existsSync(source)) return { entry: source, typescript: true }
  const built = join(PLUGIN_ROOT, 'lib', 'transport', 'bun-child.js')
  if (existsSync(built)) return { entry: built, typescript: false }
  throw new Error(`no transport child entry beside ${COMPILED_ROOT} or ${PLUGIN_ROOT}`)
}

/**
 * The pinned Bun runtime, or a skip when this host never installed it.
 *
 * Only the declared platform package is consulted: an override in the ambient environment
 * would make the case depend on whoever launched the suite.
 *
 * @param context - Test context, so the skip is reported rather than passed silently.
 * @returns The executable path, or undefined when the case has no runtime to run.
 */
function pinnedBun(context: TestContext): string | undefined {
  try {
    return resolveBunRuntime({})
  } catch (error) {
    context.skip(
      `the declared Bun platform package is not installed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}

/**
 * Copies the child entry and its framing module into a private directory.
 *
 * @param context - Test context owning the directory's removal.
 * @param prefix - `mkdtemp` prefix; its escaping characters are the case's subject.
 * @returns The staged directory and the entry inside it.
 */
function stageChild(context: TestContext, prefix: string): { root: string; entry: string } {
  const artifact = childArtifact()
  const root = mkdtempSync(join(realpathSync(tmpdir()), prefix))
  context.after(() => {
    rmSync(root, { recursive: true, force: true })
  })
  const frames = artifact.typescript ? 'frames.ts' : 'frames.js'
  const entry = join(root, basename(artifact.entry))
  copyFileSync(artifact.entry, entry)
  copyFileSync(join(dirname(artifact.entry), frames), join(root, frames))
  return { root, entry }
}

/**
 * A frame whose stream index a `uint32` cannot carry.
 *
 * The child refuses it before it issues any request, so the frame it answers with proves
 * the entry guard admitted the process to its frame loop without a request being sent.
 */
function unusableIndexFrame(): Uint8Array {
  return encodeControl({
    streamId: 'startup',
    index: -1,
    type: 'request',
    url: MESSAGES_URL,
    method: 'POST',
    headers: [],
    body: false,
  })
}

/** What one child entry run produced. */
interface EntryRun {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly frames: readonly Frame[]
  readonly stdout: string
  readonly stderr: string
  readonly decodeFailure: string | undefined
}

/**
 * Runs the child entry with one unusable-index frame and awaits the child's exit.
 *
 * The child is handed the transport's own scrubbed environment, so no proxy variable or
 * plugin switch reaches it. Its exit is awaited rather than slept on, and the frame it
 * answers with — not a deadline — is what proves it entered the loop.
 *
 * @param runtime - Executable the entry runs under.
 * @param entry - Entry module to run as the process's main module.
 * @returns The exit, the frames the entry wrote, and its streams.
 */
async function entryRun(runtime: string, entry: string): Promise<EntryRun> {
  const child = realSpawn(runtime, [entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnvironment(process.env),
  })
  const decoder = new FrameDecoder()
  const frames: Frame[] = []
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout.push(chunk)
    frames.push(...decoder.push(chunk))
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk)
  })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle, fail) => {
    const timer = setTimeout(() => {
      child.kill()
      fail(
        new Error(
          `the child entry did not exit within ${WAIT_BOUND_MS}ms; awaited state: the child ending after its stdin closed (${entry})`,
        ),
      )
    }, WAIT_BOUND_MS)
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      fail(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      settle({ code, signal })
    })
  })
  child.stdin?.write(unusableIndexFrame())
  child.stdin?.end()
  const exit = await closed
  return {
    ...exit,
    frames,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    decodeFailure: decoder.error?.reason,
  }
}

/**
 * The message of the `error` frame naming a stream.
 *
 * @param frames - Frames the child wrote.
 * @param streamId - Stream the answer belongs to.
 * @returns The message, or undefined when no such frame arrived.
 */
function errorFrameFor(frames: readonly Frame[], streamId: string): string | undefined {
  for (const frame of frames) {
    if (frame.tag !== 1) continue
    if (frame.message['streamId'] !== streamId || frame.message['type'] !== 'error') continue
    const message = frame.message['message']
    return typeof message === 'string' ? message : ''
  }
  return undefined
}

test('the child entry answers a frame from a path a file URL must escape', { timeout: CASE_BOUND_MS }, async (t) => {
  const runtime = pinnedBun(t)
  if (runtime === undefined) return
  const staged = stageChild(t, 'dsh transport #%✓-startup-')
  // The subject of the case: the path holds exactly the bytes a URL percent-encodes.
  assert.match(staged.root, / #%✓-/, 'the staged path must need URL escaping')

  const run = await entryRun(runtime, staged.entry)

  assert.equal(run.signal, null, 'no signal ended the child')
  assert.equal(run.code, 0, `the child exited on its own; stderr: ${run.stderr}`)
  assert.equal(run.stderr, '', 'the child reported no diagnostic')
  assert.equal(run.decodeFailure, undefined, 'the child wrote whole frames')
  const message = errorFrameFor(run.frames, 'startup')
  assert.ok(
    message !== undefined,
    `the child entered its frame loop and answered the unusable index; stdout: ${JSON.stringify(run.stdout)}`,
  )
  assert.match(message, /uint32 stream index/)
})

test('the child entry answers from a path that needs no escaping', { timeout: CASE_BOUND_MS }, async (t) => {
  // The control for the case above: it separates a broken entry guard from a broken
  // harness, a runtime that cannot transpile the entry, or a fixture that never arrived.
  const runtime = pinnedBun(t)
  if (runtime === undefined) return
  const staged = stageChild(t, 'dsh-startup-plain-')

  const run = await entryRun(runtime, staged.entry)

  assert.equal(run.signal, null, 'no signal ended the child')
  assert.equal(run.code, 0, `the child exited on its own; stderr: ${run.stderr}`)
  assert.equal(errorFrameFor(run.frames, 'startup'), 'request needs a uint32 stream index')
})

test('importing the child entry starts no frame loop', { timeout: CASE_BOUND_MS }, async (t) => {
  const runtime = pinnedBun(t)
  if (runtime === undefined) return
  const staged = stageChild(t, 'dsh-startup-import-')
  const launcher = join(PLUGIN_ROOT, 'test', 'fixtures', 'transport-startup-import.mjs')

  const child = realSpawn(runtime, [launcher, staged.entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnvironment(process.env),
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout.push(chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk)
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle, fail) => {
    const timer = setTimeout(() => {
      child.kill()
      fail(
        new Error(
          `the importing process did not exit within ${WAIT_BOUND_MS}ms; awaited state: the import returning without a frame loop`,
        ),
      )
    }, WAIT_BOUND_MS)
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      fail(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      settle({ code, signal })
    })
  })
  child.stdin?.write(unusableIndexFrame())
  child.stdin?.end()
  const exit = await closed

  const text = Buffer.concat(stdout).toString('utf8')
  assert.equal(exit.signal, null, 'no signal ended the process')
  assert.equal(exit.code, 0, `the importer exited on its own; stderr: ${Buffer.concat(stderr).toString('utf8')}`)
  assert.equal(
    text,
    IMPORT_MARKER,
    'an imported entry stays inert: only the marker may reach stdout, never a frame',
  )
})

test('the entry guard compares filesystem paths exactly, never as a suffix', (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-startup-guard-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
  })
  const spaced = join(root, 'space #%✓ dir')
  mkdirSync(spaced)
  const entry = join(spaced, 'bun-child.js')
  writeFileSync(entry, '')
  const url = pathToFileURL(entry).href
  assert.match(url, /%20/, 'the URL escapes the space the path spells literally')

  assert.equal(isMainEntry(url, entry), true, 'one file spelled as a URL and as a path is the entry')
  assert.equal(isMainEntry(url, resolve(entry)), true, 'an unresolved spelling resolves to the same file')
  assert.equal(isMainEntry(url, undefined), false, 'a process without argv[1] has no entry module')
  assert.equal(isMainEntry(url, ''), false, 'an empty argv[1] names no file')
  assert.equal(isMainEntry('not a url', entry), false, 'a module that is not a file URL is not the entry')
  if (process.platform === 'win32') {
    assert.equal(isMainEntry(url, entry.toUpperCase()), true, 'Windows spelling is case-insensitive')
  }

  // A different file whose path merely ends with the entry path: a suffix comparison
  // accepts it, the exact comparison refuses it. Both paths are escape-free, because an
  // escaped one makes a suffix comparison false for the wrong reason.
  const plain = join(root, 'bun-child.js')
  writeFileSync(plain, '')
  const nested = join(root, 'outer')
  mkdirSync(nested)
  const impostor = join(nested, resolve(plain).replace(/^[\\/]/u, ''))
  assert.equal(
    pathToFileURL(impostor).href.endsWith(plain.replace(/\\/gu, '/')),
    true,
    'a suffix comparison accepts this path',
  )
  assert.equal(isMainEntry(pathToFileURL(impostor).href, plain), false, 'a different file is not the entry')

  const linked = join(root, 'linked')
  // The link targets a directory inside this tree, so the clean-up can remove the tree
  // recursively without reaching anything outside it.
  try {
    symlinkSync(spaced, linked, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    // A host without the privilege to create links has no linked install layout to compare.
    t.diagnostic('link creation is unavailable on this host; the linked-path case was not exercised')
    return
  }
  assert.equal(
    isMainEntry(pathToFileURL(join(linked, 'bun-child.js')).href, entry),
    true,
    'the same file reached through a link is the entry',
  )
})

/** A complete request the bridge wrote, as the child double received it. */
interface FramedRequest {
  /** Stream the request opened. */
  readonly streamId: string
  /** Index the request assigned to that stream. */
  readonly index: number
}

/**
 * A child the bridge can talk to, driven frame by frame.
 *
 * It exposes exactly the surface `spawnBunChild` uses on a real `ChildProcess`, so the
 * bridge's own constructor, request path and teardown run unchanged: the case decides when
 * a request arrives, when it is answered, and when the child ends.
 */
class FakeChild {
  readonly #frames: Frame[] = []
  readonly #decoder = new FrameDecoder()
  readonly #requests: FramedRequest[] = []
  readonly #requestIndex = new Map<string, number>()
  readonly #openBodies = new Set<string>()
  readonly #cancelled = new Set<string>()
  readonly #answered = new Set<string>()
  readonly #data: ((chunk: Buffer) => void)[] = []
  readonly #errors: ((error: Error) => void)[] = []
  readonly #exits: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = []
  readonly #waiters: { readonly target: number; readonly settle: () => void }[] = []
  #killed = false
  #ended = false

  readonly stdin: { write(bytes: Uint8Array): void; on(event: 'error', handler: (error: Error) => void): void } = {
    write: (bytes) => {
      for (const frame of this.#decoder.push(bytes)) this.#ingest(frame)
    },
    on: (_event, handler) => {
      this.#errors.push(handler)
    },
  }

  readonly stdout: { on(event: 'data', handler: (chunk: Buffer) => void): void } = {
    on: (_event, handler) => {
      this.#data.push(handler)
    },
  }

  /**
   * Registers the bridge's handlers; its own duplex registers one of each.
   *
   * @param event - Which stream ended the child.
   * @param handler - Handler for that stream.
   */
  on(
    event: 'error' | 'exit',
    handler: ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void),
  ): void {
    if (event === 'error') this.#errors.push(handler as (error: Error) => void)
    else this.#exits.push(handler as (code: number | null, signal: NodeJS.Signals | null) => void)
  }

  /** Whether the bridge terminated this child. */
  get killed(): boolean {
    return this.#killed
  }

  /** Every frame the bridge wrote, decoded in arrival order. */
  frames(): readonly Frame[] {
    return this.#frames
  }

  /** Every complete request the bridge wrote. */
  requests(): readonly FramedRequest[] {
    return this.#requests
  }

  /**
   * Resolves once `count` complete requests have arrived.
   *
   * @param count - Number of complete requests to await.
   * @returns A promise that settles on that arrival or fails naming what it awaited.
   */
  waitForRequest(count: number): Promise<void> {
    if (this.#requests.length >= count) return Promise.resolve()
    return new Promise<void>((settle, fail) => {
      const timer = setTimeout(() => {
        fail(
          new Error(
            `waited ${WAIT_BOUND_MS}ms for request ${count} of a child; ${this.#requests.length} arrived`,
          ),
        )
      }, WAIT_BOUND_MS)
      this.#waiters.push({
        target: count,
        settle: () => {
          clearTimeout(timer)
          settle()
        },
      })
    })
  }

  /**
   * Answers the oldest request that is neither answered nor cancelled.
   *
   * @param status - Response status to frame.
   * @param body - Response body to frame.
   */
  answer(status: number, body: string): void {
    const request = this.#requests.find(
      (entry) => !this.#answered.has(entry.streamId) && !this.#cancelled.has(entry.streamId),
    )
    if (request === undefined) throw new Error('no unanswered request has arrived')
    this.#answered.add(request.streamId)
    this.#emit(
      encodeControl({
        streamId: request.streamId,
        type: 'response',
        status,
        headers: [['content-type', 'application/json']],
      }),
    )
    this.#emit(encodeBody(request.index, new TextEncoder().encode(body)))
    this.#emit(encodeControl({ streamId: request.streamId, type: 'end' }))
  }

  /**
   * Ends the child the way a crash or an external kill would.
   *
   * @param code - Exit code the bridge reports.
   * @param signal - Signal the bridge reports, if any.
   */
  exits(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#ended) return
    this.#ended = true
    for (const handler of this.#exits) handler(code, signal)
  }

  /** Terminates the child, as `BunBridge.dispose` does. */
  kill(): void {
    this.#killed = true
  }

  #emit(bytes: Uint8Array): void {
    const chunk = Buffer.from(bytes)
    for (const handler of this.#data) handler(chunk)
  }

  #ingest(frame: Frame): void {
    this.#frames.push(frame)
    if (frame.tag === 2) return
    const message = frame.message
    const streamId = message['streamId']
    if (typeof streamId !== 'string') return
    const type = message['type']
    if (type === 'request') {
      const index = message['index']
      if (typeof index !== 'number') return
      this.#requestIndex.set(streamId, index)
      if (message['body'] === true) this.#openBodies.add(streamId)
      else this.#complete(streamId)
      return
    }
    if (type === 'body-end' && this.#openBodies.delete(streamId)) this.#complete(streamId)
    if (type === 'cancel') this.#cancelled.add(streamId)
  }

  #complete(streamId: string): void {
    const index = this.#requestIndex.get(streamId)
    if (index === undefined) return
    this.#requests.push({ streamId, index })
    for (let at = this.#waiters.length - 1; at >= 0; at -= 1) {
      if (this.#waiters[at].target <= this.#requests.length) {
        this.#waiters.splice(at, 1)[0].settle()
      }
    }
  }
}

/** The children one case's fake spawn handed the bridge. */
interface SpawnRecorder {
  /** Children in spawn order. */
  readonly children: FakeChild[]
  /**
   * Resolves with the child at one position.
   *
   * @param index - Zero-based spawn position.
   * @returns The child, once the bridge has spawned it.
   */
  childAt(index: number): Promise<FakeChild>
  /**
   * The argument vector of one spawn, as the bridge passed it.
   *
   * @param index - Zero-based spawn position.
   * @returns The arguments, or undefined when no child was spawned there.
   */
  argsAt(index: number): readonly string[] | undefined
}

/**
 * Installs the fake spawn for one case and restores the builtin afterwards.
 *
 * Only `spawn` is replaced, and only for this file's process, so the bridge's real
 * `spawnBunChild` path runs against the double. The restore is registered with the case and
 * repeated after the file, so a failure inside the case cannot leave the builtin replaced.
 *
 * @param context - Test context owning the restore.
 * @returns The children the bridge spawns, awaited on demand.
 */
function installFakeSpawn(context: TestContext): SpawnRecorder {
  const children: FakeChild[] = []
  const spawnedArgs: (readonly string[])[] = []
  const waiters: { readonly target: number; readonly settle: (child: FakeChild) => void }[] = []
  const original = childProcessModule.spawn
  childProcessModule.spawn = (_command: string, args: readonly string[], _options: SpawnOptions) => {
    spawnedArgs.push([...args])
    const child = new FakeChild()
    children.push(child)
    for (let at = waiters.length - 1; at >= 0; at -= 1) {
      if (waiters[at].target <= children.length) {
        waiters.splice(at, 1)[0].settle(child)
      }
    }
    return child
  }
  syncBuiltinESMExports()
  const restore = (): void => {
    childProcessModule.spawn = original
    syncBuiltinESMExports()
  }
  context.after(restore)
  return {
    children,
    argsAt(index) {
      return spawnedArgs[index]
    },
    childAt(index) {
      if (children.length > index) return Promise.resolve(children[index])
      return new Promise<FakeChild>((settle, fail) => {
        const timer = setTimeout(() => {
          fail(
            new Error(
              `waited ${WAIT_BOUND_MS}ms for child ${index + 1}; ${children.length} spawned (awaited state: a new Bun child through the transport factory)`,
            ),
          )
        }, WAIT_BOUND_MS)
        waiters.push({
          target: index + 1,
          settle: (child) => {
            clearTimeout(timer)
            settle(child)
          },
        })
      })
    },
  }
}

/** One case's environment edits, undone when the case ends. */
interface ScopedEnv {
  /**
   * Sets one variable for the case.
   *
   * @param name - Variable name.
   * @param value - Value, or undefined to unset it.
   */
  set(name: string, value: string | undefined): void
}

/**
 * Scrubs the variables the transport reads and restores their exact prior state.
 *
 * @param context - Test context owning the restore.
 * @returns The setter for this case.
 */
function scopedEnv(context: TestContext): ScopedEnv {
  const previous = new Map<string, string | undefined>()
  context.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  return {
    set(name, value) {
      if (!previous.has(name)) previous.set(name, process.env[name])
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    },
  }
}

/**
 * Points the transport at a runtime this host has and leaves the bridge enabled.
 *
 * The lifecycle cases never let the spawned command run: `spawn` is replaced, and the
 * override only has to exist for `resolveBunRuntime` to answer.
 *
 * @param context - Test context owning the restore.
 * @returns The environment edits for this case.
 */
function bridgeOnlyEnv(context: TestContext): ScopedEnv {
  const env = scopedEnv(context)
  env.set(BUN_PATH_ENV, process.execPath)
  env.set('DSH_SUBSCRIPTIONS_BRIDGE', undefined)
  env.set('DSH_CLAUDE_PROXY_URL', undefined)
  return env
}

after(async () => {
  childProcessModule.spawn = realSpawn
  syncBuiltinESMExports()
  globalThis.fetch = realFetch
  await stopBridge()
})

beforeEach(async () => {
  // Each case owns the module's shared bridge: a leftover child, and the limit it
  // captured, must not decide the next case's outcome.
  await stopBridge()
  configureClaudeTransport(DEFAULT_MAX_QUEUED_BYTES)
  fallbackUrls.length = 0
})

test('a child that exited is replaced for the next request', { timeout: CASE_BOUND_MS }, async (t) => {
  const recorder = installFakeSpawn(t)
  bridgeOnlyEnv(t)
  fallbackUrls.length = 0

  const first = claudeApiFetch(MESSAGES_URL, { method: 'POST', body: '{"model":"x"}' })
  const childA = await recorder.childAt(0)
  assert.equal(
    recorder.argsAt(0)?.[0],
    '--no-env-file',
    'the child must not load .env files out of the Host working directory',
  )
  await childA.waitForRequest(1)
  childA.exits(7, null)

  await assert.rejects(
    first,
    (error: unknown) => error instanceof BridgeError && error.reason === 'child-exited',
  )
  assert.equal(recorder.children.length, 1, 'a dead child is not replaced until a request needs a child')

  const second = claudeApiFetch(MESSAGES_URL, { method: 'POST', body: '{"model":"x"}' })
  const childB = await recorder.childAt(1)
  await childB.waitForRequest(1)
  childB.answer(200, '{"ok":true}')

  const response = await second
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })

  assert.equal(childA.requests().length, 1, 'the request that failed was never replayed')
  assert.notEqual(
    childB.requests()[0].streamId,
    childA.requests()[0].streamId,
    'the new request owns its own stream',
  )
  assert.deepEqual(fallbackUrls, [], 'no request fell back to the Node transport')

  await stopBridge()
  assert.equal(childB.killed, true, 'teardown terminates the child')
})

test('a start that failed is not remembered', { timeout: CASE_BOUND_MS }, async (t) => {
  const recorder = installFakeSpawn(t)
  const env = bridgeOnlyEnv(t)
  fallbackUrls.length = 0

  env.set(BUN_PATH_ENV, 'C:/deepseek-harness/missing-bun.exe')
  await assert.rejects(claudeApiFetch(MESSAGES_URL, { method: 'POST', body: '{}' }), /points at a missing file/)
  // A repeated failure is re-evaluated rather than replayed from a cache.
  await assert.rejects(claudeApiFetch(MESSAGES_URL, { method: 'POST', body: '{}' }), /points at a missing file/)
  assert.equal(recorder.children.length, 0, 'a runtime that cannot start spawns nothing')

  env.set(BUN_PATH_ENV, process.execPath)
  const request = claudeApiFetch(MESSAGES_URL, { method: 'POST', body: '{}' })
  const child = await recorder.childAt(0)
  await child.waitForRequest(1)
  child.answer(200, '{"ok":true}')
  assert.equal((await request).status, 200, 'the operator remedy takes effect on the next request')

  await stopBridge()
})

test('a limit change is refused while a child is live and accepted once it ended', { timeout: CASE_BOUND_MS }, async (t) => {
  const recorder = installFakeSpawn(t)
  bridgeOnlyEnv(t)
  const raised = DEFAULT_MAX_QUEUED_BYTES + 4096

  const request = claudeApiFetch(MESSAGES_URL, { method: 'POST', body: '{}' })
  const child = await recorder.childAt(0)
  await child.waitForRequest(1)
  assert.throws(() => configureClaudeTransport(raised), /Stop the Claude transport/)
  assert.doesNotThrow(() => configureClaudeTransport(DEFAULT_MAX_QUEUED_BYTES), 'an unchanged limit is not a change')

  child.answer(200, '{}')
  await request
  assert.throws(
    () => configureClaudeTransport(raised),
    /Stop the Claude transport/,
    'a live child still holds the limit it captured',
  )

  child.exits(9, null)
  configureClaudeTransport(raised)
  await stopBridge()
  configureClaudeTransport(DEFAULT_MAX_QUEUED_BYTES)
})

test('concurrent requests share one child and teardown ends it', { timeout: CASE_BOUND_MS }, async (t) => {
  const recorder = installFakeSpawn(t)
  bridgeOnlyEnv(t)
  fallbackUrls.length = 0

  const first = claudeApiFetch(MESSAGES_URL, { method: 'POST', body: '{"a":1}' })
  const second = claudeApiFetch(MESSAGES_URL, { method: 'POST', body: '{"b":2}' })
  const child = await recorder.childAt(0)
  await child.waitForRequest(2)
  assert.equal(recorder.children.length, 1, 'both requests share one startup')

  child.answer(200, '{"first":true}')
  child.answer(200, '{"second":true}')
  assert.deepEqual(await (await first).json(), { first: true })
  assert.deepEqual(await (await second).json(), { second: true })
  assert.deepEqual(fallbackUrls, [])

  await stopBridge()
  assert.equal(child.killed, true, 'teardown terminates the child')

  const third = claudeApiFetch(MESSAGES_URL, { method: 'POST', body: '{}' })
  const next = await recorder.childAt(1)
  await next.waitForRequest(1)
  next.answer(200, '{}')
  assert.equal((await third).status, 200, 'a request after teardown starts a new child')
  await stopBridge()
})

test('an aborted request is not replayed and leaves the child serving', { timeout: CASE_BOUND_MS }, async (t) => {
  const recorder = installFakeSpawn(t)
  bridgeOnlyEnv(t)

  const controller = new AbortController()
  const aborted = claudeApiFetch(MESSAGES_URL, { method: 'POST', body: '{}', signal: controller.signal })
  const child = await recorder.childAt(0)
  await child.waitForRequest(1)
  controller.abort()

  await assert.rejects(
    aborted,
    (error: unknown) => error instanceof BridgeError && error.reason === 'cancelled',
  )
  assert.equal(recorder.children.length, 1, 'an abort starts no second child')
  const cancelled = child
    .frames()
    .some((frame) => frame.tag === 1 && frame.message['type'] === 'cancel')
  assert.equal(cancelled, true, 'the bridge tells the child to abandon the stream it stopped reading')

  const next = claudeApiFetch(MESSAGES_URL, { method: 'POST', body: '{}' })
  await child.waitForRequest(2)
  child.answer(200, '{"ok":true}')
  assert.equal((await next).status, 200, 'the live child keeps serving')
  assert.equal(recorder.children.length, 1, 'the live child was reused, not restarted')
  await stopBridge()
})
