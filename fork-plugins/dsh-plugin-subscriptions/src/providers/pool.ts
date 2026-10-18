/**
 * The pool adapter: same-subscription account routing, plus optional
 * configured tier extras. The picker is the union of every account's
 * catalog. A model listed by several accounts routes to one of them, and a
 * session keeps the account its turn is bound to.
 *
 * Two scheduling rules keep the account pool inside one subscription's meter:
 *
 * - A session is bound to one account for a whole turn. No failure inside a turn
 *   is answered from a sibling account, whatever its code; the turn fails and the
 *   retry policy retries the SAME account. This is what stops one conversation
 *   from being spread over several accounts, and what makes a 429 a pause rather
 *   than an account switch.
 * - A rematch — replacing an account that a window exhausted or a refusal
 *   parked — happens only at a turn boundary, at most once per turn, and never
 *   mid-turn. With no healthy account the pool reports the typed
 *   `no_available_account` instead of walking the pool.
 *
 * Concurrency, per-session backoff, the account request limiter and account
 * cooldowns live in {@link PoolGate}; this adapter owns selection and the
 * session-to-account affinity that survives between turns.
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
import type { UsagePoolState, UsageWindow } from './common.js'
import type { ConcretePoolMember, PoolDefinition, PoolMemberRef } from './pool-family.js'
import { poolKey } from './pool-family.js'
import {
  accountKey,
  AUTH_COOLDOWN_MS,
  classifyPoolFailure,
  isAuthCooldownReason,
  isRefusalCode,
  memberKey,
  PoolHealthRegistry,
} from './pool-health.js'
import type { MemberQuota, PoolUsageTracker } from './pool-usage.js'
import { CONSUMABLE_QUOTA_FULL_PERCENT, QUOTA_FULL_PERCENT } from './pool-usage.js'
import { poolSchedulingScore } from './pool-scheduling.js'
import type { PoolSchedulingPolicy } from './pool-scheduling.js'
import { PoolGate, PoolGateError, SessionTurns } from './pool-gate.js'
import type { AccountGateSnapshot, PoolGateConfig, PoolGateReason, SessionTurn } from './pool-gate.js'
import { resolvePoolGatePolicy } from './pool-gate.js'

/** Member-selection strategy: plain priority or quota-aware scheduling. */
type PoolStrategy = 'priority' | 'quota_aware'

