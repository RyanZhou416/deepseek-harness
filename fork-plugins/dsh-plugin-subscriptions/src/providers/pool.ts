/**
 * The pool adapter: same-subscription account routing, plus optional
 * configured tier extras. The picker is the union of every account's
 * catalog. A model listed by several accounts failovers; a model listed by
 * one account is pinned to it. Tiers are extra picker rows. Member
 * selection is sticky per session (so prompt caches survive) and optionally
 * quota-aware; failures fail over to the next member as long as no stream
 * chunk has been emitted.
 */

import {
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ProviderId } from '../auth/store.js'
import type { AccountAwareAdapter } from './accounts.js'
import { ENFORCEMENT_CODE } from './common.js'
import type { UsageWindow } from './common.js'
import type { ConcretePoolMember, PoolDefinition, PoolMemberRef } from './pool-family.js'
import { poolKey } from './pool-family.js'
import { accountKey, classifyPoolFailure, exhaustionCode, memberKey, PoolHealthRegistry } from './pool-health.js'
import type { PoolFailureScope } from './pool-health.js'
import type { MemberQuota, PoolUsageTracker } from './pool-usage.js'
import { poolSchedulingScore } from './pool-scheduling.js'
import type { PoolSchedulingPolicy } from './pool-scheduling.js'

/** Member-selection strategy: plain priority failover or quota-aware scheduling. */
export type PoolStrategy = 'priority' | 'quota_aware'

export interface PoolAdapterOptions {
  /** The live subscription adapters, by provider route. */
  adapters: Partial<Record<ProviderId, AccountAwareAdapter>>
  health: PoolHealthRegistry
  usage: PoolUsageTracker
  strategy: PoolStrategy
  /** A challenger must out-urgency the sticky member by this factor to take over. */
  switchMargin: number
  /** Complete bounded preference and account-load policy, resolved at plugin load. */
  scheduling: PoolSchedulingPolicy
  /** The default account of one provider (for config members omitting `account`). */
  defaultAccount: (provider: ProviderId) => Promise<string | undefined>
  /** Resolve legacy account aliases before pool deduplication and cache identity. */
  resolveAccount?: (provider: ProviderId, account: string) => Promise<string>
  /** Account pools (auto-aggregated plus config overrides), resolved lazily. */
  families: () => Promise<Map<string, PoolDefinition>>
  /** User-configured extra picker entries (heterogeneous fallbacks), by pool id. */
  tiers: Record<string, PoolMemberRef[]>
  /** Optional quota recovery for a depleted sticky account before choosing a replacement. */
  recoverQuota?: (member: ConcretePoolMember, signal?: AbortSignal) => Promise<boolean>
  onWarn: (message: string) => void
}

/**
 * Whether a provider's routes reserve a usage floor. Only Claude does, so only
 * Claude's members need a usage read to answer {@link pastClaudeFloor}.
 * @param provider - the provider route.
 * @returns true when the provider's floors apply.
 */
function carriesUsageFloor(provider: ProviderId): boolean {
  return provider === 'claude'
}

/**
 * The windows an availability floor is decided from: the current poll's, or the
 * ones a degraded poll carried forward from the last successful one.
 * @param quota - the member's cached quota, when usage is known at all.
 * @returns the applicable windows, empty when there are none.
 */
function floorWindows(quota: MemberQuota | undefined): readonly UsageWindow[] {
  return quota?.windows ?? quota?.floorWindows ?? []
}

/**
 * Whether a Claude account has reached the usage floor its route reserves.
 *
 * Left out of selection rather than ranked last: a member ranked last is still chosen once
 * every other member is cooling down, which is exactly the account this reserve exists to keep
 * a turn away from. Only Claude carries floors; every other route is unaffected.
 *
 * A poll that degraded to a failure keeps the last real windows for this test, so an endpoint
 * that is briefly unreachable cannot make an already-spent allowance selectable.
 *
 * @param member - the candidate member.
 * @param quota - its cached quota, when usage is known.
 * @param scheduling - the resolved policy naming both floors.
 * @returns true when the account must not be selected.
 */
