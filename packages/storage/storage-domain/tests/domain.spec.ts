import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import Storage, { StorageError, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvUnit, StorageBackend } from '@deepseek-ai/dsh-storage'
import { apply, defineDomain, descriptorOf, DomainFacility, domainTable } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { DomainChanged } from '../src/events.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

const itemSchema = z.object({ label: z.string(), count: z.number().int() })
type Item = z.infer<typeof itemSchema>

const settingsSchema = z.object({ theme: z.string() })

const spec = defineDomain({
  name: 'demo',
  version: 1,
  global: { schema: settingsSchema, initial: { theme: 'plain' } },
  tables: { items: domainTable<string, Item>(itemSchema) },
})

const bareSpec = defineDomain({
  name: 'bare',
  version: 1,
  tables: { rows: domainTable<string, Item>(itemSchema) },
})

/** Boot a context with the storage hub, one KV backend, and a facility over it. */
async function harness(options?: { pool?: MemoryMediaPool; config?: Partial<Config>; backend?: StorageBackend }) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = options?.backend ?? new MemoryStorageBackend(options?.pool)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {}, ...options?.config })
  ctx.storage.mount('domain', facility)
  const changes: DomainChanged[] = []
  ctx.on('domain/changed', (change) => { changes.push(change) })
  return { ctx, backend, facility, changes }
}

describe('defineDomain', () => {
  it('rejects invalid names and versions loudly', () => {
    expect(() => defineDomain({ name: 'Bad-Name', version: 1, tables: {} })).toThrow(/must match/)
    expect(() => defineDomain({ name: 'ok', version: 1.5, tables: {} })).toThrow(/non-negative integer/)
    expect(() => defineDomain({
      name: 'ok', version: 1, tables: { 'Bad Table': domainTable<string, Item>(itemSchema) },
    })).toThrow(/table name/)
  })

  it('rejects a global schema that accepts null (the never-written sentinel)', () => {
    expect(() => defineDomain({
      name: 'ok',
      version: 1,
      global: { schema: settingsSchema.nullable(), initial: null },
      tables: {},
    })).toThrow(/must not accept null/)
  })

  it('validates compatibleVersions entries and projects them onto the descriptor', () => {
    expect(() => defineDomain({ name: 'ok', version: 2, compatibleVersions: [1.5], tables: {} }))
      .toThrow(/compatibleVersions/)
    expect(() => defineDomain({ name: 'ok', version: 2, compatibleVersions: [2], tables: {} }))
      .toThrow(/below version/)
    expect(() => defineDomain({ name: 'ok', version: 2, compatibleVersions: [-1], tables: {} }))
      .toThrow(/compatibleVersions/)
    expect(descriptorOf(defineDomain({ name: 'ok', version: 2, compatibleVersions: [0, 1], tables: {} })))
      .toMatchObject({ compatibleVersions: [0, 1] })
    // An undeclared set is absent from the descriptor.
    expect(descriptorOf(spec)).not.toHaveProperty('compatibleVersions')
  })

  it('rejects an unknown invalidRecords policy', () => {
    expect(() => defineDomain({
      name: 'ok', version: 1, invalidRecords: 'zap' as 'backup-and-skip', tables: {},
    })).toThrow(/invalidRecords/)
  })

  it('rejects an invalid layout and projects the declared one onto the descriptor', () => {
    // A spec built from config can carry any value; the union type is
    // compile-time only, so the runtime boundary check must reject it.
    expect(() => defineDomain({ name: 'ok', version: 1, layout: 'every-record' as 'single', tables: {} }))
      .toThrow(/layout/)
    expect(descriptorOf(defineDomain({ name: 'per', version: 1, layout: 'per-record', tables: {} })))
      .toMatchObject({ name: 'per', layout: 'per-record' })
    // The default (single) layout is absent from the descriptor.
    expect(descriptorOf(spec)).not.toHaveProperty('layout')
  })
})

