/** Unified session arguments are rejected before ownership checks, lookups or native work. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionHarness, text, valueOf } from './helpers/sessions-harness.ts'
import type { SessionHarness } from './helpers/sessions-harness.ts'

const active: SessionHarness[] = []
afterEach(async () => { for (const mounted of active.splice(0)) await mounted.dispose() })

async function setup() {
  const mounted = await createSessionHarness({ config: { executable: process.execPath } })
  active.push(mounted)
  const owner = await mounted.agent('unified-session-owner')
  const calls = ['open', 'evaluate', 'read', 'list', 'close'].map(method => {
    switch (method) {
      case 'open': return vi.spyOn(mounted.sessions, 'open')
      case 'evaluate': return vi.spyOn(mounted.sessions, 'evaluate')
      case 'read': return vi.spyOn(mounted.sessions, 'read')
      case 'list': return vi.spyOn(mounted.sessions, 'list')
      default: return vi.spyOn(mounted.sessions, 'close')
    }
  })
  return { mounted, owner, calls }
}

const INVALID = [
  { action: 'open', session_id: 'foreign' },
  { action: 'open', code: 'must_not_run()' },
  { action: 'open', usage: false },
  { action: 'eval', session_id: 'foreign', code: '1', cwd: '.' },
  { action: 'eval', session_id: 'foreign', code: '1', name: 'wrong' },
  { action: 'eval', session_id: 'foreign', code: '1', usage: true },
  { action: 'read', session_id: 'foreign', timeoutMs: 1 },
  { action: 'read', session_id: 'foreign', code: '1' },
  { action: 'list', session_id: 'foreign' },
  { action: 'list', code: '1' },
  { action: 'list', name: 'wrong' },
  { action: 'list', cwd: '.' },
  { action: 'close', session_id: 'foreign', code: '1' },
  { action: 'close', session_id: 'foreign', usage: false },
  { action: 'close', session_id: 'foreign', name: 'wrong' },
  { action: 'eval' },
  { action: 'eval', session_id: 'foreign' },
  { action: 'eval', code: '1' },
  { action: 'eval', session_id: 'foreign', code: ' ' },
  { action: 'eval', session_id: ' ', code: '1' },
  { action: 'read' },
  { action: 'close' },
  { action: 'close', session_id: ' ' },
]

describe('aether_session action arguments', () => {
  it.each(INVALID)('refuses invalid combination %j before session work', async (args) => {
    const { mounted, owner, calls } = await setup()
    const result = await mounted.call('aether_session', args, { agent: owner })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('E_INPUT_SESSION_ARGS')
    for (const call of calls) expect(call).not.toHaveBeenCalled()
    expect(mounted.liveProcesses()).toBe(0)
  })

  it.each([{}, { action: 'restart' }, { action: null }, { action: 'open', unknown: true }])('refuses malformed request %j without native work', async (args) => {
    const { mounted, owner, calls } = await setup()
    expect((await mounted.call('aether_session', args, { agent: owner })).isError).toBe(true)
    for (const call of calls) expect(call).not.toHaveBeenCalled()
    expect(mounted.liveProcesses()).toBe(0)
  })

  it('validates arguments even when no owner was supplied', async () => {
    const { mounted, calls } = await setup()
    const result = await mounted.call('aether_session', { action: 'list', code: 'must_not_run()' })
    expect(text(result)).toContain('E_INPUT_SESSION_ARGS')
    for (const call of calls) expect(call).not.toHaveBeenCalled()
  })

  it('registers one session tool and refuses the retired names', async () => {
    const { mounted, owner } = await setup()
    expect(mounted.ctx.tools.schemas().map(tool => tool.name)).toEqual(['aether_session'])
    for (const action of ['open', 'eval', 'read', 'list', 'close']) {
      expect((await mounted.call(`aether_session_${action}`, {}, { agent: owner })).isError).toBe(true)
    }
    expect(valueOf(await mounted.call('aether_session', { action: 'list' }, { agent: owner }))).toMatchObject({ kind: 'listed', sessions: [] })
    expect(valueOf(await mounted.call('aether_session', { action: 'close', session_id: 'not-open' }, { agent: owner }))).toMatchObject({ kind: 'closed', closed: false })
    expect(mounted.liveProcesses()).toBe(0)
  })
})
