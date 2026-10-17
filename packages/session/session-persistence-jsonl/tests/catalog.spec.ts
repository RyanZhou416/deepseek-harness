import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { SESSION_CATALOG_FILE, SessionCatalog, type SessionCatalogEntry, type SessionLogIdentity } from '../src/catalog.ts'

const root = async (): Promise<string> => mkdtemp(join(tmpdir(), 'dsh-catalog-'))

function header(id: string, origin?: 'subagent'): SessionCatalogEntry['header'] {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 100,
    isSeeded: false,
    ...(origin === undefined ? {} : { origin }),
  }
}

function entry(id: string, origin?: 'subagent'): SessionCatalogEntry {
  return { header: header(id, origin), formatStatus: 'current', sizeBytes: 10, mtimeMs: 20 }
}

function identity(size: number, mtimeMs: number): SessionLogIdentity {
  return { size: BigInt(size), mtimeMs: BigInt(mtimeMs) }
}

describe('SessionCatalog', () => {
  it('round-trips entries and trusts only the recorded log identity', async () => {
    const dir = await root()
    try {
      const catalog = new SessionCatalog(dir, vi.fn())
      await catalog.load()
      catalog.remember('segment-a', entry('session-a'))
      expect(catalog.lookup('segment-a', identity(10, 20))).toEqual(entry('session-a'))
      expect(catalog.lookup('segment-a', identity(11, 20))).toBeUndefined()
      expect(catalog.lookup('segment-a', identity(10, 21))).toBeUndefined()
      await catalog.flush()

      const reloaded = new SessionCatalog(dir, vi.fn())
      await reloaded.load()
      expect(reloaded.lookup('segment-a', identity(10, 20))).toEqual(entry('session-a'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('discards a malformed catalog and rewrites an empty one', async () => {
    const dir = await root()
    try {
      await writeFile(join(dir, SESSION_CATALOG_FILE), '{not json')
      const warn = vi.fn()
      const catalog = new SessionCatalog(dir, warn)
      await catalog.load()
      expect(catalog.lookup('segment-a', identity(10, 20))).toBeUndefined()
      expect(warn).toHaveBeenCalledOnce()
      await catalog.flush()
      const written = JSON.parse(await readFile(join(dir, SESSION_CATALOG_FILE), 'utf8')) as { sessions: Record<string, unknown> }
      expect(written.sessions).toEqual({})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('prunes segments a full scan no longer observes', async () => {
    const dir = await root()
    try {
      const catalog = new SessionCatalog(dir, vi.fn())
      await catalog.load()
      catalog.remember('segment-a', entry('session-a'))
      catalog.remember('segment-b', entry('session-b'))
      catalog.prune(new Set(['segment-a']))
      await catalog.flush()

      const reloaded = new SessionCatalog(dir, vi.fn())
      await reloaded.load()
      expect(reloaded.lookup('segment-a', identity(10, 20))).toEqual(entry('session-a'))
      expect(reloaded.lookup('segment-b', identity(10, 20))).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports subagent segments only', async () => {
    const dir = await root()
    try {
      const catalog = new SessionCatalog(dir, vi.fn())
      await catalog.load()
      catalog.remember('segment-parent', entry('session-parent'))
      catalog.remember('segment-child', entry('session-child', 'subagent'))
      expect([...catalog.subagentSegments()]).toEqual(['segment-child'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
