/**
 * One plugin application's shared subscription cache.
 *
 * The node half keeps the only authoritative cache; this module is the
 * browser-side holder in front of it, so the composer badge and the Settings
 * page render the same entries instead of running one identical read loop
 * each. Three facts live here: the last roster answer, one entry per
 * `${provider}:${accountKey}`, and which keys have a read in flight.
 *
 * Nothing in this module runs on a timer. A read happens only when a UI event
 * asks for one, every read is single-flight per key, and a request that
 * arrives while that key is already reading folds into the running read with
 * the strongest requested mode. A failed read keeps the entry's last known
 * payload, so an error line never blanks the quotas the user was reading; an
 * entry is dropped only when the roster stops listing its account.
 *
 * Every read carries the cache epoch it started in. `reset` (a new connection
 * generation, whose Host knows nothing the previous one answered) and
 * `dispose` (the owning plugin's teardown) advance the epoch, so a result that
 * arrives afterwards is discarded instead of repopulating state the owner no
 * longer has. A roster read additionally carries its own attempt number: when
 * a fresh read overtakes one still in flight, only the newest answer is
 * published.
 *
 * The cache publishes a bare snapshot source. Components never receive it:
 * the slot `hooks` compartment binds it to a `useUsage` selector hook, and
 * the read callbacks below are the only way to ask for a read.
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import type { ProviderStatus, ProviderUsage, SubscriptionProvider } from './SubscriptionsSection.js'

/**
 * The framework's own snapshot-source and selector-hook seats, re-exported so
 * this package's client modules name the types the render machinery binds
 * (`ui-slots` derives its hooks compartment from exactly these).
 */
