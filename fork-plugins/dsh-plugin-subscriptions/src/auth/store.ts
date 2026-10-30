/**
 * On-disk OAuth session store at `~/.dsh/plugins/subscriptions/auth.json`.
 *
 * The file is a JSON object keyed by provider id, each entry holding that
 * provider's ACCOUNTS: a map of account key → session plus the default
 * account's key. Writes are atomic (tmp file + rename) with mode 0600
 * because they carry bearer tokens. Mode 0600 is the owner-only guarantee on
 * POSIX platforms only: Windows ignores it, so there the file keeps the ACL of
 * the directory holding it, and every principal that ACL admits can read the
 * tokens. Session shapes live here (not in the provider modules) because this
 * file owns the durable format.
 *
 * Backward compatibility: entries written by single-account versions hold
 * the session fields directly (no `accounts` wrapper); reads migrate them
 * in memory, and the next write persists the new shape — existing logins
 * survive the upgrade untouched.
 *
 * A Claude entry may state its credential ownership mode. An absent field reads as the mode its
 * own facts imply; a value this build does not implement fails the whole read rather than being
 * inferred from or dropped, because it decides who may spend a shared refresh grant.
 */

import { createHash, randomBytes } from 'node:crypto'
import { decodeJwtPayload } from './jwt.js'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { withStoreLockOwned } from './store-lock.js'
import { CLAUDE_CREDENTIAL_MODES, isClaudeCredentialMode } from './claude-credential-ownership.js'
import type { ClaudeCredentialMode } from './claude-credential-ownership.js'

/** Provider routes this plugin can serve. */
export type ProviderId = 'codex' | 'claude' | 'grok' | 'copilot' | 'antigravity' | 'cursor'

/** Every provider route, in display order. */
export const PROVIDER_IDS: readonly ProviderId[] = ['codex', 'claude', 'grok', 'copilot', 'antigravity', 'cursor']

/**
 * A session whose provider can report no display identity. Such a session carries the
 * random id it is keyed by, so the account key served to the browser derives from no
 * credential.
 */
interface AccountKeyedSession {
  /** Random per-login account id, written with the session; absent until one is assigned. */
  accountKeyId?: string
}

/** Stored ChatGPT/Codex subscription session. */
export interface CodexSession {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number
  /** `chatgpt_account_id` claim from the id token; sent as the `chatgpt-account-id` header. */
  accountId: string
  idToken?: string
  /** User email from the id token, when the token carried it. */
  emailAddress?: string
  /** `chatgpt_plan_type` claim from the id token (e.g. `plus`, `pro`), when present. */
  planType?: string
}

/** Stored Claude Pro/Max subscription session. */
export interface ClaudeSession extends AccountKeyedSession {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number
  /** Scope string the tokens were issued with; echoed on refresh. */
  scopes: string
  emailAddress?: string
  subscriptionType?: string
  /**
   * Account UUID from the OAuth profile; fills the `metadata.user_id`
   * correlation triple the Claude Code wire contract requires. Sessions
   * stored before the wire upgrade lack it and are backfilled on first use.
   */
  accountUuid?: string
  /**
   * Deterministic account-and-local-OS device id used in the correlation triple.
   * The Claude adapter rechecks it before Messages and conditionally replaces
   * legacy account-only ids or values copied from another OS installation.
   */
  deviceId?: string
  /**
   * True when this account was imported from Claude Code's own credential
   * store (Keychain/file): only bound accounts sync refreshes back to it.
   */
  keychainBound?: boolean
  /**
   * How this account's credential is owned, and therefore who may rotate it.
   * Absent on records written before the field existed, where the mode is
   * inferred from {@link keychainBound}; a stated value outranks that inference
   * and survives a restart. See `claude-credential-ownership.ts` for the modes
   * and the conversions allowed between them.
   */
  credentialOwnershipMode?: ClaudeCredentialMode
}

/** Stored Grok (X Premium / xAI) subscription session. */
export interface GrokSession extends AccountKeyedSession {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number
  /** Token endpoint from OIDC discovery; retained for refreshes. */
  tokenEndpoint: string
  scopes?: string
  /** Display account: email, username, or subject claim from the id token. */
  account?: string
}

/**
 * Stored GitHub Copilot subscription session. Two token generations are at
 * play: the long-lived GitHub OAuth token from the device flow is kept in
 * `refreshToken`, and `accessToken` carries the short-lived (~30 minutes)
 * Copilot API token exchanged from it. A "refresh" is therefore a fresh
 * exchange against `copilot_internal/v2/token`, not an OAuth grant.
 */
export interface CopilotSession extends AccountKeyedSession {
  /** Copilot API token; sent as the bearer on api.githubcopilot.com. */
  accessToken: string
  /** Long-lived GitHub OAuth token from the device flow. */
  refreshToken: string
  /** Epoch milliseconds at which the Copilot API token expires. */
  expiresAt: number
  /** GitHub login name, for the status display. */
  account?: string
}

/**
 * Stored Cursor account. `accessToken` is the user API key used for chat.
 * `refreshToken` repeats that key so the shared session shape stays valid.
 * Dashboard usage uses the separate session tokens captured at login; accounts
 * stored before that capture have neither and must log in again.
 */
export interface CursorSession extends AccountKeyedSession {
  /** User API key for agent requests. */
  accessToken: string
  /** Copy of the API key. Cursor chat has no refresh grant. */
  refreshToken: string
  /** Epoch milliseconds at which the user API key expires. */
  expiresAt: number
  /** Account email, when login reported one. */
  email?: string
  /** Short-lived dashboard access token for usage queries. */
  dashboardAccessToken?: string
  /** Dashboard refresh token. Renewed only when a usage query needs it. */
  dashboardRefreshToken?: string
}

/** Stored Google OAuth session for the Antigravity v1internal API. */
export interface AntigravitySession extends AccountKeyedSession {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds at which the Google access token expires. */
  expiresAt: number
  /** Cloud AI Companion project required by Antigravity request envelopes. */
  projectId: string
  /** Google account email, for the status display. */
  account?: string
  /** Subscription tier observed during project discovery. */
  plan?: string
  /** Granted Google OAuth scopes, when the token endpoint returned them. */
  scopes?: string
}

/** One provider's accounts: account key → session, plus the default account. */
interface ProviderAccounts<S> {
  /** Key of the account direct (non-pool) routes serve; the first login wins. */
  default?: string
  accounts: Record<string, S>
  /** Old keys remain bound to their migrated account, never a workspace sibling. */
  aliases?: Record<string, string>
  /**
   * Per-account credential revision, bumped by every accepted write of that account
   * (save, removal) and never decremented. A reader that decided on a revision can
   * therefore tell whether the credential it reasoned about is still the current one.
   * Absent on stores written before revisions existed, which read as revision 0.
   */
  revisions?: Record<string, number>
}

/** The durable store shape: per provider, its accounts. */
interface SessionMap {
  codex?: ProviderAccounts<CodexSession>
  claude?: ProviderAccounts<ClaudeSession>
  grok?: ProviderAccounts<GrokSession>
  copilot?: ProviderAccounts<CopilotSession>
  antigravity?: ProviderAccounts<AntigravitySession>
  cursor?: ProviderAccounts<CursorSession>
  /**
   * Per-provider, per-account revision high-water marks. They outlive the account they
   * name: removing the last account of a provider takes the account map away, and this
   * map is what keeps the next login of that account on a higher revision than the
   * credential the removal retired — in this process and in every other one.
   */
  revisions?: Record<string, Record<string, number>>
}

/**
 * One provider entry this build cannot fully represent, kept so a write can put it back.
 *
 * Parsing drops an entry from the in-memory store when it cannot be used (a provider value that
 * is not an object, a single-account record without usable tokens, a missing accounts map, a
 * non-string default, or an account without tokens). Dropping it from the FILE would destroy a
 * credential this build merely failed to read, so the raw value is retained for write-back.
 */
interface PreservedProvider {
  /** The provider's raw value, exactly as parsed. */
  raw: unknown
  /** The raw value when it is a JSON object; absent for a scalar or an array. */
  rawObject?: Record<string, unknown>
  /** Whether `rawObject.accounts` is a JSON object whose entries can be merged by key. */
  accountsMap: boolean
  /** Whether `raw` is the pre-multi-account shape (session fields at the provider level). */
  legacy: boolean
  /** Every raw account entry in file order; empty when {@link accountsMap} is false. */
  rawAccounts: Record<string, unknown>
  /** Raw account entries this build cannot use, and therefore keeps out of the typed store. */
  preservedAccounts: Map<string, unknown>
}

/** What one parse kept outside the typed store, so a write can restore it. */
interface StorePreservation {
  /** The whole parsed file, for unknown keys, unknown providers and account order. */
  root: Record<string, unknown>
  /** Provider entries, or account entries inside them, the typed store does not represent. */
  providers: Map<string, PreservedProvider>
  /** Providers the parse turned into a typed entry; a later absence is an explicit removal. */
  represented: Set<string>
  /** Accounts an explicit `deleteAccountSession` removed. The only ones a write may omit. */
  removedAccounts: Set<string>
  /** Raw account keys a rekey retired; the same session now lives under the alias target. */
  supersededAccounts: Set<string>
}

/**
 * Preservation for every store object this module parsed, keyed by that object.
 *
 * A store constructed elsewhere has no raw file to preserve and writes as it is. A store read
 * from disk carries every entry the typed view could not represent, so no read-modify-write can
 * silently drop one.
 */
const preservedStores = new WeakMap<SessionMap, StorePreservation>()

/** One account addressed exactly, as a set key. */
function accountSlot(provider: string, account: string): string {
  return `${provider}\u0000${account}`
}

/**
 * Record that one account is being retired by an explicit logout, so a later write may omit it.
 * @param store - the store the removal is applied to.
 * @param provider - the provider route.
 * @param account - the canonical account key.
 */
function markAccountRemoved(store: SessionMap, provider: ProviderId, account: string): void {
  preservedStores.get(store)?.removedAccounts.add(accountSlot(provider, account))
}

/**
 * Record that a rekey retired one raw account key. The session still exists under the alias
 * target the typed store holds, so a write must not treat the raw key's absence as a loss.
 * @param store - the store the rekey is applied to.
 * @param provider - the provider route.
 * @param account - the raw account key the rekey retired.
 */