function pastClaudeFloor(
  member: ConcretePoolMember,
  quota: MemberQuota | undefined,
  scheduling: PoolSchedulingPolicy,
): boolean {
  if (!carriesUsageFloor(member.provider)) return false
  return floorWindows(quota).some(window =>
    (window.kind === 'session' && window.usedPercent >= scheduling.claudeSessionPercentFloor)
    || (window.kind === 'weekly' && window.usedPercent >= scheduling.claudeWeeklyPercentFloor))
}

/**
 * Epoch ms of the earliest window reset in `windows` that has not already elapsed.
 * @param windows - the windows excluded members are waiting on.
 * @param now - the current epoch milliseconds.
 * @returns the earliest future reset, or undefined when none is disclosed.
 */
function earliestReset(windows: readonly UsageWindow[], now: number): number | undefined {
  let earliest: number | undefined
  for (const window of windows) {
    if (window.resetsAt === undefined || window.resetsAt <= now) continue
    if (earliest === undefined || window.resetsAt < earliest) earliest = window.resetsAt
  }
  return earliest
}

/** Bound on sticky-session memory; oldest entries evict past it. */
const STICKY_SESSION_LIMIT = 1000

/** Display form of one member (account shown when pinned). */
function memberLabel(member: PoolMemberRef): string {
  return member.account === undefined
    ? `${member.provider}/${member.model}`
    : `${member.provider}/${member.account}/${member.model}`
}

/** How long a pools snapshot is trusted (auth changes invalidate immediately). */
const POOLS_CACHE_TTL_MS = 5_000

export class PoolAdapter extends LlmAdapter {
  /** sessionId|poolId → member key of the last member that served a chunk. */
  private readonly sticky = new Map<string, string>()
  /** Outstanding pool attempts, including first-byte waits, shared across models of each account. */
  private readonly active = new Map<string, number>()
  /** Messages already warned about — configuration diagnostics repeat every request otherwise. */
  private readonly warned = new Set<string>()
  /**
   * Short-lived pools snapshot. `owns()` runs on every resolveModel — the
   * model picker issues one per entry — and pool assembly touches every
   * provider's catalog and account store, so recompute at most this often.
   * Auth changes bump {@link generation} so a stale snapshot cannot land.
   */
  private poolsCache: { at: number; pools: Map<string, PoolDefinition> } | undefined
  private poolsInflight: Promise<Map<string, PoolDefinition>> | undefined
  private generation = 0

  constructor(private readonly options: PoolAdapterOptions) {
    super()
  }

  /** Drop the pools snapshot so the next read reflects the current accounts. */
  invalidate(): void {
    this.generation += 1
    this.poolsCache = undefined
    this.poolsInflight = undefined
  }

  /** Warn once per distinct message (pools() runs on every request). */
  private warnOnce(message: string): void {
    if (this.warned.has(message)) return
    this.warned.add(message)
    this.options.onWarn(message)
  }

  /** Drop members whose adapter is not registered (copy — caller state is shared). */
  private usable(pools: Map<string, PoolDefinition>): Map<string, PoolDefinition> {
    const result = new Map<string, PoolDefinition>(pools)
    for (const [id, definition] of [...result]) {
      const kept = definition.members.filter(member => this.options.adapters[member.provider] !== undefined)
      if (kept.length === 0) result.delete(id)
      else if (kept.length < definition.members.length) result.set(id, { ...definition, members: kept })
    }
    return result
  }

  /** Account pools (auto-aggregated plus config overrides) with usable members. */
  private async familyPools(): Promise<Map<string, PoolDefinition>> {
    return this.usable(new Map<string, PoolDefinition>(await this.options.families()))
  }

