import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ProviderId } from '../auth/store.js'
import type { ProviderSettingsStore, AccountPreferences } from '../provider-settings.js'
import type { AccountAwareAdapter } from './accounts.js'
import { DISCOVERY_TIMEOUT_MS, withTimeout } from './common.js'
import { exhaustionCode } from './pool-health.js'
import type { PoolAdapter } from './pool.js'

/** Reserved namespace, recognized even when malformed or no longer enabled. */
const ACCOUNT_MODEL_PREFIX = '~account:'
export function accountModelId(account: string, model: string): string {
  return `${ACCOUNT_MODEL_PREFIX}${encodeURIComponent(account)}:${encodeURIComponent(model)}`
}
export function parseAccountModelId(id: string): { account: string; model: string } | undefined {
  if (!id.startsWith(ACCOUNT_MODEL_PREFIX)) return undefined
  const parts = id.slice(ACCOUNT_MODEL_PREFIX.length).split(':')
  try {
    if (parts.length !== 2) throw new Error()
    const account = decodeURIComponent(parts[0])
    const model = decodeURIComponent(parts[1])
    if (!account || !model || accountModelId(account, model) !== id) throw new Error()
    return { account, model }
  } catch { throw new LlmError('Invalid independent account model id', 'NO_ADAPTER') }
}
export function accountAllowsPool(preferences: AccountPreferences | undefined, model: string): boolean {
  return preferences?.poolEnabled !== false && (preferences?.poolModels?.includes(model) ?? true)
}
interface Options {
  provider: ProviderId
  adapter: AccountAwareAdapter
  settings: ProviderSettingsStore
  accounts: () => Promise<readonly { key: string; label: string }[]>
  pool: () => PoolAdapter | undefined
  /**
   * Resolve one account reference to the key the store holds it under now — the
   * hook a renamed account needs, so an independent entry a session selected
   * before the rename keeps resolving. Absent leaves the reference unchanged.
   */
  resolveAccount?: (account: string) => Promise<string>
  /**
   * Readiness gate every public read awaits first, so no policy or catalogue
   * read happens under a key the auth store has already retired (see
   * `reconcileStoredCodexAliases`). Deliberately not consulted by the pool-member
   * seam: that seam is only reached from inside a stream that has already passed
   * the gate, and awaiting it again there would let the one-time reconciliation
   * wait on the very call it is preparing.
   */
  beforeRead?: () => Promise<void>
  /** Where a pool that owns no entry for a requested model is reported. */
  onWarn: (message: string) => void
}