function markAccountSuperseded(store: SessionMap, provider: ProviderId, account: string): void {
  preservedStores.get(store)?.supersededAccounts.add(accountSlot(provider, account))
}

/** Whether a value is a JSON object (not null, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Any stored session, for provider-agnostic plumbing. */
export type StoredSession = CodexSession | ClaudeSession | GrokSession | CopilotSession | AntigravitySession | CursorSession

/** The session type one provider stores. */
type SessionOf<K extends ProviderId> = NonNullable<SessionMap[K]>['accounts'][string]

/** One account entry as returned by {@link listAccounts} (default first). */
export interface AccountEntry<S> {
  key: string
  session: S
}

/**
 * The stable identity of one session's account: Codex keys on workspace AND
 * user (email fallback, workspace-only for unidentified legacy sessions),
 * the others on their display identity, and on the random id carried by a
 * session that has none. Logging the same account in again lands on the same
 * key, so a re-login updates in place instead of duplicating. (An identity-less
 * account re-logged in mints a new id, which reads as a second account on the
 * Settings page; the earlier entry can simply be logged out.)
 *
 * A session without a display identity is assigned its id here, and the caller
 * that stores the session persists that id with it.
 * @param provider - the provider route.
 * @param session - the session to key.
 * @returns the account map key.
 */
export function accountKeyOf(provider: ProviderId, session: StoredSession): string {
  return accountIdentityOf(provider, session) ?? identitylessKey(session as AccountKeyedSession)
}

/** The display identity a provider reports for a session, when it reports one. */
function accountIdentityOf(provider: ProviderId, session: StoredSession): string | undefined {
  switch (provider) {
    case 'codex': {
      const codex = session as CodexSession
      const payload = typeof codex.idToken === 'string' ? decodeJwtPayload(codex.idToken) : undefined
      const auth = claimObject(payload?.['https://api.openai.com/auth'])
      const user = nonEmpty(auth?.chatgpt_user_id) ?? nonEmpty(auth?.user_id)
      const profile = claimObject(payload?.['https://api.openai.com/profile'])
      const email = nonEmpty(codex.emailAddress) ?? nonEmpty(payload?.email) ?? nonEmpty(profile?.email)
      if (user === undefined && email === undefined) return codex.accountId
      // JSON tuple encoding avoids separator collisions and distinguishes IDs from emails.
      return JSON.stringify([codex.accountId, user === undefined ? 'email' : 'user', user ?? email!.toLowerCase()])
    }
    case 'claude':
      return nonEmpty((session as ClaudeSession).emailAddress)
    case 'grok':
      return nonEmpty((session as GrokSession).account)
    case 'antigravity':
      return nonEmpty((session as AntigravitySession).account)
    case 'copilot':
      return nonEmpty((session as CopilotSession).account)
    case 'cursor':
      return nonEmpty((session as CursorSession).email)
  }
}

/** Prefix of every account key this store mints for an identity-less session. */
const MINTED_ACCOUNT_KEY_PREFIX = 'account-'

/**
 * Prefix of a stored key that names nothing but the session's refresh token. Reading the
 * store replaces such a key, because the account key reaches the browser.
 */
const TOKEN_DERIVED_KEY_PREFIX = 'token-'

/** A random account key: the only key an identity-less session may be served under. */
function mintedAccountKey(): string {
  return `${MINTED_ACCOUNT_KEY_PREFIX}${randomBytes(8).toString('hex')}`
}

/** The id a session without a display identity is keyed by, minted into it when absent. */
function identitylessKey(session: AccountKeyedSession): string {
  session.accountKeyId ??= mintedAccountKey()
  return session.accountKeyId
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function claimObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** Resolve only recorded aliases, not an ambiguous workspace-wide match. */
function resolveAccount(entry: ProviderAccounts<StoredSession>, key: string): string {
  const seen = new Set<string>()
  while (!Object.hasOwn(entry.accounts, key)
    && entry.aliases !== undefined
    && Object.hasOwn(entry.aliases, key)
    && !seen.has(key)) {
    seen.add(key)
    key = entry.aliases[key]
  }
  return key
}

/**
 * Resolve a Codex reference that is neither a stored key nor a recorded alias:
 * a config `account` may name the login email (as the other providers' keys
 * do) or the bare workspace ID that keys stored before per-user keys. Only an
 * unambiguous match resolves; two users sharing the workspace stay apart, and
 * the reference is returned unchanged so the caller reports it as missing.
 */
function resolveCodexReference(entry: ProviderAccounts<CodexSession>, reference: string): string {
  const wanted = reference.trim().toLowerCase()
  if (wanted.length === 0) return reference
  const matches = Object.entries(entry.accounts).filter(([, session]) =>
    session.accountId === reference.trim() || codexEmail(session) === wanted)
  return matches.length === 1 ? matches[0][0] : reference
}

/**
 * Resolve a persisted legacy account key to its canonical account identity.
 * For Codex, a reference that matches no key or alias also resolves through
 * a unique login email or workspace ID (see {@link resolveCodexReference}).
 */
export async function resolveAccountKey(
  provider: ProviderId,
  account: string,
  path = authFilePath(),
): Promise<string> {
  const entry = (await loadStore(path))[provider]
  if (entry === undefined) return account
  const key = resolveAccount(entry, account)
  if (provider === 'codex' && !Object.hasOwn(entry.accounts, key)) {
    return resolveCodexReference(entry as ProviderAccounts<CodexSession>, key)
  }
  return key
}

/** Migrate workspace-only keys once; retain collisions rather than discard credentials. */
function codexEmail(session: CodexSession): string | undefined {
  const payload = typeof session.idToken === 'string' ? decodeJwtPayload(session.idToken) : undefined
  const profile = claimObject(payload?.['https://api.openai.com/profile'])
  return (nonEmpty(session.emailAddress) ?? nonEmpty(payload?.email) ?? nonEmpty(profile?.email))?.toLowerCase()
}

function codexUserKey(session: CodexSession): string | undefined {
  const key = accountKeyOf('codex', session)
  try {
    const tuple = JSON.parse(key) as unknown
    return Array.isArray(tuple) && tuple[1] === 'user' ? key : undefined
  } catch {
    return undefined
  }
}

/**
 * Upgrade one unambiguous email fallback to the stable user key, or leave the record where it is
 * when the stable key already holds another session.
 * @param entry - the provider's stored accounts.
 * @param session - the session about to be stored.
 * @returns the account key the session must be written under, or undefined when the record needs
 *   no move.
 */
function reconcileCodexIdentity(entry: ProviderAccounts<CodexSession>, session: CodexSession): string | undefined {
  const userKey = codexUserKey(session)
  const email = codexEmail(session)
  if (userKey === undefined || email === undefined) return undefined
  const emailKey = JSON.stringify([session.accountId, 'email', email])
  const previous = entry.accounts[emailKey]
  if (previous === undefined || codexEmail(previous) !== email) return undefined
  // Never merge workspace-wide: the exact normalized workspace/email pair must match.
  if (Object.hasOwn(entry.accounts, userKey)) {
    // The canonical key already holds a session. Moving this one onto it would overwrite that
    // credential and moving it aside would delete this one, so the account keeps its stored key
    // and both records survive. The caller writes the new session to `emailKey`, and its own
    // compare-and-set still refuses a write derived from a credential another writer replaced.
    return emailKey
  }
  entry.accounts[userKey] = previous
  delete entry.accounts[emailKey]
  entry.aliases = { ...entry.aliases, [emailKey]: userKey }
  for (const [alias, target] of Object.entries(entry.aliases)) {
    if (target === emailKey) entry.aliases[alias] = userKey
  }
  if (entry.default === emailKey) entry.default = userKey
  return userKey
}

function migrateCodex(store: SessionMap, preservation: StorePreservation): void {
  const entry = store.codex
  if (entry === undefined) return
  for (const [oldKey, session] of Object.entries(entry.accounts)) {
    if (oldKey !== session.accountId) continue
    const key = accountKeyOf('codex', session)
    if (key === oldKey || Object.hasOwn(entry.accounts, key)) continue
    entry.accounts[key] = session
    delete entry.accounts[oldKey]
    entry.aliases = { ...entry.aliases, [oldKey]: key }
    if (entry.default === oldKey) entry.default = key
    // The raw file still names the retired key; its session is written under the alias target.
    preservation.supersededAccounts.add(accountSlot('codex', oldKey))
  }
}

/**
 * Absolute path of the auth store file.
 * @returns `dshHomePath('plugins', 'subscriptions', 'auth.json')`.
 */
export function authFilePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'auth.json')
}

/** Store location used before the plugin was renamed; migrated on first read. */
function legacyAuthFilePath(): string {
  return dshHomePath('plugins', 'router', 'auth.json')
}

/**
 * Refuse an unrecognized ownership mode where a Claude record crosses the durable boundary.
 *
 * The mode decides who may spend a shared refresh grant and write it back, so a value this
 * build does not implement is neither inferred from nor silently dropped: inferring would pick
 * an owner by accident, and dropping the record would strand the account's tokens on the next
 * write. The whole read fails instead, naming the account and the field.
 *
 * The write path calls this too, through {@link writeStore}, so an unusable value is refused
 * before the file is replaced rather than surfacing as a broken store on the next read.
 * @param provider - the provider route the record belongs to.
 * @param account - the account key, named in the failure.
 * @param value - the record, from a parsed file or from a caller about to be stored.
 * @throws Error when the record states a mode this build does not implement.
 */
function assertClaudeCredentialOwnershipMode(provider: ProviderId, account: string, value: unknown): void {
  if (provider !== 'claude') return
  if (typeof value !== 'object' || value === null) return
  const mode = (value as Record<string, unknown>)['credentialOwnershipMode']
  if (mode === undefined || isClaudeCredentialMode(mode)) return
  throw new Error(
    `subscriptions auth store: entry "${provider}/${account}" states credentialOwnershipMode `
    + `"${typeof mode === 'string' ? mode : String(mode)}", which is not one of `
    + `${CLAUDE_CREDENTIAL_MODES.join(', ')}; fix or delete the store file`,
  )
}

