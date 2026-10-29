/** Staged catalogue and credential state over the shared configuration form. */

import { describe, expect, it, vi } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsFormPathOp } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CcPoolModel, CcPoolSettings } from '../src/client/contract.ts'
import { CC_POOL_API_KEY_REF, CC_POOL_NS, CC_POOL_PROVIDER } from '../src/client/contract.ts'
import type { CcPoolDiscoveryOutcome, CcPoolOperations } from '../src/client/operations.ts'
import { CC_POOL_SYNC_TIMEOUT_MS, CcPoolSettingsPage } from '../src/client/settings-controller.ts'

const CATALOGUE: CcPoolModel[] = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextWindow: 1_000_000, maxTokens: 128_000, defaultReasoning: 'medium' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindow: 1_000_000, maxTokens: 128_000, defaultReasoning: 'medium' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextWindow: 1_000_000, maxTokens: 64_000, defaultReasoning: 'high' },
  { id: 'claude-mythos-5-1', name: 'Claude Mythos 5.1', contextWindow: 1_000_000, maxTokens: 64_000, defaultReasoning: 'high' },
]

/** The catalogue's ids and names, as the pool lists them. */
const POOL_IDS = CATALOGUE.map(model => ({ id: model.id, name: model.name }))

/** The one model the pool serves that the built-in catalogue does not. */
const POOL_ADDITION = { id: 'claude-nova-5', name: 'Claude Nova 5' }

/** The composition catalogue the Host resolves when the user layer stores no override. */
const BASE: CcPoolSettings = { models: CATALOGUE }

/** Apply one models write to a detached user layer, as the Host's path ops would. */
function applyModels(layer: CcPoolSettings, ops: readonly SettingsFormPathOp[]): CcPoolSettings {
  const next = structuredClone(layer)
  for (const op of ops) {
    if (op.op === 'unset') Reflect.deleteProperty(next, 'models')
    else next.models = structuredClone(op.value) as CcPoolModel[]
  }
  return next
}

/** The Host credential and discovery operations, with typed spies the tests script. */
function credentialOperations() {
  return {
    describeCredential: vi.fn<CcPoolOperations['describeCredential']>(async () => ({ configured: false, writable: true })),
    storeCredential: vi.fn<CcPoolOperations['storeCredential']>(async () => undefined),
    discoverModels: vi.fn<CcPoolOperations['discoverModels']>(async () => ({ kind: 'found', models: [] })),
  } satisfies CcPoolOperations
}

/**
 * A settings scope whose accepted writes fold back into its published snapshot.
 * @param initial - the user layer the Host already stores; omitted stores no override.
 * @param revision - the revision the first read answers.
 */
async function bench(initial: CcPoolSettings = {}, revision = 3) {
  const stub = stubConfigForm<CcPoolSettings>()
  let layer: CcPoolSettings = structuredClone(initial)
  let current = revision
  // The Host serves the user layer's catalogue, or the composition default when
  // the layer carries none.
  const resolved = (): CcPoolSettings => ({ models: layer.models ?? structuredClone(CATALOGUE) })
  stub.mutate.mockImplementation(async (ops) => {
    layer = applyModels(layer, ops)
    current += 1
    stub.publish({ value: resolved(), user: layer, revision: current })
    return true
  })
  stub.publish({ status: 'ready', value: resolved(), base: BASE, user: layer, revision, writable: true })
  const operations = credentialOperations()
  const page = new CcPoolSettingsPage(stub.scope, operations)
  return {
    stub,
    operations,
    page,
    face: page.inject(),
    snapshot: () => page.inject().hooks.ccPool.getSnapshot(),
    revision: () => current,
  }
}

/** A bench whose pool credential is configured, so the sync control may run. */
async function benchWithCredential(initial: CcPoolSettings = {}, revision = 3) {
  const setup = await bench(initial, revision)
  setup.operations.describeCredential.mockResolvedValue({ configured: true, source: 'file', writable: true })
  await setup.page.refreshCredential()
  return setup
}

