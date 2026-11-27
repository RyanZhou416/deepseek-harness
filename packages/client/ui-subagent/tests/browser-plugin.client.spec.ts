/** ui-subagent browser half: catalog actions and read-only composer routing. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Context } from '@deepseek-ai/cordis'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type {
  SessionListState, SessionSnapshot, SessionSummary, SessionProjectionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SubagentAddress, SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { SubagentHeaderLineage } from '../src/client/SubagentHeaderLineage.tsx'
import { CATALOG_PAGE, type SubagentCatalogInjected } from '../src/client/SubagentCatalog.tsx'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { en } from '../src/client/locales.ts'
import {
  SubagentReadOnlyComposer, type SubagentReadOnlyMatch,
} from '../src/client/SubagentReadOnlyComposer.tsx'
import { apply, inject } from '../src/client/index.ts'

function summary(partial: Partial<SessionSummary> & { id: SessionId }): SessionSummary {
  return {
    displayTitle: partial.id,
    running: false,
    retainedBy: {},
    updatedAt: 0,
    ...partial,
  } as SessionSummary
}

const sid = (id: string) => id as SessionId

/** Fake root sessions face for catalog actions. */
function sessionsWith(sessions: SessionSummary[]) {
  const byId: Record<string, SessionSummary> = {}
  for (const s of sessions) byId[s.id] = s
  const projections: Record<SessionId, SessionProjectionSnapshot> = {}
  const snapshot: SessionListState = { ids: sessions.map(s => s.id), byId, phase: 'ready', projectionsBySession: projections }
  const actionCalls: { method: string; args: unknown[] }[] = []
  const older: Record<SessionId, SubagentCatalogEntry[]> = {}
  const address: SubagentAddress = {
    parentSessionId: sid('parent'),
    childSessionId: sid('c1'),
    mode: 'continuable',
  }
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
    },
    actionCalls,
    projections,
    subagentAddress: (childSessionId: SessionId) => childSessionId === address.childSessionId
      ? address
      : undefined,
    refreshProjections: (parentSessionId: SessionId) => {
      actionCalls.push({ method: 'refreshProjections', args: [parentSessionId] })
      return Promise.resolve()
    },
    /** Older catalog entries the Host still holds per Session, oldest first; absent means the push was complete. */
    older,
    loadProjectionPage: (sessionId: SessionId, key: string, limit: number) => {
      actionCalls.push({ method: 'loadProjectionPage', args: [sessionId, key, limit] })
      const current = projections[sessionId]
      if (current !== undefined) {
        const unread = older[sessionId] ?? []
        const page = unread.slice(Math.max(0, unread.length - limit))
        older[sessionId] = unread.slice(0, unread.length - page.length)
        projections[sessionId] = {
          ...current,
          values: { ...current.values, subagentCatalog: [...page, ...current.values.subagentCatalog ?? []] },
          unread: { subagentCatalog: unread.length - page.length },
        }
      }
      return Promise.resolve()
    },
  }
}

async function provideSlotFaces(ctx: Context): Promise<void> {
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.lineage': { kind: 'single', scope: 'session' },
      'conversation.session.panel.section': { kind: 'list', scope: 'session' },
      'conversation.session.panel.section.actions': { kind: 'keyed', scope: 'session' },
      'conversation.session.panel.indicator': { kind: 'list', scope: 'session' },
      'conversation.composer': { kind: 'chain', scope: 'session' },
    },
  } as never, () => null)
}