/**
 * Refuse the whole write when any Claude record in it states an unusable ownership mode.
 *
 * Every write of this file goes through {@link writeStore}, so validating here covers the save,
 * removal and default-account paths alike: a caller can never replace a good store with one
 * that the next read would reject. Nothing is written when this throws.
 * @param store - the store about to be persisted.
 * @throws Error when a stored Claude record states a mode this build does not implement.
 */
function assertStoredClaudeOwnershipModes(store: SessionMap): void {
  for (const [account, session] of Object.entries(store.claude?.accounts ?? {})) {
    assertClaudeCredentialOwnershipMode('claude', account, session)
  }
}

/** Check that one durable session carries the fields every session needs. */
function assertSessionShape(provider: ProviderId, account: string, value: unknown): asserts value is StoredSession {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`subscriptions auth store: entry "${provider}/${account}" is not an object; fix or delete the store file`)
  }
  const entry = value as Record<string, unknown>
  if (typeof entry.accessToken !== 'string' || entry.accessToken.length === 0
    || typeof entry.refreshToken !== 'string' || entry.refreshToken.length === 0
    || typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt)) {
    throw new Error(
      `subscriptions auth store: entry "${provider}/${account}" is missing accessToken/refreshToken/expiresAt; fix or delete the store file`,
    )
  }
  if (provider === 'antigravity'
    && (typeof entry.projectId !== 'string' || entry.projectId.length === 0)) {
    throw new Error(
      'subscriptions auth store: entry "antigravity" is missing projectId; log out and complete Antigravity login again',
    )
  }
  assertClaudeCredentialOwnershipMode(provider, account, entry)
}

/** One read of a store file, together with the write-back that read requires. */
interface StoreRead {
  /** The parsed session map. */
  store: SessionMap
  /** The read replaced a token-derived key, or migrated the pre-rename file. */
  mustPersist: boolean
  /** Pre-rename file whose contents were migrated; removed once they are persisted. */
  legacyPath?: string
}

/**
 * Read one store path without writing. A missing file is an empty store; malformed JSON or a
 * malformed entry throws, because silently discarding tokens would strand the user without a
 * diagnosis. The pre-rename file is read when the new path does not exist.
 * @param path - store file path.
 * @returns the parsed session map and the write-back the read requires.
 */
async function readStore(path: string): Promise<StoreRead> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Migrate the pre-rename store once, preserving existing logins.
    if (path !== authFilePath()) return { store: {}, mustPersist: false }
    try {
      text = await readFile(legacyAuthFilePath(), 'utf8')
    } catch (legacyError) {
      if ((legacyError as NodeJS.ErrnoException).code === 'ENOENT') return { store: {}, mustPersist: false }
      throw legacyError
    }
    const migrated = parseStore(text, legacyAuthFilePath())
    return { store: migrated.store, mustPersist: true, legacyPath: legacyAuthFilePath() }
  }
  const parsed = parseStore(text, path)
  return { store: parsed.store, mustPersist: parsed.rekeyed }
}

/**
 * Persist what {@link readStore} found, then retire the pre-rename file it read.
 *
 * The pre-rename file is removed only after the file just written has been read back and
 * confirmed to still hold every entry it had. A migration that lost one — from a bug here or a
 * concurrent writer — leaves the original in place instead of deleting the only copy.
 * @param read - the read whose write-back is persisted.
 * @param path - store file path.
 */
async function persistStoreRead(read: StoreRead, path: string): Promise<void> {
  await writeStore(read.store, path)
  if (read.legacyPath === undefined) return
  const preservation = preservedStores.get(read.store)
  if (preservation !== undefined) {
    const migrated: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isPlainObject(migrated)) {
      throw preservationFailure('the migrated store did not read back as a JSON object')
    }
    assertStoreEntriesRetained(preservation.root, migrated)
  }
  await rm(read.legacyPath, { force: true })
}

/**
 * Read the whole store. A missing file is an empty store; malformed JSON or a
 * malformed entry throws, because silently discarding tokens would strand the
 * user without a diagnosis. Single-account entries are migrated in memory;
 * the next write persists the new shape. An account key that names the session's
 * refresh token is replaced here and written back immediately, so the account
 * keeps one key across restarts.
 *
 * A read that rewrites the file is a read-modify-write like any other. It runs after the writes
 * already queued for this path and under the store lock, and it re-reads inside that critical
 * section rather than overwriting a key another reader minted while it waited. Without that
 * serialization two concurrent reads each mint a key for the same token-derived account, the
 * last write wins, and the account's key changes on the next mount — the status endpoint reads
 * every provider at once, so one status call races with itself.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the parsed session map.
 */
export async function loadStore(path = authFilePath()): Promise<SessionMap> {
  return loadStoreFrom(path, false)
}

/**
 * Read a store while already holding this path's serialization, so a required write-back runs
 * in place instead of waiting on the chain that is already running it.
 * @param path - store file path.
 * @returns the parsed session map.
 */
async function loadStoreUnderLock(path: string): Promise<SessionMap> {
  return loadStoreFrom(path, true)
}

/**
 * Read one store path, serializing any write-back the read requires.
 * @param path - store file path.
 * @param underLock - the caller already holds this path's serialization and the store lock for
 *   the whole call, so a write-back can run directly.
 * @returns the parsed session map, or the one the serialized re-read found.
 */
async function loadStoreFrom(path: string, underLock: boolean): Promise<SessionMap> {
  const read = await readStore(path)
  if (!read.mustPersist) return read.store
  if (underLock) {
    await persistStoreRead(read, path)
    return read.store
  }
  return serialize(path, async () => {
    // Another reader may have persisted its key while this one waited; the file is the authority.
    const current = await readStore(path)
    if (current.mustPersist) await persistStoreRead(current, path)
    return current.store
  })
}

/**
 * Parse and migrate store JSON read from `path`. An ACCOUNT entry whose shape
 * is invalid (empty or missing tokens — corruption seen in the wild from a
 * broken keychain import) is left OUT of the typed store instead of rejecting
 * the read: one bad entry must not blind every provider's status read, and a
 * session without tokens is unusable by definition. The raw entry is retained
 * in {@link StorePreserved} form, so the next write puts it back verbatim; a
 * credential this build cannot read is never a credential it may delete.
 * Structural failures (invalid JSON, a non-object file) still throw — those say
 * the file itself is broken, and a write is refused rather than replacing it.
 *
 * A Claude entry stating an ownership mode this build does not implement is a structural
 * failure too: inferring an owner from it would decide who spends a shared refresh grant by
 * accident, and skipping it would strand the account's tokens on the next write.
 *
 * @param text - the file's contents.
 * @param path - the file the text came from, named in structural errors.
 * @returns the session map and whether a token-derived account key was replaced.
 */
function parseStore(text: string, path: string): { store: SessionMap; rekeyed: boolean } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`subscriptions auth store at ${path} is not valid JSON; fix or delete the file`)
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`subscriptions auth store at ${path} must be a JSON object keyed by provider; fix or delete the file`)
  }
  const raw = parsed
  const store: SessionMap = {}
  const preservation: StorePreservation = {
    root: raw,
    providers: new Map(),
    represented: new Set(),
    removedAccounts: new Set(),
    supersededAccounts: new Set(),
  }
  /** Keep one provider entry the typed store cannot represent, exactly as written. */
  const preserve = (provider: ProviderId, value: PreservedProvider): void => {
    preservation.providers.set(provider, value)
  }
  const tombstones = readRevisionTombstones(raw.revisions)
  if (Object.keys(tombstones).length > 0) store.revisions = tombstones
  let rekeyed = false
  for (const provider of PROVIDER_IDS) {
    const entry = raw[provider]
    if (entry === undefined) continue
    if (!isPlainObject(entry)) {
      console.warn(`subscriptions auth store: entry "${provider}" is not an object; kept as written`)
      preserve(provider, {
        raw: entry, accountsMap: false, legacy: false, rawAccounts: {}, preservedAccounts: new Map(),
      })
      continue
    }
    const record = entry
    if (typeof record.accessToken === 'string') {
      if (record.accounts !== undefined) {
        // Both the single-account session and an accounts map are present. Choosing one would
        // drop the other, so the whole value is kept until the file is fixed.
        console.warn(
          `subscriptions auth store: entry "${provider}" carries both a bare session and an accounts map; kept as written`,
        )
        preserve(provider, {
          raw: entry,
          rawObject: record,
          accountsMap: false,
          legacy: true,
          rawAccounts: {},
          preservedAccounts: new Map(),
        })
        continue
      }
      // Single-account format: wrap the bare session, preserving every field.
      if (!isValidSessionShape(record)) {
        console.warn(`subscriptions auth store: legacy entry "${provider}" has no usable tokens; kept as written`)
        preserve(provider, {
          raw: entry,
          rawObject: record,
          accountsMap: false,
          legacy: true,
          rawAccounts: {},
          preservedAccounts: new Map(),
        })
        continue
      }
      const session = record as unknown as StoredSession
      const key = provider === 'codex' ? (session as CodexSession).accountId : accountKeyOf(provider, session)
      assertClaudeCredentialOwnershipMode(provider, key, record)
      // An identity-less session was just keyed by a minted id; write it so the account
      // keeps that key rather than taking a new one on the next read.
      if (accountIdentityOf(provider, session) === undefined) rekeyed = true
      ;(store as Record<string, unknown>)[provider] = { default: key, accounts: { [key]: session } }
      preservation.represented.add(provider)
      continue
    }
    const accounts = record.accounts
    if (!isPlainObject(accounts)) {
      console.warn(`subscriptions auth store: entry "${provider}" has no accounts map; kept as written`)
      preserve(provider, {
        raw: entry,
        rawObject: record,
        accountsMap: false,
        legacy: false,
        rawAccounts: {},
        preservedAccounts: new Map(),
      })
      continue
    }
    if (record.default !== undefined && typeof record.default !== 'string') {
      console.warn(`subscriptions auth store: entry "${provider}" default is not a string; kept as written`)
      preserve(provider, {
        raw: entry,
        rawObject: record,
        accountsMap: true,
        legacy: false,
        rawAccounts: accounts,
        preservedAccounts: new Map(Object.entries(accounts)),
      })
      continue
    }
    const kept: Record<string, StoredSession> = {}
    const unusable = new Map<string, unknown>()
    for (const [account, session] of Object.entries(accounts)) {
      if (isValidSessionShape(session)) {
        assertClaudeCredentialOwnershipMode(provider, account, session as Record<string, unknown>)
        kept[account] = session as StoredSession
      } else {
        console.warn(
          `subscriptions auth store: entry "${provider}/${account}" has no usable accessToken/refreshToken/expiresAt; kept as written`,
        )
        unusable.set(account, session)
      }
    }
    if (Object.keys(kept).length === 0) {
      // Nothing usable to serve, but every entry is still the user's credential: keep the whole
      // provider value, including the raw default pointer, for the next write.
      preserve(provider, {
        raw: entry,
        rawObject: record,
        accountsMap: true,
        legacy: false,
        rawAccounts: accounts,
        preservedAccounts: new Map(Object.entries(accounts)),
      })
      continue
    }
    let validDefault = record.default === undefined || record.default in kept
      ? record.default as string | undefined
      : Object.keys(kept)[0]
    let aliases = record.aliases as Record<string, string> | undefined
    const keyed: Record<string, StoredSession> = {}
    for (const [account, session] of Object.entries(kept)) {
      if (accountIdentityOf(provider, session) !== undefined || !account.startsWith(TOKEN_DERIVED_KEY_PREFIX)) {
        keyed[account] = session
        continue
      }
      // The stored key names the refresh token, and this key is served to the browser.
      const carried = (session as AccountKeyedSession).accountKeyId
      const minted = carried !== undefined && !carried.startsWith(TOKEN_DERIVED_KEY_PREFIX)
        ? carried
        : mintedAccountKey()
      ;(session as AccountKeyedSession).accountKeyId = minted
      aliases = { ...aliases, [account]: minted }
      if (validDefault === account) validDefault = minted
      keyed[minted] = session
      preservation.supersededAccounts.add(accountSlot(provider, account))
      rekeyed = true
    }
    const revisions = readRevisionMap(record.revisions)
    ;(store as Record<string, unknown>)[provider] = {
      ...record,
      ...aliases === undefined ? {} : { aliases },
      default: validDefault,
      accounts: keyed,
      ...Object.keys(revisions).length === 0 ? {} : { revisions },
    }
    preservation.represented.add(provider)
    if (unusable.size > 0) {
      preserve(provider, {
        raw: entry,
        rawObject: record,
        accountsMap: true,
        legacy: false,
        rawAccounts: accounts,
        preservedAccounts: unusable,
      })
    }
  }
  if (store.codex !== undefined) migrateCodex(store, preservation)
  preservedStores.set(store, preservation)
  return { store, rekeyed }
}