describe('DomainFacility.open', () => {
  it('opens, reads back stored records, and rejects a second open of the same name', async () => {
    const { facility } = await harness()
    const domain = await facility.open(spec)
    await domain.table('items').put('a', { label: 'first', count: 1 })
    await expect(facility.open(spec)).rejects.toMatchObject({ name: 'DomainError', code: 'already-open' })
    expect(domain.table('items').get('a')).toEqual({ label: 'first', count: 1 })
  })

  it('routes per domain name and fails loud on an unregistered route target', async () => {
    const { facility } = await harness({ config: { routes: { demo: 'nonexistent' } } })
    await expect(facility.open(spec)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'backend-not-found',
    })
    // The failed open releases the name for a later attempt.
    const { facility: healthy } = await harness()
    await expect(healthy.open(spec)).resolves.toBeDefined()
  })

  it('rejects a backend without the kv facet', async () => {
    const { ctx, facility } = await harness({ config: { backend: 'nokv' } })
    ctx.storage.backend.register('nokv', { close: async () => {} })
    await expect(facility.open(spec)).rejects.toMatchObject({ code: 'facet-unsupported' })
  })

  it('falls back to the default backend when no route table is configured', async () => {
    // A second, unmounted facility whose config omits `routes` entirely
    // (exactOptionalPropertyTypes forbids an explicit undefined).
    const { ctx } = await harness()
    const routeless = new DomainFacility(ctx, { backend: 'memory' })
    await expect(routeless.open(bareSpec)).resolves.toBeDefined()
  })

  it('treats a table key the backend omitted from loadAll as empty', async () => {
    // A sparse backend: loadAll omits declared table keys entirely instead of
    // returning them as empty objects.
    const { ctx, facility } = await harness({ config: { backend: 'sparse' } })
    ctx.storage.backend.register('sparse', {
      kv: {
        open: async () => ({
          loadAll: async () => ({ tables: {}, global: null }),
          putRecord: async () => {},
          deleteRecord: async () => {},
          deleteRecords: async () => {},
          setGlobal: async () => {},
          close: async () => {},
        }),
      },
      close: async () => {},
    })
    const domain = await facility.open(bareSpec)
    expect(domain.table('rows').size).toBe(0)
  })

  it('rejects stored records that fail their schema, naming table and key', async () => {
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness({ pool })
      await (await facility.open(spec)).table('items').put('bad', { label: 'x', count: 2 })
    }
    pool.media.get('demo')!.tables.get('items')!.set('bad', { label: 'x', count: 'NaN' })
    const { facility } = await harness({ pool })
    await expect(facility.open(spec)).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: 'items', key: 'bad' },
    })
  })

  it('keeps the rejecting default under backup-and-skip when the backend cannot move documents', async () => {
    // The memory backend has no backupRecord, so the declared policy cannot
    // apply and the open falls back to failing loud.
    const salvageSpec = defineDomain({
      name: 'salvage',
      version: 1,
      invalidRecords: 'backup-and-skip',
      tables: { items: domainTable<string, Item>(itemSchema) },
    })
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness({ pool })
      await (await facility.open(salvageSpec)).table('items').put('bad', { label: 'x', count: 2 })
    }
    pool.media.get('salvage')!.tables.get('items')!.set('bad', { label: 'x', count: 'NaN' })
    const { facility } = await harness({ pool })
    await expect(facility.open(salvageSpec)).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: 'items', key: 'bad' },
    })
  })

  it('backs up and skips an invalid stored record at open when the backend can move it', async () => {
    const pool = new MemoryMediaPool()
    pool.versions.set('salvage', 1)
    pool.media.set('salvage', {
      tables: new Map([['items', new Map([['bad', { label: 'x', count: 'NaN' }]])]]),
      global: null,
    })
    const salvageSpec = defineDomain({
      name: 'salvage',
      version: 1,
      invalidRecords: 'backup-and-skip',
      tables: { items: domainTable<string, Item>(itemSchema) },
    })
    const backend = new MemoryStorageBackend(pool, { backup: true })
    const { ctx, facility } = await harness({ backend })
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const domain = await facility.open(salvageSpec)
    // The domain opened without the record, and the document was moved aside.
    expect([...domain.table('items').keys()]).toEqual([])
    expect(pool.backups).toEqual(['memory:salvage/items/bad.bak'])
    expect(error).toHaveBeenCalledWith(expect.stringContaining("record 'bad' in table 'items'"))
  })

  it('rejects a stored global that fails its schema with the global marker', async () => {
    const pool = new MemoryMediaPool()
    pool.versions.set('demo', 1)
    pool.media.set('demo', { tables: new Map(), global: { theme: 42 } })
    const { facility } = await harness({ pool })
    await expect(facility.open(spec)).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: '', key: '' },
    })
  })

  it('passes through a backend version mismatch', async () => {
    const pool = new MemoryMediaPool()
    pool.versions.set('demo', 7)
    const { facility } = await harness({ pool })
    await expect(facility.open(spec)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'version-mismatch',
    })
  })
})

describe('plugin apply', () => {
  it('uses only the default backend when routes are omitted', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend()
    ctx.storage.backend.register('memory', backend)
    const disposeBackend = ctx.provide(storageBackendServiceKey('memory'), backend)

    const fiber = await ctx.plugin({
      name: 'storage-domain-routeless-test',
      inject: ['storage'],
      apply: (domainCtx: Context) => apply(domainCtx, { backend: 'memory' }),
    })
    await vi.waitFor(() => { expect(ctx.storageDomain).toBeInstanceOf(DomainFacility) })

    disposeBackend()
    await vi.waitFor(() => { expect(ctx.get('storageDomain')).toBeUndefined() })
    await fiber.dispose()
  })

  it('waits for routed backends, then mounts one lifecycle-bound service and form', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const DomainPlugin = await import('../src/index.ts')
    const fiber = await ctx.plugin(DomainPlugin, { backend: 'memory' })
    expect(ctx.get('storageDomain')).toBeUndefined()
    expect(() => ctx.storage.form('domain')).toThrow(/not mounted/)

    const backend = new MemoryStorageBackend()
    ctx.storage.backend.register('memory', backend)
    const disposeBackend = ctx.provide(storageBackendServiceKey('memory'), backend)
    await vi.waitFor(() => { expect(ctx.storageDomain).toBeInstanceOf(DomainFacility) })
    expect(ctx.storage.domain).toBe(ctx.storageDomain)

    disposeBackend()
    await vi.waitFor(() => {
      expect(ctx.get('storageDomain')).toBeUndefined()
      expect(() => ctx.storage.form('domain')).toThrow(/not mounted/)
    })
    await fiber.dispose()
  })
})

