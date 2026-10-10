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
 */

import { randomBytes } from 'node:crypto'
import { decodeJwtPayload } from './jwt.js'
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { withStoreLock } from './store-lock.js'

/** Provider routes this plugin can serve. */
export type ProviderId = 'codex' | 'claude' | 'grok' | 'copilot' | 'antigravity' | 'cursor'

/** Every provider route, in display order. */
export const PROVIDER_IDS: readonly ProviderId[] = ['codex', 'claude', 'grok', 'copilot', 'antigravity', 'cursor']

/**
 * A session whose provider can report no display identity. Such a session carries the
 * random id it is keyed by, so the account key served to the browser derives from no
 * credential.
 */
export interface AccountKeyedSession {
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
   * Stable per-account device id minted at login; the second member of the
   * correlation triple. Backfilled on first use for pre-upgrade sessions.
   */
  deviceId?: string
  /**
   * True when this account was imported from Claude Code's own credential
   * store (Keychain/file): only bound accounts sync refreshes back to it.
   */
  keychainBound?: boolean
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
export interface ProviderAccounts<S> {
  /** Key of the account direct (non-pool) routes serve; the first login wins. */
  default?: string
  accounts: Record<string, S>
  /** Old keys remain bound to their migrated account, never a workspace sibling. */
  aliases?: Record<string, string>
}

/** The durable store shape: per provider, its accounts. */
export interface SessionMap {
  codex?: ProviderAccounts<CodexSession>
  claude?: ProviderAccounts<ClaudeSession>
  grok?: ProviderAccounts<GrokSession>
  copilot?: ProviderAccounts<CopilotSession>
  antigravity?: ProviderAccounts<AntigravitySession>
  cursor?: ProviderAccounts<CursorSession>
}

/** Any stored session, for provider-agnostic plumbing. */
export type StoredSession = CodexSession | ClaudeSession | GrokSession | CopilotSession | AntigravitySession | CursorSession

/** The session type one provider stores. */
export type SessionOf<K extends ProviderId> = NonNullable<SessionMap[K]>['accounts'][string]

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
}

/**
 * Read the whole store. A missing file is an empty store; malformed JSON or a
 * malformed entry throws, because silently discarding tokens would strand the
 * user without a diagnosis. Single-account entries are migrated in memory;
 * the next write persists the new shape. An account key that names the session's
 * refresh token is replaced here and written back immediately, so the account
 * keeps one key across restarts.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the parsed session map.
 */
export async function loadStore(path = authFilePath()): Promise<SessionMap> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Migrate the pre-rename store once, preserving existing logins.
    if (path !== authFilePath()) return {}
    try {
      text = await readFile(legacyAuthFilePath(), 'utf8')
    } catch (legacyError) {
      if ((legacyError as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw legacyError
    }
    const migrated = parseStore(text, legacyAuthFilePath())
    await writeStore(migrated.store, path)
    await rm(legacyAuthFilePath(), { force: true })
    return migrated.store
  }
  const parsed = parseStore(text, path)
  if (parsed.rekeyed) await writeStore(parsed.store, path)
  return parsed.store
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
    ;(store as Record<string, unknown>)[provider] = {
      ...record,
      ...aliases === undefined ? {} : { aliases },
      default: validDefault,
      accounts: keyed,
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
 * Write one account's session, preserving the others. The first account of a
 * provider becomes its default.
 *
 * The session is validated before it lands: a corrupt entry written here
 * would fail every later read of the whole store (one bad entry breaks all
 * providers' status), so the write path must be as strict as the read path.
 * @param provider - the provider route.
 * @param account - the account key (see {@link accountKeyOf}).
 * @param session - the fresh session from a login or refresh.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @throws when the session is missing accessToken/refreshToken/expiresAt.
 */
export async function saveAccountSession<K extends ProviderId>(
  provider: K,
  account: string,
  session: SessionOf<K>,
  path = authFilePath(),
  options: { expectedPrior?: SessionOf<K> } = {},
): Promise<boolean> {
  assertSessionShape(provider, account, session)
  return serialize(path, async () => {
    const store = await loadStore(path)
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
    ;(store as Record<string, unknown>)[provider] = {
      ...entry,
      default: entry?.default ?? account,
      accounts: { ...entry?.accounts, [account]: session },
    } satisfies ProviderAccounts<SessionOf<K>>
    await writeStore(store, path)
    return true
  })
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
 * @param provider - the provider route.
 * @param account - the account key.
 * @param path - store file path; defaults to {@link authFilePath}.
 */
export async function deleteAccountSession(
  provider: ProviderId,
  account: string,
  path = authFilePath(),
): Promise<void> {
  return serialize(path, async () => {
    const store = await loadStore(path)
    const entry = store[provider]
    if (entry === undefined) return
    account = resolveAccount(entry, account)
    if (!Object.hasOwn(entry.accounts, account)) return
    const accounts = { ...entry.accounts }
    delete accounts[account]
    if (Object.keys(accounts).length === 0) {
      delete store[provider]
    } else {
      ;(store as Record<string, unknown>)[provider] = {
        ...entry,
        ...entry.default === account ? { default: Object.keys(accounts)[0] } : { default: entry.default },
        accounts,
      }
    }
    await writeStore(store, path)
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
    const store = await loadStore(path)
    const entry = store[provider]
    if (entry !== undefined) account = resolveAccount(entry, account)
    if (entry === undefined || !Object.hasOwn(entry.accounts, account)) {
      throw new Error(`no ${provider} account "${account}" is logged in`)
    }
    ;(store as Record<string, unknown>)[provider] = { ...entry, default: account }
    await writeStore(store, path)
  })
}