export type { ObservableSnapshot, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'

/** How strong a usage read is: a plain local snapshot, an if-needed refresh, or a forced one. */
export type UsageReadMode = 'local' | 'if-needed' | 'force'

/** Strength order used when a request folds into a read already running. */
const MODE_RANK: Readonly<Record<UsageReadMode, number>> = { local: 0, 'if-needed': 1, force: 2 }

/** The `status` endpoint's provider roster, keyed by provider. */
export type StatusRoster = Partial<Record<SubscriptionProvider, ProviderStatus>>

/** Outcome of one roster read; a failure carries the message its caller renders. */
export type StatusRead =
  | { readonly ok: true; readonly providers: StatusRoster }
  | { readonly ok: false; readonly message: string }

/** One account's cached usage, retained across a later failed read. */
export interface CachedUsage {
  /** Last usage payload the node half answered with. */
  usage?: ProviderUsage
  /** Last transport failure, cleared by the next successful read. */
  error?: string
}

/** The cache snapshot every reader selects from. */
export interface SubscriptionsCacheState {
  /** Last roster answer, or undefined before the first one. */
  status: StatusRoster | undefined
  /** Entries keyed `${provider}:${accountKey}`. */
  usage: Readonly<Record<string, CachedUsage>>
  /** Keys with a read in flight. */
  loading: Readonly<Record<string, boolean>>
}

/** The shared cache face: a bare source plus the read callbacks the inject face hands out. */
export interface SubscriptionsCache {
  /** Snapshot source bound to the components' `useUsage` hook. */
  readonly source: ObservableSnapshot<SubscriptionsCacheState>
  /**
   * Read the roster and publish it. Success seeds a local read for every
   * listed account that has no entry yet, so a first mount fills the cache
   * without asking the node half for a refresh.
   * @param options - `fresh` starts an independent read instead of folding into one already running.
   * @returns the roster, or the failure message.
   */
  readStatus(options?: { fresh?: boolean }): Promise<StatusRead>
  /**
   * Read one account's usage.
   * @param provider - the account's provider.
   * @param account - the account key.
   * @param mode - local snapshot (default), if-needed refresh, or forced refresh.
   * @returns nothing once the read (and any folded follow-up) has started.
   */
  readUsage(provider: SubscriptionProvider, account: string, mode?: UsageReadMode): Promise<void>
  /**
   * Read every listed account of one provider.
   * @param provider - the provider whose accounts are read.
   * @param mode - read strength.
   * @returns nothing once every read has started.
   */
  readProvider(provider: SubscriptionProvider, mode?: UsageReadMode): Promise<void>
  /**
   * Read every listed account of the current roster.
   * @param mode - read strength.
   * @returns nothing once every read has started.
   */
  readAll(mode?: UsageReadMode): Promise<void>
  /**
   * Account keys the current roster lists for one provider.
   * @param provider - the provider to list.
   * @returns the account keys, empty while the roster is unknown.
   */
  accountsOf(provider: SubscriptionProvider): readonly string[]
  /**
   * Forget everything and discard the results of reads still in flight: a new
   * connection generation's Host knows nothing this one answered.
   */
  reset(): void
  /** Owner teardown: later results are discarded and no listener survives. */
  dispose(): void
}

/** Rebuild one record with a key replaced, dropping the key when the value is undefined. */
function withEntry<T>(record: Readonly<Record<string, T>>, key: string, value: T | undefined): Record<string, T> {
  const next = { ...record }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}

/** Human text of a read failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The cache key of one account. */
function keyOf(provider: SubscriptionProvider, account: string): string {
  return `${provider}:${account}`
}

/**
 * Build the application-scoped cache.
 * @param rpc - Connection RPC caller reaching the `subscriptions-auth` endpoints.
 * @returns the shared cache face.
 */
export function createSubscriptionsCache(rpc: ConnectionHandle['rpc']): SubscriptionsCache {
  const empty = (): SubscriptionsCacheState => ({ status: undefined, usage: {}, loading: {} })
  let state: SubscriptionsCacheState = empty()
  /** Advanced by `reset` and `dispose`; a read publishes only in the epoch it started in. */
  let epoch = 0
  /** Roster read attempt; only the newest attempt may publish a roster. */
  let statusAttempt = 0
  let usageToken = 0
  let statusInflight: Promise<StatusRead> | undefined
  let disposed = false
  const listeners = new Set<() => void>()
  const usageInflight = new Map<string, Promise<void>>()
  /** Mode of the read a key is currently running. */
  const usageRunningMode = new Map<string, UsageReadMode>()
  /** Strongest mode requested while a key's read was running. */
  const usageQueued = new Map<string, UsageReadMode>()
  /** Token of the read a key is currently running, so a stale read cannot clean up a new one. */
  const usageTokens = new Map<string, number>()

  const publish = (next: SubscriptionsCacheState): void => {
    if (disposed) return
    state = next
    for (const listener of [...listeners]) listener()
  }

  const setLoading = (key: string, loading: boolean): void => {
    publish({ ...state, loading: withEntry(state.loading, key, loading ? true : undefined) })
  }

  /** Every account key the published roster lists; empty before the first roster answer. */
  const liveKeys = (): Set<string> => {
    const keys = new Set<string>()
    for (const provider of Object.keys(state.status ?? {}) as SubscriptionProvider[]) {
      for (const account of state.status?.[provider]?.accounts ?? []) keys.add(keyOf(provider, account.key))
    }
    return keys
  }

  /** Fold one answered payload into its entry, retaining last known windows over a failed revalidation. */
  const publishUsage = (key: string, usage: ProviderUsage | undefined, error: string | undefined): void => {
    // A read that outlives its account must not resurrect the row a logout removed.
    if (state.status !== undefined && !liveKeys().has(key)) return
    const previous = state.usage[key]
    let entry: CachedUsage
    if (usage === undefined) {
      // A transport failure is not a logout: keep the payload and record why it is not fresh.
      entry = { ...previous, ...error === undefined ? {} : { error } }
    } else {
      const stale = usage.cache?.state === 'error' || usage.cache?.state === 'stale'
      const last = previous?.usage
      const emptyWindows = usage.windows === undefined || usage.windows.length === 0
      const merged = stale && emptyWindows && last !== undefined
        ? { ...usage, supported: last.supported, ...last.windows === undefined ? {} : { windows: last.windows } }
        : usage
      entry = { usage: merged }
    }
    publish({ ...state, usage: withEntry(state.usage, key, entry) })
  }

  /**
   * Drop one key's read bookkeeping. The read keeps running to completion, but
   * it no longer owns the key: its answer cannot publish, and it cannot start a
   * follow-up. A re-login that reuses the same key therefore starts a fresh read
   * instead of joining the read the logout invalidated.
   */
  const forgetRead = (key: string): void => {
    usageTokens.delete(key)
    usageInflight.delete(key)
    usageRunningMode.delete(key)
    usageQueued.delete(key)
  }

  const readUsage = async (
    provider: SubscriptionProvider,
    account: string,
    mode: UsageReadMode = 'local',
  ): Promise<void> => {
    if (disposed) return
    const key = keyOf(provider, account)
    const running = usageInflight.get(key)
    if (running !== undefined) {
      // A duplicate event folds into the read already running and never starts a
      // second one. Only a request stronger than everything already scheduled for
      // this key is queued: a later weak request must not downgrade a queued
      // force, which would silently drop the refresh the user asked for.
      const highest = usageQueued.get(key) ?? usageRunningMode.get(key) ?? 'force'
      if (MODE_RANK[mode] > MODE_RANK[highest]) usageQueued.set(key, mode)
      return running
    }
    const readEpoch = epoch
    const token = ++usageToken
    setLoading(key, true)
    usageRunningMode.set(key, mode)
    usageTokens.set(key, token)
    const read = (async (): Promise<void> => {
      /** Whether this read still owns the key (a roster drop or reset may have taken it). */
      const owns = (): boolean => readEpoch === epoch && usageTokens.get(key) === token
      try {
        const usage = await callSubscriptionsAuth<ProviderUsage>(rpc, 'usage', {
          provider,
          account,
          ...mode === 'force' ? { force: true } : mode === 'if-needed' ? { refresh: true } : {},
        })
        if (owns()) publishUsage(key, usage, undefined)
      } catch (error) {
        if (owns()) publishUsage(key, undefined, messageOf(error))
      } finally {
        // A reset, a dispose, or a roster drop may already have replaced this key's read.
        if (owns()) {
          usageTokens.delete(key)
          usageInflight.delete(key)
          usageRunningMode.delete(key)
          setLoading(key, false)
          const queued = usageQueued.get(key)
          if (queued !== undefined) {
            usageQueued.delete(key)
            if (!disposed) void readUsage(provider, account, queued)
          }
        }
      }
    })()
    usageInflight.set(key, read)
    return read
  }

  const accountsOf = (provider: SubscriptionProvider): readonly string[] =>
    (state.status?.[provider]?.accounts ?? []).map(account => account.key)

  /** Drop every entry the roster no longer lists, then read the accounts it added. */
  const syncRoster = (status: StatusRoster): void => {
    const live = new Set<string>()
    const added: { provider: SubscriptionProvider; account: string }[] = []
    for (const provider of Object.keys(status) as SubscriptionProvider[]) {
      for (const account of status[provider]?.accounts ?? []) {
        const key = keyOf(provider, account.key)
        live.add(key)
        if (state.usage[key] === undefined) added.push({ provider, account: account.key })
      }
    }
    // A read for an account this roster no longer lists belongs to the previous
    // login: invalidate it before anything can join it again.
    for (const key of [...usageTokens.keys()]) if (!live.has(key)) forgetRead(key)
    const usage: Record<string, CachedUsage> = {}
    for (const [key, entry] of Object.entries(state.usage)) if (live.has(key)) usage[key] = entry
    const loading: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(state.loading)) if (live.has(key)) loading[key] = value
    publish({ ...state, status, usage, loading })
    for (const { provider, account } of added) void readUsage(provider, account, 'local')
  }

  const readStatus = (options?: { fresh?: boolean }): Promise<StatusRead> => {
    if (disposed) return Promise.resolve({ ok: false, message: 'the subscription cache was disposed' })
    const running = statusInflight
    if (running !== undefined && options?.fresh !== true) return running
    const attempt = ++statusAttempt
    const readEpoch = epoch
    const read = (async (): Promise<StatusRead> => {
      try {
        const response = await callSubscriptionsAuth<{ providers: StatusRoster }>(rpc, 'status', {})
        // An answer a newer attempt overtook must not publish a roster the Host replaced.
        if (readEpoch !== epoch) return { ok: true, providers: state.status ?? {} }
        if (attempt !== statusAttempt) return { ok: true, providers: state.status ?? response.providers }
        syncRoster(response.providers)
        return { ok: true, providers: response.providers }
      } catch (error) {
        return { ok: false, message: messageOf(error) }
      }
    })()
    statusInflight = read
    void read.then(() => { if (statusInflight === read) statusInflight = undefined })
    return read
  }

  const readProvider = async (provider: SubscriptionProvider, mode: UsageReadMode = 'local'): Promise<void> => {
    await Promise.all(accountsOf(provider).map(account => readUsage(provider, account, mode)))
  }

  const readAll = async (mode: UsageReadMode = 'local'): Promise<void> => {
    await Promise.all(
      (Object.keys(state.status ?? {}) as SubscriptionProvider[]).flatMap(provider =>
        accountsOf(provider).map(account => readUsage(provider, account, mode))),
    )
  }

  const forget = (): void => {
    epoch += 1
    statusAttempt += 1
    usageInflight.clear()
    usageRunningMode.clear()
    usageQueued.clear()
    usageTokens.clear()
    statusInflight = undefined
  }

  return {
    source: {
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    readStatus,
    readUsage,
    readProvider,
    readAll,
    accountsOf,
    reset: () => {
      forget()
      publish(empty())
    },
    dispose: () => {
      forget()
      disposed = true
      state = empty()
      listeners.clear()
    },
  }
}
