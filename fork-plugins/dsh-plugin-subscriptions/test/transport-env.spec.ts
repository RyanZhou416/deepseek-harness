/**
 * The transport child's runtime environment and TLS verification defaults.
 *
 * Every case runs the pinned Bun runtime against synthetic inputs only: a temporary working
 * directory carrying `.env` sentinels, and a loopback TLS server on an ephemeral port whose
 * certificate is a repository fixture. Nothing contacts a provider, an account or a
 * non-loopback address, and each case skips when this host never installed the declared
 * platform package.
 *
 * The assertions name the runtime's measured behaviour, not an expectation copied from another
 * runtime: where Bun differs from Node, the case records the divergence instead of demanding
 * agreement.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { childEnvironment, spawnBunChild } from '../src/transport/bridge.js'
import { BunRuntimeError, resolveBunRuntime } from '../src/transport/bun-runtime.js'

/** Bound for one probe process, above every await inside it. */
const PROBE_BOUND_MS = 60_000

/** Case budget, above the probe bound so a stalled probe reports its own failure. */
const CASE_BOUND_MS = 90_000

/** The variables a case must not inherit from this process: they decide trust, not speed. */
const SCRUBBED = [
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
  'DSH_P22_ENV_SENTINEL', 'DSH_P22_ENV_SENTINEL_BASE',
] as const

const HERE = dirname(fileURLToPath(import.meta.url))

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

/** The fixtures this file owns, wherever the compiled test tree put it. */
const FIXTURES = join(findPluginRoot(HERE), 'test', 'fixtures')
const ENV_PROBE = join(FIXTURES, 'env', 'probe-env.mjs')
const TLS_PROBE = join(FIXTURES, 'tls', 'probe-tls.mjs')

/**
 * The pinned runtime, or a skip when this host did not install it.
 *
 * @param context - Test context that records the skip.
 * @returns The executable path, or undefined when the case cannot run here.
 */
function bunOrSkip(context: TestContext): string | undefined {
  try {
    return resolveBunRuntime()
  } catch (error) {
    if (error instanceof BunRuntimeError) {
      context.skip(`no pinned Bun runtime on this host: ${error.message}`)
      return undefined
    }
    throw error
  }
}

/**
 * The child environment this case runs with: the allowlist, minus every ambient choice.
 *
 * The TLS and proxy names are removed before the allowlist runs, so a developer machine's own
 * proxy or trust anchor cannot decide what the fixture observes.
 *
 * @returns The environment for a probe process.
 */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of SCRUBBED) delete env[name]
  return childEnvironment(env)
}

/**
 * Runs one probe process and returns its streams.
 *
 * @param bun - Runtime executable.
 * @param args - Arguments, including the probe entry.
 * @param cwd - Working directory whose `.env` family the runtime may load.
 * @param env - Environment for the child.
 * @returns Exit code and captured output.
 */
async function runBun(
  bun: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly code: number | null; readonly out: string; readonly err: string }> {
  return await new Promise((settle, fail) => {
    // A synchronous spawn throw rejects this executor before the timer exists, so no timer can
    // outlive the rejection. Every other failure path is recorded and settled from `close`, which
    // joins the child before a caller's cleanup removes the directory it was reading.
    const child = spawn(bun, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    let failure: Error | undefined
    const timer = setTimeout(() => {
      failure ??= new Error(`the probe did not exit within ${PROBE_BOUND_MS}ms`)
      child.kill()
    }, PROBE_BOUND_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { out += chunk })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { err += chunk })
    // A spawn `error` is followed by `close`, so recording it here still joins the child first.
    child.on('error', (error) => {
      failure ??= error
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (failure !== undefined) fail(failure)
      else settle({ code, out: out.trim(), err: err.trim() })
    })
  })
}

/**
 * Reads one field out of a parsed probe line.
 *
 * @param value - Parsed JSON value.
 * @param key - Field name.
 * @returns The raw field, or undefined when the value is not an object or lacks the field.
 */
function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return Reflect.get(value, key)
}

/**
 * Reads one string field, treating any other present value as absent.
 *
 * @param value - Parsed JSON value.
 * @param key - Field name.
 * @returns The string, or null.
 */
function textOf(value: unknown, key: string): string | null {
  const found = fieldOf(value, key)
  return typeof found === 'string' ? found : null
}

/**
 * Reads one boolean field, treating any other present value as absent.
 *
 * @param value - Parsed JSON value.
 * @param key - Field name.
 * @returns The boolean, or null.
 */
function boolOf(value: unknown, key: string): boolean | null {
  const found = fieldOf(value, key)
  return typeof found === 'boolean' ? found : null
}

/**
 * Parses the probe's last output line.
 *
 * @param text - Captured stdout.
 * @returns The parsed value.
 */
function lastLine(text: string): unknown {
  const line = text.split(/\r?\n/).filter(Boolean).pop()
  assert.ok(line !== undefined, `the probe printed nothing: ${text}`)
  const parsed: unknown = JSON.parse(line)
  return parsed
}

