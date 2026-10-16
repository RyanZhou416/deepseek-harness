/**
 * Multi-account token plumbing: one {@link AccountTokenManager} per provider
 * owns a lazily-built {@link TokenManager} per account, so refresh coalescing
 * (`inflight`) and permanent-failure removal stay scoped to ONE account —
 * a revoked account deletes itself without touching its siblings.
 *
 * {@link AccountAwareAdapter} is the internal interface the pool uses to
 * stream through a specific account. A catalog model listed by several
 * accounts failovers; one listed by a single account is pinned to it.
 */

import { LlmAdapter, LlmError, errorChain } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { TokenManager, withTimeout } from './common.js'
import type { CatalogRefreshReport, RefreshOwnershipOutcome, TokenManagerOptions } from './common.js'
import {
  authFilePath,
  deleteAccountSession,
  getAccountCredential,
  getAccountSession,
  listAccounts,
  saveAccountSession,
  resolveAccountKey,
} from '../auth/store.js'
import type { AccountCredential, AccountEntry, ProviderId } from '../auth/store.js'
import { withStoreLockOwned } from '../auth/store-lock.js'

export { DISCOVERY_TIMEOUT_MS } from './common.js'

/** Minimal session shape the token managers need (mirrors common.ts). */
interface TimedSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

/** An adapter that can stream through a named account (the pool's seam). */
export interface AccountAwareAdapter extends LlmAdapter {
  /** Stream using the given account's credentials instead of the default. */
  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk>
  /**
   * The provider's own catalog: one account when `account` is set, otherwise
   * the union of every logged-in account (default first; later duplicates
   * dropped). The picker uses the union; pool assembly lists each account.
   * A read: it answers from the local cache or the built-in rows and never
   * starts a provider request. Use {@link refreshOwnCatalog} for that.
   */
  listOwnModels(provider: string, account?: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]>
  /**
   * The provider's own catalog for one account for an advisory read: the
   * last-known catalogue, or the built-in rows while nothing is known, without
   * ever starting a provider request, so `undefined` reports caller cancellation
   * alone — the caller sits that account out instead of starting a second
   * attempt. Absent on an adapter with no catalog of its own, where callers fall
   * back to {@link listOwnModels}, which stays the read for an explicit enumeration.
   */
  resolveOwnCatalog?(
    provider: string,
    account: string,
    signal?: AbortSignal,
  ): Promise<readonly LlmModelInfo[] | undefined>
  /**
   * The ONE path that asks the provider for a catalogue. Every catalogue-owning
   * adapter implements it; it is optional here only because an adapter without a
   * catalogue of its own has nothing to refresh.
   *
   * `account` names the account to refresh and defaults to the provider's default
   * account — never every peer. Without `force` it is an ensure: it requests the
   * catalogue only when the entry is missing, older than the route's configured
   * maximum age, and no failure cooldown is running; otherwise it reports the
   * account as skipped. `force` re-requests a fresh successful entry (an explicit
   * user refresh) and still honours a live failure cooldown, so a broken provider
   * is not re-queried on every click. `signal` detaches this caller alone; a
   * request other callers still await keeps running.
   * @param provider - the provider route whose catalogue is refreshed.
   * @param account - the account to refresh; the provider's default when omitted.
   * @param options - `force` for an explicit refresh, `signal` for caller cancellation.
   * @returns which account was requested, skipped, cancelled or failed.
   */
  refreshOwnCatalog?(
    provider: string,
    account?: string,
    options?: { force?: boolean; signal?: AbortSignal },
  ): Promise<CatalogRefreshReport>
  /**
   * Await every catalogue request this route still has in flight, without
   * starting new work, so disposal leaves no write behind. Never rejects.
   */
  drainOwnCatalogs?(): Promise<void>
  /**
   * Capability resolution of the provider's OWN models, bypassing the pool
   * delegation. The pool resolves its members through this — an account pool
   * reuses the catalog wire id (e.g. `gpt-5.4`), so resolveModel would
   * otherwise bounce straight back into the pool forever. The optional account
   * lets adapters with account-specific limits resolve that member conservatively.
   * A read: it answers from cache and never starts a provider request.
   */
  resolveOwnModel(provider: string, model: string, account?: string): Promise<LlmResolvedModelInfo>
  /**
   * Drop the cached catalogue of one account, or every account when omitted: the
   * stored entry goes too, and an in-flight request that loses the race cannot
   * write back. Login/logout, account removal, or a changed catalogue identity.
   */
  clearAccountCatalog(account?: string): void
  /**
   * Move one account's cached catalogue to the canonical key the store renamed
   * it to, keeping the snapshot, its freshness instant and its failure cooldown
   * under the new key. Called from the account manager's rename hook, which runs
   * inside the save that proved the rename: it must not wait on an in-flight
   * catalogue request.
   * @param from - the key the account's catalogue was stored under.
   * @param to - the canonical key the account now resolves to.
   */
  renameAccountCatalog?(from: string, to: string): Promise<void>
  /**
   * Whether this route's catalog advertises the model's fast tier; absent on
   * routes whose requests carry none. The account scopes which catalog entry
   * answers (Codex and Cursor discover per account); omitted asks the
   * default-first account that lists the model. A read: never starts a request.
   */
  supportsFastTier?(model: string, account?: string): boolean | Promise<boolean>
}

