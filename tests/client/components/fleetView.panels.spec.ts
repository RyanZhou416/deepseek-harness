
import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeFleetView } from '../../../src/client/components/fleetView'
import { makeAgentHeads } from '../../../src/client/agentHeads'
import { DICT_EN } from '../../../src/client/i18n'
import { resetTimelineDetailStores } from '../../../src/client/timelineSource'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, hover, makeKit, mount, query, queryAll, text, until } from '../helpers/kit'
import { projectionsFor, richTimeline } from './contextViewHarness'

const kit = makeKit()

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetTimelineDetailStores()
})

const TEAM_PROJECTION = {
  members: [
    { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
    { id: 'w1', name: 'worker-bee', role: 'teammate', phase: 'active' },
    { id: 'w9', name: 'ghost-nine', role: 'teammate', phase: 'active' },
  ],
  tasks: [
    { id: 'task-1', revision: 1, subject: 'schema parsing', description: 'Parse it.', status: 'in_progress', ownerName: 'worker-bee', blockedBy: [], writeScopes: ['src/'], ready: false, writeScopeWarnings: [] },
  ],
}

function familySessions(base = 10) {
  const snapshot = {
    byId: {
      root: { displayTitle: 'Main Agent', running: true, updatedAt: base, projectionValues: { agentTeam: TEAM_PROJECTION } },
      w1: {
        parentId: 'root', origin: 'subagent', running: true, updatedAt: base - 2,
        projectionValues: { subagent: { mode: 'continuable', label: 'worker-bee' }, subagentTiming: { settledMs: 42000 } },
      },
      w2: {
        parentId: 'root', origin: 'subagent', running: false, updatedAt: base - 4,
        projectionValues: { subagent: { mode: 'one-shot', label: 'side-quest' }, subagentTiming: { settledMs: 9000, lastTurnCompleted: true } },
      },
    },
  }
  return {
    list: { getSnapshot: (): unknown => snapshot, subscribe: (): (() => void) => () => {} },
  }
}

function stubFleetRoute(): void {
  vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
    const { sessionId } = JSON.parse(init.body) as { sessionId: string }
    const value = sessionId === 'w1'
      ? {
        descriptor: { mode: 'continuable', label: 'worker-bee', provider: 'spawn', agentModel: 'deepseek-v4' },
        initialPrompt: 'Review the schema parser.',
        messages: [
          { seq: 9, time: 1_700_000_000_000, kind: 'relay', from: 'root', text: 'how far along?' },
          { seq: 8, time: 1_699_999_000_000, kind: 'relay', from: 'w9', text: 'ghost says hi' },
          { seq: 7, time: 1_699_998_000_000, kind: 'relay', from: 'stranger', text: 'who dis' },
          { seq: 6, time: 1_699_997_000_000, kind: 'relay', from: 'root', text: 'second from lead' },
          { seq: 5, time: 1_699_996_000_000, kind: 'relay', from: 'w1', text: 'note to self' },
          { seq: 4, time: 1_699_995_000_000, kind: 'mailbox', text: 'anonymous delivery' },
        ],
        truncated: false,
      }
      : { messages: [], truncated: false }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value }) } as Response)
  })
}

function makeView(ctx: TestClientCtx, useKit = kit) {
  return makeFleetView(asClientCtx(ctx), useKit, makeAgentHeads())
}