/**
 * Creates a temporary working directory the case removes when it ends.
 *
 * @param context - Test context owning the cleanup.
 * @returns The directory path.
 */
function scratchDir(context: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-transport-env-'))
  context.after(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

/** A loopback TLS server the case closes when it ends. */
interface FixtureServer {
  /** The ephemeral port the server bound. */
  readonly port: number
  /** Closes the server and waits for its connections. */
  close(): Promise<void>
}

/**
 * Starts one loopback TLS server with a repository fixture certificate.
 *
 * @param context - Test context owning the cleanup.
 * @param name - Fixture base name under `test/fixtures/tls`.
 * @returns The bound server.
 */
async function startTlsServer(context: TestContext, name: string): Promise<FixtureServer> {
  const server = createServer(
    {
      key: readFileSync(join(FIXTURES, 'tls', `${name}.key`)),
      cert: readFileSync(join(FIXTURES, 'tls', `${name}.crt`)),
    },
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('fixture')
    },
  )
  const close = async (): Promise<void> => {
    server.closeAllConnections()
    await new Promise<void>((settle) => { server.close(() => settle()) })
  }
  // Registered before the bind so a listen failure still reaches the same cleanup; a server that
  // never listened holds no port, and `close` reports that case through its callback.
  context.after(close)
  await new Promise<void>((settle, fail) => {
    server.once('error', fail)
    server.listen({ host: '127.0.0.1', port: 0 }, settle)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the fixture did not bind a port')
  return { port: address.port, close }
}

/**
 * Fetches one loopback URL with the pinned runtime.
 *
 * @param bun - Runtime executable.
 * @param port - Loopback port.
 * @param cwd - Working directory for the probe process.
 * @param env - Environment for the probe process.
 * @returns The probe's parsed JSON report.
 */
async function tlsOutcome(
  bun: string,
  port: number,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const run = await runBun(bun, [TLS_PROBE, `https://127.0.0.1:${String(port)}/`], cwd, env)
  assert.equal(run.code, 0, `the TLS probe exited ${String(run.code)}: ${run.err}`)
  return lastLine(run.out)
}

/**
 * Runs one probe entry through the transport's own spawn wrapper.
 *
 * @param bun - Runtime executable.
 * @param args - Arguments, including the probe entry.
 * @param cwd - Working directory for the child.
 * @returns The probe's parsed JSON report.
 */
async function throughSpawnChild(bun: string, args: readonly string[], cwd: string): Promise<unknown> {
  const child = spawnBunChild({ command: bun, args, cwd })
  let out = ''
  const decoder = new TextDecoder()
  child.onData((chunk) => { out += decoder.decode(chunk, { stream: true }) })
  await new Promise<void>((settle, fail) => {
    // The wrapper reports a spawn error and an exit through the same callback, so a recorded
    // failure is raised only once the child is gone and the scratch directory is safe to remove.
    let failure: Error | undefined
    const timer = setTimeout(() => {
      failure ??= new Error(`the wrapped probe did not exit within ${PROBE_BOUND_MS}ms`)
      child.kill()
    }, PROBE_BOUND_MS)
    child.onExit(() => {
      clearTimeout(timer)
      if (failure !== undefined) fail(failure)
      else settle()
    })
  })
  return lastLine(out)
}

test('the child runtime loads .env from its working directory and --no-env-file suppresses it', { timeout: CASE_BOUND_MS }, async (t) => {
  const bun = bunOrSkip(t)
  if (bun === undefined) return
  const cwd = scratchDir(t)
  writeFileSync(join(cwd, '.env'), readFileSync(join(FIXTURES, 'env', 'dotenv.sentinel'), 'utf8'))
  writeFileSync(join(cwd, '.env.local'), readFileSync(join(FIXTURES, 'env', 'dotenv-local.sentinel'), 'utf8'))

  const loaded = await runBun(bun, [ENV_PROBE], cwd, baseEnv())
  assert.equal(loaded.code, 0, loaded.err)
  const auto = lastLine(loaded.out)
  assert.equal(textOf(auto, 'sentinelBase'), 'base-file', 'the .env beside the working directory must reach the child')
  assert.equal(textOf(auto, 'sentinel'), 'from-dotenv-local', '.env.local overrides .env')

  const suppressed = await runBun(bun, ['--no-env-file', ENV_PROBE], cwd, baseEnv())
  assert.equal(suppressed.code, 0, suppressed.err)
  const flagged = lastLine(suppressed.out)
  assert.equal(textOf(flagged, 'sentinel'), null, '--no-env-file must suppress .env.local too')
  assert.equal(textOf(flagged, 'sentinelBase'), null, '--no-env-file must suppress .env')
})

test('the transport spawn wrapper closes the .env channel the environment allowlist cannot', { timeout: CASE_BOUND_MS }, async (t) => {
  const bun = bunOrSkip(t)
  if (bun === undefined) return
  const cwd = scratchDir(t)
  writeFileSync(join(cwd, '.env'), readFileSync(join(FIXTURES, 'env', 'dotenv-insecure.sentinel'), 'utf8'))

  const restore = new Map<string, string | undefined>()
  for (const name of ['DSH_P22_ENV_SENTINEL', 'NODE_TLS_REJECT_UNAUTHORIZED'] as const) {
    restore.set(name, process.env[name])
  }
  process.env.DSH_P22_ENV_SENTINEL = 'from-parent-process'
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  t.after(() => {
    for (const [name, value] of restore) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  // The allowlist drops both names, so only the file beside the child's working directory can
  // supply them. This control shows the allowlist alone is not the boundary.
  const unfiltered = await throughSpawnChild(bun, [ENV_PROBE], cwd)
  assert.equal(textOf(unfiltered, 'sentinel'), 'from-insecure-dotenv', 'the .env file reaches a child started without the flag')
  assert.equal(textOf(unfiltered, 'tlsReject'), '0', 'the .env file reaches a child started without the flag')

  const filtered = await throughSpawnChild(bun, ['--no-env-file', ENV_PROBE], cwd)
  assert.equal(textOf(filtered, 'sentinel'), null, 'the launch flag keeps the dropped name out')
  assert.equal(textOf(filtered, 'tlsReject'), null, 'NODE_TLS_REJECT_UNAUTHORIZED cannot arrive through a file or the parent environment')
  assert.equal(textOf(filtered, 'extraCa'), null)
  assert.equal(textOf(filtered, 'sslCertFile'), null)
})

test('the pinned runtime verifies certificates by default', { timeout: CASE_BOUND_MS }, async (t) => {
  const bun = bunOrSkip(t)
  if (bun === undefined) return
  const cwd = scratchDir(t)
  const server = await startTlsServer(t, 'server')

  const report = await tlsOutcome(bun, server.port, cwd, baseEnv())
  assert.equal(boolOf(report, 'ok'), false, 'a certificate from an untrusted CA must be rejected')
  assert.equal(textOf(report, 'code'), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
})

test('SSL_CERT_FILE and NODE_EXTRA_CA_CERTS each add the fixture CA', { timeout: CASE_BOUND_MS }, async (t) => {
  const bun = bunOrSkip(t)
  if (bun === undefined) return
  const cwd = scratchDir(t)
  const server = await startTlsServer(t, 'server')
  const ca = join(FIXTURES, 'tls', 'ca.crt')

  for (const name of ['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'] as const) {
    const report = await tlsOutcome(bun, server.port, cwd, { ...baseEnv(), [name]: ca })
    assert.equal(boolOf(report, 'ok'), true, `${name} must make the fixture CA trusted`)
    assert.equal(fieldOf(report, 'status'), 200)
  }
})

test('SSL_CERT_DIR trusts a rehashed directory and ignores plain PEM files', { timeout: CASE_BOUND_MS }, async (t) => {
  const bun = bunOrSkip(t)
  if (bun === undefined) return
  const cwd = scratchDir(t)
  const server = await startTlsServer(t, 'server')

  const rehashed = await tlsOutcome(bun, server.port, cwd, { ...baseEnv(), SSL_CERT_DIR: join(FIXTURES, 'tls', 'hashed') })
  assert.equal(boolOf(rehashed, 'ok'), true, 'a subject-hash named file is what this variable reads')

  const plain = await tlsOutcome(bun, server.port, cwd, { ...baseEnv(), SSL_CERT_DIR: join(FIXTURES, 'tls') })
  assert.equal(boolOf(plain, 'ok'), false, 'a directory of plainly named PEM files is not a trust store')
})

test('a certificate for another hostname is rejected while its CA is trusted', { timeout: CASE_BOUND_MS }, async (t) => {
  const bun = bunOrSkip(t)
  if (bun === undefined) return
  const cwd = scratchDir(t)
  const server = await startTlsServer(t, 'mismatch')

  const report = await tlsOutcome(bun, server.port, cwd, {
    ...baseEnv(),
    SSL_CERT_FILE: join(FIXTURES, 'tls', 'ca.crt'),
  })
  assert.equal(boolOf(report, 'ok'), false, 'a trusted chain does not excuse a wrong identity')
  assert.equal(textOf(report, 'code'), 'ERR_TLS_CERT_ALTNAME_INVALID')
})

test('a self-signed server certificate is trusted only when its CA file is configured', { timeout: CASE_BOUND_MS }, async (t) => {
  const bun = bunOrSkip(t)
  if (bun === undefined) return
  const cwd = scratchDir(t)
  const server = await startTlsServer(t, 'selfsigned')

  const untrusted = await tlsOutcome(bun, server.port, cwd, baseEnv())
  assert.equal(boolOf(untrusted, 'ok'), false)
  assert.equal(textOf(untrusted, 'code'), 'DEPTH_ZERO_SELF_SIGNED_CERT')

  const trusted = await tlsOutcome(bun, server.port, cwd, {
    ...baseEnv(),
    NODE_EXTRA_CA_CERTS: join(FIXTURES, 'tls', 'selfsigned.crt'),
  })
  assert.equal(boolOf(trusted, 'ok'), true, 'the variable the DSH guide names covers this shape on the pinned runtime')
})
