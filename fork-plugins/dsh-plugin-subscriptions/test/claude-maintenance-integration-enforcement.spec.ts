/**
 * Managed-policy enforcement at the tool-execution stage.
 *
 * Three facts this spec owns: the decision is taken per execution (so a policy adopted long
 * after the agent was created still stops the call, and one that stops denying stops
 * blocking); it covers EVERY tool the session runs, including tools another plugin
 * registered, because this build has no verified per-tool capability mapping; and it reads
 * only the accounts the calling session actually routed to — never a union across accounts,
 * which would let one session's restriction reach another.
 *
 * The guard is registered through the documented `tools.guard` seam, which the Host's tool
 * registry consults after every `tools/pre-execute` listener and before the tool body; that
 * consultation is the tools package's own contract (see its scoped guard suite). This spec
 * proves the plugin registers that guard and produces the right decision, and that it does
 * not fall back to a visibility restriction, which could neither be revoked nor scoped to
 * one session's accounts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Private harness home before the plugin is imported: construction reads plugin-owned
// paths, and no spec may touch the real one.
const home = mkdtempSync(join(tmpdir(), 'claude-enforce-spec-'))
process.env.DSH_HOME = home

const { claudeToolPolicyDenial, sessionAttribution } = await import('../src/index.js')

const decision = (kind: 'allow' | 'deny') =>
  kind === 'deny' ? { decision: 'deny' as const, code: 'POLICY_UNSUPPORTED' } : { decision: 'allow' as const }

/** The predicate input for one execution, over a fixed session-account table. */
function inputFor(options: {
  tool?: string
  sessionId?: string
  accounts?: Map<string, Set<string>>
  decide?: (account: string, tool: string) => { decision: 'allow' | 'deny'; code?: string }
}) {
  const execution = {
    name: options.tool ?? 'x_search',
    ...options.sessionId === undefined ? {} : { agent: { session: { id: options.sessionId } } },
  }
  return {
    execution,
    accountsFor: (sessionId: string) => options.accounts?.get(sessionId),
    decide: options.decide ?? (() => decision('allow')),
  }
}

test('a policy adopted after the agent was created stops the next call, and an empty one releases it', () => {
  const accounts = new Map([['session-a', new Set(['acct-1'])]])
  let policy: 'none' | 'deny' | 'allow' = 'none'
  const decide = (): { decision: 'allow' | 'deny'; code?: string } =>
    policy === 'deny' ? decision('deny') : decision('allow')
  const input = inputFor({ sessionId: 'session-a', accounts, decide })

  // Nothing adopted yet: the call runs.
  assert.equal(claudeToolPolicyDenial(input), undefined)
  // The policy arrives long after the agent existed; the very next call is refused.
  policy = 'deny'
  const denied = claudeToolPolicyDenial(input)
  assert.ok(denied?.includes('POLICY_UNSUPPORTED'), 'the refusal names its fixed code')
  assert.ok(denied?.includes('x_search'))
  // A later snapshot that carries no restriction releases the call again: no residual deny.
  policy = 'allow'
  assert.equal(claudeToolPolicyDenial(input), undefined)
})

test('a bound session is refused for every tool it runs, including another plugin\'s tool', () => {
  const accounts = new Map([['session-a', new Set(['acct-1'])]])
  const decide = () => decision('deny')
  // No tool-name allowlist: a restriction this build cannot prove inapplicable reaches
  // whatever the session runs, so a Host-owned shell, web, MCP or run_code tool cannot slip
  // past a narrow mapping.
  for (const tool of ['x_search', 'run_code', 'shell', 'web_search', 'mcp__server__tool']) {
    const denied = claudeToolPolicyDenial(inputFor({ sessionId: 'session-a', accounts, decide, tool }))
    assert.ok(denied?.includes(tool), `${tool} is refused`)
  }
})

test('one session\'s restriction never reaches another session or an unbound session', () => {
  const accounts = new Map([
    ['session-a', new Set(['acct-1'])],
    ['session-b', new Set(['acct-2'])],
  ])
  // Only acct-1's accepted policy refuses anything.
  const decide = (account: string) => account === 'acct-1' ? decision('deny') : decision('allow')

  assert.ok(claudeToolPolicyDenial(inputFor({ sessionId: 'session-a', accounts, decide })) !== undefined)
  assert.equal(claudeToolPolicyDenial(inputFor({ sessionId: 'session-b', accounts, decide })), undefined,
    'another session bound to another account is untouched')
  // A session that never routed to the account contributes nothing, and neither does an
  // execution with no agent at all.
  assert.equal(claudeToolPolicyDenial(inputFor({ sessionId: 'session-c', accounts, decide })), undefined)
  assert.equal(claudeToolPolicyDenial(inputFor({ accounts, decide })), undefined)
  assert.equal(claudeToolPolicyDenial(inputFor({ sessionId: 'session-a', accounts })), undefined)
})

