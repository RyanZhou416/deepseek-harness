import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installFrpc } from '../../src/frpc-download.ts'
import { buildZip } from './helpers/archives.ts'
import { startHttpServer } from './helpers/test-server.ts'

const BINARY = Buffer.from('fake-frpc-executable')
const ARCHIVE = buildZip([{ name: 'frp_0.71.0_windows_amd64/frpc.exe', data: BINARY, deflate: true }])
const HASH = createHash('sha256').update(ARCHIVE).digest('hex')

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function serveArchive(options: { status?: number; delayMs?: number } = {}) {
  let requests = 0
  const server = await startHttpServer((_request, response) => {
    requests += 1
    const send = (): void => {
      response.writeHead(options.status ?? 200, {
        'content-type': 'application/octet-stream',
        'content-length': String(ARCHIVE.length),
      })
      response.end(ARCHIVE)
    }
    if (options.delayMs === undefined) send()
    else setTimeout(send, options.delayMs)
  })
  return { server, requests: () => requests, base: `http://127.0.0.1:${String(server.port)}` }
}

describe('frpc installation', () => {
  it('verifies the archive, extracts it, and reuses the marker', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-relay-download-'))
    const served = await serveArchive()
    try {
      const progress: number[] = []
      const installed = await installFrpc({
        version: '0.71.0',
        platform: 'win32',
        arch: 'x64',
        hashes: { '0.71.0/win32-x64': HASH },
        home: root,
        timeoutMs: 2_000,
        downloadBaseUrl: served.base,
        fetchImpl: fetch,
        onProgress: received => progress.push(received),
      })
      expect(installed.downloaded).toBe(true)
      expect(installed.path).toBe(join(root, 'dsh-relay', 'bin', 'frpc.exe'))
      expect((await readFile(installed.path)).equals(BINARY)).toBe(true)
      expect(progress.at(-1)).toBe(ARCHIVE.length)
      expect(served.requests()).toBe(1)
      if (process.platform !== 'win32') {
        expect((await stat(installed.path)).mode & 0o777).toBe(0o700)
      }

      const reused = await installFrpc({
        version: '0.71.0',
        platform: 'win32',
        arch: 'x64',
        hashes: { '0.71.0/win32-x64': HASH },
        home: root,
        timeoutMs: 2_000,
        downloadBaseUrl: served.base,
      })
      expect(reused.downloaded).toBe(false)
      expect(served.requests()).toBe(1)
    } finally {
      await served.server.close()
    }
  })

  it('refuses an archive whose hash does not match', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-relay-download-'))
    const served = await serveArchive()
    try {
      await expect(installFrpc({
        version: '0.71.0',
        platform: 'win32',
        arch: 'x64',
        hashes: { '0.71.0/win32-x64': 'f'.repeat(64) },
        home: root,
        timeoutMs: 2_000,
        downloadBaseUrl: served.base,
      })).rejects.toMatchObject({ code: 'frpc-hash-mismatch' })
      await expect(stat(join(root, 'dsh-relay', 'bin', 'frpc.exe'))).rejects.toThrow()
    } finally {
      await served.server.close()
    }
  })

  it('refuses an unpinned release', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-relay-download-'))
    await expect(installFrpc({
      version: '9.9.9',
      platform: 'win32',
      arch: 'x64',
      hashes: { '0.71.0/win32-x64': HASH },
      home: root,
      timeoutMs: 2_000,
    })).rejects.toMatchObject({ code: 'frpc-unsupported' })
  })

  it('reports a failed download', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-relay-download-'))
    const served = await serveArchive({ status: 404 })
    try {
      await expect(installFrpc({
        version: '0.71.0',
        platform: 'win32',
        arch: 'x64',
        hashes: { '0.71.0/win32-x64': HASH },
        home: root,
        timeoutMs: 2_000,
        downloadBaseUrl: served.base,
      })).rejects.toMatchObject({ code: 'frpc-download-failed' })
    } finally {
      await served.server.close()
    }
  })

  it('reports a download timeout', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-relay-download-'))
    const served = await serveArchive({ delayMs: 500 })
    try {
      await expect(installFrpc({
        version: '0.71.0',
        platform: 'win32',
        arch: 'x64',
        hashes: { '0.71.0/win32-x64': HASH },
        home: root,
        timeoutMs: 30,
        downloadBaseUrl: served.base,
      })).rejects.toMatchObject({ code: 'network-timeout' })
    } finally {
      await served.server.close()
    }
  })

  it('refuses a platform with no release asset', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-relay-download-'))
    await expect(installFrpc({
      version: '0.71.0',
      platform: 'aix',
      arch: 'x64',
      hashes: {},
      home: root,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: 'frpc-unsupported' })
  })
})