describe('table and snapshot reads', () => {
  it('serves entries, keys, and size as stable snapshots; unknown table names throw', async () => {
    const { facility } = await harness()
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.put('b', { label: 'y', count: 2 })
    expect(table.size).toBe(2)
    expect([...table.keys()].sort()).toEqual(['a', 'b'])
    expect(new Map(table.entries()).get('a')).toEqual({ label: 'x', count: 1 })
    expect(() => domain.table('nope' as never)).toThrow(/declares no table/)
  })
})

describe('KvTable writes', () => {
  it('serializes concurrent updates on one key without losing increments', async () => {
    const { facility } = await harness()
    const table = (await facility.open(spec)).table('items')
    await table.put('counter', { label: 'c', count: 0 })
    await Promise.all(Array.from({ length: 50 }, () =>
      table.update('counter', current => ({ ...current, count: current.count + 1 }))))
    expect(table.get('counter')).toEqual({ label: 'c', count: 50 })
  })

  it('update rejects a missing key; delete reports prior existence', async () => {
    const { facility } = await harness()
    const table = (await facility.open(spec)).table('items')
    await expect(table.update('ghost', v => v)).rejects.toMatchObject({ code: 'missing-key' })
    await table.put('a', { label: 'x', count: 1 })
    await expect(table.delete('a')).resolves.toBe(true)
    await expect(table.delete('a')).resolves.toBe(false)
  })

  it('deleteMany removes the existing keys in one write slot and reports the count', async () => {
    const { facility, changes } = await harness()
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.put('b', { label: 'y', count: 2 })
    await table.put('c', { label: 'z', count: 3 })
    const seen = changes.length
    await expect(table.deleteMany(['a', 'c', 'missing', 'a'])).resolves.toBe(2)
    expect([...table.entries()]).toEqual([['b', { label: 'y', count: 2 }]])
    expect(changes.slice(seen)).toEqual([
      { domain: 'demo', table: 'items', key: 'a', operation: 'deleted' },
      { domain: 'demo', table: 'items', key: 'c', operation: 'deleted' },
    ])
    // A batch without existing keys is a no-op: no backend write and no event.
    await expect(table.deleteMany(['ghost'])).resolves.toBe(0)
    expect(changes).toHaveLength(seen + 2)
  })

  it('applies the whole batch to memory before announcing it', async () => {
    const { ctx, facility } = await harness()
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.put('b', { label: 'y', count: 2 })
    const observed: string[][] = []
    ctx.on('domain/changed', () => { observed.push([...table.keys()].sort()) })
    await table.deleteMany(['a', 'b'])
    // Every listener run sees the committed batch state, not a prefix of it.
    expect(observed).toEqual([[], []])
  })

  it('calls the backend batch primitive exactly once per deleteMany', async () => {
    const inner = new MemoryStorageBackend()
    let batches = 0
    let singles = 0
    const counting: StorageBackend = {
      close: () => inner.close(),
      kv: {
        open: async (descriptor) => {
          const kv = inner.kv
          if (kv === undefined) throw new Error('memory backend is missing its kv facet')
          const unit = await kv.open(descriptor)
          return {
            loadAll: () => unit.loadAll(),
            putRecord: (table, key, value) => unit.putRecord(table, key, value),
            deleteRecord: async (table, key) => {
              singles += 1
              return unit.deleteRecord(table, key)
            },
            deleteRecords: async (table, keys) => {
              batches += 1
              return unit.deleteRecords(table, keys)
            },
            setGlobal: value => unit.setGlobal(value),
            close: () => unit.close(),
          }
        },
      },
    }
    const { facility } = await harness({ backend: counting })
    const table = (await facility.open(spec)).table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.put('b', { label: 'y', count: 2 })
    await expect(table.deleteMany(['a', 'b', 'missing'])).resolves.toBe(2)
    expect(batches).toBe(1)
    expect(singles).toBe(0)
  })

  it('emits domain/changed per durable write, in order, with tombstones and global marker', async () => {
    const { facility, changes } = await harness()
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.update('a', current => ({ ...current, count: 2 }))
    await table.delete('a')
    await table.delete('a') // no event: already absent
    await domain.global.set({ theme: 'dark' })
    expect(changes).toEqual([
      { domain: 'demo', table: 'items', key: 'a', operation: 'put', value: { label: 'x', count: 1 } },
      { domain: 'demo', table: 'items', key: 'a', operation: 'put', value: { label: 'x', count: 2 } },
      { domain: 'demo', table: 'items', key: 'a', operation: 'deleted' },
      { domain: 'demo', table: '', key: '', operation: 'put', value: { theme: 'dark' } },
    ])
  })
})