/** Whether a value carries the fields every stored session needs (non-empty tokens). */
function isValidSessionShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.accessToken === 'string' && entry.accessToken.length > 0
    && typeof entry.refreshToken === 'string' && entry.refreshToken.length > 0
    && typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt)
}

/** How many times to retry a Windows replace before giving the write up. */
const STORE_REPLACE_ATTEMPTS = 8

/** Windows denies rename-over when a reader still has the destination open. */
function isRetryableReplaceError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

/**
 * Swap a finished temp file onto `path`. POSIX rename replaces an existing file atomically.
 *
 * Windows often returns EPERM for that replace while Defender, the indexer, or a reader holds
 * the destination. It is retried, and then the write fails: copying over the live store instead
 * would be a non-atomic replacement, and an interrupted copy would corrupt every credential the
 * file holds. A failed write leaves the old file whole.
 */
async function replaceStoreFile(tmp: string, path: string): Promise<void> {
  let last: unknown
  for (let attempt = 0; attempt < STORE_REPLACE_ATTEMPTS; attempt++) {
    try {
      await rename(tmp, path)
      return
    } catch (error) {
      last = error
      if (!isRetryableReplaceError(error) || attempt === STORE_REPLACE_ATTEMPTS - 1) break
      await delay(50 * (attempt + 1))
    }
  }
  throw last
}

/** Write a temp file and flush it to the device, so a crash cannot expose a torn store. */
async function writeDurably(path: string, text: string): Promise<void> {
  const handle = await open(path, 'w', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Error for a write whose existing bytes would be lost. */
function preservationFailure(detail: string): Error {
  return new Error(
    `subscriptions auth store: refusing to write because ${detail}; nothing was written — `
    + 'fix or delete the store file',
  )
}

/** Whether every raw value in `expected` still appears in `actual` (objects may gain keys). */
function rawContained(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((value, index) => rawContained(actual[index], value))
  }
  if (isPlainObject(expected)) {
    return isPlainObject(actual)
      && Object.entries(expected).every(([key, value]) => rawContained(actual[key], value))
  }
  return actual === expected
}

/** Throw unless every raw value in `expected` still appears in `actual`. */
function assertRawContained(actual: unknown, expected: unknown, label: string): void {
  if (!rawContained(actual, expected)) throw preservationFailure(`a value in ${label} would be lost`)
}

/**
 * Whether the provider's recorded aliases map `account` to an account the typed store holds.
 * Used for a raw account key a rekey retired without an explicit removal.
 */
function aliasedAccount(
  typed: ProviderAccounts<StoredSession>,
  account: string,
): string | undefined {
  const target = typed.aliases?.[account]
  return target !== undefined && Object.hasOwn(typed.accounts, target) ? target : undefined
}

/**
 * Rebuild the provider's accounts map for one write.
 * @param provider - the provider route.
 * @param typed - the typed entry, when the store holds one.
 * @param preserved - the raw entries the typed store cannot represent.
 * @param preservation - the store's preserved raw document.
 * @returns the merged accounts map, or undefined when the typed store holds no accounts.
 */
function mergedAccountsFor(
  provider: ProviderId,
  typed: ProviderAccounts<StoredSession>,
  preserved: PreservedProvider | undefined,
  preservation: StorePreservation,
): Record<string, unknown> {
  const accounts: Record<string, unknown> = {}
  const rawAccounts = preserved?.accountsMap === true ? preserved.rawAccounts : typed.accounts
  for (const [account, rawValue] of Object.entries(rawAccounts)) {
    if (Object.hasOwn(typed.accounts, account)) {
      accounts[account] = typed.accounts[account]
      continue
    }
    if (preserved?.preservedAccounts.has(account) === true) {
      accounts[account] = preserved.preservedAccounts.get(account)
      continue
    }
    if (preservation.removedAccounts.has(accountSlot(provider, account))) continue
    if (preservation.supersededAccounts.has(accountSlot(provider, account))) continue
    if (aliasedAccount(typed, account) !== undefined) continue
    throw preservationFailure(
      `account "${provider}/${account}" has no typed value, no preserved raw value and no explicit removal`,
    )
  }
  for (const [account, session] of Object.entries(typed.accounts)) {
    if (!Object.hasOwn(accounts, account)) accounts[account] = session
  }
  return accounts
}

/**
 * The parsed store's own entries as a JSON object.
 * @param store - the store to enumerate.
 * @returns a document holding exactly the store entries this build read.
 */
function storeEntries(store: SessionMap): Record<string, unknown> {
  const entries: [string, unknown][] = Object.entries(store)
  return Object.fromEntries(entries)
}

/**
 * The document a write must persist for one parsed store.
 *
 * Unknown top-level entries are copied through, providers the typed store does not represent are
 * kept whole, and preserved account entries are put back where they were. Only a typed account
 * that an explicit removal retired — or a key a rekey superseded — is omitted.
 * @param store - the store to serialize.
 * @returns the JSON document for the file.
 * @throws Error when a raw entry and a typed entry cannot both be written.
 */
function materializeStore(store: SessionMap): Record<string, unknown> {
  const preservation = preservedStores.get(store)
  if (preservation === undefined) return storeEntries(store)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(preservation.root)) {
    if (key === 'revisions') continue
    if (!(PROVIDER_IDS as readonly string[]).includes(key)) {
      out[key] = value
      continue
    }
    const provider = key as ProviderId
    const typed = store[provider] as ProviderAccounts<StoredSession> | undefined
    const preserved = preservation.providers.get(provider)
    if (typed === undefined) {
      if (preserved === undefined) continue
      if (!preservation.represented.has(provider)) {
        // The provider was never represented; keep exactly what was written.
        out[provider] = preserved.accountsMap
          ? { ...preserved.rawObject, accounts: Object.fromEntries(preserved.preservedAccounts) }
          : preserved.raw
        continue
      }
      // A represented provider whose last usable account was explicitly removed: keep the
      // entries this build could not read, and drop the provider only when there are none.
      if (preserved.preservedAccounts.size === 0) continue
      out[provider] = { ...preserved.rawObject, accounts: Object.fromEntries(preserved.preservedAccounts) }
      continue
    }
    if (preserved !== undefined && !preserved.accountsMap) {
      throw preservationFailure(
        `provider "${provider}" holds a value this build cannot read (${preserved.legacy
          ? 'a single-account record without usable tokens or with an accounts map'
          : 'a value that is not an account map'}) and a new value cannot be written beside it`,
      )
    }
    const base = preserved?.rawObject === undefined ? { ...typed } : { ...preserved.rawObject, ...typed }
    out[provider] = { ...base, accounts: mergedAccountsFor(provider, typed, preserved, preservation) }
  }
  // A provider stored for the first time has no raw entry to preserve.
  for (const provider of PROVIDER_IDS) {
    if (Object.hasOwn(out, provider)) continue
    if (Object.hasOwn(preservation.root, provider)) continue
    const value = store[provider]
    if (value !== undefined) out[provider] = value
  }
  const revisions = materializeRevisions(preservation.root.revisions, store.revisions)
  if (revisions !== undefined) out.revisions = revisions
  return out
}

/**
 * Merge the raw revision map with the typed one. Typed high-water marks win per account; raw
 * entries this build did not validate (an unknown provider, a malformed value) are kept.
 * @param rawRevisions - the parsed root `revisions` value, when the file had one.
 * @param typedRevisions - the store's own revision map.
 * @returns the merged map, or undefined when neither side has one.
 */
function materializeRevisions(
  rawRevisions: unknown,
  typedRevisions: SessionMap['revisions'],
): unknown {
  if (!isPlainObject(rawRevisions)) return typedRevisions ?? rawRevisions
  const out: Record<string, unknown> = {}
  for (const [provider, accounts] of Object.entries(rawRevisions)) {
    const typed = typedRevisions?.[provider]
    out[provider] = isPlainObject(accounts) ? { ...accounts, ...typed } : typed ?? accounts
  }
  for (const [provider, accounts] of Object.entries(typedRevisions ?? {})) {
    if (!Object.hasOwn(out, provider)) out[provider] = accounts
  }
  return out
}