test('the guard is registered once through the tools seam, and policy is not a visibility restriction', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const plugin = await import('../src/index.js')
  const registered: string[] = []
  const restrictions: Record<string, unknown>[] = []
  const guards: ((execution: { name: string; agent?: { session: { id: unknown } } }) => string | undefined)[] = []
  const ctx = new Context()
  ctx.provide('llm', {
    failureRecoveryVersion: 1,
    registerAdapter: (providers: string[]) => {
      registered.push(...providers)
      return Object.assign(() => {}, { replace: () => {} })
    },
  })
  ctx.provide('tools', {
    register: () => () => {},
    restrict: (filter: Record<string, unknown>) => { restrictions.push(filter); return () => {} },
    guard: (guard: (execution: { name: string; agent?: { session: { id: unknown } } }) => string | undefined) => {
      guards.push(guard)
      return () => {}
    },
  })
  await ctx.plugin(plugin, { providers: ['claude', 'grok'] })
  await new Promise(resolve => setImmediate(resolve))

  // The Claude route is registered (the Host declares the contract) and the enforcement is
  // one execution-stage guard covering the whole registry.
  assert.deepEqual(registered, ['claude', 'grok'])
  assert.equal(guards.length, 1, 'exactly one guard, not one per agent or per tool')
  assert.equal(restrictions.length, 0, 'policy is not a visibility restriction; local preferences narrow nothing by default')

  const guard = guards[0]!
  // A session that never used an account is left completely alone, whatever it runs.
  assert.equal(guard({ name: 'x_search', agent: { session: { id: 'never-used' } } }), undefined)
  assert.equal(guard({ name: 'run_code', agent: { session: { id: 'never-used' } } }), undefined)
  assert.equal(guard({ name: 'x_search' }), undefined)
  await ctx.fiber.dispose()
})

test('a session is judged by its current Claude account, not by every account it ever used', () => {
  const attribution = sessionAttribution()
  attribution.noteRequestOwner('claude', 'session-a')
  attribution.attributeAccount('session-a', 'acct-a')
  assert.deepEqual([...attribution.accountsFor('session-a')!], ['acct-a'])

  // Only acct-a's accepted policy refuses anything, and the session now targets acct-b.
  const decide = (account: string) => account === 'acct-a' ? decision('deny') : decision('allow')
  const tool = (sessionId: string) => ({
    execution: { name: 'run_code', agent: { session: { id: sessionId } } },
    accountsFor: (id: string) => attribution.accountsFor(id),
    decide,
  })
  assert.ok(claudeToolPolicyDenial(tool('session-a')) !== undefined, 'the current account decides')

  attribution.noteRequestOwner('claude', 'session-a')
  attribution.attributeAccount('session-a', 'acct-b')
  assert.deepEqual([...attribution.accountsFor('session-a')!], ['acct-b'], 'the retired account is gone')
  assert.equal(claudeToolPolicyDenial(tool('session-a')), undefined,
    'the retired account\'s restriction does not reach the session any more')
})

test('another provider serving the session retires the Claude attribution, and other sessions keep theirs', () => {
  const attribution = sessionAttribution()
  attribution.noteRequestOwner('claude', 'session-a')
  attribution.attributeAccount('session-a', 'acct-a')
  attribution.noteRequestOwner('claude', 'session-b')
  attribution.attributeAccount('session-b', 'acct-a')

  // session-a's next committed request runs on another provider: Claude rules must not reach it.
  attribution.noteRequestOwner('codex', 'session-a')
  assert.equal(attribution.accountsFor('session-a'), undefined)

  const accounts = (id: string) => attribution.accountsFor(id)
  const denyAll = () => decision('deny')
  const forSession = (sessionId: string) => ({
    execution: { name: 'run_code', agent: { session: { id: sessionId } } },
    accountsFor: accounts,
    decide: denyAll,
  })
  assert.equal(claudeToolPolicyDenial(forSession('session-a')), undefined,
    'a session now served by another provider keeps its own tools')
  assert.ok(claudeToolPolicyDenial(forSession('session-b')) !== undefined,
    'the session still bound to the account keeps its policy')

  // Ending the session, or retiring the account, drops the attribution outright.
  attribution.forgetSession('session-b')
  assert.equal(claudeToolPolicyDenial(forSession('session-b')), undefined)
})