describe('durability failure', () => {
  it('leaves memory untouched and emits nothing when the backend rejects a write', async () => {
    const pool = new MemoryMediaPool()
    const { facility, changes } = await harness({ pool })
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    const seen = changes.length

    pool.failNextWrites = 3
    await expect(table.put('a', { label: 'x', count: 99 })).rejects.toThrow(/injected/)
    await expect(table.update('a', c => ({ ...c, count: c.count + 1 }))).rejects.toThrow(/injected/)
    await expect(table.delete('a')).rejects.toThrow(/injected/)

    // Reads still serve the pre-failure record; no events leaked.
    expect(table.get('a')).toEqual({ label: 'x', count: 1 })
    expect(pool.media.get('demo')!.tables.get('items')!.get('a')).toEqual({ label: 'x', count: 1 })
    expect(changes).toHaveLength(seen)

    // The chain survives rejections: the next write lands cleanly with no residue.
    await table.update('a', c => ({ ...c, count: c.count + 1 }))
    expect(table.get('a')).toEqual({ label: 'x', count: 2 })
  })

  it('leaves every record in place when a batch delete fails durability', async () => {
    const pool = new MemoryMediaPool()
    const { facility, changes } = await harness({ pool })
    const table = (await facility.open(spec)).table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.put('b', { label: 'y', count: 2 })
    const seen = changes.length

    pool.failNextWrites = 1
    await expect(table.deleteMany(['a', 'b'])).rejects.toThrow(/injected/)

    expect([...table.entries()]).toEqual([
      ['a', { label: 'x', count: 1 }],
      ['b', { label: 'y', count: 2 }],
    ])
    expect(pool.media.get('demo')!.tables.get('items')!.get('b')).toEqual({ label: 'y', count: 2 })
    expect(changes).toHaveLength(seen)

    // The write chain keeps serving after a rejected batch.
    await table.put('c', { label: 'z', count: 3 })
    expect(table.get('c')).toEqual({ label: 'z', count: 3 })
  })

  it('quarantines the domain after a batch reports unknown-state', async () => {
    const inner = new MemoryStorageBackend()
    const poisoned: StorageBackend = {
      close: () => inner.close(),
      kv: {
        open: async (descriptor) => {
          const kv = inner.kv
          if (kv === undefined) throw new Error('memory backend is missing its kv facet')
          const unit: KvUnit = await kv.open(descriptor)
          return {
            loadAll: () => unit.loadAll(),
            putRecord: (table, key, value) => unit.putRecord(table, key, value),
            deleteRecord: (table, key) => unit.deleteRecord(table, key),
            deleteRecords: () => Promise.reject(new StorageError('unknown-state', 'unknown-state injected by the test')),
            setGlobal: value => unit.setGlobal(value),
            close: () => unit.close(),
          }
        },
      },
    }
    const { facility } = await harness({ backend: poisoned })
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })

    // A later job queued before the failure surfaces is rejected too.
    const failing = table.deleteMany(['a'])
    const queued = table.put('b', { label: 'y', count: 2 })
    await expect(failing).rejects.toMatchObject({ code: 'unknown-state' })
    await expect(queued).rejects.toMatchObject({ code: 'unknown-state' })
    // Synchronous reads and later chain jobs see the quarantined domain.
    expect(() => table.get('a')).toThrow(/unknown-state/)
    expect(() => [...table.keys()]).toThrow(/unknown-state/)
    expect(() => table.size).toThrow(/unknown-state/)
    await expect(table.deleteMany(['missing'])).rejects.toMatchObject({ code: 'unknown-state' })
    await expect(table.put('c', { label: 'z', count: 3 })).rejects.toMatchObject({ code: 'unknown-state' })
    await expect(domain.global.set({ theme: 'dark' })).rejects.toMatchObject({ code: 'unknown-state' })
    expect(() => domain.global.get()).toThrow(/unknown-state/)
    // Releasing the domain stays possible.
    await expect(domain.close()).resolves.toBeUndefined()
  })

  it('keeps serving initial when the first global set fails durability', async () => {
    const pool = new MemoryMediaPool()
    const { facility } = await harness({ pool })
    const domain = await facility.open(spec)
    pool.failNextWrites = 1
    await expect(domain.global.set({ theme: 'dark' })).rejects.toThrow(/injected/)
    expect(domain.global.get()).toEqual({ theme: 'plain' })
    expect(pool.media.get('demo')!.global).toBeNull()
  })
})

describe('global singleton', () => {
  it('serves initial before first set without materializing, then persists the first set', async () => {
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness({ pool })
      const domain = await facility.open(spec)
      expect(domain.global.get()).toEqual({ theme: 'plain' })
      expect(pool.media.get('demo')!.global).toBeNull() // initial never touches the medium
      await domain.global.set({ theme: 'dark' })
      expect(pool.media.get('demo')!.global).toEqual({ theme: 'dark' })
    }
    const { facility } = await harness({ pool })
    expect((await facility.open(spec)).global.get()).toEqual({ theme: 'dark' })
  })

  it('throws on access when the spec declares no global', async () => {
    const { facility } = await harness()
    const domain = await facility.open(bareSpec)
    expect(() => (domain as { global: unknown }).global).toThrow(/declares no global/)
  })
})

