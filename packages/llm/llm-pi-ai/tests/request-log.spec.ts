import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PiAiRequestDiagnostic } from '../src/adapter.ts'
import { resolveRequestLog } from '../src/config.ts'
import type { PiAiRequestLogProfile } from '../src/config.ts'
import {
  DEFAULT_REQUEST_LOG_MAX_FILE_BYTES,
  DEFAULT_REQUEST_LOG_MAX_FILES,
  MAX_REQUEST_LOG_TOTAL_BYTES,
  requestLogLine,
  RequestDiagnosticLog,
} from '../src/request-log.ts'
import type { ResolvedRequestLogConfig } from '../src/request-log.ts'

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
      'attempt', 'cause', 'clientRequestId', 'code', 'endpoint', 'kind', 'message',
      'model', 'poolRequestId', 'provider', 'sessionId', 'status', 'stream', 'ts',
    ].sort())

    const minimal = JSON.parse(requestLogLine({ ...request('ledger-3'), kind: 'response' })) as Record<string, unknown>
    expect(Object.keys(minimal).sort()).toEqual([
      'attempt', 'clientRequestId', 'endpoint', 'kind', 'model', 'provider', 'sessionId', 'stream', 'ts',
    ].sort())
    const fixed = JSON.parse(
      requestLogLine({ ...request('ledger-4'), kind: 'response' }, new Date(1_700_000_000_000)),
    ) as Record<string, unknown>
    expect(fixed['ts']).toBe(new Date(1_700_000_000_000).toISOString())
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
