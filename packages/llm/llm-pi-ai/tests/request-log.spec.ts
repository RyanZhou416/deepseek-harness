import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { PiAiRequestDiagnostic } from '../src/adapter.ts'
import { resolveRequestLog } from '../src/config.ts'
import type { PiAiRequestLogProfile } from '../src/config.ts'
import {
  DEFAULT_REQUEST_LOG_MAX_FILE_BYTES,
  DEFAULT_REQUEST_LOG_MAX_FILES,
  MAX_REQUEST_LOG_TOTAL_BYTES,
  redactEndpoint,
  requestLogLine,
  RequestDiagnosticLog,
} from '../src/request-log.ts'
import type { ResolvedRequestLogConfig } from '../src/request-log.ts'
import { createPiAiRequestLog, piAiDiagnosticHooks } from '../src/reuse.ts'

/** A complete request record; optional response facts are added by each case. */
function request(clientRequestId: string): PiAiRequestDiagnostic {
  return {
    kind: 'request',
    provider: 'cc-pool',
    model: 'claude-sonnet-4-6',
    endpoint: 'https://ccpool.test',
    sessionId: 'session-request-log',
    clientRequestId,
    stream: true,
    attempt: 1,
  }
}

/** Resolved bounds over one temporary file, with the caller's overrides. */
function settings(path: string, overrides: Partial<ResolvedRequestLogConfig> = {}): ResolvedRequestLogConfig {
  return { path, maxFileBytes: 1024, maxFiles: 2, allRoutes: true, ...overrides }
}

let root: string | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A fresh owner-private directory for one case. */
async function temporaryRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-request-log-'))
  return root
}