describe('close and lifecycle', () => {
  it('close drains queued writes, then rejects reads and writes, and frees the name', async () => {
    const pool = new MemoryMediaPool()
    const { facility } = await harness({ pool })
    const domain = await facility.open(spec)
    const table = domain.table('items')
    const pending = Promise.all([
      table.put('a', { label: 'x', count: 1 }),
      table.put('b', { label: 'y', count: 2 }),
    ])
    await Promise.all([domain.close(), domain.close()]) // idempotent
    await pending // queued before close → still landed
    // Durability is the drain contract: both queued writes reached the medium.
    expect([...pool.media.get('demo')!.tables.get('items')!.keys()].sort()).toEqual(['a', 'b'])
    await expect(table.put('c', { label: 'z', count: 3 })).rejects.toMatchObject({ code: 'closed' })
    expect(() => table.get('a')).toThrow(/closed/)
    // The name is free again: reopening sees the drained state.
    const reopened = await facility.open(spec)
    expect([...reopened.table('items').keys()].sort()).toEqual(['a', 'b'])
  })

  it('facility unmount closes domains the consumer never closed', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend()
    ctx.storage.backend.register('memory', backend)
    ctx.provide(storageBackendServiceKey('memory'), backend)
    const DomainPlugin = await import('../src/index.ts')
    const fiber = await ctx.plugin(DomainPlugin, { backend: 'memory' })
    const domain = await ctx.storageDomain.open(bareSpec)
    const table = domain.table('rows')
    await table.put('a', { label: 'x', count: 1 })
    await fiber.dispose()
    await expect(table.put('b', { label: 'y', count: 2 })).rejects.toMatchObject({ code: 'closed' })
    expect(() => ctx.storage.form('domain')).toThrow(/not mounted/)
  })

  it('contains a throwing domain/changed listener without rejecting the committed write', async () => {
    const pool = new MemoryMediaPool()
    const { ctx, facility, changes } = await harness({ pool })
    const domain = await facility.open(spec)
    const table = domain.table('items')
    ctx.on('domain/changed', () => {
      throw new Error('hostile observer')
    })
    await expect(table.put('a', { label: 'x', count: 1 })).resolves.toBeUndefined()
    // Commit survived intact on both planes, and well-behaved listeners
    // (registered before the thrower) still observed the event.
    expect(table.get('a')).toEqual({ label: 'x', count: 1 })
    expect(pool.media.get('demo')!.tables.get('items')!.get('a')).toEqual({ label: 'x', count: 1 })
    expect(changes).toHaveLength(1)
    // The chain is unpoisoned: subsequent writes proceed normally.
    await expect(table.delete('a')).resolves.toBe(true)
  })
})

const residentSpec = defineDomain({
  name: 'resident',
  version: 1,
  layout: 'per-record',
  global: { schema: settingsSchema, initial: { theme: 'plain' } },
  tables: { items: domainTable<string, Item>(itemSchema) },
})

const residentSalvageSpec = defineDomain({
  name: 'resident',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { items: domainTable<string, Item>(itemSchema) },
})

const residentSingleSpec = defineDomain({
  name: 'resident',
  version: 1,
  tables: { items: domainTable<string, Item>(itemSchema) },
})

/** Medium of the `resident` unit, seeded without an open. */
function residentMedium(records: Record<string, Item>, global: unknown = null): MemoryMediaPool {
  const pool = new MemoryMediaPool()
  pool.versions.set('resident', 1)
  pool.media.set('resident', {
    tables: new Map([['items', new Map(Object.entries(records))]]),
    global,
  })
  return pool
}

/** Compact JSON bytes of one seeded value, the resident budget's unit. */
const valueBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

/** Open `residentSpec` for lazy reads over an in-memory backend. */
async function lazyHarness(options: {
  pool: MemoryMediaPool
  maxResidentBytes?: number
  backend?: StorageBackend
  spec?: typeof residentSpec | typeof residentSalvageSpec
}) {
  const backend = options.backend ?? new MemoryStorageBackend(options.pool)
  const mounted = await harness({ backend })
  const domain = await mounted.facility.open(options.spec ?? residentSpec, {
    lazyReads: true,
    maxResidentBytes: options.maxResidentBytes ?? 1024 * 1024,
  })
  return { ...mounted, pool: options.pool, domain, table: domain.table('items') }
}

