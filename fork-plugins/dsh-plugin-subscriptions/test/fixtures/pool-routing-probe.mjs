/** Record account-pool choices through a shipped headless profile without provider requests. */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { PoolAdapter } from '../../src/providers/pool.ts'
import { PoolUsageTracker } from '../../src/providers/pool-usage.ts'
import { PoolHealthRegistry } from '../../src/providers/pool-health.ts'
import { resolvePoolScheduling } from '../../src/providers/pool-scheduling.ts'
import { CodexAutoReset } from '../../src/providers/codex-auto-reset.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'pool-routing-probe'
export const inject = ['tools']

class AccountAdapter extends LlmAdapter {
  async *streamAccount(_options, account) {
    yield { type: 'text-delta', index: 0, text: account }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Register a deterministic account-selection probe with recorded model-visible output. */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'pool_route_probe',
    description: 'Report the account chosen for a subscription scheduling scenario.',
    parameters: { scenario: { type: 'string', enum: ['claude-reset', 'codex-reset', 'codex-finish', 'auto-earliest', 'auto-later', 'auto-disabled'], required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute({ scenario }) {
      if (scenario.startsWith('auto-')) {
        const directory = await mkdtemp(join(tmpdir(), 'snapshot-reset-'))
        try {
          let usedPercent = 100
          const spent = []
          const manager = new CodexAutoReset({
            confirmationTimeoutMs: 10_000,
            claimsDirectory: directory,
            enabled: () => scenario !== 'auto-disabled',
            accounts: async () => ['current', 'other'],
            usage: async account => ({ supported: true, windows: [{ kind: 'weekly', usedPercent: account === 'current' ? usedPercent : 30 }] }),
            list: async account => ({ supported: true, credits: [{ id: account, status: 'available', resetType: 'codex_rate_limits',
              expiresAt: new Date(Date.now() + (account === 'current' ? 2 : scenario === 'auto-later' ? 1 : 3) * 3_600_000).toISOString() }] }),
            consume: async (_account, credit) => { spent.push(credit); usedPercent = 0; return { windowsReset: 2 } },
            changed: () => {}, onWarn: message => { throw new Error(message) },
          })
          const recovered = await manager.recover('current', new AbortController().signal)
          return JSON.stringify({ scenario, recovered, spent })
        } finally { await rm(directory, { recursive: true, force: true }) }
      }
      const provider = scenario === 'claude-reset' ? 'claude' : 'codex'
      const accounts = scenario === 'codex-finish' ? ['roomy', 'nearly-empty'] : ['roomy', 'near-reset']
      const now = Date.now()
      const window = (usedPercent, minutes, kind = 'session') => ({ supported: true,
        windows: [{ kind, usedPercent, resetsAt: now + minutes * 60_000 }] })
      const usage = scenario === 'claude-reset'
        ? { roomy: window(20, 300), 'near-reset': window(96, 30) }
        : scenario === 'codex-reset'
          ? { roomy: window(20, 30), 'near-reset': window(80, 10) }
          : { roomy: window(70, 2880, 'weekly'), 'nearly-empty': window(98, 2880, 'weekly') }
      const pool = new PoolAdapter({
        adapters: { [provider]: new AccountAdapter() }, health: new PoolHealthRegistry(),
        usage: new PoolUsageTracker((_provider, account) => async () => usage[account]),
        strategy: 'quota_aware', switchMargin: 2, scheduling: resolvePoolScheduling(),
        defaultAccount: async () => accounts[0],
        families: async () => new Map([[`${provider}/probe`, { members: accounts.map(account => ({ provider, account, model: 'probe' })) }]]),
        tiers: {}, onWarn: () => {},
      })
      let selected = ''
      for await (const chunk of pool.stream({ provider, model: 'probe', messages: [] })) {
        if (chunk.type === 'text-delta') selected += chunk.text
      }
      return JSON.stringify({ scenario, selected })
    },
    presentCall: args => ({ card: 'generic', title: 'Inspect subscription account selection', kind: 'other', rawInput: args }),
  })))
}