/** Boot the plugin over fake sessions and slot faces. */
async function fullBench(sessions: SessionSummary[]) {
  const ctx = new Context()
  const face = sessionsWith(sessions)
  ctx.provide('sessions', face)
  ctx.provide('uiWorkspace', {
    openSession: (address: SubagentAddress) => {
      face.actionCalls.push({ method: 'openSession', args: [address] })
    },
  } as never)
  ctx.provide('sidebarRight', {
    openResource: (address: string, options: unknown) => {
      face.actionCalls.push({ method: 'openResource', args: [address, options] })
    },
  } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('uiSession.sessionStatus', createSnapshotStore(new Map()) as never)
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  await provideSlotFaces(ctx)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { face, ctx }
}

const FAMILY: SessionSummary[] = [
  summary({ id: sid('parent'), displayTitle: 'parent', running: true }),
  summary({ id: sid('c1'), parentId: sid('parent'), displayTitle: 'worker-1', running: true }),
  summary({ id: sid('c2'), parentId: sid('parent'), displayTitle: 'worker-2', running: true }),
  // Filtered out: not running / other parent / label miss.
  summary({ id: sid('c3'), parentId: sid('parent'), displayTitle: 'worker-3', running: false }),
  summary({ id: sid('c4'), parentId: sid('other'), displayTitle: 'worker-4', running: true }),
  summary({ id: sid('c5'), parentId: sid('parent'), displayTitle: 'scout', running: true }),
]

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['sessions', 'uiWorkspace', 'slots', 'locale', 'sidebarRight', 'uiSession.sessionStatus'])
  })

  it('keeps the root catalog extension available when optional Sidebar services arrive', async () => {
    const { ctx } = await fullBench(FAMILY)
    onTestFinished(() => ctx.fiber.dispose())
    const registerResource = vi.fn(() => () => {})
    const registerTab = vi.fn(() => () => {})
    ctx.provide('resources', { register: registerResource } as never)
    ctx.provide('sidebarRightTabs', { register: registerTab } as never)
    await vi.waitFor(() => { expect(registerResource).toHaveBeenCalledOnce() })
    expect(registerTab).toHaveBeenCalledOnce()
    expect(ctx.slots.entries('conversation.session.panel.section').map(entry => entry.options.id)).toEqual(['subagents'])
  })

  it('reads the parent, then the shown children together, newest first', async () => {
    const { ctx, face } = await fullBench([...FAMILY, summary({ id: sid('legacy'), formatStatus: 'migration-required' })])
    onTestFinished(() => ctx.fiber.dispose())
    const entry = ctx.slots.entries('conversation.session.header.lineage')
      .find(entry => entry.component === SubagentHeaderLineage)!
    const actions = (entry.inject as (id: SessionId) => SubagentCatalogInjected)(sid('parent'))
    const projections = face.projections
    const held = Promise.withResolvers<undefined>()
    const refresh = vi.spyOn(face, 'refreshProjections').mockImplementation(async (id) => {
      if (id === sid('parent')) projections[id] = { state: 'ready', error: null, values: { subagentCatalog: [
        { id: sid('external'), mode: 'external', createdAt: 9 },
        ...['legacy', 'blocked', 'failed'].map(id => ({ id: sid(id), mode: 'one-shot' as const, createdAt: 8 })),
        { id: sid('c1'), mode: 'one-shot', createdAt: 2 },
        { id: sid('c2'), mode: 'one-shot', createdAt: 3 },
      ] } }
      if (id === sid('c1')) {
        await held.promise
        projections[id] = { state: 'ready', error: null, values: { subagentCatalog: [
          { id: sid('grandchild'), mode: 'one-shot', createdAt: 1 },
        ] } }
      }
    })
    onTestFinished(() => { refresh.mockRestore() })
    projections[sid('blocked')] = { state: 'migration-required', error: null, values: {} }
    projections[sid('failed')] = { state: 'error', error: null, values: {} }
    const reading = actions.prepareCatalog(sid('parent'))
    // c2 is requested while c1 is still pending: children are read together, newest first.
    await vi.waitFor(() => { expect(refresh.mock.calls).toEqual([[sid('parent')], [sid('c2')], [sid('c1')]]) })
    held.resolve(undefined)
    await reading
    expect(projections[sid('c1')]?.values.subagentCatalog).toHaveLength(1)
    // A level that is not ready reads no children; a ready level without a catalog reads none either.
    refresh.mockClear()
    await actions.prepareCatalog(sid('c2'))
    projections[sid('c2')] = { state: 'ready', error: null, values: {} }
    await actions.prepareCatalog(sid('c2'))
    expect(refresh.mock.calls).toEqual([[sid('c2')], [sid('c2')]])
  })

  it('reads only the child catalogs of the shown page and the next page on request', async () => {
    const { ctx, face } = await fullBench(FAMILY)
    onTestFinished(() => ctx.fiber.dispose())
    const entry = ctx.slots.entries('conversation.session.header.lineage')
      .find(entry => entry.component === SubagentHeaderLineage)!
    const actions = (entry.inject as (id: SessionId) => SubagentCatalogInjected)(sid('parent'))
    const projections = face.projections
    const children = Array.from({ length: CATALOG_PAGE + 7 }, (_, index) => ({
      id: sid(`many-${String(index)}`), mode: 'one-shot' as const, createdAt: index,
    }))
    const refresh = vi.spyOn(face, 'refreshProjections').mockImplementation(async (id) => {
      if (id === sid('parent')) projections[id] = { state: 'ready', error: null, values: { subagentCatalog: children } }
    })
    onTestFinished(() => { refresh.mockRestore() })
    await actions.prepareCatalog(sid('parent'))
    const firstPage = refresh.mock.calls.slice(1).map(([id]) => id)
    expect(firstPage).toHaveLength(CATALOG_PAGE)
    expect(firstPage[0]).toBe(sid(`many-${String(CATALOG_PAGE + 6)}`))
    expect(firstPage).not.toContain(sid('many-0'))
    refresh.mockClear()
    await actions.prepareCatalog(sid('parent'), CATALOG_PAGE * 2)
    expect(refresh.mock.calls.map(([id]) => id)).toContain(sid('many-0'))
  })

  it('reads older catalog pages until the shown rows are known', async () => {
    const { ctx, face } = await fullBench(FAMILY)
    onTestFinished(() => ctx.fiber.dispose())
    const entry = ctx.slots.entries('conversation.session.header.lineage')
      .find(entry => entry.component === SubagentHeaderLineage)!
    const actions = (entry.inject as (id: SessionId) => SubagentCatalogInjected)(sid('parent'))
    const all = Array.from({ length: 500 }, (_, index) => ({ id: sid(`old-${String(index)}`), mode: 'one-shot' as const, createdAt: index }))
    face.older[sid('parent')] = all.slice(0, 468)
    const refresh = vi.spyOn(face, 'refreshProjections').mockImplementation(async (id) => {
      if (id === sid('parent')) face.projections[id] ??= { state: 'ready', error: null, values: { subagentCatalog: all.slice(468) } }
    })
    onTestFinished(() => { refresh.mockRestore() })
    await actions.prepareCatalog(sid('parent'))
    const pageReads = () => face.actionCalls.filter(call => call.method === 'loadProjectionPage')
    // The first activation reads one older page even when the pushed window already fills the shown rows.
    expect(pageReads()).toEqual([{ method: 'loadProjectionPage', args: [sid('parent'), 'subagentCatalog', 200] }])
    expect(face.projections[sid('parent')]?.unread).toEqual({ subagentCatalog: 268 })
    await actions.prepareCatalog(sid('parent'), 400)
    expect(pageReads()).toHaveLength(2)
    expect(face.projections[sid('parent')]?.values.subagentCatalog).toHaveLength(432)
    await actions.prepareCatalog(sid('parent'), 1000)
    expect(pageReads()).toHaveLength(3)
    expect(face.projections[sid('parent')]?.unread).toEqual({ subagentCatalog: 0 })
    await actions.prepareCatalog(sid('parent'), 1000)
    expect(pageReads()).toHaveLength(3)
  })
  it('stops reading older pages when a read leaves the unread count unchanged', async () => {
    const { ctx, face } = await fullBench(FAMILY)
    onTestFinished(() => ctx.fiber.dispose())
    const entry = ctx.slots.entries('conversation.session.header.lineage')
      .find(entry => entry.component === SubagentHeaderLineage)!
    const actions = (entry.inject as (id: SessionId) => SubagentCatalogInjected)(sid('parent'))
    face.projections[sid('parent')] = { state: 'ready', error: null, values: {} }
    const load = vi.spyOn(face, 'loadProjectionPage').mockResolvedValue(undefined)
    const refresh = vi.spyOn(face, 'refreshProjections')
    onTestFinished(() => { load.mockRestore(); refresh.mockRestore() })
    await actions.prepareCatalog(sid('parent'))
    expect(load).toHaveBeenCalledOnce()
    expect(refresh.mock.calls).toEqual([[sid('parent')]])
  })
  it('registers catalog actions and selects read-only subagent composers from session facts', async () => {
    const { ctx, face } = await fullBench(FAMILY)
    const catalogEntry = ctx.slots.entries('conversation.session.header.lineage')
      .find(entry => entry.component === SubagentHeaderLineage)!
    const actions = (catalogEntry.inject as unknown as (id: SessionId) => SubagentCatalogInjected)(sid('parent'))
    const address: SubagentAddress = {
      parentSessionId: sid('parent'),
      childSessionId: sid('c1'),
      mode: 'continuable',
    }
    actions.openChild(address)
    actions.openChildAside(address)
    actions.refreshProjection(sid('parent'))
    expect(face.actionCalls).toEqual([
      { method: 'openSession', args: [address] },
      {
        method: 'openResource',
        args: [
          'dsh-resource://subagentchat/session/c1?parent=parent&mode=continuable',
          { kind: 'subagentchat', preferNewPane: true },
        ],
      },
      { method: 'refreshProjections', args: [sid('parent')] },
    ])

    // The Session panel section registers with the same business face,
    // after change requests (100) and before background jobs (300), together
    // with its progress control beside the title.
    const sectionEntry = ctx.slots.entries('conversation.session.panel.section')
      .find(entry => entry.options.id === 'subagents')!
    expect(sectionEntry.options.order).toBe(200)
    expect(resolveSlotLabel(sectionEntry.options.label)).toBe(en['section.title'])
    expect(ctx.slots.entries('conversation.session.panel.section.actions').map(entry => entry.options.key)).toEqual(['subagents'])
    expect(ctx.slots.entries('conversation.session.panel.indicator')[0]).toMatchObject({ options: { id: 'subagents.running', order: 10 } })
    const sectionActions = (sectionEntry.inject as (id: SessionId) => SubagentCatalogInjected)(sid('parent'))
    expect(Object.keys(sectionActions).sort()).toEqual(['openChild', 'openChildAside', 'prepareCatalog', 'refreshProjection'])

    const composerEntry = ctx.slots.entries('conversation.composer')
      .find(entry => entry.component === SubagentReadOnlyComposer)!
    const select = composerEntry.select as (owner: ComposerChainProps) => SubagentReadOnlyMatch | null
    const owner = (
      subagent: SessionSnapshot['subagent'] | undefined,
      running = false,
    ): ComposerChainProps => ({
      sessionId: subagent?.address.childSessionId,
      session: subagent === undefined
        ? undefined
        : ({ subagent, running } as SessionSnapshot),
      pendingInteraction: undefined,
    })
    expect(select(owner(undefined))).toBeNull()
    expect(select(owner(null))).toBeNull()
    expect(select(owner({ address: { ...address, mode: 'one-shot' } })))
      .toEqual({ reason: 'one-shot' })
    // One-shot stays read-only even while running: it has no stop action.
    expect(select(owner({ address: { ...address, mode: 'one-shot' } }, true)))
      .toEqual({ reason: 'one-shot' })
    expect(select(owner({ address: { ...address, mode: 'unknown' } })))
      .toEqual({ reason: 'unknown' })
    expect(select(owner({ address }))).toBeNull()
    expect(select(owner({ address }, true))).toBeNull()
  })
})
