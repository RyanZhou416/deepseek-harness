import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { JsonStorageBackend } from '../src/index.ts'

const reads = vi.hoisted(() => ({ inFlight: 0, peak: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const readFile = async (...args: Parameters<typeof actual.readFile>): Promise<string | Buffer> => {
    reads.peak = Math.max(reads.peak, ++reads.inFlight)
    try {
      return await actual.readFile(...args)
    } finally {
      reads.inFlight--
    }
  }
  return { ...actual, readFile }
})

const roots: string[] = []

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

it('loads a large table with a bounded number of record files open at once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-storage-json-'))
  roots.push(root)
  const table = join(root, 'recs', 't')
  await mkdir(table, { recursive: true })
  for (let n = 0; n < 300; n++) {
    await writeFile(join(table, `k${n}.json`), JSON.stringify({ version: 1, record: { n } }))
  }
  const backend = new JsonStorageBackend(root)
  const unit = await backend.kv.open({ name: 'recs', version: 1, layout: 'per-record', tables: ['t'], hasGlobal: false })
  reads.peak = 0
  const state = await unit.loadAll()
  expect(Object.keys(state.tables.t ?? {})).toHaveLength(300)
  expect(reads.peak).toBeGreaterThan(1)
  expect(reads.peak).toBeLessThanOrEqual(64)
  await backend.close()
})