describe('CcPoolSettingsPage', () => {
  it('seeds one row per effective entry and reports a fresh Host section', async () => {
    const { snapshot } = await bench()

    const state = snapshot()
    expect(state.loading).toBe(false)
    expect(state.available).toBe(true)
    expect(state.overridden).toBe(false)
    expect(state.dirty).toBe(false)
    expect(state.invalid).toBe(false)
    expect(state.rows.map(row => row.draft.id)).toEqual(CATALOGUE.map(model => model.id))
    expect(state.rows[3]?.draft).toEqual({
      id: 'claude-mythos-5-1', name: 'Claude Mythos 5.1', contextWindow: '1000000', maxTokens: '64000', defaultReasoning: 'high',
    })
    expect(state.token).toEqual({ text: '', configured: false, writable: true })
  })

  it('reports the credential configured with its source, and keeps the literal out of the snapshot', async () => {
    const { operations, page } = await bench()
    operations.describeCredential.mockResolvedValue({ configured: true, source: 'file', writable: true })
    await page.refreshCredential()

    expect(page.inject().hooks.ccPool.getSnapshot().token).toEqual({ text: '', configured: true, source: 'file', writable: true })
  })

  it('surfaces a credential read failure and disables the control', async () => {
    const { operations, page } = await bench()
    operations.describeCredential.mockResolvedValue({ configured: false, writable: false, error: 'no credential provider' })
    await page.refreshCredential()

    const token = page.inject().hooks.ccPool.getSnapshot().token
    expect(token).toEqual({ text: '', configured: false, writable: false, error: 'no credential provider' })
  })

  it('stages a row edit against the revision it started from and writes the whole array on save', async () => {
    const { stub, operations, face, snapshot } = await bench()

    face.editRow(1, 'contextWindow', '200000')
    face.editToken('  sk-pool-test  ')
    expect(snapshot().dirty).toBe(true)
    expect(snapshot().invalid).toBe(false)

    face.save()
    await vi.waitFor(() => { expect(stub.mutate).toHaveBeenCalledOnce() })

    const expected = CATALOGUE.map(model => model.id === 'claude-opus-5-5' ? { ...model, contextWindow: 200_000 } : model)
    expect(stub.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['models'], value: expected }], 3)
    await vi.waitFor(() => { expect(operations.storeCredential).toHaveBeenCalledWith(CC_POOL_API_KEY_REF, 'sk-pool-test') })
    await vi.waitFor(() => { expect(snapshot().saving).toBe(false) })
    expect(snapshot().dirty).toBe(false)
    expect(snapshot().token.text).toBe('')
  })

  it('blocks the save while a row is invalid and reports the field problem', async () => {
    const { stub, face, snapshot } = await bench()

    face.editRow(1, 'id', 'claude-sonnet-5-5')
    expect(snapshot().invalid).toBe(true)
    expect(snapshot().rows[0]?.errors.id).toBe('idDuplicate')
    expect(snapshot().rows[1]?.errors.id).toBe('idDuplicate')
    face.save()

    await vi.waitFor(() => { expect(snapshot().saving).toBe(false) })
    expect(stub.mutate).not.toHaveBeenCalled()
  })

  it('reports blank ids, unreadable numbers, and levels outside the five', async () => {
    const { face, snapshot } = await bench()

    face.editRow(0, 'id', '')
    face.editRow(0, 'contextWindow', '0')
    face.editRow(0, 'maxTokens', '1.5')
    face.editRow(0, 'defaultReasoning', 'off')
    face.editRow(0, 'name', '   ')

    expect(snapshot().rows[0]?.errors).toEqual({
      id: 'idBlank', name: 'nameBlank', contextWindow: 'positiveInteger', maxTokens: 'positiveInteger', defaultReasoning: 'reasoningLevel',
    })
  })

  it('appends a blank row and refuses a catalogue with no models left', async () => {
    const { face, snapshot } = await bench()

    face.addRow()
    expect(snapshot().rows).toHaveLength(5)
    expect(snapshot().invalid).toBe(true)
    expect(snapshot().rows[4]?.errors.id).toBe('idBlank')
    expect(snapshot().rows[4]?.errors.contextWindow).toBe('positiveInteger')

    for (let index = 4; index >= 0; index -= 1) face.removeRow(index)
    expect(snapshot().rows).toEqual([])
    expect(snapshot().emptyCatalogue).toBe(true)
    expect(snapshot().invalid).toBe(true)
  })

  it('stages a return to the built-in catalogue and clears the override on save', async () => {
    const { stub, face, snapshot } = await bench({ models: CATALOGUE.slice(0, 1) })

    face.editRow(0, 'name', 'Sonnet')
    face.resetModels()
    expect(snapshot().resetPending).toBe(true)
    // The badge previews the save: the staged reset clears the override.
    expect(snapshot().overridden).toBe(false)
    expect(snapshot().rows.map(row => row.draft.id)).toEqual(CATALOGUE.map(model => model.id))
    expect(snapshot().dirty).toBe(true)

    face.save()
    await vi.waitFor(() => { expect(stub.mutate).toHaveBeenCalledOnce() })
    expect(stub.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['models'] }], 3)
    await vi.waitFor(() => { expect(snapshot().resetPending).toBe(false) })
    // The accepted reset serves the composition catalogue again, so the page
    // shows it as the catalogue with nothing left to save.
    expect(snapshot().rows.map(row => row.draft.id)).toEqual(CATALOGUE.map(model => model.id))
    expect(snapshot().overridden).toBe(false)
    expect(snapshot().dirty).toBe(false)
    expect(snapshot().failed).toBe(false)
  })

  it('keeps every draft and reports a plain refusal as rejected values', async () => {
    const { stub, operations, face, snapshot } = await bench()
    stub.mutate.mockResolvedValue(false)

    face.editRow(1, 'name', 'Opus')
    face.editToken('sk-refused')
    face.save()

    await vi.waitFor(() => { expect(snapshot().failed).toBe(true) })
    expect(snapshot().saveError).toEqual({ kind: 'rejected' })
    expect(snapshot().saving).toBe(false)
    expect(snapshot().rows[1]?.draft.name).toBe('Opus')
    expect(snapshot().token.text).toBe('sk-refused')
    expect(snapshot().dirty).toBe(true)
    expect(operations.storeCredential).not.toHaveBeenCalled()
  })

  it('keeps the drafts, reports a conflict, and retries against the revision the Host answered', async () => {
    const { stub, face, snapshot } = await bench()
    face.editRow(1, 'name', 'Opus')

    // The shared form re-reads the Host after a refused write: another surface
    // won the fence while these drafts were being edited.
    stub.mutate.mockImplementationOnce(async () => {
      stub.publish({ value: { models: structuredClone(CATALOGUE) }, revision: 4 })
      return false
    })
    face.save()
    await vi.waitFor(() => { expect(snapshot().saveError).toEqual({ kind: 'conflict' }) })
    expect(snapshot().failed).toBe(true)
    expect(snapshot().rows[1]?.draft.name).toBe('Opus')
    expect(snapshot().dirty).toBe(true)

    // The retry must fence with the revision that recovery read answered.
    stub.mutate.mockImplementation(async (ops: readonly SettingsFormPathOp[]) => {
      const op = ops[0]
      const models = op?.op === 'set' ? op.value as CcPoolModel[] : []
      stub.publish({ value: { models }, user: { models }, revision: 5 })
      return true
    })
    face.save()
    await vi.waitFor(() => { expect(snapshot().saving).toBe(false) })
    expect(stub.mutate.mock.calls[1]?.[1]).toBe(4)
    expect(snapshot().failed).toBe(false)
    expect(snapshot().saveError).toBeUndefined()
    expect(snapshot().rows[1]?.draft.name).toBe('Opus')
    expect(snapshot().dirty).toBe(false)
    expect(snapshot().overridden).toBe(true)
  })

  it('re-seeds the accepted catalogue so normalized drafts leave nothing to save', async () => {
    const { stub, operations, face, snapshot } = await bench()

    // Padding the Host would trim and a capacity typed with leading zeros are
    // not edits: the page compares the values a save would write.
    face.editRow(1, 'contextWindow', ' 1000000 ')
    expect(snapshot().dirty).toBe(false)

    face.editRow(0, 'id', '  claude-sonnet-5-9  ')
    face.editRow(0, 'name', ' Claude Sonnet 5.9 ')
    face.editRow(1, 'contextWindow', ' 000200000 ')
    expect(snapshot().dirty).toBe(true)
    face.save()

    await vi.waitFor(() => { expect(stub.mutate).toHaveBeenCalledOnce() })
    const ops: readonly SettingsFormPathOp[] = stub.mutate.mock.calls[0]?.[0] ?? []
    const written = ops[0]?.op === 'set' ? ops[0].value as CcPoolModel[] : []
    expect(written[0]).toMatchObject({ id: 'claude-sonnet-5-9', name: 'Claude Sonnet 5.9' })
    expect(written[1]).toMatchObject({ contextWindow: 200_000 })

    await vi.waitFor(() => { expect(snapshot().saving).toBe(false) })
    expect(snapshot().rows[0]?.draft).toMatchObject({ id: 'claude-sonnet-5-9', name: 'Claude Sonnet 5.9' })
    expect(snapshot().rows[1]?.draft.contextWindow).toBe('200000')
    expect(snapshot().dirty).toBe(false)
    expect(snapshot().failed).toBe(false)
    expect(operations.storeCredential).not.toHaveBeenCalled()
  })

  it('keeps the typed key when the credentials domain refuses it', async () => {
    const { operations, face, snapshot } = await bench()
    operations.storeCredential.mockResolvedValue('the store is read-only')

    face.editToken('sk-refused')
    face.save()

    await vi.waitFor(() => { expect(snapshot().failed).toBe(true) })
    expect(snapshot().saveError).toEqual({ kind: 'credential', message: 'the store is read-only' })
    expect(snapshot().token.text).toBe('sk-refused')
    expect(snapshot().dirty).toBe(true)
  })

  it('adopts an accepted catalogue when only the credential write fails', async () => {
    const { stub, operations, face, snapshot } = await bench()
    operations.storeCredential.mockResolvedValue('credential/rejected')

    face.editRow(1, 'contextWindow', ' 200000 ')
    face.editToken('sk-refused')
    face.save()

    await vi.waitFor(() => { expect(snapshot().saveError).toEqual({ kind: 'credential', message: 'credential/rejected' }) })
    // The catalogue landed; only the key stays staged for another attempt.
    expect(snapshot().rows[1]?.draft.contextWindow).toBe('200000')
    expect(snapshot().dirty).toBe(true)

    operations.storeCredential.mockResolvedValue(undefined)
    face.save()
    await vi.waitFor(() => { expect(snapshot().token.text).toBe('') })
    expect(stub.mutate).toHaveBeenCalledOnce()
    expect(snapshot().failed).toBe(false)
    expect(snapshot().saveError).toBeUndefined()
    expect(snapshot().dirty).toBe(false)
  })

  it('marks the catalogue overridden from the user layer', async () => {
    const { stub, snapshot } = await bench()
    stub.publish({ user: { models: CATALOGUE.slice(0, 1) } })

    expect(snapshot().overridden).toBe(true)
  })

  it('follows an external Host change while nothing is staged and keeps staged edits otherwise', async () => {
    const { stub, face, snapshot } = await bench()

    stub.publish({ value: { models: CATALOGUE.slice(0, 2) }, revision: 4 })
    await vi.waitFor(() => { expect(snapshot().rows).toHaveLength(2) })

    face.editRow(0, 'id', 'claude-sonnet-5-6')
    stub.publish({ value: { models: CATALOGUE.slice(0, 1) }, revision: 5 })
    await vi.waitFor(() => { expect(snapshot().rows[0]?.draft.id).toBe('claude-sonnet-5-6') })
    expect(snapshot().rows).toHaveLength(2)
  })

  it('drops every draft on discard and releases the subscription on dispose', async () => {
    const { stub, face, page, snapshot } = await bench()

    face.editRow(0, 'name', 'Sonnet')
    face.editToken('sk-draft')
    face.discard()
    expect(snapshot().token.text).toBe('')
    expect(snapshot().rows[0]?.draft.name).toBe(CATALOGUE[0]?.name)
    expect(snapshot().dirty).toBe(false)

    expect(stub.listenerCount()).toBe(1)
    page.dispose()
    expect(stub.listenerCount()).toBe(0)
  })

  it('renders a section that has not arrived yet as loading', async () => {
    const stub = stubConfigForm<CcPoolSettings>()
    const page = new CcPoolSettingsPage(stub.scope, credentialOperations())

    const state = page.inject().hooks.ccPool.getSnapshot()
    expect(state.loading).toBe(true)
    expect(state.available).toBe(false)
    expect(state.rows).toEqual([])
    page.dispose()
  })

  it('writes nothing on a save with no staged edit', async () => {
    const { stub, operations, face, snapshot } = await bench()

    face.save()
    await vi.waitFor(() => { expect(snapshot().saving).toBe(false) })
    expect(stub.mutate).not.toHaveBeenCalled()
    expect(operations.storeCredential).not.toHaveBeenCalled()
  })

  it('writes only the credential when only the token is staged', async () => {
    const { stub, operations, face, snapshot } = await bench()

    face.editToken('sk-only')
    face.save()
    await vi.waitFor(() => { expect(operations.storeCredential).toHaveBeenCalledOnce() })
    expect(stub.mutate).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(snapshot().token.text).toBe('') })
  })

  it('keeps the drafts when the settings transport rejects the write', async () => {
    const { stub, face, snapshot } = await bench()
    stub.mutate.mockRejectedValue(new Error('transport down'))

    face.editRow(0, 'name', 'Sonnet')
    face.save()

    await vi.waitFor(() => { expect(snapshot().failed).toBe(true) })
    expect(snapshot().saveError).toEqual({ kind: 'transport' })
    expect(snapshot().saving).toBe(false)
    expect(snapshot().rows[0]?.draft.name).toBe('Sonnet')
  })

  it('stages an empty catalogue when the composition exposes no base layer', async () => {
    const stub = stubConfigForm<CcPoolSettings>()
    stub.publish({ status: 'ready', value: { models: CATALOGUE }, revision: 1, writable: true })
    const page = new CcPoolSettingsPage(stub.scope, credentialOperations())

    page.inject().resetModels()

    expect(page.inject().hooks.ccPool.getSnapshot().rows).toEqual([])
    expect(page.inject().hooks.ccPool.getSnapshot().resetPending).toBe(true)
    page.dispose()
  })
})