/**
 * Verify that a materialized document still carries every entry the parse preserved.
 *
 * The writer already refuses a merge it cannot represent; this second check catches a mistake
 * in the merge itself before the file is replaced.
 * @param preservation - what the parse kept outside the typed store.
 * @param output - the document about to be written.
 * @throws Error when any preserved entry would be lost.
 */
function assertStorePreserved(preservation: StorePreservation, output: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(preservation.root)) {
    if (key === 'revisions' || (PROVIDER_IDS as readonly string[]).includes(key)) continue
    assertRawContained(output[key], value, `entry "${key}"`)
  }
  for (const provider of PROVIDER_IDS) {
    const rawEntry = preservation.root[provider]
    if (rawEntry === undefined) continue
    const outEntry = output[provider]
    if (!isPlainObject(rawEntry)) {
      assertRawContained(outEntry, rawEntry, `entry "${provider}"`)
      continue
    }
    const preserved = preservation.providers.get(provider)
    if (typeof rawEntry.accessToken === 'string') {
      // The single-account shape either stayed verbatim or was converted to one account entry.
      if (preserved?.legacy === true) {
        assertRawContained(outEntry, rawEntry, `entry "${provider}"`)
        continue
      }
      const converted = isPlainObject(outEntry) && isPlainObject(outEntry.accounts)
        ? outEntry.accounts : undefined
      if (converted === undefined || Object.keys(converted).length === 0) {
        throw preservationFailure(`the single-account record for "${provider}" would be lost`)
      }
      continue
    }
    if (outEntry === undefined) {
      // A provider may disappear only when an explicit logout removed its every account and
      // nothing inside it was preserved.
      const rawAccounts = isPlainObject(rawEntry.accounts) ? rawEntry.accounts : undefined
      const allRemoved = preserved === undefined
        && rawAccounts !== undefined
        && Object.keys(rawAccounts).every(account =>
          preservation.removedAccounts.has(accountSlot(provider, account))
          || preservation.supersededAccounts.has(accountSlot(provider, account)))
      if (!allRemoved) throw preservationFailure(`provider "${provider}" would disappear`)
      continue
    }
    for (const [field, value] of Object.entries(rawEntry)) {
      if (field === 'default' || field === 'accounts' || field === 'aliases' || field === 'revisions') continue
      assertRawContained((outEntry as Record<string, unknown>)[field], value, `entry "${provider}" field "${field}"`)
    }
    if (!isPlainObject(rawEntry.accounts)) continue
    const outAccounts = isPlainObject(outEntry) && isPlainObject(outEntry.accounts)
      ? outEntry.accounts : undefined
    if (outAccounts === undefined) throw preservationFailure(`provider "${provider}" lost its accounts map`)
    for (const [account, rawValue] of Object.entries(rawEntry.accounts)) {
      if (preserved?.preservedAccounts.has(account) === true) {
        assertRawContained(outAccounts[account], rawValue, `entry "${provider}/${account}"`)
        continue
      }
      if (Object.hasOwn(outAccounts, account)) continue
      if (preservation.removedAccounts.has(accountSlot(provider, account))) continue
      if (preservation.supersededAccounts.has(accountSlot(provider, account))) continue
      if (isPlainObject(outEntry) && isPlainObject(outEntry.aliases)) {
        const target = outEntry.aliases[account]
        if (typeof target === 'string' && Object.hasOwn(outAccounts, target)) continue
      }
      throw preservationFailure(`account "${provider}/${account}" would be lost`)
    }
  }
}

/**
 * Throw when `next` would omit an entry `previous` holds, unless an explicit removal names it.
 *
 * This compares a document against a store file: for the write path, the file currently on disk
 * against the document about to be written; for the pre-rename migration, the legacy file
 * against the file just written. A rekey is accepted through the alias the store records.
 * @param previous - the source document.
 * @param next - the document that must retain its entries.
 * @param allowAccountRemoval - whether this exact provider/account was explicitly logged out.
 */
function assertStoreEntriesRetained(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  allowAccountRemoval: (provider: string, account: string) => boolean = () => false,
): void {
  for (const [key, previousValue] of Object.entries(previous)) {
    if (key === 'revisions') continue
    if (!Object.hasOwn(next, key)) {
      // An explicit removal may take a provider entry away with its last account; nothing else
      // may disappear.
      const removedProvider = (PROVIDER_IDS as readonly string[]).includes(key)
        && isPlainObject(previousValue)
        && typeof previousValue.accessToken !== 'string'
        && isPlainObject(previousValue.accounts)
        && Object.keys(previousValue.accounts).length > 0
        && Object.keys(previousValue.accounts).every(account => allowAccountRemoval(key, account))
      if (!removedProvider) {
        throw preservationFailure(`entry "${key}" from the current file would disappear`)
      }
      continue
    }
    if (!(PROVIDER_IDS as readonly string[]).includes(key)) {
      assertRawContained(next[key], previousValue, `entry "${key}"`)
      continue
    }
    if (!isPlainObject(previousValue)) continue
    const previousAccounts = isPlainObject(previousValue.accounts) && typeof previousValue.accessToken !== 'string'
      ? previousValue.accounts : undefined
    if (previousAccounts === undefined) continue
    const nextEntry = next[key]
    if (!isPlainObject(nextEntry)) continue
    const nextAccounts = isPlainObject(nextEntry.accounts) ? nextEntry.accounts : undefined
    for (const account of Object.keys(previousAccounts)) {
      if (nextAccounts !== undefined && Object.hasOwn(nextAccounts, account)) continue
      if (allowAccountRemoval(key, account)) continue
      if (isPlainObject(nextEntry.aliases)) {
        const target = nextEntry.aliases[account]
        if (typeof target === 'string' && nextAccounts !== undefined && Object.hasOwn(nextAccounts, target)) continue
      }
      throw preservationFailure(
        `account "${key}/${account}" would be dropped without an explicit logout`,
      )
    }
  }
}

/**
 * Keep one generation of the store beside it, so a bad write can be recovered by hand.
 *
 * The copy is written and flushed before the live file is replaced; a failure to write it fails
 * the whole write instead of replacing the only copy. It carries bearer tokens, so it keeps
 * mode 0600, and this module never reads it back.
 * @param path - the store file the backup belongs to.
 * @param bytes - the bytes to keep.
 */