/** Keeps the registered route separate from raw adapters and pool member seams. */
export class AccountPreferencesAdapter extends LlmAdapter {
  /** Models already reported as unowned — a per-request diagnostic is stated once otherwise. */
  private readonly reported = new Set<string>()
  constructor(private readonly options: Options) { super() }
  override providerRetryPolicy(provider: string) {
    return this.options.adapter.providerRetryPolicy(provider)
  }
  /**
   * The wrapped adapter's own display identity.
   *
   * The harness reads this for every registered route and shows the name in the model picker for
   * a route that declares no provider directory, which is how these routes appear; without the
   * delegation each adapter's name would be replaced by the raw route id.
   */
  override providerInfo(provider: string) {
    return this.options.adapter.providerInfo(provider)
  }
  private preference(account: string): AccountPreferences | undefined {
    const accounts = this.options.settings.get(this.options.provider).accounts
    return accounts && Object.hasOwn(accounts, account) ? accounts[account] : undefined
  }
  private async models(account: string): Promise<readonly LlmModelInfo[]> {
    return await withTimeout(signal => this.options.adapter.listOwnModels(this.options.provider, account, signal), DISCOVERY_TIMEOUT_MS) ?? []
  }
  /**
   * The rows an availability check reads.
   *
   * A capability question answers from the caches alone. A request about to be
   * sent first ENSURES the one account being validated — a single provider
   * request when that account's catalogue is missing or stale, never one per
   * peer — and then reads it; a failed ensure warns and falls through to the
   * last-known rows and the built-in catalog, so an unreachable provider does
   * not turn a selectable model into a refusal.
   * @param account - the account whose catalog is checked.
   * @param requireFresh - true for the account a request is about to use.
   * @returns that account's rows, empty when the read was cancelled.
   */
  private async listed(account: string, requireFresh: boolean): Promise<readonly LlmModelInfo[]> {
    const adapter = this.options.adapter
    if (requireFresh) {
      await withTimeout(
        async signal => { await adapter.refreshOwnCatalog?.(this.options.provider, account, { signal }) },
        DISCOVERY_TIMEOUT_MS,
      ).catch(() => undefined)
    }
    const advisory = adapter.resolveOwnCatalog?.bind(adapter)
    if (advisory === undefined) return await this.models(account)
    return await withTimeout(
      signal => advisory(this.options.provider, account, signal),
      DISCOVERY_TIMEOUT_MS,
    ) ?? []
  }
  private async requireAccount(
    account: string,
    model: string,
    independent: boolean,
    requireFresh: boolean,
  ): Promise<void> {
    if (!(await this.options.accounts()).some(entry => entry.key === account)
      || (independent ? this.preference(account)?.independentEntry !== true : !accountAllowsPool(this.preference(account), model))
      || !(await this.listed(account, requireFresh)).some(entry => entry.id === model)) {
      throw new LlmError(`Account route unavailable: ${this.options.provider}/${account}/${model}`, 'NO_ADAPTER')
    }
  }
  /**
   * Report once, per model, that an enabled pool owns no entry for it. The
   * request still runs, but on one account chosen by the pool's availability
   * rule rather than through pool failover, and that gap is a configuration
   * state the operator can act on instead of a silent difference in routing.
   */
  private reportUnowned(model: string): void {
    const key = `${this.options.provider}/${model}`
    if (this.reported.has(key)) return
    this.reported.add(key)
    this.options.onWarn(
      `pool owns no entry for "${key}"; serving it from a single account instead of pool failover`,
    )
  }
  /**
   * The account serving a model the pool does not own. The pool's availability
   * rule still applies: an account that is cooling down, or that is past a
   * Claude usage floor, is skipped for the next eligible one — the fallback can
   * never reach an account the pool would have held back.
   *
   * When no account qualifies, the error names why the pool held them back and
   * when the earliest one may serve again. That is the pool-exhausted error's own
   * cause and hint: a spent allowance or a parked account is temporary and
   * retryable, and reporting `NO_ADAPTER` for it would name an unavailable model
   * and discard the recovery instant the provider already disclosed.
   *
   * A candidate's usage floor is judged from what the pool already knows, except
   * on the streaming path: `requireFresh` is this caller's statement that it is
   * about to commit a request, which is what permits the one usage read per
   * candidate considered. Listing or resolving a model reaches no usage endpoint.
   */
  private async fallback(model: string, requireFresh: boolean): Promise<string> {
    const pool = this.options.pool()
    if (pool !== undefined) this.reportUnowned(model)
    const held: { code: string; retryAfterMs?: number }[] = []
    for (const { key } of await this.options.accounts()) {
      if (!accountAllowsPool(this.preference(key), model)) continue
      let listed = false
      try { await this.requireAccount(key, model, false, requireFresh); listed = true } catch { /* unavailable catalog */ }
      if (!listed) continue
      const holdback = pool === undefined
        ? undefined
        : await pool.accountHoldback(this.options.provider, model, key, requireFresh)
      if (holdback !== undefined) { held.push(holdback); continue }
      return key
    }
    if (held.length === 0) {
      throw new LlmError(`No eligible account for ${this.options.provider}/${model}`, 'NO_ADAPTER')
    }
    const retryAfterMs = held.reduce<number | undefined>(
      (earliest, entry) => entry.retryAfterMs === undefined ? earliest
        : earliest === undefined ? entry.retryAfterMs : Math.min(earliest, entry.retryAfterMs),
      undefined,
    )
    throw new LlmError(
      `No eligible account for ${this.options.provider}/${model}: every candidate is cooling down or past its usage floor`,
      exhaustionCode(new Set(held.map(entry => entry.code))),
      { ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs } },
    )
  }
  /** Pool-only facade: explicit families/tiers must obey the same policy as auto pools. */
  poolMember(): AccountAwareAdapter {
    const raw = this.options.adapter
    /**
     * The account one pool member resolves to. `requireFresh` follows the same
     * split as {@link requireAccount}: capability resolution answers from the
     * caches, while the member about to stream ensures its own catalogue once
     * before the membership check.
     */
    const keyFor = async (account: string | undefined, model: string, requireFresh: boolean): Promise<string> => {
      if (model.startsWith(ACCOUNT_MODEL_PREFIX)) throw new LlmError('Independent entries cannot be pool members', 'NO_ADAPTER')
      const key = account ?? (await this.options.accounts())[0]?.key
      if (!key) throw new LlmError('No account available', 'NO_ADAPTER')
      await this.requireAccount(key, model, false, requireFresh)
      return key
    }
    return new Proxy(raw, { get: (target, property) => {
      if (property === 'streamAccount') return async function* (options: GenerateOptions, account: string) {
        let key: string
        try { key = await keyFor(account, options.model, true) } catch (cause) {
          // Skip policy-excluded members without poisoning account health. The
          // pool treats TRANSPORT as switch-without-cooldown; raw is never called.
          throw new LlmError('Pool member unavailable under account preferences', 'TRANSPORT', { cause })
        }
        yield* raw.streamAccount(options, key)
      }
      if (property === 'resolveOwnModel') return async (provider: string, model: string, account?: string) =>
        raw.resolveOwnModel(provider, model, await keyFor(account, model, false))
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    await this.ready()
    const result = new Map<string, LlmModelInfo>()
    const catalogs = await Promise.all((await this.options.accounts()).map(async account => ({ ...account, models: await this.models(account.key).catch(() => []) })))
    for (const { key, label, models } of catalogs) {
      const preferences = this.preference(key)
      for (const model of models) {
        if (model.id.startsWith(ACCOUNT_MODEL_PREFIX)) continue
        if (accountAllowsPool(preferences, model.id) && this.options.settings.visible(this.options.provider, model.id) && !result.has(model.id)) result.set(model.id, model)
        if (preferences?.independentEntry === true && this.options.settings.visible(this.options.provider, model.id)) {
          const id = accountModelId(key, model.id)
          result.set(id, { ...model, id, name: `${preferences.alias || label} · ${model.name}` })
        }
      }
    }
    for (const model of await this.options.pool()?.modelsForProvider(this.options.provider) ?? []) {
      if (model.id.startsWith(ACCOUNT_MODEL_PREFIX) || !this.options.settings.visible(this.options.provider, model.id)) continue
      try { await this.options.pool()!.resolveModel(provider, model.id); result.set(model.id, model) } catch { /* excluded tier */ }
    }
    const priority = (model: LlmModelInfo): number => (model as LlmModelInfo & { priority?: number }).priority ?? Number.MAX_SAFE_INTEGER
    return [...result.values()].sort((left, right) => priority(left) - priority(right))
  }
  override async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    await this.ready()
    const independent = parseAccountModelId(id)
    if (independent) {
      // A session may hold an id naming the key this account had before the
      // store renamed it; resolve first, and report the resolved key's label.
      const account = await this.resolved(independent.account)
      await this.requireAccount(account, independent.model, true, false)
      const info = await this.options.adapter.resolveOwnModel(provider, independent.model, account)
      const label = (await this.options.accounts()).find(entry => entry.key === account)?.label ?? account
      return { ...info, id, name: `${this.preference(account)?.alias || label} · ${info.name}` }
    }
    const pool = this.options.pool()
    if (pool && await pool.owns(this.options.provider, id)) return pool.resolveModel(provider, id)
    return this.options.adapter.resolveOwnModel(provider, id, await this.fallback(id, false))
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.ready()
    const independent = parseAccountModelId(options.model)
    if (independent) {
      const account = await this.resolved(independent.account)
      await this.requireAccount(account, independent.model, true, true)
      yield* this.options.adapter.streamAccount({ ...options, model: independent.model }, account)
      return
    }
    const pool = this.options.pool()
    if (pool && await pool.owns(this.options.provider, options.model)) { yield* pool.stream(options); return }
    yield* this.options.adapter.streamAccount(options, await this.fallback(options.model, true))
  }

  /** Wait for the one-time account-rename reconciliation before reading state. */
  private async ready(): Promise<void> {
    await this.options.beforeRead?.()
  }

  /** One account reference as the store holds it now (the rename hook). */
  private async resolved(account: string): Promise<string> {
    return this.options.resolveAccount === undefined ? account : await this.options.resolveAccount(account)
  }
}