  /** All pools (account pools merged with extra tiers) with usable members. */
  private async pools(): Promise<Map<string, PoolDefinition>> {
    const cached = this.poolsCache
    if (cached !== undefined && Date.now() - cached.at < POOLS_CACHE_TTL_MS) return cached.pools
    const gen = this.generation
    this.poolsInflight ??= this.assemblePools()
      .then((pools) => {
        if (this.generation === gen) this.poolsCache = { at: Date.now(), pools }
        return pools
      })
      .finally(() => {
        this.poolsInflight = undefined
      })
    return this.poolsInflight
  }

  /** Recompute the pools snapshot (account pools merged with extra tiers). */
  private async assemblePools(): Promise<Map<string, PoolDefinition>> {
    const pools = await this.familyPools()
    for (const [id, members] of Object.entries(this.options.tiers)) {
      if (members.length === 0) continue
      const owner = members[0].provider
      const key = poolKey(owner, id)
      if (pools.has(key)) this.warnOnce(`tier pool "${id}" overrides the account pool of the same id under ${owner}`)
      pools.set(key, { members, extra: true })
    }
    return this.usable(pools)
  }

  /**
   * Extra picker rows one provider lists (configured tiers). Account pools
   * reuse the catalog entry of the same wire id, so they are not listed
   * again — the picker stays one row per model in ChatGPT / Claude / ….
   */
  async modelsForProvider(provider: ProviderId): Promise<LlmModelInfo[]> {
    const pools = await this.pools()
    const models: LlmModelInfo[] = []
    for (const [key, definition] of pools) {
      if (definition.extra !== true) continue
      if (!key.startsWith(`${provider}/`)) continue
      const id = key.slice(provider.length + 1)
      models.push({
        provider,
        id,
        name: definition.name ?? id,
        ...definition.description === undefined ? {} : { description: definition.description },
      })
    }
    return models
  }

  /**
   * Whether `model` on `provider`'s route is served here (several accounts
   * fail over, one account is pinned, or a configured tier).
   */
  async owns(provider: ProviderId, model: string): Promise<boolean> {
    return (await this.pools()).has(poolKey(provider, model))
  }

  /**
   * Resolve every member's account (config members may omit it to mean "the
   * default account") and drop members with no resolvable login. Duplicates
   * collapse — an explicitly pinned account and the default may coincide.
   */
  private async concrete(members: readonly PoolMemberRef[]): Promise<ConcretePoolMember[]> {
    const seen = new Set<string>()
    const resolved: ConcretePoolMember[] = []
    for (const member of members) {
      const requested = member.account ?? await this.options.defaultAccount(member.provider)
      if (requested === undefined) continue
      const account = await (this.options.resolveAccount?.(member.provider, requested) ?? Promise.resolve(requested))
      const key = memberKey(member.provider, account, member.model)
      if (seen.has(key)) continue
      seen.add(key)
      resolved.push({ provider: member.provider, account, model: member.model })
    }
    return resolved
  }