/** One promise plus its resolver, for scripting an in-flight Host call. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

describe('CcPoolSettingsPage pool sync', () => {
  it('merges the pool listing into the table without writing the settings document', async () => {
    const { stub, operations, face, snapshot } = await benchWithCredential()
    operations.discoverModels.mockResolvedValue({
      kind: 'found',
      models: [
        { id: 'claude-sonnet-5-5', name: 'Renamed by the pool' },
        ...POOL_IDS.slice(1),
        POOL_ADDITION,
      ],
    })
    face.editRow(0, 'maxTokens', '32000')

    face.syncModels()
    await vi.waitFor(() => { expect(snapshot().sync.running).toBe(false) })

    expect(operations.discoverModels).toHaveBeenCalledWith(
      CC_POOL_NS,
      { provider: CC_POOL_PROVIDER },
      expect.any(AbortSignal),
    )
    expect(stub.mutate).not.toHaveBeenCalled()
    expect(snapshot().sync.error).toBeUndefined()
    expect(snapshot().sync.pendingRemoval).toBeUndefined()
    expect(snapshot().rows.map(row => row.draft.id)).toEqual([...POOL_IDS.map(model => model.id), POOL_ADDITION.id])
    // An existing row keeps every field the user already holds, the pool's new
    // display name included in what it does not overwrite.
    expect(snapshot().rows[0]).toMatchObject({
      synced: false,
      draft: { name: 'Claude Sonnet 5.5', maxTokens: '32000' },
    })
    expect(snapshot().rows[4]).toMatchObject({
      synced: true,
      draft: {
        id: 'claude-nova-5', name: 'Claude Nova 5', contextWindow: '1000000', maxTokens: '128000', defaultReasoning: 'medium',
      },
    })
    expect(snapshot().dirty).toBe(true)

    face.save()
    await vi.waitFor(() => { expect(stub.mutate).toHaveBeenCalledOnce() })
    const ops: readonly SettingsFormPathOp[] = stub.mutate.mock.calls[0]?.[0] ?? []
    expect(ops[0]).toMatchObject({ op: 'set', path: ['models'] })
    const written = ops[0]?.op === 'set' ? ops[0].value as CcPoolModel[] : []
    expect(written.map(model => model.id)).toEqual([...POOL_IDS.map(model => model.id), POOL_ADDITION.id])
    expect(written[0]).toMatchObject({ maxTokens: 32_000 })
    expect(written[4]).toMatchObject({
      id: 'claude-nova-5', contextWindow: 1_000_000, maxTokens: 128_000, defaultReasoning: 'medium',
    })
    await vi.waitFor(() => { expect(snapshot().saving).toBe(false) })
    // A saved row is no longer an unreviewed addition.
    expect(snapshot().rows.every(row => !row.synced)).toBe(true)
  })

  it('asks before dropping rows the pool no longer lists and drops them on confirm', async () => {
    const { stub, operations, face, snapshot } = await benchWithCredential()
    operations.discoverModels.mockResolvedValue({ kind: 'found', models: [{ id: 'claude-sonnet-5-5' }, POOL_ADDITION] })

    face.syncModels()
    await vi.waitFor(() => {
      expect(snapshot().sync.pendingRemoval).toEqual(['claude-opus-5-5', 'claude-fable-5-1', 'claude-mythos-5-1'])
    })
    // Nothing is staged or written while the confirmation is pending.
    expect(snapshot().rows.map(row => row.draft.id)).toEqual(CATALOGUE.map(model => model.id))
    expect(snapshot().dirty).toBe(false)
    expect(stub.mutate).not.toHaveBeenCalled()

    face.confirmSyncRemoval()

    expect(snapshot().sync.pendingRemoval).toBeUndefined()
    expect(snapshot().rows.map(row => row.draft.id)).toEqual(['claude-sonnet-5-5', 'claude-nova-5'])
    expect(snapshot().rows[1]?.synced).toBe(true)
    expect(snapshot().dirty).toBe(true)
  })

  it('keeps the rows the pool no longer lists when the user keeps them', async () => {
    const { operations, face, snapshot } = await benchWithCredential()
    operations.discoverModels.mockResolvedValue({ kind: 'found', models: [{ id: 'claude-sonnet-5-5' }, POOL_ADDITION] })

    face.syncModels()
    await vi.waitFor(() => { expect(snapshot().sync.pendingRemoval).toHaveLength(3) })
    face.keepSyncRows()

    expect(snapshot().sync.pendingRemoval).toBeUndefined()
    expect(snapshot().rows.map(row => row.draft.id)).toEqual([...CATALOGUE.map(model => model.id), 'claude-nova-5'])
  })

  it('cancels the whole sync when the removal confirmation is dismissed', async () => {
    const { operations, face, snapshot } = await benchWithCredential()
    operations.discoverModels.mockResolvedValue({ kind: 'found', models: [{ id: 'claude-sonnet-5-5' }, POOL_ADDITION] })

    face.syncModels()
    await vi.waitFor(() => { expect(snapshot().sync.pendingRemoval).toHaveLength(3) })
    face.cancelSync()

    // Closing the prompt drops the merge: no row is dropped and the pool's
    // additions are not staged either.
    expect(snapshot().sync.pendingRemoval).toBeUndefined()
    expect(snapshot().rows.map(row => row.draft.id)).toEqual(CATALOGUE.map(model => model.id))
    expect(snapshot().dirty).toBe(false)
  })

  it('stages nothing when the table already matches the pool', async () => {
    const { stub, operations, face, snapshot } = await benchWithCredential()
    operations.discoverModels.mockResolvedValue({ kind: 'found', models: POOL_IDS })

    face.syncModels()
    await vi.waitFor(() => { expect(snapshot().sync.running).toBe(false) })

    expect(snapshot().dirty).toBe(false)
    expect(snapshot().sync.pendingRemoval).toBeUndefined()
    // An unchanged merge leaves no staged edit behind, so an accepted Host
    // change still reseeds the table.
    stub.publish({ value: { models: CATALOGUE.slice(0, 2) }, revision: 4 })
    await vi.waitFor(() => { expect(snapshot().rows).toHaveLength(2) })
  })

  it.each([
    ['an empty listing', { kind: 'found', models: [] }, 'syncEmpty'],
    ['a repeated id', { kind: 'found', models: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-sonnet-5-5' }] }, 'syncDuplicate'],
    ['an unusable id', { kind: 'found', models: [{ id: '  ' }] }, 'syncInvalid'],
  ] as const)('leaves the table untouched on %s', async (_name, answer, key) => {
    const { stub, operations, face, snapshot } = await benchWithCredential()
    operations.discoverModels.mockResolvedValue(answer)

    face.syncModels()
    await vi.waitFor(() => { expect(snapshot().sync.error).toEqual({ kind: 'copy', key }) })

    expect(snapshot().rows.map(row => row.draft.id)).toEqual(CATALOGUE.map(model => model.id))
    expect(snapshot().dirty).toBe(false)
    expect(stub.mutate).not.toHaveBeenCalled()
  })

  it('reports a refused interrogation with the Host diagnostic', async () => {
    const { stub, operations, face, snapshot } = await benchWithCredential()
    operations.discoverModels.mockResolvedValue({
      kind: 'refused',
      message: 'no model discovery is registered for "llm-cc-pool"',
    })

    face.syncModels()
    await vi.waitFor(() => {
      expect(snapshot().sync.error).toEqual({ kind: 'host', message: 'no model discovery is registered for "llm-cc-pool"' })
    })
    expect(snapshot().rows.map(row => row.draft.id)).toEqual(CATALOGUE.map(model => model.id))
    expect(stub.mutate).not.toHaveBeenCalled()
  })

  it('reports a failed transport and keeps the table', async () => {
    const { operations, face, snapshot } = await benchWithCredential()
    operations.discoverModels.mockRejectedValue(new Error('transport down'))

    face.syncModels()
    await vi.waitFor(() => { expect(snapshot().sync.error).toEqual({ kind: 'host', message: 'transport down' }) })
    expect(snapshot().sync.running).toBe(false)
    expect(snapshot().rows.map(row => row.draft.id)).toEqual(CATALOGUE.map(model => model.id))
  })

  it('reports a rejection that arrives without an Error', async () => {
    const { operations, face, snapshot } = await benchWithCredential()
    operations.discoverModels.mockImplementation(
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a rejected Remote call need not carry an Error.
      () => Promise.reject('connection closed'),
    )

    face.syncModels()
    await vi.waitFor(() => { expect(snapshot().sync.error).toEqual({ kind: 'host', message: 'connection closed' }) })
    expect(snapshot().rows.map(row => row.draft.id)).toEqual(CATALOGUE.map(model => model.id))
  })

  it('ignores a removal decision no merge is waiting on', async () => {
    const { face, snapshot } = await benchWithCredential()
    const before = snapshot()

    face.confirmSyncRemoval()
    face.keepSyncRows()
    face.cancelSync()

    expect(snapshot().rows.map(row => row.draft.id)).toEqual(before.rows.map(row => row.draft.id))
    expect(snapshot().sync.pendingRemoval).toBeUndefined()
    expect(snapshot().dirty).toBe(before.dirty)
  })

  it('refuses to sync while no pool token is stored', async () => {
    const { operations, page, face, snapshot } = await bench()
    await page.refreshCredential()

    face.syncModels()
    await vi.waitFor(() => { expect(snapshot().sync.error).toEqual({ kind: 'copy', key: 'syncNoToken' }) })

    expect(operations.discoverModels).not.toHaveBeenCalled()
    expect(snapshot().rows.map(row => row.draft.id)).toEqual(CATALOGUE.map(model => model.id))
  })

  it('asks the Host to sync before the credential read settles', async () => {
    const stub = stubConfigForm<CcPoolSettings>()
    stub.publish({ status: 'ready', value: { models: CATALOGUE }, base: { models: CATALOGUE }, revision: 3, writable: true })
    const operations = credentialOperations()
    operations.describeCredential.mockReturnValue(new Promise(() => {}))
    operations.discoverModels.mockResolvedValue({ kind: 'found', models: POOL_IDS })
    const page = new CcPoolSettingsPage(stub.scope, operations)

    page.inject().syncModels()
    await vi.waitFor(() => { expect(operations.discoverModels).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(page.inject().hooks.ccPool.getSnapshot().sync.running).toBe(false) })

    expect(page.inject().hooks.ccPool.getSnapshot().sync.error).toBeUndefined()
    page.dispose()
  })

  it('keeps one discovery in flight at a time', async () => {
    const { operations, face, snapshot } = await benchWithCredential()
    const answer = deferred<CcPoolDiscoveryOutcome>()
    operations.discoverModels.mockReturnValue(answer.promise)

    face.syncModels()
    face.syncModels()
    expect(operations.discoverModels).toHaveBeenCalledOnce()
    expect(snapshot().sync.running).toBe(true)

    answer.resolve({ kind: 'found', models: POOL_IDS })
    await vi.waitFor(() => { expect(snapshot().sync.running).toBe(false) })
  })

  it('gives up on a discovery that outlives its deadline and stops showing it as running', async () => {
    const { operations, face, snapshot } = await benchWithCredential()
    let signal: AbortSignal | undefined
    operations.discoverModels.mockImplementation((_ns, _request, received) => {
      signal = received
      // A Host that never answers: only the page's deadline releases the control.
      return new Promise<CcPoolDiscoveryOutcome>(() => {})
    })
    vi.useFakeTimers()
    try {
      face.syncModels()
      expect(snapshot().sync.running).toBe(true)

      await vi.advanceTimersByTimeAsync(CC_POOL_SYNC_TIMEOUT_MS)

      expect(signal?.aborted).toBe(true)
      expect(snapshot().sync.running).toBe(false)
      expect(snapshot().sync.error).toEqual({ kind: 'copy', key: 'syncTimeout' })
      expect(snapshot().rows.map(row => row.draft.id)).toEqual(CATALOGUE.map(model => model.id))
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a discovery in flight when the drafts are discarded or the page leaves', async () => {
    const { operations, page, face, snapshot } = await benchWithCredential()
    const signals: AbortSignal[] = []
    operations.discoverModels.mockImplementation((_ns, _request, received) => {
      if (received !== undefined) signals.push(received)
      return new Promise<CcPoolDiscoveryOutcome>(() => {})
    })

    face.syncModels()
    expect(snapshot().sync.running).toBe(true)
    face.discard()

    expect(signals[0]?.aborted).toBe(true)
    expect(snapshot().sync.running).toBe(false)
    expect(snapshot().sync.error).toBeUndefined()
    expect(snapshot().rows.map(row => row.draft.id)).toEqual(CATALOGUE.map(model => model.id))

    // A later sync is a new request, and leaving the page cancels that one too.
    face.syncModels()
    expect(snapshot().sync.running).toBe(true)
    page.dispose()

    expect(signals[1]?.aborted).toBe(true)
  })

  it('drops a discovery rejection that arrives after the request was cancelled', async () => {
    const { operations, page, face, snapshot } = await benchWithCredential()
    operations.discoverModels.mockImplementation((_ns, _request, signal) => new Promise<CcPoolDiscoveryOutcome>((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(new Error('the read was cancelled')) }, { once: true })
    }))

    // The real read rejects when the page aborts it; a discarded sync reports
    // nothing, and a disposed one has no page left to report to.
    face.syncModels()
    face.discard()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(snapshot().sync.running).toBe(false)
    expect(snapshot().sync.error).toBeUndefined()

    face.syncModels()
    page.dispose()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(snapshot().sync.error).toBeUndefined()
  })

  it('supersedes a staged reset only when the merge changes the table', async () => {
    const { operations, face, snapshot } = await benchWithCredential()
    face.resetModels()
    expect(snapshot().resetPending).toBe(true)

    // A listing that matches the shown rows leaves the staged reset alone.
    operations.discoverModels.mockResolvedValue({ kind: 'found', models: POOL_IDS })
    face.syncModels()
    await vi.waitFor(() => { expect(snapshot().sync.running).toBe(false) })
    expect(snapshot().resetPending).toBe(true)

    // A listing that adds a row stages the merge and supersedes the reset.
    operations.discoverModels.mockResolvedValue({ kind: 'found', models: [...POOL_IDS, POOL_ADDITION] })
    face.syncModels()
    await vi.waitFor(() => { expect(snapshot().rows).toHaveLength(5) })
    expect(snapshot().resetPending).toBe(false)
  })

  it('drops a pending removal when the drafts are discarded', async () => {
    const { operations, face, snapshot } = await benchWithCredential()
    operations.discoverModels.mockResolvedValue({ kind: 'found', models: [{ id: 'claude-sonnet-5-5' }] })

    face.syncModels()
    await vi.waitFor(() => { expect(snapshot().sync.pendingRemoval).toHaveLength(3) })

    face.discard()

    expect(snapshot().sync.pendingRemoval).toBeUndefined()
    expect(snapshot().rows.map(row => row.draft.id)).toEqual(CATALOGUE.map(model => model.id))
    expect(snapshot().dirty).toBe(false)
  })

  it('ignores the sync control while a save is in flight or the section is not writable', async () => {
    const { stub, operations, face, snapshot } = await benchWithCredential()
    const save = deferred<boolean>()
    stub.mutate.mockReturnValue(save.promise)

    face.editRow(0, 'name', 'Sonnet')
    face.save()
    expect(snapshot().saving).toBe(true)
    face.syncModels()
    expect(operations.discoverModels).not.toHaveBeenCalled()

    save.resolve(true)
    await vi.waitFor(() => { expect(snapshot().saving).toBe(false) })
    stub.publish({ writable: false })
    face.syncModels()
    expect(operations.discoverModels).not.toHaveBeenCalled()
  })

  it('drops a discovery answer that arrives after the page left', async () => {
    const { operations, page, face, snapshot } = await benchWithCredential()
    const answer = deferred<CcPoolDiscoveryOutcome>()
    operations.discoverModels.mockReturnValue(answer.promise)
    const shipped = snapshot()

    face.syncModels()
    page.dispose()
    answer.resolve({ kind: 'found', models: [...POOL_IDS, POOL_ADDITION] })
    await answer.promise
    await Promise.resolve()

    // The disposed page stages nothing; the last published projection stands.
    expect(snapshot().rows.map(row => row.draft.id)).toEqual(shipped.rows.map(row => row.draft.id))
    expect(snapshot().sync.pendingRemoval).toBeUndefined()
  })
})
