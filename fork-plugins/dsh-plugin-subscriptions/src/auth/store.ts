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

import { randomBytes } from 'node:crypto'
import { decodeJwtPayload } from './jwt.js'
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { withStoreLock } from './store-lock.js'
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

/** Upgrade one unambiguous email fallback to the stable user key. */
function reconcileCodexIdentity(entry: ProviderAccounts<CodexSession>, session: CodexSession): string | undefined {
  const userKey = codexUserKey(session)
  const email = codexEmail(session)
  if (userKey === undefined || email === undefined) return undefined
  const emailKey = JSON.stringify([session.accountId, 'email', email])
  const previous = entry.accounts[emailKey]
  if (previous === undefined || codexEmail(previous) !== email) return undefined
  // Never merge workspace-wide: the exact normalized workspace/email pair must match.
  if (!Object.hasOwn(entry.accounts, userKey)) entry.accounts[userKey] = previous
  delete entry.accounts[emailKey]
  entry.aliases = { ...entry.aliases, [emailKey]: userKey }
  for (const [alias, target] of Object.entries(entry.aliases)) {
    if (target === emailKey) entry.aliases[alias] = userKey
  }
  if (entry.default === emailKey) entry.default = userKey
  return userKey
}

function migrateCodex(entry: ProviderAccounts<CodexSession>): void {
  for (const [oldKey, session] of Object.entries(entry.accounts)) {
    if (oldKey !== session.accountId) continue
    const key = accountKeyOf('codex', session)
    if (key === oldKey || Object.hasOwn(entry.accounts, key)) continue
    entry.accounts[key] = session
    delete entry.accounts[oldKey]
    entry.aliases = { ...entry.aliases, [oldKey]: key }
    if (entry.default === oldKey) entry.default = key
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
 * @param read - the read whose write-back is persisted.
 * @param path - store file path.
 */
async function persistStoreRead(read: StoreRead, path: string): Promise<void> {
  await writeStore(read.store, path)
  if (read.legacyPath !== undefined) await rm(read.legacyPath, { force: true })
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
 * broken keychain import) is SKIPPED instead of rejected: one bad entry must
 * not blind every provider's status read, and a session without tokens is
 * unusable by definition, so nothing of value is discarded. The next write
 * persists the store without the skipped entry. Structural failures (invalid
 * JSON, a non-object file) still throw — those say the file itself is broken.
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
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`subscriptions auth store at ${path} must be a JSON object keyed by provider; fix or delete the file`)
  }
  const raw = parsed as Record<string, unknown>
  const store: SessionMap = {}
  const tombstones = readRevisionTombstones(raw.revisions)
  if (Object.keys(tombstones).length > 0) store.revisions = tombstones
  let rekeyed = false
  for (const provider of PROVIDER_IDS) {
    const entry = raw[provider]
    if (entry === undefined) continue
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      console.warn(`subscriptions auth store: entry "${provider}" is not an object; skipped`)
      continue
    }
    const record = entry as Record<string, unknown>
    if (typeof record.accessToken === 'string') {
      // Single-account format: wrap the bare session, preserving every field.
      if (!isValidSessionShape(record)) {
        console.warn(`subscriptions auth store: legacy entry "${provider}" has no usable tokens; skipped`)
        continue
      }
      const session = record as unknown as StoredSession
      const key = provider === 'codex' ? (session as CodexSession).accountId : accountKeyOf(provider, session)
      assertClaudeCredentialOwnershipMode(provider, key, record)
      // An identity-less session was just keyed by a minted id; write it so the account
      // keeps that key rather than taking a new one on the next read.
      if (accountIdentityOf(provider, session) === undefined) rekeyed = true
      ;(store as Record<string, unknown>)[provider] = { default: key, accounts: { [key]: session } }
      continue
    }
    const accounts = record.accounts
    if (typeof accounts !== 'object' || accounts === null || Array.isArray(accounts)) {
      console.warn(`subscriptions auth store: entry "${provider}" has no accounts map; skipped`)
      continue
    }
    if (record.default !== undefined && typeof record.default !== 'string') {
      console.warn(`subscriptions auth store: entry "${provider}" default is not a string; skipped`)
      continue
    }
    const kept: Record<string, StoredSession> = {}
    for (const [account, session] of Object.entries(accounts)) {
      if (isValidSessionShape(session)) {
        assertClaudeCredentialOwnershipMode(provider, account, session as Record<string, unknown>)
        kept[account] = session as StoredSession
      } else {
        console.warn(
          `subscriptions auth store: entry "${provider}/${account}" has no usable accessToken/refreshToken/expiresAt; skipped`,
        )
      }
    }
    if (Object.keys(kept).length === 0) continue
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
  }
  if (store.codex !== undefined) migrateCodex(store.codex)
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

/** How many times to retry a Windows replace before falling back to a copy. */
const STORE_REPLACE_ATTEMPTS = 8

/** Windows denies rename-over when a reader still has the destination open. */
function isRetryableReplaceError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

/**
 * Swap a finished temp file onto `path`. POSIX rename replaces an existing
 * file. Windows often returns EPERM for that replace while Defender, the
 * indexer, or a reader holds `auth.json`, so retry, then copy over it.
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
  if (!isRetryableReplaceError(last)) throw last
  await copyFile(tmp, path)
  await rm(tmp, { force: true })
}

/** Persist the whole store atomically with owner-only permissions. */
async function writeStore(store: SessionMap, path: string): Promise<void> {
  // Before anything is written: one unusable mode would make every later read of this file
  // throw, so the store that is about to replace it is refused instead.
  assertStoredClaudeOwnershipModes(store)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
    // An existing destination keeps its old mode through rename on some
    // filesystems; enforce 0600 on the source before the swap.
    await chmod(tmp, 0o600)
    await replaceStoreFile(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
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
 * the rename, so two dsh processes sharing one DSH_HOME take turns instead. It
 * is the protocol store-lock.ts describes, and it degrades to the in-process
 * chain alone when a foreign holder cannot be waited out.
 *
 * A read that rewrites what it read — the migration from the pre-rename store,
 * and the replacement of a token-derived account key — runs inside
 * {@link loadStore}, so a mutating caller covers it in the same critical
 * section; a read-only caller's rewrite stays outside the lock.
 * @param path - the store file being mutated.
 * @param action - the read-modify-write to run.
 * @returns whatever `action` returns.
 */
async function serialize<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(path) ?? Promise.resolve()
  const locked = (): Promise<T> => withStoreLock(path, action)
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
        account = reconcileCodexIdentity(
          entry as unknown as ProviderAccounts<CodexSession>,
          session as unknown as CodexSession,
        ) ?? accountKeyOf('codex', session as unknown as CodexSession)
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
    await writeStore(store, path)
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