export interface PoolAdapterOptions {
  /** The live subscription adapters, by provider route. */
  adapters: Partial<Record<ProviderId, AccountAwareAdapter>>
  health: PoolHealthRegistry
  usage: PoolUsageTracker
  strategy: PoolStrategy
  /** Complete bounded preference and account-load policy, resolved at plugin load. */
  scheduling: PoolSchedulingPolicy
  /** Account concurrency, request limiter and backoff policy; defaults apply when omitted. */
  concurrency?: PoolGateConfig
  /** The default account of one provider (for config members omitting `account`). */
  defaultAccount: (provider: ProviderId) => Promise<string | undefined>
  /** Resolve legacy account aliases before pool deduplication and cache identity. */
  resolveAccount?: (provider: ProviderId, account: string) => Promise<string>
  /**
   * Account pools (auto-aggregated plus config overrides). The provider hint
   * scopes the sweep: a family source that lists accounts per provider must not
   * enumerate another route's accounts for a read that only asks about one, so
   * resolving a model never waits on an unrelated provider's catalog. A source
   * that is already complete ignores it.
   */
  families: (provider?: ProviderId) => Promise<Map<string, PoolDefinition>>
  /** User-configured extra picker entries (heterogeneous fallbacks), by pool id. */
  tiers: Record<string, PoolMemberRef[]>
  /** Optional quota recovery for a depleted bound account before it is rematched. */
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
 * The subset of `windows` that actually breaches its configured floor. These
 * alone hold an account back, so these alone state when it becomes selectable
 * again: a window under its floor resets without releasing anything.
 * @param windows - the windows constraining the member.
 * @param scheduling - the resolved policy naming both floors.
 * @returns the breaching windows, in their original order.
 */
function breachingWindows(
  windows: readonly UsageWindow[],
  scheduling: PoolSchedulingPolicy,
): UsageWindow[] {
  return windows.filter(window =>
    (window.kind === 'session' && window.usedPercent >= scheduling.claudeSessionPercentFloor)
    || (window.kind === 'weekly' && window.usedPercent >= scheduling.claudeWeeklyPercentFloor))
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
  return usageFloorBreaches(member.provider, quota, scheduling).length > 0
}

/**
 * The windows of one account's retained quota that breach its configured usage
 * floor. Exported so a route that serves an account without going through the
 * pool can apply the same reserve before it starts a request, instead of
 * starting one the pool would have held back.
 * @param provider - the provider route.
 * @param quota - the account's retained quota, when usage is known.
 * @param scheduling - the resolved policy naming both floors.
 * @returns the breaching windows, in their original order; empty when none do.
 */
export function usageFloorBreaches(
  provider: ProviderId,
  quota: MemberQuota | undefined,
  scheduling: PoolSchedulingPolicy,
): UsageWindow[] {
  if (!carriesUsageFloor(provider)) return []
  return breachingWindows(floorWindows(quota), scheduling)
}

/**
 * The windows that keep one member out of selection: a Claude usage floor, or a
 * window the account's own quota rule reports as full.
 * @param member - the excluded member.
 * @param quota - its retained reading, when usage is known.
 * @param scheduling - the resolved policy naming both floors.
 * @returns the blocking windows, in their original order.
 */
function blockingWindows(
  member: ConcretePoolMember,
  quota: MemberQuota | undefined,
  scheduling: PoolSchedulingPolicy,
): UsageWindow[] {
  const full = member.provider === 'codex' || member.provider === 'claude'
    ? CONSUMABLE_QUOTA_FULL_PERCENT : QUOTA_FULL_PERCENT
  return floorWindows(quota).filter(window =>
    window.usedPercent >= full
    || breachingWindows([window], scheduling).length > 0)
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

/** Bound on remembered session-account bindings; oldest entries evict past it. */
const BINDING_LIMIT = 1_000

/** A session's account affinity: the account its turns are bound to. */
interface SessionBinding {
  readonly provider: ProviderId
  readonly account: string
  /** Identity of the turn that last used this binding, from {@link SessionTurns}. */
  turnKey: number | undefined
}

/** Display form of one member (account shown when pinned). */
function memberLabel(member: PoolMemberRef): string {
  return member.account === undefined
    ? `${member.provider}/${member.model}`
    : `${member.provider}/${member.account}/${member.model}`
}

/** How long a pools snapshot is trusted (auth changes invalidate immediately). */
const POOLS_CACHE_TTL_MS = 5_000

export class PoolAdapter extends LlmAdapter {
  /** sessionId|poolId → account the session's turns are bound to. */
  private readonly bindings = new Map<string, SessionBinding>()
  /** The open turn of every live session, fed by `turn/start` and `turn/end`. */
  private readonly turns = new SessionTurns()
  /** Concurrency, backoff and cooldown decisions for every account of this pool. */
  private readonly gate: PoolGate
  /** Outstanding pool attempts, including first-byte waits, shared across models of each account. */
  private readonly active = new Map<string, number>()
  /** Messages already warned about — configuration diagnostics repeat every request otherwise. */
  private readonly warned = new Set<string>()
  /** Identity of a sessionless request, so its transient bookings can be forgotten. */
  private requestSerial = 0
  /**
   * Short-lived pools snapshots, one per provider route. `owns()` runs on every
   * resolveModel — the model picker issues one per entry — and assembly reads
   * every account of the provider it names, so recompute at most this often.
   * Kept per provider because every read path already knows its route: a codex
   * read must not pay for grok's discovery. Auth changes bump {@link generation}
   * so a stale snapshot cannot land.
   */
  private readonly poolsCache = new Map<ProviderId, { at: number; pools: Map<string, PoolDefinition> }>()
  private readonly poolsInflight = new Map<ProviderId, Promise<Map<string, PoolDefinition>>>()
  private generation = 0

  constructor(private readonly options: PoolAdapterOptions) {
    super()
    this.gate = new PoolGate(resolvePoolGatePolicy(options.concurrency), options.health)
  }

  /** Drop the pools snapshots so the next read reflects the current accounts. */
  invalidate(): void {
    this.generation += 1
    this.poolsCache.clear()
    this.poolsInflight.clear()
  }

  /**
   * Record that a session opened a turn. Every request of that turn is bound to
   * one account; only the next turn may rematch.
   * @param sessionId - the session whose turn opened.
   * @param turn - the turn number the session log recorded.
   */
  noteTurnStart(sessionId: string, turn: number): void {
    this.turns.noteTurnStart(sessionId, turn)
  }

  /**
   * Record that a session closed a turn, releasing its account session slot.
   * @param sessionId - the session whose turn closed.
   * @param turn - the turn number that ended, when the event named it.
   */
  noteTurnEnd(sessionId: string, turn?: number): void {
    const open = this.turns.current(sessionId)
    this.turns.noteTurnEnd(sessionId, turn)
    // A stale end (an earlier turn closing after a resume opened the next one)
    // must not release the slot the open turn is using.
    if (open === undefined || turn === undefined || open.turn === turn) this.gate.releaseTurn(sessionId)
  }

  /**
   * Forget a disposed session's turn and bookings.
   * @param sessionId - the disposed session.
   */
  forgetSession(sessionId: string): void {
    this.turns.forget(sessionId)
    this.gate.forget(sessionId)
    const prefix = `${sessionId}|`
    for (const key of [...this.bindings.keys()]) {
      if (key.startsWith(prefix)) this.bindings.delete(key)
    }
  }

  /**
   * Report one account's concurrency and cooldown state (diagnostics only).
   * @param provider - the account's provider route.
   * @param account - the account key.
   * @returns the account's slot, limiter and cooldown facts.
   */
  gateSnapshot(provider: ProviderId, account: string): AccountGateSnapshot {
    return this.gate.snapshot(provider, account)
  }

  /** Refuse queued admissions; called when the plugin is disposed. */
  dispose(): void {
    this.gate.dispose()
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

  /** One provider's account pools (auto-aggregated plus config overrides) with usable members. */
  private async familyPools(provider: ProviderId): Promise<Map<string, PoolDefinition>> {
    return this.usable(new Map<string, PoolDefinition>(await this.options.families(provider)))
  }

  /** The pools one provider's route resolves through, assembled at most once per TTL. */
  private async pools(provider: ProviderId): Promise<Map<string, PoolDefinition>> {
    const cached = this.poolsCache.get(provider)
    if (cached !== undefined && Date.now() - cached.at < POOLS_CACHE_TTL_MS) return cached.pools
    const gen = this.generation
    let inflight = this.poolsInflight.get(provider)
    if (inflight === undefined) {
      const created = this.assemblePools(provider)
        .then((pools) => {
          if (this.generation === gen) this.poolsCache.set(provider, { at: Date.now(), pools })
          return pools
        })
        .finally(() => {
          if (this.poolsInflight.get(provider) === created) this.poolsInflight.delete(provider)
        })
      this.poolsInflight.set(provider, created)
      inflight = created
    }
    return inflight
  }

  /** Recompute one provider's pools snapshot (its account pools merged with its own tiers). */
  private async assemblePools(provider: ProviderId): Promise<Map<string, PoolDefinition>> {
    const pools = await this.familyPools(provider)
    for (const [id, members] of Object.entries(this.options.tiers)) {
      if (members.length === 0) continue
      const owner = members[0].provider
      // A tier is keyed under its first member's provider, so it belongs to that
      // provider's snapshot only; its own members may still span providers.
      if (owner !== provider) continue
      const key = poolKey(owner, id)
      if (pools.has(key)) this.warnOnce(`tier pool "${id}" overrides the account pool of the same id under ${owner}`)
      pools.set(key, { members })
    }
    return this.usable(pools)
  }

  /**
   * Extra picker rows one provider lists (configured tiers). This is a
   * configuration read: an account pool reuses the catalog entry of its own wire
   * id, so it contributes no row here, and answering must not assemble the
   * account pools or await any provider's discovery. The row a tier lists is
   * keyed under its first member's provider and named by its pool id, exactly as
   * the assembled snapshot names it.
   * @param provider - the provider route whose tiers are listed.
   * @returns the provider's configured extra rows, in configuration order.
   */
  async modelsForProvider(provider: ProviderId): Promise<LlmModelInfo[]> {
    const models: LlmModelInfo[] = []
    for (const [id, members] of Object.entries(this.options.tiers)) {
      if (members.length === 0 || members[0].provider !== provider) continue
      // The assembled snapshot drops a pool whose members all lack a registered
      // adapter; a tier row obeys the same rule.
      if (members.every(member => this.options.adapters[member.provider] === undefined)) continue
      models.push({ provider, id, name: id })
    }
    return models
  }

  /**
   * Whether `model` on `provider`'s route is served here (several accounts
   * route, one account is pinned, or a configured tier).
   */
  async owns(provider: ProviderId, model: string): Promise<boolean> {
    return (await this.pools(provider)).has(poolKey(provider, model))
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
   * so a request valid for the pool stays valid after a rematch. Capability
   * metadata is account-specific, so every distinct member is resolved.
   */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const definition = (await this.pools(provider as ProviderId)).get(poolKey(provider, model))
    if (definition === undefined) throw new LlmError(`unknown pool model "${model}"`, 'NO_ADAPTER')
    const resolved: LlmResolvedModelInfo[] = []
    let lastFailure: unknown
    const members = await this.concrete(definition.members)
    for (const member of members) {
      const adapter = this.options.adapters[member.provider]
      if (adapter === undefined) continue
      // Tolerate per-member failures (a misconfigured tier member, a
      // logged-out provider throwing AUTH): the pool serves as long as ONE
      // member resolves.
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
    const definition = (await this.pools(options.provider as ProviderId)).get(identity)
    if (definition === undefined) throw new LlmError(`unknown pool model "${options.model}"`, 'NO_ADAPTER')
    const members = await this.concrete(definition.members)
    const sessionKey = options.sessionId === undefined ? undefined : String(options.sessionId)
    const turn = sessionKey === undefined ? undefined : this.turns.current(sessionKey)
    const bindingKey = sessionKey === undefined ? undefined : affinityKey(identity, sessionKey)
    // A sessionless request gets its own transient bookings, forgotten when it ends.
    const slotKey = sessionKey ?? `request:${String(this.requestSerial += 1)}`
    // Retained readings are read before selection; only the account about to serve
    // is verified with one upstream read, so an idle peer is never swept.
    const quotas = new Map<ConcretePoolMember, MemberQuota>()
    for (const member of members) {
      if (!this.options.health.isMemberAvailable(member.provider, member.account, member.model)) continue
      quotas.set(member, this.options.usage.quotaFor(member))
    }
    const excluded = new Set<ConcretePoolMember>()
    const reasons: string[] = []
    try {
      // A local account-policy refusal sends no request, so another member may
      // take this request; every real failure below ends the turn on its account.
      for (let attempt = 0; attempt <= members.length; attempt += 1) {
        options.signal?.throwIfAborted()
        const chosen = await this.bindTurn({
          model: options.model,
          members,
          quotas,
          excluded,
          slotKey,
          turn,
          bindingKey,
          signal: options.signal,
        })
        const member = chosen.member
        const adapter = this.options.adapters[member.provider]
        if (adapter === undefined) {
          chosen.release()
          excluded.add(member)
          this.dropBinding(bindingKey)
          this.gate.releaseTurn(slotKey)
          continue
        }
        let iterator: AsyncIterator<StreamChunk> | undefined
        let admitted: (() => void) | undefined
        let committed = false
        try {
          admitted = await this.gate.admit(slotKey, member.provider, member.account, options.signal)
          // The one account about to serve is the only one whose reading may be
          // refreshed here; peers were ranked from what was already known.
          iterator = adapter.streamAccount(
            { ...options, provider: member.provider, model: member.model }, member.account,
          )[Symbol.asyncIterator]()
          const first = await iterator.next()
          if (first.done === true) {
            throw new LlmError(`${memberLabel(member)} returned an empty stream`, EMPTY_RESPONSE_CODE)
          }
          committed = true
          // A visible stream stays on one account even if quota or load changes.
          yield first.value
          for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
            yield next.value
          }
          this.gate.noteSuccess(slotKey)
          return
        } catch (error: unknown) {
          if (error instanceof PoolGateError) throw error
          const classification = classifyPoolFailure(error, member.provider)
          if (classification.action === 'member-ineligible' && !committed) {
            excluded.add(member)
            this.dropBinding(bindingKey)
            this.gate.releaseTurn(slotKey)
            continue
          }
          this.recordFailure(member, slotKey, classification, reasons)
          throw error
        } finally {
          try {
            await iterator?.return?.()
          } catch (_closeFailure) {
            // Stream teardown must not replace the request's outcome.
          } finally {
            admitted?.()
            chosen.release()
          }
        }
      }
      throw this.noAvailableAccount(options.model, members, reasons, quotas)
    } finally {
      if (sessionKey === undefined) this.gate.forget(slotKey)
    }
  }

  /**
   * Choose the account one request is sent to, and reserve its load before the
   * account's own reading is verified so concurrent selections spread rather
   * than all taking the cold-start leader.
   *
   * The affinity rule: a request of an open turn keeps that turn's account. At a
   * turn boundary the bound account is kept while it may serve, and replaced
   * only when a window exhausted it or a refusal parked it. A turn boundary the
   * plugin did not observe is not a boundary, so nothing is rematched.
   */
  private async bindTurn(input: {
    model: string
    members: readonly ConcretePoolMember[]
    quotas: Map<ConcretePoolMember, MemberQuota>
    excluded: ReadonlySet<ConcretePoolMember>
    slotKey: string
    turn: SessionTurn | undefined
    bindingKey: string | undefined
    signal: AbortSignal | undefined
  }): Promise<{ member: ConcretePoolMember; release: () => void }> {
    const { model, members, quotas, excluded, slotKey, turn, bindingKey, signal } = input
    const usable = this.candidates(members, quotas, excluded)
    const binding = bindingKey === undefined ? undefined : this.bindings.get(bindingKey)
    const sameTurn = binding !== undefined && turn !== undefined && binding.turnKey === turn.key
    // The retry budget is per logical request cycle: a new turn starts a fresh one.
    if (turn !== undefined && !sameTurn) this.gate.beginTurn(slotKey)
    const bound = binding === undefined ? undefined : usable.find(member =>
      member.provider === binding.provider && member.account === binding.account)

    if (binding !== undefined && sameTurn) {
      if (bound === undefined) throw this.boundDenied(model, binding)
      const release = this.reserve(bound)
      try {
        await this.gate.acquireTurn(slotKey, bound.provider, bound.account, signal)
        this.touch(bindingKey, binding)
        return { member: bound, release }
      } catch (error: unknown) {
        release()
        throw error
      }
    }

    if (binding !== undefined && bound !== undefined) {
      // The bound account is still selectable: keep it unless its own reading says
      // spent and a peer the pool could still verify is not.
      const release = this.reserve(bound)
      try {
        const fresh = await this.verifyAccount(bound, signal)
        quotas.set(bound, fresh)
        if (!this.floorBlocked(bound, fresh)) {
          const peerBetter = this.unavailable(fresh)
            && usable.some(candidate => candidate !== bound && !this.spentReading(candidate))
          if (!peerBetter) {
            await this.gate.acquireTurn(slotKey, bound.provider, bound.account, signal)
            this.remember(bindingKey, bound, turn)
            return { member: bound, release }
          }
        }
        release()
      } catch (error: unknown) {
        release()
        throw error
      }
      if (turn === undefined) throw this.boundDenied(model, binding)
    } else if (binding !== undefined && turn === undefined) {
      throw this.boundDenied(model, binding)
    }

    // A spent leader is deferred to an unspent peer; when every candidate is spent
    // the pool still tries one, which is its last resort rather than a refusal.
    // A usage floor is different: it is a hard reserve, so such a member is skipped.
    const ranked = this.select(usable, quotas)
    const leader = ranked.find(candidate => !this.spentReading(candidate)) ?? ranked[0]
    const alternate = leader === undefined ? undefined
      : ranked.find(candidate => candidate !== leader && !this.spentReading(candidate))
    const attempts = leader === undefined ? [] : alternate === undefined ? [leader] : [leader, alternate]
    for (const candidate of attempts) {
      const release = this.reserve(candidate)
      try {
        const fresh = await this.verifyAccount(candidate, signal)
        quotas.set(candidate, fresh)
        if (this.floorBlocked(candidate, fresh)) {
          release()
          continue
        }
        if (candidate === leader && alternate !== undefined && this.unavailable(fresh)) {
          release()
          continue
        }
        await this.gate.acquireTurn(slotKey, candidate.provider, candidate.account, signal)
        this.remember(bindingKey, candidate, turn)
        return { member: candidate, release }
      } catch (error: unknown) {
        release()
        throw error
      }
    }
    throw this.noAvailableAccount(model, members, [], quotas)
  }

  /**
   * The members a turn may start on: health, usage floors and the catalogue
   * adapter all permit them, and no earlier local refusal excluded them.
   */
  private candidates(
    members: readonly ConcretePoolMember[],
    quotas: ReadonlyMap<ConcretePoolMember, MemberQuota>,
    excluded: ReadonlySet<ConcretePoolMember>,
  ): ConcretePoolMember[] {
    return members.filter(member =>
      !excluded.has(member)
      && this.options.adapters[member.provider] !== undefined
      && this.options.health.isMemberAvailable(member.provider, member.account, member.model)
      && !pastClaudeFloor(member, quotas.get(member), this.options.scheduling))
  }

  /**
   * Verify the candidate about to serve with one upstream usage read, and give
   * a depleted Codex account its reset-credit recovery before it is judged.
   */
  private async verifyAccount(member: ConcretePoolMember, signal?: AbortSignal): Promise<MemberQuota> {
    let quota = await this.options.usage.ensureForUse(member)
    if (quota.available === false && await this.options.recoverQuota?.(member, signal) === true) {
      this.options.usage.invalidate(member.provider, member.account)
      quota = await this.options.usage.ensureForUse(member)
    }
    return quota
  }

  /** Whether a reading breaches this account's configured usage floor (a hard reserve). */
  private floorBlocked(member: ConcretePoolMember, quota: MemberQuota): boolean {
    return usageFloorBreaches(member.provider, quota, this.options.scheduling).length > 0
  }

  /** Whether a reading reports the account's allowance as spent (a soft, last-resort signal). */
  private unavailable(quota: MemberQuota): boolean {
    return quota.available === false
  }

  /** Whether the candidate's retained reading already reports a spent allowance. */
  private spentReading(member: ConcretePoolMember): boolean {
    return this.unavailable(this.options.usage.quotaFor(member))
  }

  /**
   * Whether one account is past a usage floor for every model it could be asked for.
   *
   * The floors are model-independent — the session and weekly windows — so this answers
   * the `usage` card's question ("could a peer serve instead?") without naming a model and
   * without the discovery that naming one would trigger. A model-scoped lane below its own
   * floor cannot make an account selectable when its session window breached.
   *
   * Deliberately answered from retained readings only: this is the peer test the usage card
   * runs over every account, and reading them here would be the whole-pool sweep the pool
   * exists to avoid. {@link accountHoldback} is the one that may read, because its caller is
   * about to commit a request to the account it asks about.
   * @param provider - the provider route.
   * @param account - the resolved account key.
   * @returns true when only a window reset can make the account selectable again.
   */
  async accountAtFloor(provider: ProviderId, account: string): Promise<boolean> {
    if (!carriesUsageFloor(provider)) return false
    const quota = this.options.usage.quotaFor({ provider, account })
    return usageFloorBreaches(provider, quota, this.options.scheduling).length > 0
  }

  /**
   * Why the pool's availability rule holds one account back, in the vocabulary the
   * pool-exhausted error reports: neither the member nor its whole account may be
   * cooling down, and a Claude account must not have reached a usage floor. A route
   * that owns no entry for a model still consults this, so it cannot serve an account
   * the pool itself would have held back — and it can state the same cause and the
   * same earliest-recovery hint instead of naming an unavailable model.
   *
   * Answered from retained readings by default, because the callers that list or
   * resolve a model must not reach the network. `ensure` is the caller's own
   * statement that it is about to commit a request to this account, which buys the
   * single read {@link PoolUsageTracker.ensureForUse} may perform.
   * @param provider - the provider route.
   * @param model - the catalog model id.
   * @param account - the resolved account key.
   * @param ensure - permit one upstream usage read for this account when its reading is missing or stale.
   * @returns the holdback, or undefined when the account may serve now.
   */
  async accountHoldback(
    provider: ProviderId,
    model: string,
    account: string,
    ensure = false,
  ): Promise<{ code: string; retryAfterMs?: number } | undefined> {
    const now = Date.now()
    const cooling = this.options.health.accountCooling(provider, account, now)
    if (cooling !== undefined) {
      return { code: cooling.reason, retryAfterMs: Math.max(cooling.unavailableUntil - now, 1) }
    }
    // Only Claude carries floors, so only Claude needs a usage read here.
    if (!carriesUsageFloor(provider)) return undefined
    const member: ConcretePoolMember = { provider, account, model }
    const quota = ensure
      ? await this.options.usage.ensureForUse(member)
      : this.options.usage.quotaFor(member)
    const breaching = usageFloorBreaches(provider, quota, this.options.scheduling)
    if (breaching.length === 0) return undefined
    const reset = earliestReset(breaching, now)
    // A floor is a spent allowance, not a refusal: `RATE_LIMIT` is what the pool-exhausted
    // error reports when floors alone held every member back, and it is the code the harness
    // retries with the disclosed reset as its hint.
    return { code: 'RATE_LIMIT', ...reset === undefined ? {} : { retryAfterMs: Math.max(reset - now, 1) } }
  }

  /** Remember the account a session's turns are bound to, with bounded memory. */
  private remember(bindingKey: string | undefined, member: ConcretePoolMember, turn: SessionTurn | undefined): void {
    if (bindingKey === undefined) return
    this.bindings.delete(bindingKey)
    if (this.bindings.size >= BINDING_LIMIT) {
      const oldest = this.bindings.keys().next()
      if (oldest.done !== true) this.bindings.delete(oldest.value)
    }
    this.bindings.set(bindingKey, {
      provider: member.provider,
      account: member.account,
      turnKey: turn?.key,
    })
  }

  /** Drop one session's affinity (its account could not be used at all). */
  private dropBinding(bindingKey: string | undefined): void {
    if (bindingKey !== undefined) this.bindings.delete(bindingKey)
  }

  /**
   * Apply one failure's effect to the gate.
   *
   * No branch switches accounts: the account is parked or the session backs off,
   * and the turn fails with the provider's own error so retry policy decides
   * whether the same account may be tried again.
   */
  private recordFailure(
    member: ConcretePoolMember,
    slotKey: string,
    classification: ReturnType<typeof classifyPoolFailure>,
    reasons: string[],
  ): void {
    switch (classification.action) {
      case 'session-backoff': {
        this.gate.noteSessionFailure(slotKey, {
          reason: classification.reason,
          ...classification.delayMs === undefined ? {} : { delayMs: classification.delayMs },
        })
        reasons.push(classification.reason)
        this.options.onWarn(
          `pool: ${memberLabel(member)} failed before any output`
          + ` (${classification.reason}); backing this session off instead of switching accounts`,
        )
        return
      }
      case 'account-cooldown': {
        this.gate.cooldown(member.provider, member.account, classification.cooldownMs, classification.reason)
        reasons.push(classification.reason)
        // A spent allowance invalidates the reading; a refusal says nothing about it.
        if (classification.reason === QUOTA_EXCEEDED_CODE) {
          this.options.usage.invalidate(member.provider, member.account)
        }
        this.options.onWarn(
          `pool: ${memberLabel(member)} is parked for ${String(classification.cooldownMs)}ms`
          + ` (${classification.reason}); this turn ends on that account`
          + (isRefusalCode(classification.reason) ? ' and the next turn rematches' : ''),
        )
        return
      }
      case 'refresh': {
        const refresh = this.gate.noteRefreshFailure(member.provider, member.account)
        reasons.push(classification.reason)
        if (refresh.exhausted) {
          // The refresh budget is spent: only a re-login (or its expiry) can help,
          // so the account is parked for the auth cooldown.
          this.gate.cooldown(member.provider, member.account, AUTH_COOLDOWN_MS, classification.reason)
          this.options.onWarn(
            `pool: ${memberLabel(member)} exhausted its ${String(this.gate.concurrency.maxRefreshAttempts)}`
            + ` credential refreshes (${classification.reason}); the account is parked`
            + ' and the next turn rematches',
          )
        } else {
          this.options.onWarn(
            `pool: ${memberLabel(member)} credential refresh failed`
            + ` (${String(refresh.attempts)}/${String(this.gate.concurrency.maxRefreshAttempts)},`
            + ` ${classification.reason}); the same account is retried`,
          )
        }
        return
      }
      case 'model-scoped': {
        reasons.push(classification.reason)
        this.options.onWarn(
          `pool: ${memberLabel(member)} denied this model (${classification.reason}); the account is not switched`,
        )
        return
      }
      case 'member-ineligible': {
        reasons.push(classification.reason)
        return
      }
      case 'throw': {
        return
      }
    }
  }

  /**
   * Order the candidates for one request. Health filters both strategies;
   * `quota_aware` combines normalized urgency, bounded preferences, and
   * account load. Quota-full members stay in a last-resort band.
   */
  private select(
    members: ConcretePoolMember[],
    quotas: ReadonlyMap<ConcretePoolMember, MemberQuota>,
  ): ConcretePoolMember[] {
    if (members.length === 0) return []
    if (this.options.strategy === 'priority') return members
    // Usage was read before selection, so a member whose cooldown expired since
    // has no entry. Unknown usage is not evidence of a spent allowance: leave
    // such a member in the primary band rather than in neither.
    const quotaOf = (member: ConcretePoolMember): MemberQuota =>
      quotas.get(member) ?? { available: true, urgency: 0, fetchedAt: 0, observation: 'unavailable' }
    const scored = members.filter(member => quotaOf(member).available)
    const quotaFull = members.filter(member => !quotaOf(member).available)
    const now = Date.now()
    const scores = new Map<ConcretePoolMember, number>()
    for (const band of [scored, quotaFull]) {
      const maxUrgency = band.reduce((max, member) => Math.max(max, quotaOf(member).urgency), 0)
      for (const member of band) {
        const quota = quotaOf(member)
        // An account nothing has been observed for yet scores the band's unit
        // baseline: a cold cache is not a statement that the account is empty,
        // and ranking it on invented urgency would both starve it and hand it
        // traffic it may not be able to serve.
        const ranked = quota.observation === 'unread' ? { ...quota, urgency: maxUrgency, windows: [] } : quota
        scores.set(member, poolSchedulingScore(member, ranked, maxUrgency,
          this.active.get(accountKey(member.provider, member.account)) ?? 0, this.options.scheduling, now))
      }
    }
    // A route with no usage endpoint can never be ranked on evidence, so it
    // yields to an unread account the pool could still verify, which in turn
    // yields to one it has actually observed.
    const evidence = (member: ConcretePoolMember): number => {
      const observation = quotaOf(member).observation
      return observation === 'observed' ? 2 : observation === 'unread' ? 1 : 0
    }
    const byQuota = (a: ConcretePoolMember, b: ConcretePoolMember): number => {
      const scoreOrder = scores.get(b)! - scores.get(a)!
      if (scoreOrder !== 0) return scoreOrder
      const evidenceOrder = evidence(b) - evidence(a)
      if (evidenceOrder !== 0 || this.options.scheduling.loadPenalty === 0) return evidenceOrder
      return (this.active.get(accountKey(a.provider, a.account)) ?? 0) - (this.active.get(accountKey(b.provider, b.account)) ?? 0)
    }
    scored.sort(byQuota)
    return [...scored, ...quotaFull.sort(byQuota)]
  }

  /**
   * The typed refusal of a pool that may not ask any account on this turn.
   *
   * It reports when the earliest exclusion recovers, when one is known, but it
   * never walks the remaining members: a pool with nothing healthy must not
   * generate one request per account.
   */
  private noAvailableAccount(
    model: string,
    pool: readonly ConcretePoolMember[],
    reasons: readonly string[],
    quotas: ReadonlyMap<ConcretePoolMember, MemberQuota>,
    detail?: string,
  ): PoolGateError {
    const now = Date.now()
    const keys = new Set<string>()
    for (const member of pool) {
      keys.add(memberKey(member.provider, member.account, member.model))
      keys.add(accountKey(member.provider, member.account))
    }
    const recovery = this.options.health.earliestRecovery(keys, now)
    // Only a window that actually holds the account back states a usable wait: a
    // window under its floor releases nothing when it resets.
    const blocked = pool.flatMap(member => blockingWindows(member, quotas.get(member), this.options.scheduling))
    const windows = earliestReset(blocked, now)
    const next = recovery === undefined ? windows
      : windows === undefined ? recovery : Math.min(recovery, windows)
    const retryAfterMs = next === undefined ? undefined : Math.max(next - now, 1)
    const why = [...new Set(reasons)]
    return new PoolGateError(
      detail ?? `pool "${model}" has no available account: every member is cooling down or past its usage floor`
        + (why.length > 0 ? ` (${why.join('; ')})` : ''),
      'no_available_account',
      { ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs } },
    )
  }

  /**
   * The typed refusal of a turn whose bound account cannot serve.
   *
   * It is not a rematch point: the turn keeps its account, and the next turn
   * decides again. The record's reason selects the typed outcome and the wait.
   */
  private boundDenied(model: string, binding: SessionBinding): PoolGateError {
    const now = Date.now()
    const cooling = this.options.health.accountCooling(binding.provider, binding.account, now)
    const reason: PoolGateReason = cooling === undefined ? 'account_unavailable'
      : isAuthCooldownReason(cooling.reason) ? 'account_unavailable'
        : cooling.reason === QUOTA_EXCEEDED_CODE ? 'quota_exhausted'
          : cooling.reason === 'RATE_LIMIT' ? 'rate_limited'
            : 'account_unavailable'
    const retryAfterMs = cooling === undefined ? undefined : Math.max(cooling.unavailableUntil - now, 1)
    return new PoolGateError(
      `pool "${model}": ${binding.provider}/${binding.account} cannot serve this turn;`
      + ' the turn keeps its account and the next turn rematches',
      reason,
      { ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs } },
      cooling?.reason,
    )
  }

  /**
   * Refresh one binding's position in the bounded map without changing it, so
   * eviction follows recent affinity rather than first use.
   */
  private touch(bindingKey: string | undefined, binding: SessionBinding): void {
    if (bindingKey === undefined) return
    this.bindings.delete(bindingKey)
    this.bindings.set(bindingKey, binding)
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
}

/**
 * The `usage` endpoint's pool attribution for one account.
 *
 * A peer counts only when the pool would actually accept it: its account record is
 * clear AND, on a route that reserves usage floors, it has not reached one. Health
 * alone would let the card claim another account is serving while every peer sits
 * past its floor — a rematch that cannot happen — so the floor check is required
 * before a pool attribution is printed.
 * @param health - the pool's cooldown registry.
 * @param pool - the pool whose availability rule applies, or undefined when none is wired.
 * @param provider - the provider route.
 * @param account - the account the card describes.
 * @param peers - every other account of the provider, in the token store's order.
 * @param pooled - whether one account participates in the pool (the caller's preference rule).
 * @returns the parking record for this account, and whether a peer may serve in its place.
 */
export async function usagePoolState(
  health: PoolHealthRegistry,
  pool: PoolAdapter | undefined,
  provider: ProviderId,
  account: string,
  peers: readonly string[],
  pooled: (account: string) => boolean,
): Promise<UsagePoolState> {
  const cooling = health.accountCooling(provider, account)
  let peerAvailable = false
  for (const peer of peers) {
    if (peer === account || !pooled(peer)) continue
    if (!health.isAvailable(accountKey(provider, peer))) continue
    if (pool !== undefined && await pool.accountAtFloor(provider, peer)) continue
    peerAvailable = true
    break
  }
  if (cooling === undefined) return { peerAvailable }
  return {
    peerAvailable,
    coolingUntil: cooling.unavailableUntil,
    coolingReason: isAuthCooldownReason(cooling.reason) ? 'auth' : 'quota',
  }
}

function affinityKey(poolId: string, sessionId: string): string {
  return `${sessionId}|${poolId}`
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