/** Options for {@link unionAccountCatalogs}. */
interface UnionAccountCatalogsOptions {
  /** Per-account bound; a hang sits that account out instead of blocking the picker. */
  timeoutMs?: number
  /** Caller cancellation; aborting drops the whole union. */
  signal?: AbortSignal
}

/** Catalog sort hint when the provider advertised one (Codex `priority`). */
function catalogPriority(model: LlmModelInfo): number {
  const ranked = model as LlmModelInfo & { priority?: number }
  return typeof ranked.priority === 'number' ? ranked.priority : Number.MAX_SAFE_INTEGER
}

/**
 * Merge per-account catalogs, keeping the first occurrence of each model id.
 * Rows that carry a numeric `priority` (Codex discovery) are then ordered by
 * it so a model only the second account lists — e.g. `gpt-5.6-sol` — still
 * sits with its generation instead of being appended after the default
 * account's older ids.
 */
export async function unionAccountCatalogs(
  accounts: readonly string[],
  listOne: (account: string, signal?: AbortSignal) => Promise<readonly LlmModelInfo[]>,
  options?: UnionAccountCatalogsOptions,
): Promise<LlmModelInfo[]> {
  const timeoutMs = options?.timeoutMs
  const caller = options?.signal
  const catalogs = await Promise.all(accounts.map(async account => {
    try {
      if (timeoutMs === undefined) return await listOne(account, caller)
      const models = await withTimeout(
        timeoutSignal => listOne(
          account,
          caller === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, caller]),
        ),
        timeoutMs,
      )
      return models ?? []
    } catch (error: unknown) {
      // One expired or failing account must not hide models the others list.
      if (caller?.aborted === true) throw error
      return []
    }
  }))
  const seen = new Set<string>()
  const models: LlmModelInfo[] = []
  for (const catalog of catalogs) {
    for (const model of catalog) {
      if (seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
  }
  models.sort((left, right) => catalogPriority(left) - catalogPriority(right))
  return models
}

/** Store I/O behind {@link AccountTokenManager} (injectable for tests). */
interface AccountStoreIo<S> {
  list(): Promise<AccountEntry<S>[]>
  get(account?: string): Promise<S | undefined>
  save(account: string, session: S, expectedPrior?: S, expectedRevision?: number): Promise<void>
  /**
   * Remove the account's stored session. With `expectedPrior`, the store
   * removes it only while it is still that session, and with `expectedRevision` only while
   * the stored revision is still the one the caller read, so a removal cannot delete a
   * login that landed after the caller read the account.
   * @returns true when the session was removed, false when the store refused it.
   *   An implementation may return nothing, which reads as removed.
   */
  remove(account: string, expectedPrior?: S, expectedRevision?: number): Promise<void | boolean>
  /** Resolve a legacy alias to the canonical account key. */
  resolve?(account: string): Promise<string>
  /**
   * Read one account's credential with the revision it is stored under, without
   * refreshing. Absent on an implementation whose backend keeps no revision, where
   * {@link AccountTokenManager.snapshot} reports revision 0.
   * @param account - the canonical account key.
   * @returns the snapshot, or `undefined` when nothing is stored.
   */
  credential?(account: string): Promise<AccountCredential<S> | undefined>
}

/**
 * Cross-process ownership over one account's whole refresh cycle.
 *
 * A hook is obtained per account so an implementation may scope ownership per account or
 * per shared credential store, and every refresh the manager runs goes through it.
 * @typeParam T - the value the owned cycle produces.
 */
export type RefreshOwnershipHook = <T>(cycle: () => Promise<T>) => Promise<RefreshOwnershipOutcome<T>>

/** Constructor dependencies for {@link AccountTokenManager}. */
export interface AccountTokenManagerOptions<S extends TimedSession> {
  provider: ProviderId
  /** Human-readable provider name for error messages. */
  displayName: string
  /** Provider hooks shared by every account (load/save/remove are bound per account). */
  makeOptions: (account: string) => Omit<TokenManagerOptions<S>, 'load' | 'save' | 'remove' | 'onRemoved' | 'displayName'>
  /**
   * Cross-process refresh ownership for one account, when its credential store is shared
   * with cooperating plugin processes. Absent keeps the in-process single-flight and the
   * store's conditional write as the whole guarantee.
   * @param account - the canonical account key.
   * @returns the hook every refresh cycle for that account runs under.
   */
  refreshOwnership?: (account: string) => RefreshOwnershipHook
  /**
   * Preparation for one credential USE, when a route's credential must be resolved from
   * somewhere the manager's own load-and-refresh path cannot see.
   *
   * Called by {@link AccountTokenManager.session} alone — the path a request, a forced refresh
   * after a 401, a usage read, a catalogue read or a maintenance read goes through — and never
   * by {@link AccountTokenManager.list}, {@link AccountTokenManager.peek},
   * {@link AccountTokenManager.snapshot} or {@link AccountTokenManager.hasSession}, so a status
   * or account-list read stays a pure local read. An implementation that answers a session
   * takes over the whole use: the manager neither loads the stored credential nor refreshes it,
   * which is how a credential this plugin does not own is served without ever spending its
   * grant.
   * @param account - the canonical account key being used.
   * @param forceRefresh - the caller's forced-refresh request, for a route that can honour it.
   * @returns the session to serve, or `undefined` to continue with the manager's own path.
   */
  prepareSession?: (account: string, forceRefresh: boolean) => Promise<S | undefined>
  /** Called after a permanent refresh failure deleted one account's session. */
  onAccountRemoved?: (account: string) => void
  /**
   * Gates one account's credential removal behind the provider's own identity change, when it owns
   * durable identity state.
   *
   * `deleteCredential` performs the store removal and answers whether the record was really removed
   * (`false` when its compare-and-set refused, in which case the account is not reported as
   * removed). This callback must resolve as soon as that deletion has settled: the identity change
   * it starts can await cleanup that is waiting on the very stack that asked for the removal — a
   * permanent refresh failure removes the account from inside its own credential cycle — so
   * awaiting the change here would deadlock. The change itself is owned by whoever supplied this
   * callback, which tracks and reports its settlement, and the account stays closed to requests
   * until that settlement rather than being treated as ready when the deletion returns.
   */
  removalGate?: (account: string, deleteCredential: () => Promise<boolean>) => Promise<boolean>
  /**
   * Called when a successful save proves the store renamed one account's
   * canonical key — a Codex identity that gained its stable user id, for
   * instance. Awaited before the manager re-binds, so an owner of
   * account-keyed state can move that account's own metadata to the new key
   * before anything reads it.
   *
   * A rejection is contained by the caller: the renamed session is already
   * stored and the store still resolves the old key through the alias it
   * recorded, so a move that could not complete must not surface as a refresh
   * failure for a usable account. The failure is reported through {@link onWarn}.
   * @param from - the key the account was stored under until this save.
   * @param to - the canonical key the store now resolves that account to.
   */
  onAccountRenamed?: (from: string, to: string) => Promise<void>
  /** Warning sink for a rename move that could not complete; absent stays quiet. */
  onWarn?: (message: string) => void
  /** Store backend; defaults to the durable auth store. */
  io?: AccountStoreIo<S>
}

export class AccountTokenManager<S extends TimedSession> {
  private readonly managers = new Map<string, TokenManager<S>>()
  private readonly io: AccountStoreIo<S>

  constructor(private readonly options: AccountTokenManagerOptions<S>) {
    const provider = options.provider
    this.io = options.io ?? {
      list: () => listAccounts(provider) as Promise<AccountEntry<S>[]>,
      get: account => getAccountSession(provider, account) as Promise<S | undefined>,
      save: async (account, session, expectedPrior, expectedRevision) => {
        // The refusal is internal: a caller that named its prior only needs the write
        // to have been considered, and the store stays the authority either way.
        await saveAccountSession(provider, account, session as never, undefined, {
          ...expectedPrior === undefined ? {} : { expectedPrior: expectedPrior as never },
          ...expectedRevision === undefined ? {} : { expectedRevision },
        })
      },
      remove: (account, expectedPrior, expectedRevision) => deleteAccountSession(provider, account, undefined, {
        ...expectedPrior === undefined ? {} : { expectedPrior: expectedPrior as never },
        ...expectedRevision === undefined ? {} : { expectedRevision },
      }),
      resolve: account => resolveAccountKey(provider, account),
      credential: account => getAccountCredential(provider, account) as Promise<AccountCredential<S> | undefined>,
    }
  }

  /** The provider's accounts, default first (straight from the store). */
  list(): Promise<AccountEntry<S>[]> {
    return this.io.list()
  }

  /** The default account's key, or undefined when logged out. */
  async defaultAccount(): Promise<string | undefined> {
    return (await this.list())[0]?.key
  }

  /**
   * Resolve a usable session for one account (default when omitted),
   * refreshing proactively or on demand.
   *
   * This is the one use path: a route with a `prepareSession` hook resolves the credential it
   * actually serves there, and a hook that answers skips the manager's own load and refresh
   * entirely. Every read-only entry point — a request, a forced refresh after a 401, usage,
   * catalogue discovery, maintenance — arrives here, so none of them can reach a refresh the
   * hook's owner does not permit.
   * @param account - the account key; the default account when undefined.
   * @param forceRefresh - refresh regardless of expiry (used after a 401).
   * @returns the persisted session to send.
   * @throws LlmError MISSING_CREDENTIAL when the account is not logged in, and whatever the
   *   hook throws when it refuses this use.
   */
  async session(account?: string, forceRefresh = false): Promise<S> {
    const requested = account ?? await this.defaultAccount()
    if (requested === undefined) throw this.missingCredential()
    const key = await this.resolveAccount(requested)
    if (this.options.prepareSession !== undefined) {
      const prepared = await this.options.prepareSession(key, forceRefresh)
      if (prepared !== undefined) return prepared
    }
    return this.tokensFor(key).session(forceRefresh)
  }

  /** Resolve a legacy alias before it reaches any per-account manager or cache. */
  resolveAccount(account: string): Promise<string> {
    return this.io.resolve?.(account) ?? Promise.resolve(account)
  }

  /** Read an account's stored session without any refresh side effect. */
  async peek(account?: string): Promise<S | undefined> {
    return this.io.get(account === undefined ? undefined : await this.resolveAccount(account))
  }

  /**
   * Read one account's stored credential with the revision it is stored under, without
   * refreshing. A maintenance scheduler records the revision and re-reads before acting, so
   * a credential that changed underneath it is never written over.
   * @param account - the account key; the default account when undefined.
   * @returns the snapshot, or `undefined` when the account is not logged in.
   */
  async snapshot(account?: string): Promise<AccountCredential<S> | undefined> {
    const requested = account ?? await this.defaultAccount()
    if (requested === undefined) return undefined
    const key = await this.resolveAccount(requested)
    return this.io.credential?.(key)
  }

  /**
   * The revision of one account's stored credential.
   * @param account - the account key.
   * @returns the stored revision, or 0 when nothing is stored or the backend keeps none.
   */
  async revisionOf(account: string): Promise<number> {
    return (await this.snapshot(account))?.revision ?? 0
  }

  /**
   * Persist a caller-updated session for one account (default when omitted).
   * Identity backfill uses this; the next {@link session} read returns the
   * updated copy.
   * @param account - the account key; the default account when undefined.
   * @param session - the updated session to store.
   * @param expectedPrior - the stored session this update was derived from. The
   *   store refuses the write once another writer has replaced it, so an update
   *   derived from a credential the account no longer holds cannot land.
   * @param expectedRevision - the revision that stored session was read under,
   *   when the caller read both together. The store refuses the write once the
   *   record has moved on, which is what keeps a backfill from rolling back a
   *   write that left the credential fields identical — an ownership-mode
   *   change, a logout or a same-token re-login. Absent keeps the session
   *   comparison as the whole guard.
   */
  async persist(
    account: string | undefined,
    session: S,
    expectedPrior?: S,
    expectedRevision?: number,
  ): Promise<void> {
    const requested = account ?? await this.defaultAccount()
    if (requested === undefined) return
    const key = await this.resolveAccount(requested)
    await this.tokensFor(key).replace(session, expectedPrior, expectedRevision)
  }

  /** Whether a session is stored for the account (cheap; never refreshes). */
  async hasSession(account?: string): Promise<boolean> {
    return (await this.peek(account)) !== undefined
  }

  /** The TokenManager bound to one account (created lazily, then cached). */
  tokensFor(account: string): TokenManager<S> {
    let manager = this.managers.get(account)
    if (manager === undefined) {
      const io = this.io
      let boundAccount = account
      manager = new TokenManager<S>({
        displayName: this.options.displayName,
        ...this.options.makeOptions(account),
        ...this.options.refreshOwnership === undefined
          ? {}
          : { withRefreshOwnership: cycle => this.options.refreshOwnership!(boundAccount)(cycle) },
        load: () => io.get(boundAccount),
        // One store read for the credential a refresh spends and the revision it is stored
        // under, so no writer can land between them and pair a stale session with a newer
        // revision. The two cases stay apart: a backend WITHOUT the combined read falls back
        // to one `get` carrying no revision, while a combined read that reports nothing means
        // the account is logged out — it is never re-read through `get`, which could
        // resurrect a login that landed in between and bypass the revision check.
        ...io.credential === undefined
          ? { loadCredential: async () => ({ session: await io.get(boundAccount), revision: undefined }) }
          : {
            loadCredential: async () => {
              const credential = await io.credential!(boundAccount)
              return credential === undefined
                ? { session: undefined, revision: undefined }
                : { session: credential.session, revision: credential.revision }
            },
          },
        save: async (session, expectedPrior, expectedRevision) => {
          await io.save(boundAccount, session, expectedPrior, expectedRevision)
          const canonical = await this.resolveAccount(boundAccount)
          if (canonical !== boundAccount) {
            const renamedFrom = boundAccount
            try {
              await this.options.onAccountRenamed?.(renamedFrom, canonical)
            } catch (renameFailure: unknown) {
              // The renamed session is stored and the store's alias still
              // resolves the old key, so the account keeps serving; a move that
              // failed here must not be reported as a refresh failure. The old
              // key's state stays where it is, which is the degraded outcome the
              // warning names.
              this.options.onWarn?.(
                `dsh-plugin-subscriptions: account state did not follow the renamed key `
                + `"${renamedFrom}" -> "${canonical}" (${errorChain(renameFailure)})`,
              )
            }
            // Move the binding as well as the cache entry: logout can delete
            // aliases, so callbacks must not keep relying on the old key.
            // Retain the manager itself to preserve its in-flight refresh.
            this.managers.set(canonical, manager!)
            if (this.managers.get(renamedFrom) === manager) this.managers.delete(renamedFrom)
            boundAccount = canonical
          }
        },
        remove: async (expectedPrior, expectedRevision) => {
          // The store's own removal answers nothing when it deleted the record, so the absence of a
          // refusal is the removal: the gate's boolean is that same fact, never a `void` read as one.
          const deleteCredential = async (): Promise<boolean> =>
            (await io.remove(boundAccount, expectedPrior, expectedRevision)) !== false
          const gate = this.options.removalGate
          // Without a gate the removal is the store's own compare-and-set, exactly as before.
          return gate === undefined ? await deleteCredential() : await gate(boundAccount, deleteCredential)
        },
        onRemoved: () => { this.options.onAccountRemoved?.(boundAccount) },
      })
      this.managers.set(account, manager)
    }
    return manager
  }

  /** The logged-out error, mirroring TokenManager's own message. */
  private missingCredential(): LlmError {
    return new LlmError(
      `dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; `
      + 'log in via Settings → Subscriptions in the dsh web app',
      'MISSING_CREDENTIAL',
    )
  }
}

/**
 * Cross-process refresh ownership over the plugin's own credential store.
 *
 * Two cooperating plugin processes that share one store would otherwise both spend the same
 * refresh grant before either conditional write lands, invalidating whichever rotation
 * lost. The lock is taken on a resource beside the store file — never on the store file
 * itself, whose writes take their own lock — and a holder that cannot be waited out stops
 * the cycle instead of rotating unowned. Ownership covers the whole read-refresh-save
 * sequence, because a lock released before the save would let the next process re-read the
 * credential this one already spent.
 *
 * The lock is process-local coordination only. It neither constrains nor claims anything
 * about Claude Code, Desktop or any other holder of the same account.
 * @param resourcePath - the credential store both processes write; defaults to the plugin's own store file.
 * @returns the per-account ownership supplier to pass as `refreshOwnership`.
 */
export function durableStoreRefreshOwnership(
  resourcePath: string = authFilePath(),
): (account: string) => RefreshOwnershipHook {
  const ownershipPath = `${resourcePath}.refresh`
  return () => cycle => withStoreLockOwned(ownershipPath, cycle)
}