  /**
   * Resolve a pool model to the conservative INTERSECTION of its members'
   * capabilities: the smallest context window and output cap, the reasoning
   * efforts every member supports, and the modalities all of them accept —
   * so a request valid for the pool stays valid after a failover. Capability
   * metadata is account-specific, so every distinct member is resolved.
   */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const definition = (await this.pools()).get(poolKey(provider, model))
    if (definition === undefined) throw new LlmError(`unknown pool model "${model}"`, 'NO_ADAPTER')
    const resolved: LlmResolvedModelInfo[] = []
    let lastFailure: unknown
    const members = await this.concrete(definition.members)
    for (const member of members) {
      const adapter = this.options.adapters[member.provider]
      if (adapter === undefined) continue
      // Tolerate per-member failures (a misconfigured tier member, a
      // logged-out provider throwing AUTH): the pool serves as long as ONE
      // member resolves, mirroring stream()'s failover semantics.
      try {
        resolved.push(await adapter.resolveOwnModel(member.provider, member.model, member.account))
      } catch (error: unknown) {
        lastFailure = error
        this.warnOnce(
          `pool "${model}": member ${memberLabel(member)} failed to resolve`
          + ` (${error instanceof Error ? error.message : String(error)}); excluding it`,
        )
      }
    }
    if (resolved.length === 0) {
      throw new LlmError(`pool "${model}" has no usable member`, 'NO_ADAPTER', {
        ...lastFailure === undefined ? {} : { cause: lastFailure },
      })
    }
    const contextWindows = resolved.map(info => info.context?.contextWindow).filter(isNumber)
    const maxTokens = resolved.map(info => info.defaultMaxTokens).filter(isNumber)
    const reasoning = intersectReasoning(resolved)
    const modalities = intersectModalities(resolved)
    return {
      provider,
      id: model,
      name: definition.name ?? model,
      ...definition.description === undefined ? {} : { description: definition.description },
      ...contextWindows.length > 0 ? { context: { contextWindow: Math.min(...contextWindows) } } : {},
      ...maxTokens.length > 0 ? { defaultMaxTokens: Math.min(...maxTokens) } : {},
      ...reasoning === undefined ? {} : { reasoning },
      ...modalities === undefined ? {} : { inputModalities: modalities },
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const identity = poolKey(options.provider, options.model)
    const definition = (await this.pools()).get(identity)
    if (definition === undefined) throw new LlmError(`unknown pool model "${options.model}"`, 'NO_ADAPTER')
    const members = await this.concrete(definition.members)
    // Priority mode reads no usage, except for Claude: its floors are a usability rule rather
    // than a ranking preference, so an account past them is excluded whichever strategy runs.
    // The tracker caches each read, so this costs one lookup per cold member, not per request.
    const quotaMembers = this.options.strategy === 'priority'
      ? members.filter(member => member.provider === 'claude')
      : members
    const quotas = new Map<ConcretePoolMember, MemberQuota>(await Promise.all(quotaMembers
      .filter(member => this.options.health.isMemberAvailable(member.provider, member.account, member.model))
      .map(async member => [member, await this.options.usage.quotaFor(member)] as const)))
    const sessionId = options.sessionId
    const sticky = sessionId === undefined ? undefined : members.find(member =>
      memberKey(member.provider, member.account, member.model) === this.sticky.get(stickyKey(identity, sessionId)))
    if (sticky !== undefined && quotas.get(sticky)?.available === false
      && await this.options.recoverQuota?.(sticky, options.signal)) {
      this.options.usage.invalidate(sticky.provider, sticky.account)
      quotas.set(sticky, await this.options.usage.quotaFor(sticky))
    }
    let remaining = members
    const failures = new Map<ConcretePoolMember, unknown>()
    /** Cooldown reasons recorded during this selection, for the terminal error's code. */
    const reasons: string[] = []
    // A member the floors hold back leaves no health record, so its windows are the only
    // statement of when it becomes selectable again. The terminal error reports the earliest.
    const floorBlocked = quotaMembers.filter(member =>
      pastClaudeFloor(member, quotas.get(member), this.options.scheduling))
    const excludedWindows = floorBlocked.flatMap(member => floorWindows(quotas.get(member)))
    while (remaining.length > 0) {
      options.signal?.throwIfAborted()
      // Ranking and reservation are synchronous after shared quota reads settle.
      // Concurrent requests therefore see earlier reservations before choosing.
      const member = this.select(remaining, quotas, identity, options.sessionId)[0]
      if (member === undefined) break
      remaining = remaining.filter(candidate => candidate !== member)
      const adapter = this.options.adapters[member.provider]
      if (adapter === undefined) continue
      const release = this.reserve(member)
      let iterator: AsyncIterator<StreamChunk> | undefined
      try {
        let first: IteratorResult<StreamChunk>
        try {
          iterator = adapter.streamAccount(
            { ...options, provider: member.provider, model: member.model }, member.account,
          )[Symbol.asyncIterator]()
          first = await iterator.next()
          if (first.done === true) {
            throw new LlmError(`${memberLabel(member)} returned an empty stream`, EMPTY_RESPONSE_CODE)
          }
        } catch (error: unknown) {
          const classification = classifyPoolFailure(error, member.provider)
          if (classification.action === 'throw') throw error
          if (classification.action === 'park') {
            // A refusal the provider aimed at this account: record it, then end the
            // turn on it. Asking the next member would repeat the refusal under
            // another identity, which is the traffic a refusal exists to stop.
            this.recordCooldown(member, classification.scope, classification.cooldownMs, classification.reason)
            this.options.onWarn(
              `pool "${options.model}": ${memberLabel(member)} was refused`
              + ` (${error instanceof Error ? error.message : String(error)}); ending the turn`,
            )
            throw error
          }
          if ('cooldownMs' in classification) {
            this.recordCooldown(member, classification.scope, classification.cooldownMs, classification.reason)
            reasons.push(classification.reason)
            if (classification.reason === QUOTA_EXCEEDED_CODE || classification.reason === 'RATE_LIMIT') {
              this.options.usage.invalidate(member.provider, member.account)
            }
          }
          this.options.onWarn(
            `pool "${options.model}": ${memberLabel(member)} failed before any output`
            + ` (${error instanceof Error ? error.message : String(error)}); trying the next member`,
          )
          failures.set(member, error)
          continue
        }
        this.remember(identity, options.sessionId, member)
        // A visible stream stays on one account even if quota or load changes.
        yield first.value
        for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
          yield next.value
        }
        return
      } finally {
        try {
          await iterator?.return?.()
        } catch (_closeFailure) {
          // Stream teardown must not replace the request's outcome.
        } finally {
          release()
        }
      }
    }
    throw this.exhausted(options.model, members, failures, reasons, excludedWindows)
  }

  /**
   * Whether one account may serve one model under the pool's availability rule:
   * neither the member nor its whole account is cooling down, and a Claude
   * account has not reached a usage floor. The registered account route consults
   * this for a model the pool does not own, so that route cannot serve an
   * account the pool itself would have held back.
   * @param provider - the provider route.
   * @param model - the catalog model id.
   * @param account - the resolved account key.
   * @returns true when the account may serve now.
   */
  async accountAvailable(provider: ProviderId, model: string, account: string): Promise<boolean> {
    if (!this.options.health.isMemberAvailable(provider, account, model)) return false
    // Only Claude carries floors, so only Claude needs a usage read here.
    if (!carriesUsageFloor(provider)) return true
    const member: ConcretePoolMember = { provider, account, model }
    return !pastClaudeFloor(member, await this.options.usage.quotaFor(member), this.options.scheduling)
  }

  /**
   * Order the candidates for one request. Health filters both strategies;
   * `quota_aware` combines normalized urgency, bounded preferences, and
   * account load. Quota-full members stay in a last-resort band. A healthy
   * sticky member leads unless the same adjusted score beats its margin.
   */
  private select(
    members: ConcretePoolMember[],
    quotas: ReadonlyMap<ConcretePoolMember, MemberQuota>,
    poolId: string,
    sessionId: GenerateOptions['sessionId'],
  ): ConcretePoolMember[] {
    const usable = members.filter(member =>
      this.options.adapters[member.provider] !== undefined
      && this.options.health.isMemberAvailable(member.provider, member.account, member.model)
      && !pastClaudeFloor(member, quotas.get(member), this.options.scheduling))
    if (usable.length === 0) return []
    const stickyMember = sessionId === undefined
      ? undefined
      : usable.find(member =>
        memberKey(member.provider, member.account, member.model) === this.sticky.get(stickyKey(poolId, sessionId)))
    if (this.options.strategy === 'priority') {
      return stickyMember === undefined
        ? usable
        : [stickyMember, ...usable.filter(member => member !== stickyMember)]
    }
    // Usage was read before selection, so a member whose cooldown expired since
    // has no entry. Unknown usage is not evidence of a spent allowance: leave
    // such a member in the primary band rather than in neither.
    const quotaOf = (member: ConcretePoolMember): MemberQuota =>
      quotas.get(member) ?? { available: true, urgency: 0, fetchedAt: 0 }
    const scored = usable.filter(member => quotaOf(member).available)
    const quotaFull = usable.filter(member => !quotaOf(member).available)
    const now = Date.now()
    const scores = new Map<ConcretePoolMember, number>()
    for (const band of [scored, quotaFull]) {
      const maxUrgency = band.reduce((max, member) => Math.max(max, quotaOf(member).urgency), 0)
      for (const member of band) {
        scores.set(member, poolSchedulingScore(member, quotaOf(member), maxUrgency,
          this.active.get(accountKey(member.provider, member.account)) ?? 0, this.options.scheduling, now))
      }
    }
    const byQuota = (a: ConcretePoolMember, b: ConcretePoolMember): number => {
      const scoreOrder = scores.get(b)! - scores.get(a)!
      if (scoreOrder !== 0 || this.options.scheduling.loadPenalty === 0) return scoreOrder
      return (this.active.get(accountKey(a.provider, a.account)) ?? 0) - (this.active.get(accountKey(b.provider, b.account)) ?? 0)
    }
    scored.sort(byQuota)
    if (stickyMember !== undefined && scored.includes(stickyMember)) {
      const best = scored[0]
      const stickyScore = scores.get(stickyMember)!
      const bestScore = scores.get(best)!
      if (best === stickyMember || bestScore <= stickyScore * this.options.switchMargin) {
        scored.splice(scored.indexOf(stickyMember), 1)
        scored.unshift(stickyMember)
      }
    }
    return [...scored, ...quotaFull.sort(byQuota)]
  }

  /**
   * Mark one member, or its whole account, unavailable for `cooldownMs`.
   * @param member - the member that failed.
   * @param scope - whether the record covers the member or its account.
   * @param cooldownMs - how long the record holds.
   * @param reason - the failure code the record names.
   */
  private recordCooldown(
    member: ConcretePoolMember,
    scope: PoolFailureScope,
    cooldownMs: number,
    reason: string,
  ): void {
    this.options.health.markUnavailable(
      scope === 'account'
        ? accountKey(member.provider, member.account)
        : memberKey(member.provider, member.account, member.model),
      cooldownMs,
      reason,
    )
  }

  /** Hold account load through first-byte wait, streaming, and iterator teardown. */
  private reserve(member: ConcretePoolMember): () => void {
    const key = accountKey(member.provider, member.account)
    this.active.set(key, (this.active.get(key) ?? 0) + 1)
    return () => {
      const next = this.active.get(key)! - 1
      if (next === 0) this.active.delete(key)
      else this.active.set(key, next)
    }
  }

  /** Pin the serving member to the session (with bounded memory). */
  private remember(poolId: string, sessionId: GenerateOptions['sessionId'], member: ConcretePoolMember): void {
    if (sessionId === undefined) return
    const key = stickyKey(poolId, sessionId)
    this.sticky.delete(key)
    if (this.sticky.size >= STICKY_SESSION_LIMIT) {
      const oldest = this.sticky.keys().next()
      if (oldest.done !== true) this.sticky.delete(oldest.value)
    }
    this.sticky.set(key, memberKey(member.provider, member.account, member.model))
  }

  /**
   * A still-available member's failure keeps its own retry facts. A fully
   * unavailable pool reports why it is unavailable and when it may serve again:
   * the earliest health recovery, or the earliest reset among the windows that
   * held a member back.
   * @param model - the pool model being reported.
   * @param pool - every member of that pool.
   * @param failures - the failures this selection saw, by member.
   * @param reasons - the cooldown reasons this selection recorded.
   * @param excludedWindows - windows of members the availability floors held back.
   * @returns the terminal error for the exhausted pool.
   */
  private exhausted(
    model: string,
    pool: ConcretePoolMember[],
    failures: ReadonlyMap<ConcretePoolMember, unknown>,
    reasons: readonly string[],
    excludedWindows: readonly UsageWindow[],
  ): LlmError {
    for (const [member, error] of failures) {
      if (error instanceof LlmError && this.options.health.isMemberAvailable(member.provider, member.account, member.model)) return error
    }
    const cause = [...failures.values()].at(-1)
    const keys = new Set<string>()
    for (const member of pool) {
      keys.add(memberKey(member.provider, member.account, member.model))
      keys.add(accountKey(member.provider, member.account))
    }
    // The terminal code names why nothing served. Every member carries one reason — the failure
    // it just reported, or the health record that parked it before this selection started (a pool
    // parked by an auth failure says so rather than reporting a rate limit). A pool that reported
    // an enforcement-shaped refusal reports that refusal, whatever its other members did: naming a
    // rate limit instead would hand a refused account's turn back to the retry loop.
    const codes = new Set<string>(reasons)
    for (const member of pool) {
      if (this.options.health.isMemberAvailable(member.provider, member.account, member.model)) continue
      const cooling = this.options.health.accountCooling(member.provider, member.account)
      if (cooling !== undefined) codes.add(cooling.reason)
    }
    const code = exhaustionCode(codes)
    const now = Date.now()
    const recovery = this.options.health.earliestRecovery(keys, now)
    const reset = earliestReset(excludedWindows, now)
    const next = recovery === undefined ? reset
      : reset === undefined ? recovery : Math.min(recovery, reset)
    const retryAfterMs = next === undefined ? undefined : Math.max(next - now, 1)
    const detail = cause instanceof Error && cause.message.length > 0 ? cause.message : undefined
    return new LlmError(
      detail === undefined
        ? `pool "${model}" exhausted: every member is unavailable or failed`
        : `pool "${model}" exhausted: ${detail}`,
      code,
      {
        ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
        ...cause === undefined ? {} : { cause },
      },
    )
  }
}