/** Every NDJSON line of one file, parsed. */
async function lines(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('request log records', () => {
  it('persists exactly the diagnostic fields with a timestamp', () => {
    const parsed = JSON.parse(requestLogLine(request('ledger-1'))) as Record<string, unknown>

    expect(Object.keys(parsed).sort()).toEqual([
      'attempt',
      'clientRequestId',
      'endpoint',
      'kind',
      'model',
      'provider',
      'sessionId',
      'stream',
      'ts',
    ].sort())
    expect(parsed).toMatchObject({
      kind: 'request',
      provider: 'cc-pool',
      model: 'claude-sonnet-4-6',
      endpoint: 'https://ccpool.test',
      sessionId: 'session-request-log',
      clientRequestId: 'ledger-1',
      stream: true,
      attempt: 1,
    })
    expect(new Date(parsed['ts'] as string).toISOString()).toBe(parsed['ts'])
  })

  it('adds the settled response facts and omits the ones the attempt lacked', () => {
    const full = JSON.parse(requestLogLine({
      ...request('ledger-2'),
      kind: 'response',
      attempt: 2,
      status: 429,
      poolRequestId: 'pool-request-9',
      code: 'POOL_CAPACITY',
      message: 'all accounts are at their session limit',
      cause: 'Error: fetch failed\nCaused by: connect ECONNREFUSED',
    })) as Record<string, unknown>
    expect(Object.keys(full).sort()).toEqual([
      'attempt', 'clientRequestId', 'code', 'endpoint', 'kind', 'model',
      'poolRequestId', 'provider', 'sessionId', 'status', 'stream', 'ts',
    ].sort())
    // Provider failure text can echo request content, so the durable record
    // carries the stable code only; the process logger keeps the message.
    expect(full).not.toHaveProperty('message')
    expect(full).not.toHaveProperty('cause')

    const minimal = JSON.parse(requestLogLine({ ...request('ledger-3'), kind: 'response' })) as Record<string, unknown>
    expect(Object.keys(minimal).sort()).toEqual([
      'attempt', 'clientRequestId', 'endpoint', 'kind', 'model', 'provider', 'sessionId', 'stream', 'ts',
    ].sort())
    const fixed = JSON.parse(
      requestLogLine({ ...request('ledger-4'), kind: 'response' }, new Date(1_700_000_000_000)),
    ) as Record<string, unknown>
    expect(fixed['ts']).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it('reduces the endpoint to its origin and path', () => {
    const parsed = JSON.parse(requestLogLine({
      ...request('ledger-6'),
      endpoint: 'https://member:pool-secret@ccpool.test/v1/messages?api_key=query-secret&x=1#fragment',
      kind: 'response',
      status: 200,
      message: 'upstream rejected: member:pool-secret and query-secret',
    })) as Record<string, unknown>

    expect(parsed['endpoint']).toBe('https://ccpool.test/v1/messages')
    const text = JSON.stringify(parsed)
    for (const secret of ['member', 'pool-secret', 'api_key', 'query-secret', 'fragment', 'upstream rejected']) {
      expect(text).not.toContain(secret)
    }
  })

  it('projects away content, bodies, credentials, and other foreign fields', () => {
    // A future adapter field must not reach the file even when it carries content.
    const contaminated = Object.assign({}, request('ledger-5'), {
      messages: [{ role: 'user', content: 'secret prompt' }],
      body: '{"messages":[]}',
      token: 'sk-secret',
      cookie: 'session=secret',
      proxyPassword: 'proxy-secret',
      title: 'secret session title',
    })

    const parsed = JSON.parse(requestLogLine(contaminated)) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual([
      'attempt', 'clientRequestId', 'endpoint', 'kind', 'model', 'provider', 'sessionId', 'stream', 'ts',
    ].sort())
    const text = JSON.stringify(parsed)
    for (const secret of ['secret prompt', 'sk-secret', 'session=secret', 'proxy-secret', 'secret session title', '{"messages":[]}']) {
      expect(text).not.toContain(secret)
    }
  })
})

describe('endpoint redaction', () => {
  it.each([
    ['https://ccpool.test', 'https://ccpool.test'],
    ['https://ccpool.test/v1/messages', 'https://ccpool.test/v1/messages'],
    ['https://user:secret@ccpool.test/v1/messages', 'https://ccpool.test/v1/messages'],
    ['https://ccpool.test/v1?token=secret#frag', 'https://ccpool.test/v1'],
    ['https://user@ccpool.test', 'https://ccpool.test'],
    // Only the authority's userinfo is removed: a path keeps its own `@`.
    ['https://ccpool.test/v1/users/@me', 'https://ccpool.test/v1/users/@me'],
  ])('keeps %s as %s', (input, expected) => {
    expect(redactEndpoint(input)).toBe(expected)
  })

  it('strips userinfo and query from a value fetch would refuse', () => {
    // Not URLs, but the durable file still must not outlive a pasted secret.
    expect(redactEndpoint('member:secret@host/v1')).toBe('host/v1')
    expect(redactEndpoint('//member:secret@host/v1')).toBe('//host/v1')
    expect(redactEndpoint('not a url://user:secret@host/path?token=secret'))
      .toBe('not a url://host/path')
  })

  it('never emits a placeholder origin for a non-special scheme', () => {
    // `URL.origin` is the string `null` for these schemes, which must not
    // replace the route's own authority.
    expect(redactEndpoint('custom://member:secret@host/v1')).toBe('custom://host/v1')
    expect(redactEndpoint('custom://member:secret@host')).toBe('custom://host')
  })
})

describe('fixed-route request log', () => {
  it('follows session headers by default and requires a real setting when opted out', async () => {
    const home = await temporaryRoot()
    vi.stubEnv('DSH_HOME', home)
    const warn = vi.fn()

    // The pi-ai plugin's own rule: a session-header route persists by default.
    const implicit = createPiAiRequestLog({
      config: undefined,
      sessionHeaders: new Set(['cc-pool']),
      warn,
    })
    expect(implicit).toBeDefined()
    await implicit?.close()

    // A fixed-route plugin opts out: no configuration means no sink. The loader
    // materializes an absent nested object as `{}`, and that profile carries no
    // setting, so it must not turn the sink on either.
    expect(createPiAiRequestLog({
      config: undefined,
      sessionHeaders: new Set(['cc-pool']),
      warn,
      implicit: false,
    })).toBeUndefined()
    expect(createPiAiRequestLog({
      config: {},
      sessionHeaders: new Set(['cc-pool']),
      warn,
      implicit: false,
    })).toBeUndefined()

    // One real setting turns it back on, at the plugin's own default.
    const explicit = createPiAiRequestLog({
      config: { enabled: true },
      sessionHeaders: new Set(['cc-pool']),
      warn,
      implicit: false,
      defaultPath: join(home, 'logs', 'llm-cc-pool-requests.jsonl'),
    })
    expect(explicit).toBeDefined()
    await explicit?.close()

    // pi-ai's own default is unchanged: the same empty profile still follows
    // its session headers.
    const implicitEmpty = createPiAiRequestLog({
      config: {},
      sessionHeaders: new Set(['cc-pool']),
      warn,
    })
    expect(implicitEmpty).toBeDefined()
    await implicitEmpty?.close()
  })
})

describe('retained-route process log', () => {
  /** A logger double; the hooks only write through it. */
  function logger(): {
    debug: Mock<(line: string, fields: object) => void>
    info: Mock<(line: string, fields: object) => void>
    warn: Mock<(line: string, fields?: object) => void>
  } {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
  }

  it('redacts the endpoint and drops provider failure text for a retained route', () => {
    const sink = logger()
    const appended: PiAiRequestDiagnostic[] = []
    const hooks = piAiDiagnosticHooks({
      label: 'llm-cc-pool',
      retainedRoutes: new Set(['cc-pool']),
      logger: sink,
      append: (event) => { appended.push(event) },
    })
    const event: PiAiRequestDiagnostic = {
      kind: 'response',
      provider: 'cc-pool',
      model: 'claude-sonnet-4-6',
      endpoint: 'https://member:pool-secret@ccpool.test/v1/messages?api_key=query-secret',
      stream: true,
      status: 529,
      poolRequestId: 'pool-request-1',
      code: 'POOL_ERROR',
      message: 'provider echoed member:pool-secret',
      cause: 'Error: connect ECONNREFUSED',
    }

    hooks.onRequestDiagnostic?.(event)

    expect(sink.warn).toHaveBeenCalledTimes(1)
    const [line, fields] = sink.warn.mock.calls[0] as [string, Record<string, unknown>]
    expect(line).toContain('model request failed')
    expect(fields).toMatchObject({
      endpoint: 'https://ccpool.test/v1/messages',
      status: 529,
      poolRequestId: 'pool-request-1',
      code: 'POOL_ERROR',
    })
    expect(fields).not.toHaveProperty('message')
    expect(fields).not.toHaveProperty('cause')
    const text = JSON.stringify(fields)
    for (const secret of ['member', 'pool-secret', 'api_key', 'query-secret', 'provider echoed', 'ECONNREFUSED']) {
      expect(text).not.toContain(secret)
    }
    // The durable sink owns its own projection; the process log is the only copy redacted here.
    expect(appended[0]).toBe(event)
  })

  it('redacts a retained request line and keeps it at INFO', () => {
    const sink = logger()
    const hooks = piAiDiagnosticHooks({ label: 'llm-cc-pool', retainedRoutes: new Set(['cc-pool']), logger: sink })

    hooks.onRequestDiagnostic?.({
      kind: 'request',
      provider: 'cc-pool',
      model: 'claude-sonnet-4-6',
      endpoint: 'https://user:secret@ccpool.test/v1?token=secret',
      sessionId: 'session-1',
      clientRequestId: 'ledger-1',
      stream: true,
      attempt: 1,
    })

    expect(sink.info).toHaveBeenCalledTimes(1)
    const [line, fields] = sink.info.mock.calls[0] as [string, Record<string, unknown>]
    expect(line).toContain('model request')
    expect(fields).toMatchObject({ endpoint: 'https://ccpool.test/v1', sessionId: 'session-1', attempt: 1 })
    expect(JSON.stringify(fields)).not.toContain('secret')
  })

  it('keeps the live failure text and endpoint on a route the durable sink does not retain', () => {
    const sink = logger()
    const hooks = piAiDiagnosticHooks({ label: 'llm-pi-ai', retainedRoutes: new Set(['cc-pool']), logger: sink })

    hooks.onRequestDiagnostic?.({
      kind: 'response',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      endpoint: 'https://member:secret@api.test/v1',
      stream: true,
      code: 'SERVER',
      message: 'overloaded',
      cause: 'Error: connect',
    })
    hooks.onRequestDiagnostic?.({
      kind: 'request',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      endpoint: 'https://member:secret@api.test/v1',
      stream: true,
    })

    const [, failureFields] = sink.warn.mock.calls[0] as [string, Record<string, unknown>]
    expect(failureFields).toMatchObject({ message: 'overloaded', cause: 'Error: connect' })
    const [, requestFields] = sink.debug.mock.calls[0] as [string, Record<string, unknown>]
    expect(requestFields['endpoint']).toBe('https://member:secret@api.test/v1')
  })
})

describe('request log resolution', () => {
  it('persists session-header routes by default below the harness home', async () => {
    const home = await temporaryRoot()
    vi.stubEnv('DSH_HOME', home)

    expect(resolveRequestLog(undefined, new Set(['cc-pool']))).toEqual({
      path: join(home, 'logs', 'llm-pi-ai-requests.jsonl'),
      maxFileBytes: DEFAULT_REQUEST_LOG_MAX_FILE_BYTES,
      maxFiles: DEFAULT_REQUEST_LOG_MAX_FILES,
      allRoutes: false,
    })
    expect(resolveRequestLog(undefined, new Set())).toBeUndefined()
  })

  it('lets an explicit switch disable or widen persistence', async () => {
    const home = await temporaryRoot()
    vi.stubEnv('DSH_HOME', home)
    expect(resolveRequestLog({ enabled: false, path: 'requests.jsonl' }, new Set(['cc-pool']))).toBeUndefined()
    expect(resolveRequestLog({ enabled: true }, new Set())).toMatchObject({
      path: join(home, 'logs', 'llm-pi-ai-requests.jsonl'),
      allRoutes: true,
    })
    expect(resolveRequestLog({ path: 'requests.jsonl' }, new Set(['cc-pool']))).toMatchObject({
      path: 'requests.jsonl',
      allRoutes: false,
    })
    expect(resolveRequestLog({ path: 'requests.jsonl', enabled: true }, new Set(['cc-pool']))).toMatchObject({
      path: 'requests.jsonl',
      allRoutes: true,
    })
  })

  it('lets a fixed-route plugin name its own default file', async () => {
    const home = await temporaryRoot()
    vi.stubEnv('DSH_HOME', home)
    expect(resolveRequestLog(undefined, new Set(['cc-pool']), join(home, 'logs', 'llm-cc-pool-requests.jsonl')))
      .toMatchObject({ path: join(home, 'logs', 'llm-cc-pool-requests.jsonl') })
    expect(resolveRequestLog({}, new Set(['cc-pool']), 'pool.jsonl'))
      .toMatchObject({ path: 'pool.jsonl' })
    // An explicit path still wins over the plugin's default.
    expect(resolveRequestLog({ path: 'configured.jsonl' }, new Set(['cc-pool']), 'pool.jsonl'))
      .toMatchObject({ path: 'configured.jsonl' })
  })

  it('keeps the retained set within the total bound', () => {
    const bounded = resolveRequestLog({ path: 'requests.jsonl', maxFileBytes: 64 * 1024 * 1024, maxFiles: 8 }, new Set(['cc-pool']))
    // 128 MiB / 64 MiB leaves room for two files, not the configured eight.
    expect(bounded).toMatchObject({ maxFileBytes: 64 * 1024 * 1024, maxFiles: 2 })

    const oversize = resolveRequestLog({ path: 'requests.jsonl', maxFileBytes: 256 * 1024 * 1024, maxFiles: 8 }, new Set(['cc-pool']))
    expect(oversize).toMatchObject({ maxFileBytes: MAX_REQUEST_LOG_TOTAL_BYTES, maxFiles: 1 })

    const configured = resolveRequestLog({ path: 'requests.jsonl', maxFileBytes: 1024, maxFiles: 3 }, new Set(['cc-pool']))
    expect(configured).toMatchObject({ maxFileBytes: 1024, maxFiles: 3 })
    expect(Object.isFrozen(configured)).toBe(true)
  })

  it.each<[string, PiAiRequestLogProfile]>([
    ['requestLog.path must be a non-empty file path', { path: '' }],
    ['requestLog.maxFileBytes must be a positive integer', { path: 'requests.jsonl', maxFileBytes: 0 }],
    ['requestLog.maxFileBytes must be a positive integer', { path: 'requests.jsonl', maxFileBytes: 1.5 }],
    ['requestLog.maxFiles must be a positive integer', { path: 'requests.jsonl', maxFiles: 0 }],
  ])('refuses an unusable bound: %s', (message, value) => {
    expect(() => resolveRequestLog(value, new Set(['cc-pool']))).toThrow(message)
  })
})

describe('request log files', () => {
  it.skipIf(process.platform === 'win32')('repairs an existing file whose permissions reach beyond its owner', async () => {
    const home = await temporaryRoot()
    const path = join(home, 'logs', 'requests.jsonl')
    await mkdir(join(home, 'logs'), { recursive: true })
    await writeFile(path, '')
    await chmod(path, 0o644)

    const log = new RequestDiagnosticLog(settings(path), vi.fn())
    log.append(request('ledger-1'))
    await log.close()

    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await lines(path)).map(record => record['clientRequestId'])).toEqual(['ledger-1'])
  })

  it('appends one NDJSON line per record and protects the file', async () => {
    const home = await temporaryRoot()
    const path = join(home, 'logs', 'requests.jsonl')
    const log = new RequestDiagnosticLog(settings(path), vi.fn())

    log.append(request('ledger-1'))
    log.append({ ...request('ledger-1'), kind: 'response', status: 200 })
    await log.close()

    const records = await lines(path)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ kind: 'request', clientRequestId: 'ledger-1' })
    expect(records[1]).toMatchObject({ kind: 'response', clientRequestId: 'ledger-1', status: 200 })
    if (process.platform !== 'win32') {
      expect((await stat(join(home, 'logs'))).mode & 0o777).toBe(0o700)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  })

  it('rotates at the file bound and drops the oldest rotation first', async () => {
    const home = await temporaryRoot()
    const path = join(home, 'requests.jsonl')
    const oneLine = Buffer.byteLength(requestLogLine(request('id-0')))
    const log = new RequestDiagnosticLog(settings(path, { maxFileBytes: oneLine + 10, maxFiles: 3 }), vi.fn())

    for (let index = 0; index < 5; index += 1) log.append(request(`id-${index}`))
    await log.close()

    expect((await readdir(home)).sort()).toEqual(['requests.jsonl', 'requests.jsonl.1', 'requests.jsonl.2'])
    expect((await lines(path)).map(record => record['clientRequestId'])).toEqual(['id-4'])
    expect((await lines(`${path}.1`)).map(record => record['clientRequestId'])).toEqual(['id-3'])
    expect((await lines(`${path}.2`)).map(record => record['clientRequestId'])).toEqual(['id-2'])
    for (const file of [path, `${path}.1`, `${path}.2`]) {
      expect((await stat(file)).size).toBeLessThanOrEqual(oneLine + 10)
    }
  })

  it('keeps several records in one file before rotating', async () => {
    const home = await temporaryRoot()
    const path = join(home, 'requests.jsonl')
    const oneLine = Buffer.byteLength(requestLogLine(request('id-0')))
    const log = new RequestDiagnosticLog(settings(path, { maxFileBytes: oneLine * 3, maxFiles: 2 }), vi.fn())

    for (let index = 0; index < 6; index += 1) log.append(request(`id-${index}`))
    await log.close()

    expect((await lines(path)).map(record => record['clientRequestId'])).toEqual(['id-3', 'id-4', 'id-5'])
    expect((await lines(`${path}.1`)).map(record => record['clientRequestId'])).toEqual(['id-0', 'id-1', 'id-2'])
  })

  it('restarts a single-file rotation instead of retaining a rotation', async () => {
    const home = await temporaryRoot()
    const path = join(home, 'requests.jsonl')
    const oneLine = Buffer.byteLength(requestLogLine(request('id-0')))
    const log = new RequestDiagnosticLog(settings(path, { maxFileBytes: oneLine + 10, maxFiles: 1 }), vi.fn())

    for (let index = 0; index < 3; index += 1) log.append(request(`id-${index}`))
    await log.close()

    expect((await readdir(home)).sort()).toEqual(['requests.jsonl'])
    expect((await lines(path)).map(record => record['clientRequestId'])).toEqual(['id-2'])
  })

  it('accounts for a file that already exists before the first append', async () => {
    const home = await temporaryRoot()
    const path = join(home, 'requests.jsonl')
    const oneLine = Buffer.byteLength(requestLogLine(request('old-0')))
    await writeFile(path, requestLogLine(request('old-0')).repeat(4))
    const log = new RequestDiagnosticLog(settings(path, { maxFileBytes: oneLine + 10, maxFiles: 2 }), vi.fn())

    log.append(request('new'))
    await log.close()

    expect((await lines(path)).map(record => record['clientRequestId'])).toEqual(['new'])
    expect(await lines(`${path}.1`)).toHaveLength(4)
  })

  it('reports the first write failure once and keeps requests unaffected', async () => {
    const home = await temporaryRoot()
    const blocker = join(home, 'blocker')
    await writeFile(blocker, 'not a directory')
    const warn = vi.fn()
    const log = new RequestDiagnosticLog(settings(join(blocker, 'requests.jsonl')), warn)

    expect(() => {
      log.append(request('first'))
      log.append(request('second'))
      log.append(request('third'))
    }).not.toThrow()
    await log.close()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('cannot be written')
    expect(warn.mock.calls[0]?.[0]).toContain('blocker')
  })

  it('reports an unusable path once and keeps requests unaffected', async () => {
    const home = await temporaryRoot()
    const warn = vi.fn()
    // The path cannot even be inspected, so the writer's first failure is
    // reported and later records stay silent.
    const log = new RequestDiagnosticLog(settings(join(home, 'requests\u0000.jsonl')), warn)

    log.append(request('first'))
    log.append(request('second'))
    await log.close()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('cannot be written')
  })

  it('reports a rotation failure without rejecting the queued write', async () => {
    const home = await temporaryRoot()
    const path = join(home, 'requests.jsonl')
    const oneLine = Buffer.byteLength(requestLogLine(request('old')))
    await writeFile(path, 'x'.repeat(oneLine + 10))
    // A non-empty directory cannot be unlinked, so the oldest rotation cannot move.
    await mkdir(`${path}.1`)
    await writeFile(join(`${path}.1`, 'keep'), 'keep')
    const warn = vi.fn()
    const log = new RequestDiagnosticLog(settings(path, { maxFileBytes: oneLine + 10, maxFiles: 2 }), warn)

    log.append(request('new'))
    await log.close()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(existsSync(`${path}.1/keep`)).toBe(true)
  })

  it('stops accepting records once closed', async () => {
    const home = await temporaryRoot()
    const path = join(home, 'requests.jsonl')
    const log = new RequestDiagnosticLog(settings(path), vi.fn())

    await log.close()
    log.append(request('late'))
    await log.close()

    expect(existsSync(path)).toBe(false)
  })
})