async function writeBackup(path: string, bytes: Buffer): Promise<void> {
  const backup = `${path}.bak`
  const tmp = `${backup}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    const handle = await open(tmp, 'w', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await chmod(tmp, 0o600)
    await replaceStoreFile(tmp, backup)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * Keep the previous generation of the store beside it.
 * @param path - the store file about to be replaced.
 */
async function backupStoreFile(path: string): Promise<void> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await writeBackup(path, bytes)
}

/**
 * Persist the whole store atomically with owner-only permissions.
 *
 * The write is refused before anything is touched when a preserved entry cannot be carried, and
 * again when the new document would drop an account the current file holds without an explicit
 * removal. The previous generation is copied to `<path>.bak` first, the new bytes are flushed,
 * and only then does the atomic rename replace the live file.
 * @param store - the store to persist.
 * @param path - the store file.
 * @param options - `prune` marks an explicit account removal as the reason an entry may vanish.
 * @throws Error when the write would lose data, or when the lock or the filesystem refuses it.
 */
async function writeStore(
  store: SessionMap,
  path: string,
  options: { prune?: boolean } = {},
): Promise<void> {
  // Before anything is written: one unusable mode would make every later read of this file
  // throw, so the store that is about to replace it is refused instead.
  assertStoredClaudeOwnershipModes(store)
  const document = materializeStore(store)
  const preservation = preservedStores.get(store)
  if (preservation !== undefined) assertStorePreserved(preservation, document)
  let previous: Record<string, unknown> | undefined
  try {
    const text = await readFile(path, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw preservationFailure('the file on disk is not valid JSON and cannot be compared before a rewrite')
    }
    if (!isPlainObject(parsed)) {
      throw preservationFailure('the file on disk is not a JSON object and cannot be compared before a rewrite')
    }
    previous = parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (previous !== undefined) {
    // Only the account this logout named may vanish; a sibling dropped by any other path is
    // refused here even though the write declares itself a prune.
    const removed = options.prune === true && preservation !== undefined
      ? (provider: string, account: string): boolean =>
        preservation.removedAccounts.has(accountSlot(provider, account))
      : undefined
    assertStoreEntriesRetained(previous, document, removed)
  }
  await mkdir(dirname(path), { recursive: true })
  await backupStoreFile(path)
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    await writeDurably(tmp, JSON.stringify(document, null, 2))
    // An existing destination keeps its old mode through rename on some filesystems; enforce
    // 0600 on the source before the swap.
    await chmod(tmp, 0o600)
    await replaceStoreFile(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * Layout version written by the pending-refresh journal.
 *
 * The journal is a sibling document of `auth.json`, so a refresh that has already spent the
 * grant survives a crash between the token response and the store write.
 */
const REFRESH_JOURNAL_VERSION = 1

/** Suffix of the pending-refresh journal beside the store file. */
const REFRESH_JOURNAL_SUFFIX = '.pending-refresh.json'

/**
 * Absolute path of the durable pending-refresh journal beside a store file.
 * @param storePath - store file path; defaults to {@link authFilePath}.
 * @returns `${storePath}.pending-refresh.json`, for example
 *   `$DSH_HOME/plugins/subscriptions/auth.json.pending-refresh.json`.
 */
export function pendingRefreshJournalPath(storePath = authFilePath()): string {
  return `${storePath}${REFRESH_JOURNAL_SUFFIX}`
}

/**
 * A session's stable, non-reversible identity: a digest of both tokens.
 *
 * The journal stores this instead of either token, so a marker cannot be replayed as a
 * credential. It answers "is the stored session still the one this rotation started from".
 * @param session - the session to fingerprint.
 * @returns `sha256:<hex>` over the access and refresh tokens.
 */
function credentialFingerprint(session: { accessToken: string; refreshToken: string }): string {
  return `sha256:${createHash('sha256')
    .update(session.accessToken)
    .update('\u0000')
    .update(session.refreshToken)
    .digest('hex')}`
}

/** A fresh journal document. */
function emptyRefreshJournal(): Record<string, unknown> {
  return { version: REFRESH_JOURNAL_VERSION, rotations: {} }
}

/**
 * Read the journal, keeping its unknown keys and providers exactly as written.
 *
 * An unreadable document is an error, never an empty journal: replacing it would drop a
 * rotation that may be the only copy of a newly minted credential.
 * @param path - the journal file.
 * @returns the parsed document, or a fresh one when the file does not exist.
 * @throws Error when the file exists but is not this build's journal.
 */
async function readRefreshJournal(path: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRefreshJournal()
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`subscriptions refresh journal at ${path} is not valid JSON; refusing to replace it`)
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`subscriptions refresh journal at ${path} is not a JSON object; refusing to replace it`)
  }
  if (parsed.version !== REFRESH_JOURNAL_VERSION) {
    throw new Error(
      `subscriptions refresh journal at ${path} states version ${String(parsed.version)}, `
      + `this build writes ${REFRESH_JOURNAL_VERSION}; refusing to replace it`,
    )
  }
  if (parsed.rotations !== undefined && !isPlainObject(parsed.rotations)) {
    throw new Error(`subscriptions refresh journal at ${path} has no readable rotations map; refusing to replace it`)
  }
  return parsed
}

/**
 * Atomically replace the journal with owner-only permissions.
 * @param path - the journal file.
 * @param root - the document to write.
 */
async function writeRefreshJournalFile(path: string, root: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    await writeDurably(tmp, JSON.stringify(root, null, 2))
    await chmod(tmp, 0o600)
    await replaceStoreFile(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** The journal's rotations map, without dropping an unknown or malformed value. */
function journalRotations(root: Record<string, unknown>): Record<string, unknown> {
  return isPlainObject(root.rotations) ? root.rotations : {}
}

/** One provider's rotation map. */
function journalProviderMap(root: Record<string, unknown>, provider: string): Record<string, unknown> {
  const map = journalRotations(root)[provider]
  return isPlainObject(map) ? map : {}
}

/** One account's marker, when it is a JSON object. */
function journalEntry(
  root: Record<string, unknown>,
  provider: string,
  account: string,
): Record<string, unknown> | undefined {
  const entry = journalProviderMap(root, provider)[account]
  return isPlainObject(entry) ? entry : undefined
}

/** Store one account's marker, preserving every other entry and unknown field. */
function setJournalEntry(
  root: Record<string, unknown>,
  provider: string,
  account: string,
  entry: Record<string, unknown>,
): void {
  const rotations = journalRotations(root)
  const map = isPlainObject(rotations[provider]) ? rotations[provider] : {}
  rotations[provider] = { ...map, [account]: entry }
  root.rotations = rotations
}

/** Remove one account's marker; returns whether one was there. */
function deleteJournalEntry(root: Record<string, unknown>, provider: string, account: string): boolean {
  const rotations = journalRotations(root)
  const map = rotations[provider]
  if (!isPlainObject(map) || !Object.hasOwn(map, account)) return false
  const next = { ...map }
  delete next[account]
  if (Object.keys(next).length === 0) delete rotations[provider]
  else rotations[provider] = next
  root.rotations = rotations
  return true
}

/**
 * Record the intent to spend one account's refresh grant, before the request is sent.
 *
 * The marker holds the provider/account, the credential revision and a fingerprint of the
 * tokens the grant will spend — never the tokens themselves. It is written atomically with
 * mode 0600; a write that fails leaves no marker, and the caller must not send the request.
 * @param provider - the provider route.
 * @param account - the canonical account key.
 * @param session - the session whose refresh token is about to be spent.
 * @param revision - the credential revision that session was read under, when known.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @throws Error when a completed rotation is already waiting for recovery, or the write fails.
 */
export async function beginPendingRefreshRotation(
  provider: ProviderId,
  account: string,
  session: StoredSession,
  revision: CredentialRevision | undefined,
  path = authFilePath(),
): Promise<void> {
  const journalPath = pendingRefreshJournalPath(path)
  await serialize(journalPath, async () => {
    const root = await readRefreshJournal(journalPath)
    const existing = journalEntry(root, provider, account)
    if (existing?.phase === 'completed') {
      throw new Error(
        `subscriptions refresh journal: a completed rotation for "${provider}/${account}" is `
        + 'waiting for recovery; refusing to spend another grant',
      )
    }
    const now = Date.now()
    setJournalEntry(root, provider, account, {
      ...existing,
      phase: 'pending',
      provider,
      account,
      startedAt: now,
      updatedAt: now,
      ...revision === undefined ? {} : { priorRevision: revision },
      priorFingerprint: credentialFingerprint(session),
    })
    await writeRefreshJournalFile(journalPath, root)
  })
}

/**
 * Record the credential a spent grant produced, before the store is asked to persist it.
 *
 * A marker can only be completed by the attempt that wrote the pending phase for the same
 * prior tokens; anything else is refused rather than overwritten.
 * @param provider - the provider route.
 * @param account - the canonical account key.
 * @param next - the freshly minted session.
 * @param prior - the session whose refresh token was spent.
 * @param revision - the credential revision the prior session was read under, when known.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @throws Error when the pending marker does not match, or the write fails.
 */
export async function recordPendingRefreshRotation(
  provider: ProviderId,
  account: string,
  next: StoredSession,
  prior: StoredSession,
  revision: CredentialRevision | undefined,
  path = authFilePath(),
): Promise<void> {
  const journalPath = pendingRefreshJournalPath(path)
  await serialize(journalPath, async () => {
    const root = await readRefreshJournal(journalPath)
    const existing = journalEntry(root, provider, account)
    if (existing?.phase !== 'pending' || existing.priorFingerprint !== credentialFingerprint(prior)) {
      throw new Error(
        `subscriptions refresh journal: no pending marker matches the credential being rotated `
        + `for "${provider}/${account}"; refusing to overwrite the journal`,
      )
    }
    setJournalEntry(root, provider, account, {
      ...existing,
      phase: 'completed',
      updatedAt: Date.now(),
      ...revision === undefined ? {} : { priorRevision: revision },
      session: next,
    })
    await writeRefreshJournalFile(journalPath, root)
  })
}

/** Whether the journal already holds a marker for one account. */
async function journalEntryExists(journalPath: string, provider: string, account: string): Promise<boolean> {
  return journalEntry(await readRefreshJournal(journalPath), provider, account) !== undefined
}

/**
 * Clear one account's rotation marker. A missing journal, or a missing marker, is a no-op.
 * @param provider - the provider route.
 * @param account - the canonical account key.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @throws Error when the journal cannot be read or written.
 */
export async function completePendingRefreshRotation(
  provider: ProviderId,
  account: string,
  path = authFilePath(),
): Promise<void> {
  const journalPath = pendingRefreshJournalPath(path)
  if (!await journalEntryExists(journalPath, provider, account)) return
  await serialize(journalPath, async () => {
    const root = await readRefreshJournal(journalPath)
    if (!deleteJournalEntry(root, provider, account)) return
    await writeRefreshJournalFile(journalPath, root)
  })
}

/**
 * Settle the rotation marker after a store write already landed.
 *
 * A completed marker is kept when the write stored the very credential the rotation started
 * from: that write is a backfill (a device id or profile field), not a decision about which
 * credential is current, and discarding the marker would throw away the rotated token recovery
 * still holds. Any other landed write — the rotation's own session, a login, or a rotation from
 * another writer — supersedes the marker.
 * @param provider - the provider route.
 * @param account - the canonical account key.
 * @param stored - the session the write persisted.
 * @param path - store file path.
 */
async function settleRotationMarker(
  provider: ProviderId,
  account: string,
  stored: StoredSession,
  path: string,
): Promise<void> {
  try {
    const root = await readRefreshJournal(pendingRefreshJournalPath(path))
    const entry = journalEntry(root, provider, account)
    if (entry === undefined) return
    if (entry.phase === 'completed'
      && typeof entry.priorFingerprint === 'string'
      && credentialFingerprint(stored) === entry.priorFingerprint) {
      return
    }
    await completePendingRefreshRotation(provider, account, path)
  } catch (error: unknown) {
    // The credential is already stored; failing the write here would report a persistence failure
    // that did not happen. Recovery reconciles the marker when it next runs.
    void error
  }
}

/**
 * The accounts of one provider with a completed rotation marker the journal still holds.
 *
 * Used by the status projection to state `reauth_required` for an unsafe recovery. A journal
 * read that fails reports nothing here; startup recovery reports the failure itself.
 * @param provider - the provider route.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the account keys with a completed marker.
 */
export async function pendingRotationAccounts(
  provider: ProviderId,
  path = authFilePath(),
): Promise<ReadonlySet<string>> {
  try {
    const root = await readRefreshJournal(pendingRefreshJournalPath(path))
    const map = journalProviderMap(root, provider)
    const accounts = Object.entries(map)
      .filter(([, entry]) => isPlainObject(entry) && entry.phase === 'completed')
      .map(([account]) => account)
    return new Set(accounts)
  } catch (error: unknown) {
    // A status read must not fail on the optional journal; recovery owns reporting it.
    void error
    return new Set()
  }
}

/** What one startup recovery pass did. */
export interface PendingRotationRecovery {
  /** Completed rotations written back into the store. */
  readonly applied: number
  /** Markers cleared because the store already held their result, or nothing was recoverable. */
  readonly cleared: number
  /** Markers left in place because applying them was unsafe or failed. */
  readonly unresolved: readonly { readonly provider: ProviderId; readonly account: string }[]
}

/**
 * Recover rotation markers after a restart.
 *
 * A completed marker is applied only while the store still holds the credential the rotation
 * started from, and the write is compare-and-swapped on that credential's revision. When the
 * store already holds the journal's session the marker is cleared; when it holds something
 * else, the marker is left in place and reported rather than overwriting a newer login. A
 * marker whose account is absent is discarded — an explicit logout must never be undone. This
 * function never deletes a stored credential.
 * @param options - store path and warning sink; defaults to the plugin's own store.
 * @param options.path - store file path; defaults to {@link authFilePath}.
 * @param options.onWarn - receives a safe diagnostic for each interrupted or unresolved marker.
 * @returns what the pass applied, cleared and left unresolved.
 * @throws Error when the journal cannot be read; the file is left untouched.
 */
export async function recoverPendingRefreshRotations(options: {
  path?: string
  onWarn?: (message: string) => void
} = {}): Promise<PendingRotationRecovery> {
  const path = options.path ?? authFilePath()
  const journalPath = pendingRefreshJournalPath(path)
  const root = await readRefreshJournal(journalPath)
  const targets: { provider: ProviderId; account: string; entry: Record<string, unknown> }[] = []
  for (const [provider, map] of Object.entries(journalRotations(root))) {
    if (!(PROVIDER_IDS as readonly string[]).includes(provider) || !isPlainObject(map)) continue
    for (const [account, entry] of Object.entries(map)) {
      if (isPlainObject(entry)) targets.push({ provider: provider as ProviderId, account, entry })
    }
  }
  let applied = 0
  let cleared = 0
  const unresolved: { provider: ProviderId; account: string }[] = []
  /** Leave one marker in place and report why it could not be recovered. */
  const retain = (provider: ProviderId, account: string, reason: string): void => {
    unresolved.push({ provider, account })
    options.onWarn?.(`dsh-plugin-subscriptions: refresh journal for "${provider}/${account}" ${reason}`)
  }
  for (const { provider, account, entry } of targets) {
    if (entry.phase === 'pending') {
      // The crash happened before a new credential was recorded: nothing to restore. The old
      // tokens stay stored; the next real refresh either succeeds or parks the account.
      options.onWarn?.(
        `dsh-plugin-subscriptions: an interrupted refresh for "${provider}/${account}" left only `
        + 'an intent marker; no new credential was recorded and the stored one is kept',
      )
      try {
        await completePendingRefreshRotation(provider, account, path)
        cleared += 1
      } catch (error: unknown) {
        retain(provider, account, `could not be cleared (${journalFailureText(error)})`)
      }
      continue
    }
    if (entry.phase !== 'completed' || !isValidSessionShape(entry.session)
      || typeof entry.priorFingerprint !== 'string') {
      retain(provider, account, 'states no usable completed credential and was left in place')
      continue
    }
    const next = entry.session as StoredSession
    const credential = await getAccountCredential(provider, account, path)
    if (credential === undefined) {
      // The account is gone: an explicit logout must not be undone by a recovery pass.
      try {
        await completePendingRefreshRotation(provider, account, path)
        cleared += 1
        options.onWarn?.(
          `dsh-plugin-subscriptions: refresh journal for "${provider}/${account}" was discarded; `
          + 'the account is no longer stored',
        )
      } catch (error: unknown) {
        retain(provider, account, `could not be discarded (${journalFailureText(error)})`)
      }
      continue
    }
    const storedFingerprint = credentialFingerprint(credential.session)
    if (storedFingerprint === credentialFingerprint(next)) {
      try {
        await completePendingRefreshRotation(provider, account, path)
        cleared += 1
      } catch (error: unknown) {
        retain(provider, account, `could not be cleared (${journalFailureText(error)})`)
      }
      continue
    }
    if (storedFingerprint !== entry.priorFingerprint) {
      retain(provider, account, 'was left in place: the store holds a different credential')
      continue
    }
    try {
      const written = await saveAccountSession(provider, account, next as never, path, {
        expectedRevision: credential.revision,
      })
      if (!written) {
        retain(provider, account, 'was not applied: the store changed while it was being recovered')
        continue
      }
      applied += 1
      try {
        await completePendingRefreshRotation(provider, account, path)
      } catch (error: unknown) {
        retain(provider, account, `was applied but its marker could not be cleared (${journalFailureText(error)})`)
      }
    } catch (error: unknown) {
      retain(provider, account, `could not be applied (${journalFailureText(error)})`)
    }
  }
  return { applied, cleared, unresolved }
}

/** A safe one-line description of a journal failure; carries no credential. */
function journalFailureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One write chain per store path. Every mutation is a read-modify-write of a
 * single JSON file, and the plugin has several independent writers — a login,
 * a logout, and one token refresh per provider account, each on its own
 * schedule. Overlapping them unserialized costs whichever account read the
 * store first its entry.
 *
 * A chain is dropped once nothing is queued behind it, so the map holds an
 * entry only while writes are in flight.
 */
const writeChains = new Map<string, Promise<unknown>>()

/**
 * Run one read-modify-write of a store path after every write already queued
 * for it in this process, and under the lock that keeps another process out of
 * the same window. Callers join the chain synchronously, so call order is
 * write order.
 *
 * The chain orders this process's writers alone, and the conditional write in
 * {@link saveAccountSession} cannot close the rest of the window: it compares
 * only the entry of the account being written, while every writer loads the
 * whole file and renames a whole file back. A login landing between another
 * writer's load and rename adds an account key no guard is watching, and the
 * later rename drops it; {@link deleteAccountSession} and
 * {@link setDefaultAccount} carry no guard at all. The lock spans the load and
 * the rename, so two dsh processes sharing one DSH_HOME take turns instead.
 *
 * A lock that cannot be acquired fails the whole write. This path used to degrade to the
 * in-process chain when a foreign holder could not be waited out, and two writers then each read
 * the same file and the later rename dropped the other's account. Refusing the write leaves the
 * file whole, which is the outcome a credential store must choose.
 *
 * A read that rewrites what it read — the migration from the pre-rename store,
 * and the replacement of a token-derived account key — runs inside
 * {@link loadStore}, so a mutating caller covers it in the same critical
 * section; a read-only caller's rewrite stays outside the lock.
 * @param path - the store file being mutated.
 * @param action - the read-modify-write to run.
 * @returns whatever `action` returns.
 * @throws Error when another holder cannot be waited out; nothing is written.
 */
async function serialize<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(path) ?? Promise.resolve()
  const locked = async (): Promise<T> => {
    // The lock lives beside the store: its directory must exist before the lock can be created,
    // which is also what the write itself needs.
    await mkdir(dirname(path), { recursive: true })
    const outcome = await withStoreLockOwned(path, action)
    if (!outcome.acquired) {
      throw new Error(
        'subscriptions store: another process holds the store lock and the write was not '
        + 'started; nothing was written, retry when the other holder finishes',
      )
    }
    return outcome.value
  }
  // Both handlers: a failed write must not strand everything queued behind it.
  const next = previous.then(locked, locked)
  const tail = next.then(() => undefined, () => undefined)
  writeChains.set(path, tail)
  try {
    return await next
  } finally {
    if (writeChains.get(path) === tail) writeChains.delete(path)
  }
}

/**
 * List one provider's accounts, default first.
 * @param provider - the provider route.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the account entries in stable order (empty when logged out).
 */
export async function listAccounts<K extends ProviderId>(
  provider: K,
  path = authFilePath(),
): Promise<AccountEntry<SessionOf<K>>[]> {
  const entry = (await loadStore(path))[provider]
  if (entry === undefined) return []
  const accounts = Object.entries(entry.accounts).map(([key, session]) => ({ key, session }))
  accounts.sort((a, b) => Number(b.key === entry.default) - Number(a.key === entry.default))
  return accounts
}

/**
 * Read one account's session.
 * @param provider - the provider route.
 * @param account - the account key; defaults to the provider's default account.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the stored session, or `undefined` when absent.
 */
export async function getAccountSession<K extends ProviderId>(
  provider: K,
  account?: string,
  path = authFilePath(),
): Promise<SessionOf<K> | undefined> {
  const entry = (await loadStore(path))[provider]
  if (entry === undefined) return undefined
  const key = account ?? entry.default
  if (key === undefined) return undefined
  return entry.accounts[resolveAccount(entry, key)] as SessionOf<K> | undefined
}

/**
 * A store-minted, monotonic revision of one account's credential.
 *
 * It changes whenever the credential does — a rotation, a re-login, a removal — and never
 * returns to an earlier value, so a caller that recorded a revision can tell whether the
 * credential it reasoned about is still the one stored.
 */
export type CredentialRevision = number

/**
 * One account's stored credential together with the revision it is stored under.
 * @typeParam S - the provider's session type.
 */
export interface AccountCredential<S> {
  /** Canonical account key the credential is stored under. */
  key: string
  session: S
  revision: CredentialRevision
}

/**
 * Highest revision this process has already issued for one account.
 *
 * The persisted high-water mark is the cross-process authority; this floor covers the
 * window before a write lands and a store file that predates the revision map. It is keyed
 * by store path as well as provider and account, so two stores — a test home and the real
 * one, or two DSH homes — never share a counter.
 */
const revisionFloors = new Map<string, number>()

/** Key of one store's process-local revision floor. */
function revisionFloorKey(path: string, provider: ProviderId, account: string): string {
  return `${path}\u0000${provider}\u0000${account}`
}

/**
 * Validate one persisted revision map.
 *
 * Revisions are read from a file, which is an untyped boundary, so a value that is not a
 * non-negative safe integer is dropped rather than trusted; the account keeps reading as
 * revision 0 and the next accepted write mints a higher one.
 * @param value - the parsed value to validate.
 * @returns the usable entries, empty when the value carries none.
 */
function readRevisionMap(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const kept: Record<string, number> = {}
  for (const [account, revision] of Object.entries(value)) {
    if (account.length === 0) continue
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) continue
    kept[account] = revision
  }
  return kept
}

/**
 * Validate the root revision map, keeping only known providers.
 * @param value - the parsed value to validate.
 * @returns the usable per-provider maps, empty when the value carries none.
 */
function readRevisionTombstones(value: unknown): Record<string, Record<string, number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const kept: Record<string, Record<string, number>> = {}
  for (const provider of PROVIDER_IDS) {
    const accounts = readRevisionMap(raw[provider])
    if (Object.keys(accounts).length > 0) kept[provider] = accounts
  }
  return kept
}

/**
 * The next revision for one account: one above both the persisted high-water mark and
 * every revision this process has already issued for it.
 * @param path - the store file, so unrelated stores keep unrelated counters.
 * @param provider - the provider route.
 * @param entry - the provider's stored entry, when it has one.
 * @param tombstones - the store's root high-water marks.
 * @param account - the canonical account key.
 * @returns the revision the next accepted write establishes.
 */
function nextCredentialRevision(
  path: string,
  provider: ProviderId,
  entry: ProviderAccounts<StoredSession> | undefined,
  tombstones: Record<string, Record<string, number>> | undefined,
  account: string,
): CredentialRevision {
  const key = revisionFloorKey(path, provider, account)
  const persisted = Math.max(
    entry?.revisions?.[account] ?? 0,
    tombstones?.[provider]?.[account] ?? 0,
  )
  const next = Math.max(persisted, revisionFloors.get(key) ?? 0) + 1
  revisionFloors.set(key, next)
  return next
}

/**
 * Record one account's new revision in both places it must persist: beside the account,
 * for readers of that entry, and at the store root, so it survives the account's removal.
 * @param store - the loaded store, mutated in place.
 * @param provider - the provider route.
 * @param account - the canonical account key.
 * @param revision - the revision this write establishes.
 */
function recordCredentialRevision(
  store: SessionMap,
  provider: ProviderId,
  account: string,
  revision: CredentialRevision,
): void {
  store.revisions = {
    ...store.revisions,
    [provider]: { ...store.revisions?.[provider], [account]: revision },
  }
}

/**
 * Read one account's credential and the revision it is stored under, without any side
 * effect and without refreshing. A caller that will act on the session keeps the revision
 * and re-reads before committing an effect that must not land on a newer credential.
 * @param provider - the provider route.
 * @param account - the account key; defaults to the provider's default account.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the credential snapshot, or `undefined` when the account is not logged in.
 */
export async function getAccountCredential<K extends ProviderId>(
  provider: K,
  account?: string,
  path = authFilePath(),
): Promise<AccountCredential<SessionOf<K>> | undefined> {
  const store = await loadStore(path)
  const entry = store[provider]
  if (entry === undefined) return undefined
  const requested = account ?? entry.default
  if (requested === undefined) return undefined
  const key = resolveAccount(entry, requested)
  const session = entry.accounts[key] as SessionOf<K> | undefined
  if (session === undefined) return undefined
  return {
    key,
    session,
    revision: currentRevision(store, provider, entry as ProviderAccounts<StoredSession> | undefined, key),
  }
}

/**
 * Write one account's session, preserving the others. The first account of a
 * provider becomes its default.
 *
 * The session is validated before it lands: a corrupt entry written here
 * would fail every later read of the whole store (one bad entry breaks all
 * providers' status), so the write path must be as strict as the read path.
 * Every accepted write also bumps that account's {@link CredentialRevision}.
 * @param provider - the provider route.
 * @param account - the account key (see {@link accountKeyOf}).
 * @param session - the fresh session from a login or refresh.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @param options - `expectedPrior` compares the stored session's tokens, and
 *   `expectedRevision` compares the stored revision, so a decision taken on either can be
 *   refused once a newer credential landed. Both are optional; a caller that reads a
 *   revision before deciding passes it.
 * @throws when the session is missing accessToken/refreshToken/expiresAt.
 */
export async function saveAccountSession<K extends ProviderId>(
  provider: K,
  account: string,
  session: SessionOf<K>,
  path = authFilePath(),
  options: { expectedPrior?: SessionOf<K>; expectedRevision?: CredentialRevision } = {},
): Promise<boolean> {
  assertSessionShape(provider, account, session)
  return serialize(path, async () => {
    const store = await loadStoreUnderLock(path)
    const entry = store[provider] as ProviderAccounts<SessionOf<K>> | undefined
    if (entry !== undefined) {
      account = resolveAccount(entry, account)
      if (provider === 'codex') {
        const previousAccount = account
        account = reconcileCodexIdentity(
          entry as unknown as ProviderAccounts<CodexSession>,
          session as unknown as CodexSession,
        ) ?? accountKeyOf('codex', session as unknown as CodexSession)
        // The raw file may still name the key this rekey retired; the session is written under
        // the alias target, so the absence is a move rather than a loss.
        if (account !== previousAccount && !Object.hasOwn(entry.accounts, previousAccount)) {
          markAccountSuperseded(store, provider, previousAccount)
        }
      }
    }
    // A refresh that started before a logout or a re-login must not put its own
    // result back: the stored session is the authority, and a caller that names
    // the session it read only writes while that session is still the one there.
    // Comparing tokens rather than object identity is what makes this work across
    // the serialization boundary the store already has.
    if (options.expectedPrior !== undefined) {
      const stored = entry?.accounts[account]
      if (!sameStoredSession(stored, options.expectedPrior)) return false
    }
    // A revision the caller decided on is checked the same way, which also refuses a write
    // whose credential tokens happen to repeat an earlier state.
    if (options.expectedRevision !== undefined
      && currentRevision(store, provider, entry as ProviderAccounts<StoredSession> | undefined, account) !== options.expectedRevision) {
      return false
    }
    const revision = nextCredentialRevision(path, provider, entry as ProviderAccounts<StoredSession> | undefined, store.revisions, account)
    ;(store as Record<string, unknown>)[provider] = {
      ...entry,
      default: entry?.default ?? account,
      accounts: { ...entry?.accounts, [account]: session },
      revisions: { ...entry?.revisions, [account]: revision },
    } satisfies ProviderAccounts<SessionOf<K>>
    recordCredentialRevision(store, provider, account, revision)
    await writeStore(store, path)
    // The store now holds the newest credential: an intent or completed marker for it is stale.
    await settleRotationMarker(provider, account, session as StoredSession, path)
    return true
  })
}

/**
 * The revision one account currently reads as: the persisted high-water mark, whether it
 * sits beside the account or at the store root.
 * @param store - the loaded store.
 * @param provider - the provider route.
 * @param entry - the provider's stored entry, when it has one.
 * @param account - the canonical account key.
 * @returns the revision, 0 when nothing was ever recorded.
 */
function currentRevision(
  store: SessionMap,
  provider: ProviderId,
  entry: ProviderAccounts<StoredSession> | undefined,
  account: string,
): CredentialRevision {
  return Math.max(entry?.revisions?.[account] ?? 0, store.revisions?.[provider]?.[account] ?? 0)
}

/**
 * Whether a stored session is the one a caller read: same access and refresh token.
 *
 * @param stored - the session currently in the store, when any.
 * @param expected - the session the caller read before its round trip.
 * @returns true when the caller may write over it.
 */
function sameStoredSession(
  stored: SessionOf<ProviderId> | undefined,
  expected: SessionOf<ProviderId>,
): boolean {
  if (stored === undefined) return false
  return stored.accessToken === expected.accessToken && stored.refreshToken === expected.refreshToken
}

/**
 * Delete one account's session (logout). Deleting the default moves the badge
 * to the next remaining account.
 *
 * The removal runs inside the store's own serialization, so a caller that names
 * the session it read cannot delete one another writer stored in the meantime:
 * a login or a rotation that landed first is kept, and the caller answers false.
 * @param provider - the provider route.
 * @param account - the account key.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @param options - `expectedPrior` makes the removal conditional on the stored
 *   session still being that one, and `expectedRevision` on the stored revision still
 *   being the one the caller read, exactly as {@link saveAccountSession} does.
 * @returns true when the session was actually removed; false when the account
 *   was already absent or another writer had replaced the named session.
 */
export async function deleteAccountSession<K extends ProviderId>(
  provider: K,
  account: string,
  path = authFilePath(),
  options: { expectedPrior?: SessionOf<K>; expectedRevision?: CredentialRevision } = {},
): Promise<boolean> {
  return serialize(path, async () => {
    const store = await loadStoreUnderLock(path)
    const entry = store[provider] as ProviderAccounts<SessionOf<K>> | undefined
    if (entry === undefined) return false
    account = resolveAccount(entry, account)
    if (!Object.hasOwn(entry.accounts, account)) return false
    if (options.expectedRevision !== undefined
      && currentRevision(store, provider, entry as ProviderAccounts<StoredSession> | undefined, account) !== options.expectedRevision) {
      return false
    }
    // The stored session is the authority: a caller that read one only deletes
    // while that session is still the one there, so a refresh that started
    // before a logout or a re-login cannot destroy the newer credential.
    if (options.expectedPrior !== undefined
      && !sameStoredSession(entry.accounts[account], options.expectedPrior)) return false
    // A logged-out account must not be resurrected by a pending rotation, and a completed marker
    // must not outlive the deletion. The clear runs before the deletion so a failure aborts the
    // logout instead of leaving a marker that could be applied after a restart.
    await completePendingRefreshRotation(provider, account, path)
    // The one intent that may omit a stored credential is this explicit logout.
    markAccountRemoved(store, provider, account)
    const accounts = { ...entry.accounts }
    delete accounts[account]
    // The removal is itself a credential change: a re-login must land on a higher revision
    // than the credential this logout retired, and a decision taken before it must not
    // still read as current. The root high-water mark is written either way, so removing
    // the provider's last account does not reset the counter.
    const revision = nextCredentialRevision(
      path,
      provider,
      entry as ProviderAccounts<StoredSession>,
      store.revisions,
      account,
    )
    recordCredentialRevision(store, provider, account, revision)
    if (Object.keys(accounts).length === 0) {
      delete store[provider]
    } else {
      ;(store as Record<string, unknown>)[provider] = {
        ...entry,
        ...entry.default === account ? { default: Object.keys(accounts)[0] } : { default: entry.default },
        accounts,
        revisions: { ...entry.revisions, [account]: revision },
      }
    }
    await writeStore(store, path, { prune: true })
    return true
  })
}

/**
 * Pin the account direct (non-pool) routes serve.
 * @param provider - the provider route.
 * @param account - the account key; must exist.
 * @param path - store file path; defaults to {@link authFilePath}.
 */
export async function setDefaultAccount(
  provider: ProviderId,
  account: string,
  path = authFilePath(),
): Promise<void> {
  return serialize(path, async () => {
    const store = await loadStoreUnderLock(path)
    const entry = store[provider]
    if (entry !== undefined) account = resolveAccount(entry, account)
    if (entry === undefined || !Object.hasOwn(entry.accounts, account)) {
      throw new Error(`no ${provider} account "${account}" is logged in`)
    }
    ;(store as Record<string, unknown>)[provider] = { ...entry, default: account }
    await writeStore(store, path)
  })
}