function stickyKey(poolId: string, sessionId: NonNullable<GenerateOptions['sessionId']>): string {
  return `${String(sessionId)}|${poolId}`
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined
}

/** Reasoning efforts every member supports (id intersection, first member's order). */
function intersectReasoning(
  resolved: readonly LlmResolvedModelInfo[],
): LlmResolvedModelInfo['reasoning'] | undefined {
  const [first, ...rest] = resolved
  if (first?.reasoning === undefined) return undefined
  const efforts = first.reasoning.efforts.filter(effort =>
    rest.every(info => info.reasoning?.efforts.some(other => other.id === effort.id) === true))
  if (efforts.length === 0) return undefined
  const defaultEffort = first.reasoning.defaultEffort !== undefined
    && efforts.some(effort => effort.id === first.reasoning?.defaultEffort)
    ? first.reasoning.defaultEffort
    : undefined
  return { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } }
}

/** Modalities all members accept; undefined when any member leaves it unknown. */
function intersectModalities(
  resolved: readonly LlmResolvedModelInfo[],
): LlmResolvedModelInfo['inputModalities'] | undefined {
  const [first, ...rest] = resolved
  if (first?.inputModalities === undefined) return undefined
  const modalities = first.inputModalities.filter(modality =>
    rest.every(info => info.inputModalities?.includes(modality) === true))
  // An empty intersection would declare negative capability ("accepts
  // nothing"); report unknown instead — the serving member enforces its own
  // limits at request time.
  return modalities.length === 0 ? undefined : modalities
}