describe('lazy record reads', () => {
  const a: Item = { label: 'a', count: 1 }
  const b: Item = { label: 'b', count: 2 }
  const c: Item = { label: 'c', count: 3 }

  it('opens from the key index without loading any record', async () => {
    const { table, pool } = await lazyHarness({ pool: residentMedium({ a, b }) })
    expect(pool.loads).toBe(0)
    expect(pool.recordReads).toBe(0)
    // The index serves every identity cheaply; nothing is resident yet.
    expect(table.size).toBe(2)
    expect([...table.keys()].sort()).toEqual(['a', 'b'])
    expect([...table.entries()]).toEqual([])
    expect(table.get('missing')).toBeUndefined()
    // A hit loads exactly that one record, and a re-read stays resident.
    expect(table.get('a')).toEqual(a)
    expect(pool.recordReads).toBe(1)
    expect(table.get('a')).toEqual(a)
    expect(pool.recordReads).toBe(1)
    expect([...table.entries()]).toEqual([['a', a]])
  })

  it('validates a record when the read loads it, not at open', async () => {
    const pool = residentMedium({ good: a, bad: b })
    const { table } = await lazyHarness({ pool })
    // The open survived a medium that no longer matches the schema.
    pool.media.get('resident')!.tables.get('items')!.set('bad', { label: 'x', count: 'NaN' })
    let failure: unknown
    try {
      table.get('bad')
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: 'invalid-record', detail: { table: 'items', key: 'bad' } })
    expect(table.get('good')).toEqual(a)
  })

  it('backs up and skips a record that fails validation when a read loads it', async () => {
    const pool = residentMedium({ good: a, bad: b })
    const backend = new MemoryStorageBackend(pool, { backup: true })
    const { ctx, table } = await lazyHarness({ pool, backend, spec: residentSalvageSpec })
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    pool.media.get('resident')!.tables.get('items')!.set('bad', { label: 'x', count: 'NaN' })
    expect(table.get('bad')).toBeUndefined()
    // The salvage is fail-soft and reported once it lands.
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith(expect.stringContaining("record 'bad' in table 'items'"))
    })
    expect(pool.backups).toEqual(['memory:resident/items/bad.bak'])
    // The policy's "treated as absent" is durable for this open: no key, no size.
    expect([...table.keys()]).toEqual(['good'])
    expect(table.size).toBe(1)
    expect(pool.recordReads).toBe(1)
  })

  it('warns when a schema-failing record cannot be moved aside', async () => {
    const pool = residentMedium({ bad: b })
    const inner = new MemoryStorageBackend(pool, { backup: true })
    const failing: StorageBackend = {
      close: () => inner.close(),
      kv: {
        open: async (descriptor) => {
          const kv = inner.kv
          if (kv === undefined) throw new Error('memory backend is missing its kv facet')
          const unit = await kv.open(descriptor)
          return {
            loadAll: () => unit.loadAll(),
            putRecord: (table, key, value) => unit.putRecord(table, key, value),
            deleteRecord: (table, key) => unit.deleteRecord(table, key),
            deleteRecords: (table, keys) => unit.deleteRecords(table, keys),
            setGlobal: value => unit.setGlobal(value),
            close: () => unit.close(),
            ...unit.recordReader === undefined ? {} : { recordReader: unit.recordReader },
            backupRecord: async () => {
              throw new Error('salvage refused')
            },
          }
        },
      },
    }
    const { ctx, table } = await lazyHarness({ pool, backend: failing, spec: residentSalvageSpec })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    pool.media.get('resident')!.tables.get('items')!.set('bad', { label: 'x', count: 'NaN' })
    expect(table.get('bad')).toBeUndefined()
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be moved aside'))
    })
    expect(table.size).toBe(0)
  })

  it('reads a record the medium no longer holds as absent', async () => {
    const { table, pool } = await lazyHarness({ pool: residentMedium({ a, b }) })
    pool.media.get('resident')!.tables.get('items')!.delete('a')
    expect(table.get('a')).toBeUndefined()
    expect(pool.recordReads).toBe(1)
    expect([...table.keys()]).toEqual(['b'])
    // The vanished key is absent from now on, not re-read on every call.
    expect(table.get('a')).toBeUndefined()
    expect(pool.recordReads).toBe(1)
  })

  it('releases the least recently used record beyond the budget and reloads it on demand', async () => {
    const pool = residentMedium({ a, b, c })
    const budget = valueBytes(a) + valueBytes(b)
    const { table } = await lazyHarness({ pool, maxResidentBytes: budget })
    expect(table.get('a')).toEqual(a)
    expect(table.get('b')).toEqual(b)
    expect([...table.entries()].map(([key]) => key)).toEqual(['a', 'b'])
    expect(table.get('c')).toEqual(c)
    // The oldest record paid for the third; the medium still holds it.
    expect([...table.entries()].map(([key]) => key)).toEqual(['b', 'c'])
    expect(table.get('a')).toEqual(a)
    expect([...table.entries()].map(([key]) => key)).toEqual(['c', 'a'])
    expect(pool.recordReads).toBe(4)
  })

  it('keeps a record larger than the whole budget resident alone', async () => {
    const huge: Item = { label: 'x'.repeat(4096), count: 9 }
    const huge2: Item = { label: 'y'.repeat(4096), count: 10 }
    const pool = residentMedium({ a, huge, huge2 })
    const { table } = await lazyHarness({ pool, maxResidentBytes: valueBytes(a) })
    expect(table.get('a')).toEqual(a)
    expect(table.get('huge')).toEqual(huge)
    expect([...table.entries()].map(([key]) => key)).toEqual(['huge'])
    // A second oversized read replaces it: the resident set never exceeds one
    // record above the budget.
    expect(table.get('huge2')).toEqual(huge2)
    expect([...table.entries()].map(([key]) => key)).toEqual(['huge2'])
  })

  it('charges writes against the budget and keeps them durable', async () => {
    const pool = residentMedium({ a })
    const { table, changes } = await lazyHarness({ pool, maxResidentBytes: valueBytes(a) })
    await table.put('written', b)
    expect(pool.media.get('resident')!.tables.get('items')!.get('written')).toEqual(b)
    expect([...table.entries()].map(([key]) => key)).toEqual(['written'])
    expect(changes.at(-1)).toMatchObject({ table: 'items', key: 'written', operation: 'put' })
    // A value the store cannot charge rejects inside the write slot, before
    // durability: the medium and the index are untouched.
    await expect(table.put('undefined' as never, undefined as never)).rejects.toThrow(/not JSON-serializable/)
    expect(table.size).toBe(2)
    expect(pool.media.get('resident')!.tables.get('items')!.has('undefined')).toBe(false)
  })

  it('deletes and updates non-resident records without loading them unnecessarily', async () => {
    const pool = residentMedium({ a, b, c })
    const { table } = await lazyHarness({ pool, maxResidentBytes: valueBytes(a) })
    // Deleting a record the open never loaded still removes its document.
    await expect(table.delete('a')).resolves.toBe(true)
    expect(pool.media.get('resident')!.tables.get('items')!.has('a')).toBe(false)
    expect(table.size).toBe(2)
    expect(pool.recordReads).toBe(0)
    // update loads the current record, then writes the replacement durably.
    await expect(table.update('b', current => ({ ...current, count: current.count + 10 }))).resolves.toEqual({ label: 'b', count: 12 })
    expect(pool.recordReads).toBe(1)
    expect(pool.media.get('resident')!.tables.get('items')!.get('b')).toEqual({ label: 'b', count: 12 })
    // A missing target never touches the medium.
    await expect(table.update('ghost', current => current)).rejects.toMatchObject({ code: 'missing-key' })
  })

  it('rejects an update whose record the medium cannot serve', async () => {
    const pool = residentMedium({ b })
    const backend = new MemoryStorageBackend(pool, { backup: true })
    const { table } = await lazyHarness({ pool, backend, spec: residentSalvageSpec })
    pool.media.get('resident')!.tables.get('items')!.set('b', { label: 'x', count: 'NaN' })
    await expect(table.update('b', current => current)).rejects.toMatchObject({ code: 'missing-key' })
  })

  it('serves and validates the stored global on a lazy open', async () => {
    const stored = await lazyHarness({ pool: residentMedium({}, { theme: 'dark' }) })
    expect(stored.domain.global.get()).toEqual({ theme: 'dark' })
    const plain = await lazyHarness({ pool: residentMedium({}) })
    expect(plain.domain.global.get()).toEqual({ theme: 'plain' })
    const broken = residentMedium({}, { theme: 42 })
    await expect(lazyHarness({ pool: broken })).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: '', key: '' },
    })
  })

  it('rejects malformed lazy options before opening the unit', async () => {
    const { facility, ctx } = await harness({ pool: residentMedium({ a }) })
    await expect(facility.open(residentSpec, { lazyReads: true })).rejects.toThrow(/maxResidentBytes/)
    await expect(facility.open(residentSpec, { lazyReads: true, maxResidentBytes: 0 })).rejects.toThrow(/maxResidentBytes/)
    await expect(facility.open(residentSpec, { lazyReads: true, maxResidentBytes: 1.5 })).rejects.toThrow(/maxResidentBytes/)
    await expect(facility.open(residentSpec, { maxResidentBytes: 8 })).rejects.toThrow(/lazyReads/)
    await expect(facility.open(residentSingleSpec, { lazyReads: true, maxResidentBytes: 8 }))
      .rejects.toThrow(/per-record/)
    // Each rejected open released the reserved name: an eager open still works.
    expect(ctx.storage.domain).toBe(facility)
    await expect(facility.open(residentSingleSpec)).resolves.toBeDefined()
  })

  it('treats a declared table the reader index omits as empty', async () => {
    const pool = residentMedium({})
    const inner = new MemoryStorageBackend(pool)
    const sparseIndex: StorageBackend = {
      close: () => inner.close(),
      kv: {
        open: async (descriptor) => {
          const kv = inner.kv
          if (kv === undefined) throw new Error('memory backend is missing its kv facet')
          const unit = await kv.open(descriptor)
          if (unit.recordReader === undefined) throw new Error('memory unit must expose a recordReader')
          const reader = unit.recordReader
          return {
            loadAll: () => unit.loadAll(),
            putRecord: (table, key, value) => unit.putRecord(table, key, value),
            deleteRecord: (table, key) => unit.deleteRecord(table, key),
            deleteRecords: (table, keys) => unit.deleteRecords(table, keys),
            setGlobal: value => unit.setGlobal(value),
            close: () => unit.close(),
            recordReader: {
              listKeys: async () => ({ tables: {}, global: null }),
              read: (table: string, key: string) => reader.read(table, key),
              readAsync: (table: string, key: string) => reader.readAsync(table, key),
            },
          }
        },
      },
    }
    const { table } = await lazyHarness({ pool, backend: sparseIndex })
    expect(table.size).toBe(0)
    expect(table.get('a')).toBeUndefined()
  })

  it('falls back to eager materialization when the unit cannot read records on demand', async () => {
    const pool = residentMedium({ a })
    const inner = new MemoryStorageBackend(pool)
    const eagerOnly: StorageBackend = {
      close: () => inner.close(),
      kv: {
        open: async (descriptor) => {
          const kv = inner.kv
          if (kv === undefined) throw new Error('memory backend is missing its kv facet')
          const unit = await kv.open(descriptor)
          return {
            loadAll: () => unit.loadAll(),
            putRecord: (table, key, value) => unit.putRecord(table, key, value),
            deleteRecord: (table, key) => unit.deleteRecord(table, key),
            deleteRecords: (table, keys) => unit.deleteRecords(table, keys),
            setGlobal: value => unit.setGlobal(value),
            close: () => unit.close(),
          }
        },
      },
    }
    const { ctx, facility } = await harness({ backend: eagerOnly })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const domain = await facility.open(residentSpec, { lazyReads: true, maxResidentBytes: 1024 })
    // The fallback loaded the corpus and warned about the degradation.
    expect(pool.loads).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('opening eagerly'))
    expect(domain.table('items').get('a')).toEqual(a)
  })
})