describe('FleetView — the panels over one family', () => {
  test('the other-agents card enter and aside buttons jump to the session, and the aside prefers the right Sidebar\'s subagent chat', async () => {
    stubFleetRoute()
    const opened = new Array<string>()
    const ctx = new TestClientCtx({
      services: { sessions: familySessions(), uiWorkspace: { openSession: (id: string) => { opened.push(id) } } },
    })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    const card = queryAll(m.container, '.lc-member-card').at(-1)!
    await click(query(card, '.lc-member-enter'))
    assert.deepEqual([...opened], ['w2'])
    await click(query(card, '.lc-member-aside'))
    assert.deepEqual([...opened], ['w2', 'w2'], 'the aside falls back to the whole-view jump')
    await m.unmount()
    ctx.dispose()

    const sidebarOpened: { address: string; options: unknown }[] = []
    const sidebarCtx = new TestClientCtx({
      services: {
        sessions: familySessions(),
        sidebarRight: { openResource: (address: string, options?: unknown) => { sidebarOpened.push({ address, options }) } },
      },
    })
    const SidebarView = makeView(sidebarCtx)
    const sidebarMount = await mount(h(SidebarView, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    try {
      await click(query(queryAll(sidebarMount.container, '.lc-member-card').at(-1)!, '.lc-member-aside'))
      assert.deepEqual(sidebarOpened, [{
        address: 'dsh-resource://subagentchat/session/w2?parent=root&mode=one-shot',
        options: { kind: 'subagentchat', preferNewPane: true },
      }])
    } finally {
      await sidebarMount.unmount()
      sidebarCtx.dispose()
    }
  })

  test('overview strip, team chip, members board, task board, and comms all render off the one derivation', async () => {
    stubFleetRoute()
    const ctx = new TestClientCtx({ services: { sessions: familySessions() } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))

    const summary = query(m.container, '.lc-summary')
    assert.ok(text(summary).includes('3 agents'))
    assert.ok(text(summary).includes('2 running'))
    assert.ok(text(summary).includes(DICT_EN['fleet.summary.tasks']))
    assert.ok(text(summary).includes('0/1'))
    assert.ok(text(query(m.container, '.lc-agents')).includes('team · 3 members · 1 tasks'))
    const board = query(m.container, '.lc-members')
    assert.ok(text(board).includes('worker-bee'))
    assert.ok(text(board).includes(DICT_EN['fleet.board.others']))
    assert.equal(queryAll(board, '.lc-member-card').length, 4)
    assert.ok(text(query(m.container, '.lc-tasks')).includes('schema parsing'))
    await until(() => text(query(m.container, '.lc-comms')).includes('Auto-read'), 'the comms hub never rendered')
    assert.equal(queryAll(m.container, '.lc-inspector').length, 0)
    await m.unmount()

    const ZhView = makeView(ctx, makeKit('zh'))
    const zh = await mount(h(ZhView, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    assert.ok(text(query(zh.container, '.lc-members')).includes('其他 Agent'))
    await zh.unmount()
    ctx.dispose()
  })

  test('hovering a member card lights its graph card; pinning sticks and rings both', async () => {
    stubFleetRoute()
    const ctx = new TestClientCtx({ services: { sessions: familySessions() } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))

    const card = queryAll(m.container, '.lc-member-card')[1]
    await hover(card)
    assert.ok(query(m.container, '[data-agent="w1"]').className.includes('lc-agent-hover'))
    assert.ok(query(m.container, '[data-task="task-1"]').className.includes('lc-team-task-hover'))
    await hover(query(m.container, '[data-agent="w1"]'))
    assert.ok(queryAll(m.container, '.lc-member-card')[1].className.includes('lc-member-hover'))
    assert.ok(query(m.container, '[data-task="task-1"]').className.includes('lc-team-task-hover'))
    await click(card)
    assert.ok(query(m.container, '[data-task="task-1"]').className.includes('lc-team-task-related'))
    await hover(queryAll(m.container, '.lc-member-card')[0])
    const node = query(m.container, '[data-agent="w1"]')
    assert.ok(node.className.includes('lc-agent-pinned'))
    assert.ok(!node.className.includes('lc-agent-hover'))
    assert.ok(query(m.container, '.lc-member-pinned') !== null, 'the member card echoes the pin')

    await until(() => text(query(m.container, '.lc-members')).includes('deepseek-v4'), 'the descriptor never landed')
    assert.ok(text(query(m.container, '.lc-members')).includes('1 active tasks'))
    await m.unmount()
    ctx.dispose()
  })

  test('a graph-node pick rings the card and narrows the task board to its tasks', async () => {
    stubFleetRoute()
    const opened = new Array<string>()
    const ctx = new TestClientCtx({
      services: { sessions: familySessions(), uiWorkspace: { openSession: (id: string) => { opened.push(id) } } },
    })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))

    await click(query(m.container, '[data-agent="w1"]'))
    assert.ok(query(m.container, '[data-agent="w1"]').className.includes('lc-agent-pinned'))
    assert.ok(query(m.container, '[data-task="task-1"]').className.includes('lc-team-task-related'))
    assert.ok(text(query(m.container, '.lc-tasks-filter')).includes('worker-bee'))
    assert.deepEqual([...opened], [], 'a pick never jumps')

    await click(query(m.container, '[data-task="task-1"]'))
    assert.ok(query(m.container, '[data-task="task-1"] .lc-ts-card') !== null, 'the opened card boxes up')
    assert.ok(query(m.container, '[data-agent="w1"]').className.includes('lc-agent-pinned'))

    await click(query(m.container, '.lc-tasks-group-head .lc-team-task-owner'))
    assert.equal(queryAll(m.container, '.lc-agent-pinned').length, 0)
    assert.equal(queryAll(m.container, '.lc-tasks-filter').length, 0)

    await click(query(m.container, '[data-agent="w2"]'))
    assert.ok(text(query(m.container, '.lc-tasks-filter')).includes('side-quest'), 'the chip names the subagent, not its id')
    await click(query(m.container, '[data-task="w2"]'))
    await click(query(m.container, '[data-task="w2"] .lc-team-task-box-agent .lc-team-task-owner'))
    assert.equal(queryAll(m.container, '.lc-agent-pinned').length, 0)
    assert.equal(queryAll(m.container, '.lc-tasks-filter').length, 0)

    await click(query(m.container, '[data-agent="w2"]'))
    assert.ok(query(m.container, '[data-agent="w2"]').className.includes('lc-agent-pinned'))
    assert.ok(text(query(m.container, '.lc-tasks-filter')).includes('side-quest'), 'the chip names the subagent, not its id')

    await click(query(m.container, '[data-agent="w2"]'))
    assert.equal(queryAll(m.container, '.lc-agent-pinned').length, 0)
    assert.equal(queryAll(m.container, '.lc-tasks-filter').length, 0)

    await click(query(m.container, '[data-agent="w1"]'))
    assert.ok(text(query(m.container, '.lc-tasks-filter')).includes('worker-bee'))
    await click(query(m.container, '[data-agent="w1"]'))
    assert.equal(queryAll(m.container, '.lc-tasks-filter').length, 0)
    await click(query(m.container, '[data-agent="w1"]'))
    await click(query(m.container, '.lc-tasks-filter'))
    assert.ok(query(m.container, '[data-agent="w1"]').className.includes('lc-agent-pinned'))
    await click(query(m.container, '[data-agent="w1"]'))
    assert.equal(queryAll(m.container, '.lc-agent-pinned').length, 0)

    await click(query(m.container, '.lc-team-task-owner'))
    assert.ok(query(m.container, '[data-agent="w1"]').className.includes('lc-agent-pinned'))
    assert.ok(query(m.container, '.lc-member-pinned') !== null)
    await click(query(m.container, '.lc-team-task-owner'))
    assert.equal(queryAll(m.container, '.lc-agent-pinned').length, 0)
    await m.unmount()
    ctx.dispose()
  })

  test('the comms hub merges the family logs automatically and its detail steers the boards', async () => {
    stubFleetRoute()
    const ctx = new TestClientCtx({ services: { sessions: familySessions() } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))

    await until(() => queryAll(m.container, '.lc-comms-event').length === 6, 'the relays never surfaced')
    const rows = queryAll<HTMLElement>(m.container, '.lc-comms-event')
    assert.ok(text(rows[0]!).includes('Lead'))
    assert.ok(text(rows[0]!).includes('worker-bee'))
    assert.ok(text(rows[0]!).includes('how far along?'))
    assert.ok(text(rows[1]!).includes('ghost-nine'))
    assert.ok(text(rows[2]!).includes('stranger'))

    await click(query(rows[0]!, '.lc-comms-hit'))
    const leadEvent = query(m.container, '.lc-comms-detail')
    const peer = queryAll<HTMLElement>(leadEvent, '.lc-comms-person').find(person => text(person).includes('worker-bee'))!
    await click(queryAll<HTMLElement>(peer, '.lc-inspector-btn')[0]!)
    assert.ok(query(m.container, '[data-agent="w1"]').className.includes('lc-agent-pinned'))
    assert.ok(query(m.container, '.lc-member-pinned') !== null)

    await click(query(rows[0]!, '.lc-comms-hit'))
    const pinned = queryAll<HTMLElement>(m.container, '.lc-comms-person').find(person => text(person).includes('worker-bee'))!
    await click(query(pinned, '.lc-comms-person-pin-on'))
    await until(() => queryAll(m.container, '.lc-agent-pinned, .lc-member-pinned').length === 0, 'the pin never released')

    await click(query(rows[1]!, '.lc-comms-hit'))
    const ghost = queryAll<HTMLElement>(m.container, '.lc-comms-person').find(person => text(person).includes('ghost-nine'))!
    await click(queryAll<HTMLElement>(ghost, '.lc-inspector-btn')[0]!)
    await until(() => queryAll(m.container, '.lc-agent-pinned').length === 0, 'the ghost pin never released')
    await click(query(m.container, '.lc-comms .lc-tasks-filter'))
    await until(() => queryAll(m.container, '.lc-comms-event').length === 6, 'the ghost scope never cleared')

    await click(query(m.container, '[data-agent="w2"]'))
    assert.ok(text(query(m.container, '.lc-comms')).includes(DICT_EN['fleet.comms.noMatch']), 'side-quest rode no relays')
    await click(query(m.container, '.lc-comms .lc-tasks-filter'))
    await until(() => queryAll(m.container, '.lc-comms-event').length === 6, 'the rows never returned')
    await m.unmount()
    ctx.dispose()
  })

  test('the comms identities prefer roster names and duties over prompt labels', async () => {
    vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
      const { sessionId } = JSON.parse(init.body) as { sessionId: string }
      const value = sessionId === 'w1'
        ? {
          messages: [
            { seq: 9, time: 2000, kind: 'relay', from: 'root', text: 'hello bee' },
            { seq: 8, time: 1000, kind: 'relay', from: 'w9', text: 'hello from the ghost' },
          ],
          truncated: false,
        }
        : {
          messages: [],
          truncated: false,
          roster: [
            { name: 'worker-bee', description: 'schema duty' },
            { name: 'ghost-nine', description: 'ghost duty' },
          ],
        }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value }) } as Response)
    })
    const ctx = new TestClientCtx({ services: { sessions: familySessions(1000) } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    await until(() => queryAll(m.container, '.lc-comms-event').length === 2, 'the roster traffic never surfaced')
    const rows = queryAll<HTMLElement>(m.container, '.lc-comms-event')

    await click(query(rows[0]!, '.lc-comms-hit'))
    const bee = queryAll<HTMLElement>(m.container, '.lc-comms-person').find(person => text(person).includes('worker-bee'))!
    assert.ok(text(bee).includes('schema duty'))
    const lead = queryAll<HTMLElement>(m.container, '.lc-comms-person').find(person => text(person).includes('Lead'))!
    assert.ok(text(lead).includes('Main Agent'), 'the lead falls back to the session title')

    await click(query(rows[1]!, '.lc-comms-hit'))
    const ghost = queryAll<HTMLElement>(m.container, '.lc-comms-person').find(person => text(person).includes('ghost-nine'))!
    assert.ok(text(ghost).includes('ghost duty'), 'a roster member without a session row keeps its duty')
    await m.unmount()
    ctx.dispose()
  })

  test('a fleet-detail read that serves nothing leaves the boards standing', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 503 } as Response))
    const team = {
      members: [
        { id: 'cold-root', name: 'cold-lead', role: 'lead', phase: 'active' },
        { id: 'cold-w1', name: 'cold-worker', role: 'teammate', phase: 'active' },
      ],
      tasks: [],
    }
    const snapshot = {
      byId: {
        'cold-root': { displayTitle: 'Cold Lead', running: false, updatedAt: 3, projectionValues: { agentTeam: team } },
        'cold-w1': { parentId: 'cold-root', origin: 'subagent', running: false, updatedAt: 2, projectionValues: { subagent: { mode: 'one-shot', label: 'cold-worker' } } },
      },
    }
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'cold-root', useProjection: projectionsFor(richTimeline()) }))

    assert.ok(text(query(m.container, '.lc-members')).includes('cold-worker'))
    await until(() => text(query(m.container, '.lc-comms')).includes(DICT_EN['fleet.comms.empty']), 'the failed reads never settled')
    await m.unmount()
    ctx.dispose()
  })

  test('the direct projection seat serves the team when the viewed session leads it', async () => {
    stubFleetRoute()
    const snapshot = {
      byId: {
        root: { displayTitle: 'Main Agent', running: true, updatedAt: 10 },
        w1: { parentId: 'root', origin: 'subagent', running: false, updatedAt: 8 },
      },
    }
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline(), { agentTeam: TEAM_PROJECTION }), }))
    assert.ok(query(m.container, '.lc-members') !== null)
    assert.ok(query(m.container, '.lc-tasks') !== null)
    const columns = queryAll(query(m.container, '.lc-cols'), '.lc-col')
    assert.equal(columns.length, 2)
    assert.ok(columns[0].contains(query(m.container, '.lc-agents')), 'the network owns the left column')
    assert.ok(columns[1].classList.contains('lc-col-boards'), 'the boards column stacks its cards')
    assert.ok(columns[1].contains(query(m.container, '.lc-members')), 'the members board heads the right column')
    assert.ok(columns[1].contains(query(m.container, '.lc-tasks')), 'the task board sits under it')
    const leadCard = queryAll(m.container, '.lc-member-card')[0]
    assert.ok(text(leadCard).includes(DICT_EN['fleet.role.lead']))
    await m.unmount()
    ctx.dispose()

    const bareCtx = new TestClientCtx({ services: {} })
    const BareView = makeView(bareCtx)
    const bare = await mount(h(BareView, { sessionId: 'root', useProjection: projectionsFor(richTimeline(), { agentTeam: TEAM_PROJECTION }), }))
    try {
      const row = query(bare.container, '.lc-cols')
      assert.equal(queryAll(bare.container, '.lc-agents').length, 0)
      assert.equal(queryAll(bare.container, '.lc-members').length, 0)
      assert.equal(queryAll(bare.container, '.lc-summary').length, 0, 'no strip without a family')
      const tasks = query(bare.container, '.lc-tasks')
      assert.ok(row.contains(tasks), 'a team without a family forest serves the task board alone in the row')
    } finally {
      await bare.unmount()
      bareCtx.dispose()
    }
  })

  test('a solo session keeps the boards up with guidance — the graph, the strip, the comms card, and pointers', async () => {
    stubFleetRoute()
    const snapshot = { byId: { only: { displayTitle: 'Solo', running: false, updatedAt: 1 } } }
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'only', useProjection: projectionsFor(richTimeline()) }))
    assert.ok(query(m.container, '.lc-agents') !== null)
    assert.ok(query(m.container, '.lc-summary') !== null)
    assert.equal(queryAll(m.container, '.lc-summary-progress').length, 0)
    assert.ok(text(query(m.container, '.lc-members')).includes(DICT_EN['fleet.board.solo']))
    assert.ok(text(query(m.container, '.lc-tasks')).includes(DICT_EN['fleet.tasks.noTeam']))
    await until(() => text(query(m.container, '.lc-comms')).includes(DICT_EN['fleet.comms.empty']), 'the empty comms card never settled')
    await m.unmount()
    ctx.dispose()
  })

  test('a plain subagents session: the subagent progress bar and the no-team pointer', async () => {
    stubFleetRoute()
    const snapshot = {
      byId: {
        root: { displayTitle: 'Main Agent', running: true, updatedAt: 10 },
        w1: {
          parentId: 'root', origin: 'subagent', running: false, updatedAt: 8,
          projectionValues: { subagent: { mode: 'one-shot', label: 'worker-bee' }, subagentTiming: { settledMs: 42000, lastTurnCompleted: true } },
        },
        w2: {
          parentId: 'root', origin: 'subagent', running: true, updatedAt: 6,
          projectionValues: { subagent: { mode: 'continuable', label: 'side-quest' } },
        },
      },
    }
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    const progress = query(m.container, '.lc-summary-progress')
    assert.ok(text(progress).includes(DICT_EN['fleet.summary.subs']))
    assert.ok(text(progress).includes('1/2'))
    assert.ok(text(query(m.container, '.lc-members')).includes(DICT_EN['fleet.board.noTeam']))
    assert.equal(queryAll(m.container, '.lc-member-card').length, 2)
    assert.ok(!text(query(m.container, '.lc-tasks')).includes(DICT_EN['fleet.tasks.noTeam']), 'delegations board, no pointer')
    assert.deepEqual(queryAll(m.container, '.lc-tasks .lc-team-task').length, 2)
    await m.unmount()
    ctx.dispose()
  })

  test("a task card's report-back: the excerpt boards first, then the full read replaces it", async () => {
    const team = {
      members: [
        { id: 'rq-root', name: 'lead', role: 'lead', phase: 'active' },
        { id: 'rq-w1', name: 'worker-bee', role: 'teammate', phase: 'active' },
      ],
      tasks: [
        { id: 'task-1', revision: 1, subject: 'schema parsing', description: 'Parse it.', status: 'in_progress', ownerName: 'worker-bee', blockedBy: [], writeScopes: ['src/'], ready: false, writeScopeWarnings: [] },
      ],
    }
    const snapshot = {
      byId: {
        'rq-root': { displayTitle: 'Main Agent', running: true, updatedAt: 10, projectionValues: { agentTeam: team } },
        'rq-w1': {
          parentId: 'rq-root', origin: 'subagent', running: true, updatedAt: 8,
          projectionValues: { subagent: { mode: 'continuable', label: 'worker-bee' }, subagentTiming: { settledMs: 42000 } },
        },
      },
    }
    const fulls: Array<(value: unknown) => void> = []
    vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { sessionId: string; full?: boolean }
      if (body.full === true) {
        return new Promise((resolve) => { fulls.push(resolve) })
      }
      const value = body.sessionId === 'rq-w1'
        ? { lastReply: { time: 1_700_000_000_000, text: '13 of 15 c…' }, messages: [], truncated: true }
        : { messages: [], truncated: false }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value }) } as Response)
    })
    const ctx = new TestClientCtx({
      services: {
        sessions: { list: { getSnapshot: (): unknown => snapshot, subscribe: (): (() => void) => () => {} } },
      },
    })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'rq-root', useProjection: projectionsFor(richTimeline()) }))

    await until(() => text(m.container).includes('13 of 15 c…'), 'the excerpt never landed')
    await click(query(m.container, '[data-task="task-1"]'))
    const card = queryAll(m.container, '[data-task="task-1"] .lc-ts-card').at(-1)!
    assert.ok(text(card).includes('13 of 15 c…'), 'the excerpt boards while waiting')
    assert.ok(text(card).includes(DICT_EN['fleet.tasks.replyFull']))
    assert.equal(fulls.length, 1, 'one whole-log read for the owner, not per render')

    fulls[0]!({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        value: { lastReply: { time: 1_700_000_000_000, text: '13 of 15 cases, fully reported.' }, messages: [], truncated: false },
      }),
    })
    await until(() => text(m.container).includes('13 of 15 cases, fully reported.'), 'the full read never replaced the excerpt')
    assert.ok(!text(m.container).includes(DICT_EN['fleet.tasks.replyFull']), 'the note yields once full')

    await click(query(m.container, '[data-task="task-1"]'))
    await click(query(m.container, '[data-task="task-1"]'))
    await until(() => fulls.length === 1 && text(m.container).includes('fully reported.'), 're-unfolding lost the full text')
    await m.unmount()
    ctx.dispose()
  })
})
