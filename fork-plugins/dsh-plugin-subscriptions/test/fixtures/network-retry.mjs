/** Replay real account routing and durable retries without provider requests. */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { loadReplayScript } from '@deepseek-ai/dsh-llm-replay'
import { AccountPreferencesAdapter } from '../../src/providers/account-preferences.ts'
import { ProviderSettingsStore } from '../../src/provider-settings.ts'
import { PoolAdapter } from '../../src/providers/pool.ts'
import { PoolUsageTracker } from '../../src/providers/pool-usage.ts'
import { memberKey, PoolHealthRegistry } from '../../src/providers/pool-health.ts'
import { resolvePoolScheduling } from '../../src/providers/pool-scheduling.ts'
import { DEFAULT_RETRY, subscriptionRetryPolicy } from '../../src/providers/rate-limit.ts'

export const name = 'subscription-network-retry'
export const inject = ['llm']
const provider = 'claude'
const model = 'claude-opus-5-5'

/** Mount the same account facade as the subscription plugin with a recorded member stream. */
export function apply(ctx) {
  const script = loadReplayScript({ file: process.env.DSH_SNAPSHOT_FILE, overrideFile: process.env.DSH_SNAPSHOT_OVERRIDE })
  class RecordedAccount extends LlmAdapter {
    providerRetryPolicy() {
      return subscriptionRetryPolicy({ ...DEFAULT_RETRY, initialDelayMs: 1, jitterRatio: 0 },
        { wait: false, maxWaitMs: 6 * 3_600_000 }, 'snapshot')
    }
    async listOwnModels() { return [{ provider, id: model, name: model }] }
    async resolveOwnModel() { return { provider, id: model, name: model } }
    clearAccountCatalog() {}
    async *streamAccount(_options, account) {
      if (account !== 'online') throw new Error('Cooling account must not be called')
      const entry = script.shift()
      if (!entry || entry.kind === 'hang') throw new Error('Unexpected replay request')
      yield* entry.chunks
      if (entry.kind === 'throw') throw new LlmError(entry.message, entry.code)
    }
  }
  const adapter = new RecordedAccount()
  const health = new PoolHealthRegistry()
  health.markUnavailable(memberKey(provider, 'cooling', model), 32 * 3_600_000, 'RATE_LIMIT')
  const pool = new PoolAdapter({
    adapters: { [provider]: adapter }, health, usage: new PoolUsageTracker(() => undefined),
    strategy: 'priority', switchMargin: 2, scheduling: resolvePoolScheduling(),
    defaultAccount: async () => 'online',
    families: async () => new Map([[`${provider}/${model}`, { members: ['cooling', 'online'].map(account => ({ provider, account, model })) }]]),
    tiers: {}, onWarn: () => {},
  })
  const route = new AccountPreferencesAdapter({ provider, adapter, settings: new ProviderSettingsStore(),
    accounts: async () => ['cooling', 'online'].map(key => ({ key, label: key })), pool: () => pool })
  ctx.effect(() => ctx.llm.registerAdapter([provider], route))
}