describe('lazy record scan', () => {
  const a: Item = { label: 'a', count: 1 }
  const b: Item = { label: 'b', count: 2 }

  /** Drain one scan, collecting the keys it streamed. */
  async function drain(iterator: AsyncIterableIterator<readonly [string, Item]>): Promise<string[]> {
    const keys: string[] = []
    for await (const [key] of iterator) keys.push(key)
    return keys
  }

  it('streams every record without retaining it', async () => {
    const { table, pool } = await lazyHarness({ pool: residentMedium({ a, b }) })
    const seen = new Map<string, Item>()
    for await (const [key, value] of table.scan!()) seen.set(key, value)
    expect([...seen.keys()]).toEqual(['a', 'b'])
    expect(seen.get('a')).toEqual(a)
    expect(seen.get('b')).toEqual(b)
    // The pass reads through the asynchronous path and leaves the resident set
    // (and the synchronous read counter) untouched.
    expect(pool.recordAsyncReads).toBe(2)
    expect(pool.recordReads).toBe(0)
    expect([...table.entries()]).toEqual([])
    expect(table.size).toBe(2)
  })

  it('drops a key the medium no longer holds', async () => {
    const { table, pool } = await lazyHarness({ pool: residentMedium({ a, b }) })
    pool.media.get('resident')!.tables.get('items')!.delete('a')
    expect(await drain(table.scan!() as AsyncIterableIterator<readonly [string, Item]>)).toEqual(['b'])
    expect([...table.keys()]).toEqual(['b'])
  })

  it('applies the salvage policy while streaming', async () => {
    const pool = residentMedium({ good: a, bad: b })
    const backend = new MemoryStorageBackend(pool, { backup: true })
    const { ctx, table } = await lazyHarness({ pool, backend, spec: residentSalvageSpec })
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    pool.media.get('resident')!.tables.get('items')!.set('bad', { label: 'x', count: 'NaN' })
    expect(await drain(table.scan!() as AsyncIterableIterator<readonly [string, Item]>)).toEqual(['good'])
    // The streaming path awaits the move, so the diagnostic is already logged.
    expect(error).toHaveBeenCalledWith(expect.stringContaining("record 'bad' in table 'items'"))
    expect(pool.backups).toEqual(['memory:resident/items/bad.bak'])
    expect(table.size).toBe(1)
  })

  it('rejects a schema-failing record when the policy cannot salvage it', async () => {
    const pool = residentMedium({ bad: b })
    const { table } = await lazyHarness({ pool })
    pool.media.get('resident')!.tables.get('items')!.set('bad', { label: 'x', count: 'NaN' })
    await expect(drain(table.scan!() as AsyncIterableIterator<readonly [string, Item]>))
      .rejects.toMatchObject({ code: 'invalid-record', detail: { table: 'items', key: 'bad' } })
  })

  it('stops streaming once the domain is closed', async () => {
    const { table, domain } = await lazyHarness({ pool: residentMedium({ a, b }) })
    const iterator = table.scan!() as AsyncIterableIterator<readonly [string, Item]>
    expect((await iterator.next()).done).toBe(false)
    await domain.close()
    await expect(iterator.next()).rejects.toMatchObject({ code: 'closed' })
  })

  it('is absent on an eagerly loaded table', async () => {
    const { facility } = await harness()
    const domain = await facility.open(spec)
    expect(domain.table('items').scan).toBeUndefined()
  })
})
