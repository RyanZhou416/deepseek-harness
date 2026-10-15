/**
 * Sandbox authority over the interpreter.
 *
 * The plugin has no shell service and never uses the interpreter's own
 * workspace jail: `ctx.sandbox` is the confinement that counts, resolved per
 * call from the calling session through `ctx.sandboxPolicy`. These cases use a
 * recording provider in place of the host's ACL/Landlock/Seatbelt runner (the
 * external, host-dependent boundary) and assert the exact argv and policy the
 * plugin handed it, the sandbox facts each outcome carries, the denial
 * classification, and fail-closed behavior when no confinement is available.
 * Real ACL enforcement is covered by the separate Windows integration suite.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, sessionAgent, text, valueOf } from './helpers/harness.ts'
import type { Harness } from './helpers/harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  const owned = harness
  harness = undefined
  await owned?.dispose()
})

async function setup(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  harness = await createHarness(options)
  return harness
}

describe('aether-shell sandbox policy resolution', () => {
  it('spawns unconfined under danger-full-access and never calls confine', async () => {
    const mounted = await setup({ mode: 'danger-full-access' })
    const result = await mounted.call('aether_call', { builtin: 'pwd' })
    const value = valueOf(result)
    expect(value['kind']).toBe('value')
    expect(value['sandbox']).toEqual({ mode: 'danger-full-access', denied: false })
    expect(mounted.confineCalls).toEqual([])
  })

  it('confines the exact interpreter argv under a non-full mode', async () => {
    const mounted = await setup({ mode: 'read-only' })
    const result = await mounted.call('aether_call', { builtin: 'pwd' })
    const value = valueOf(result)
    expect(value['kind']).toBe('value')
    expect(value['sandbox']).toEqual({ mode: 'read-only', enforcement: 'full', denied: false })
    expect(mounted.confineCalls).toHaveLength(1)
    const [confineCall] = mounted.confineCalls
    // The wrapped argv is the interpreter, the fixture argv, and the Agent API
    // subcommand — the plugin hands over the complete command, not a shell string.
    expect(confineCall?.argv.slice(1)).toEqual([expect.stringContaining('ae-fixture.mjs'), 'agent', 'execute'])
    expect(confineCall?.policy.mode).toBe('read-only')
    expect(confineCall?.policy.workspaceRoot).toBe(mounted.workspace)
  })

  it('carries the backend enforcement verdict into the outcome', async () => {
    const mounted = await setup({ mode: 'workspace-write', enforcement: 'partial' })
    const value = valueOf(await mounted.call('aether_call', { builtin: 'pwd' }))
    expect(value['sandbox']).toEqual({ mode: 'workspace-write', enforcement: 'partial', denied: false })
  })

  it('confines the command-line evaluation argv for the eval tool', async () => {
    const mounted = await setup({ mode: 'read-only' })
    await mounted.call('aether_eval', { code: '1 + 1' })
    expect(mounted.confineCalls).toHaveLength(1)
    expect(mounted.confineCalls[0]?.argv.slice(1)).toEqual([
      expect.stringContaining('ae-fixture.mjs'),
      '--deterministic',
      '-c',
      '1 + 1',
    ])
  })

  it('lets a session log override the deployment default mode', async () => {
    const mounted = await setup({ mode: 'workspace-write' })
    const overridden = sessionAgent(mounted.workspace, 'sess-readonly', [
      { type: 'sandbox/mode', data: { mode: 'read-only' } },
    ])
    await mounted.call('aether_call', { builtin: 'pwd' }, { agent: overridden })
    expect(mounted.confineCalls[0]?.policy.mode).toBe('read-only')
    expect(mounted.confineCalls[0]?.policy.sessionId).toBeDefined()
  })

  it('uses the deployment workspace root for an agentless call', async () => {
    const mounted = await setup({ mode: 'workspace-write' })
    await mounted.call('aether_call', { builtin: 'pwd' }, { agent: null })
    expect(mounted.confineCalls[0]?.policy.workspaceRoot).toBe(mounted.workspace)
    expect(mounted.confineCalls[0]?.policy.sessionId).toBeUndefined()
  })
})

describe('aether-shell denial classification', () => {
  it('reports a confined exchange the backend dialect identifies as denied', async () => {
    const mounted = await setup({
      mode: 'read-only',
      denialSignatures: ['access is denied'],
    })
    const result = await mounted.call('aether_call', { builtin: 'denied' })
    const value = valueOf(result)
    expect(value['kind']).toBe('denied')
    expect(value['sandbox']).toEqual({ mode: 'read-only', enforcement: 'full', denied: true })
    expect((value['process'] as { exitCode: number }).exitCode).toBe(5)
    expect(text(result)).toContain('[sandbox: file access denied under read-only mode]')
  })

  it('does not read the same failure as a denial when the backend names no dialect', async () => {
    const mounted = await setup({ mode: 'read-only', denialSignatures: [] })
    const value = valueOf(await mounted.call('aether_call', { builtin: 'denied' }))
    expect(value['kind']).toBe('error')
    expect(value['sandbox']).toEqual({ mode: 'read-only', enforcement: 'full', denied: false })
  })

  it('leaves an interpreter failure outside the denial dialect as an error', async () => {
    const mounted = await setup({ mode: 'read-only', denialSignatures: ['access is denied'] })
    const value = valueOf(await mounted.call('aether_eval', { code: 'fixture:fail:' }))
    // The fixture's own failure text carries no denial signature, so a program
    // the interpreter itself rejected stays an interpreter failure.
    expect(value['kind']).toBe('error')
    expect(value['sandbox']).toEqual({ mode: 'read-only', enforcement: 'full', denied: false })
  })
})

describe('aether-shell fails closed without confinement', () => {
  it('refuses to run under a confining policy when no backend is usable', async () => {
    const mounted = await setup({ mode: 'read-only', sandbox: 'unavailable' })
    const result = await mounted.call('aether_call', { builtin: 'pwd' })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected a fail-closed result')
    expect(result.error.info?.code).toBe('SANDBOX_UNAVAILABLE')
    expect(text(result)).toContain('sandbox mode "read-only" is requested')
  })

  it('still runs the standing danger-full-access mode without a backend', async () => {
    const mounted = await setup({ mode: 'danger-full-access', sandbox: 'unavailable' })
    const result = await mounted.call('aether_call', { builtin: 'pwd' })
    expect(valueOf(result)['kind']).toBe('value')
  })
})
