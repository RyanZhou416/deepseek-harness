import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { withStoreLockOwned } from './store-lock.js'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getAccountSession } from './store.js'
import { claudeCredentialModeOf, withClaudeCredentialReference } from './claude-credential-ownership.js'
import type { ClaudeSession } from './store.js'

const PRIMARY_SERVICE = 'Claude Code-credentials'

interface RawCreds {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  scopes?: string[] | string
  subscriptionType?: string
  emailAddress?: string
}

interface CredentialBlob {
  claudeAiOauth?: RawCreds
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  scopes?: string[] | string
  subscriptionType?: string
  emailAddress?: string
}

/**
 * The scope set this plugin's own record carries when the credential blob states none.
 *
 * It exists for the local record and for the pre-existing legacy synchronization path, which
 * refresh from the same scope list the pinned client uses. It is deliberately NOT what a
 * read-only use reads: see {@link ClaudeSourceCredential.declaredScopes}.
 */
const DEFAULT_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers'

function toSession(data: RawCreds): ClaudeSession | undefined {
  // Empty-string tokens (seen from a corrupted Keychain item left by a Claude
  // Code logout) pass the typeof gate but are useless and would poison the
  // auth store — a single such entry fails every provider's status read.
  if (typeof data.accessToken !== 'string' || data.accessToken.length === 0
    || typeof data.refreshToken !== 'string' || data.refreshToken.length === 0
    || typeof data.expiresAt !== 'number' || !Number.isFinite(data.expiresAt)) {
    return undefined
  }
  const scopes = Array.isArray(data.scopes) ? data.scopes.join(' ') : typeof data.scopes === 'string' ? data.scopes : DEFAULT_SCOPES
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: Math.trunc(data.expiresAt),
    scopes,
    ...typeof data.emailAddress === 'string' ? { emailAddress: data.emailAddress } : {},
    ...typeof data.subscriptionType === 'string' ? { subscriptionType: data.subscriptionType } : {},
  }
}

/**
 * The scopes the credential document itself states, or `undefined` when it states none.
 *
 * The distinction matters because {@link toSession} fills the pinned default set into the local
 * record: "the source grants inference" and "the source said nothing" would otherwise be the
 * same string. A malformed value states nothing rather than being coerced.
 * @param data - the credential fields the document stated.
 * @returns the declared scopes, or `undefined` for an absent, empty or non-string value.
 */
function declaredScopes(data: RawCreds): string | undefined {
  const scopes = Array.isArray(data.scopes)
    ? data.scopes.every(entry => typeof entry === 'string') ? data.scopes.join(' ') : undefined
    : typeof data.scopes === 'string' ? data.scopes : undefined
  return scopes !== undefined && scopes.trim().length > 0 ? scopes : undefined
}

/**
 * One credential as Claude Code's own store states it.
 *
 * `session` is the shape this plugin records; `declaredScopes` is what the source itself
 * granted, which a read-only use must judge for itself because the recorded shape may carry the
 * pinned default set the source never stated.
 */
export interface ClaudeSourceCredential {
  /** The session shape this plugin records for this source. */
  readonly session: ClaudeSession
  /**
   * The scopes the credential document itself declared, or `undefined` when it declared none.
   * A read-only use refuses a source that declares none: an inferred scope set must never
   * authorize serving an externally owned credential.
   */
  readonly declaredScopes?: string
}

/**
 * Parse one credentials document into the source credential.
 *
 * A JSON root that is not an object — `null`, an array, or a primitive — carries no
 * `claudeAiOauth` to read. It reports "no credentials" so the caller falls back to the browser
 * flow, instead of a property access throwing a TypeError out of the login RPC.
 *
 * @param raw - the credential store's raw text.
 * @returns the source credential, or `undefined` when the document is unusable.
 */
function parseSource(raw: string): ClaudeSourceCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const blob = parsed as CredentialBlob
  const data = blob.claudeAiOauth ?? blob
  const session = toSession(data)
  if (session === undefined) return undefined
  const declared = declaredScopes(data)
  return { session, ...declared === undefined ? {} : { declaredScopes: declared } }
}

/**
 * Parse one credentials document into a session, dropping the source's own scope statement.
 * @param raw - the credential store's raw text.
 * @returns the session, or `undefined` when the document is unusable.
 */
function parseBlob(raw: string): ClaudeSession | undefined {
  return parseSource(raw)?.session
}

function credentialsFilePath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json')
}

function readKeychainRaw(): string | undefined {
  try {
    return execFileSync('/usr/bin/security', ['find-generic-password', '-s', PRIMARY_SERVICE, '-w'], {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return undefined
  }
}

function readFileRaw(): string | undefined {
  try {
    return readFileSync(credentialsFilePath(), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Read the current Claude Code credential from its source of truth: macOS Keychain, falling
 * back to the credentials file.
 * @returns the source credential, or `undefined` when the source holds none.
 */
export function readClaudeCodeCredentialSource(): ClaudeSourceCredential | undefined {
  if (process.platform === 'darwin') {
    const raw = readKeychainRaw()
    const source = raw !== undefined ? parseSource(raw) : undefined
    if (source) return source
  }
  const raw = readFileRaw()
  return raw !== undefined ? parseSource(raw) : undefined
}

/** Read the current Claude Code session from its source of truth: macOS Keychain, falling back to the credentials file. */
export function readClaudeCodeCredentials(): ClaudeSession | undefined {
  return readClaudeCodeCredentialSource()?.session
}

function blobMatches(raw: string, expectedAccessToken: string): boolean {
  return parseBlob(raw)?.accessToken === expectedAccessToken
}

function getKeychainAccountName(): string | undefined {
  try {
    const output = execFileSync('/usr/bin/security', ['find-generic-password', '-s', PRIMARY_SERVICE], {
      timeout: 2000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return /"acct"<blob>="([^"]*)"/.exec(output)?.[1]
  } catch {
    return undefined
  }
}

/** Merge fresh tokens into an existing raw blob, preserving unrelated fields. */
function mergeIntoBlob(existingRaw: string, next: ClaudeSession): string | undefined {
  let parsed: CredentialBlob
  try {
    parsed = JSON.parse(existingRaw)
  } catch {
    return undefined
  }
  const target = (parsed.claudeAiOauth ?? parsed) as RawCreds
  target.accessToken = next.accessToken
  target.refreshToken = next.refreshToken
  target.expiresAt = next.expiresAt
  return JSON.stringify(parsed)
}

/**
 * Write a refreshed session back to Claude Code's own credential store, so
 * the `claude` CLI and any other consumer of the same account see the token
 * we just rotated. A stale-blob mismatch (something else rotated it first)
 * is a no-op — the caller already has that other rotation via readClaudeCodeCredentials.
 * @param next - the freshly refreshed session to persist.
 * @param expectedPriorAccessToken - the access token this refresh started from.
 * @returns whether the write-back succeeded.
 */
function writeBackClaudeCodeCredentials(next: ClaudeSession, expectedPriorAccessToken: string): boolean {
  if (process.platform === 'darwin') {
    const raw = readKeychainRaw()
    if (raw === undefined || !blobMatches(raw, expectedPriorAccessToken)) return false
    const updated = mergeIntoBlob(raw, next)
    if (updated === undefined) return false
    const account = getKeychainAccountName() ?? PRIMARY_SERVICE
    try {
      // The secret goes over stdin: with no value after `-w`, `security` reads the password
      // from its input, which keeps it out of the process argument list where any local user
      // could read it. `-U` stays last so an existing item is replaced.
      execFileSync('/usr/bin/security', ['add-generic-password', '-s', PRIMARY_SERVICE, '-a', account, '-w', '-U'], {
        input: updated,
        timeout: 2000,
        stdio: ['pipe', 'ignore', 'ignore'],
      })
      return true
    } catch {
      return false
    }
  }
  const path = credentialsFilePath()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  if (!blobMatches(raw, expectedPriorAccessToken)) return false
  const updated = mergeIntoBlob(raw, next)
  if (updated === undefined) return false
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(path, updated, { encoding: 'utf8', mode: 0o600 })
    chmodSync(path, 0o600)
    return true
  } catch {
    return false
  }
}

/**
 * Failure code for a Claude refresh whose source store changed and cannot be confirmed as this
 * account's.
 *
 * Deliberately not `AUTH`: the credential this call holds is sound and no provider refused
 * anything, so this is a local refusal rather than a spent login.
 */
const CLAUDE_CREDENTIAL_SOURCE_CHANGED_CODE = 'CLAUDE_CREDENTIAL_SOURCE_CHANGED'

/**
 * The failure for a source credential this account cannot be confirmed against.
 * @returns the error to throw.
 */
function claudeCredentialSourceChangedError(): LlmError {
  return new LlmError(
    "Claude Code's credential store changed and cannot be confirmed for this account; "
    + 're-import it, or sign in with the browser flow',
    CLAUDE_CREDENTIAL_SOURCE_CHANGED_CODE,
  )
}

/**
 * The login email as a known identity, or `undefined` when it carries nothing.
 * @param value - the session's email field.
 * @returns the trimmed email, or `undefined` for an absent, empty or whitespace-only value.
 */
function knownEmail(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/**
 * Whether a credential read from Claude Code's own store may stand in for the account being
 * refreshed.
 *
 * An email carrying something after trimming on both sides is compared as written, without case
 * folding; an empty or whitespace-only email is not a known identity. With no comparable email,
 * only an unchanged refresh token counts: the caller already holds a different access token
 * when this runs, so a shared refresh token is a shared lineage. `accountUuid` is not compared
 * because {@link readClaudeCodeCredentials} never fills it in.
 *
 * @param source - the session read from Claude Code's store.
 * @param session - the session the caller is refreshing.
 * @returns true when the source rotation may stand in for this account's.
 */
function sameSourceAccount(source: ClaudeSession, session: ClaudeSession): boolean {
  const sourceEmail = knownEmail(source.emailAddress)
  const sessionEmail = knownEmail(session.emailAddress)
  if (sourceEmail !== undefined && sessionEmail !== undefined) return sourceEmail === sessionEmail
  return source.refreshToken === session.refreshToken
}

/**
 * Refresh a Claude session, first checking whether Claude Code's own store
 * already holds a fresher token (rotated by the `claude` CLI or another
 * consumer) before hitting the OAuth endpoint ourselves — and writing our own
 * refresh back to that store so every consumer of the account stays synced.
 *
 * A rotation read from that store is adopted only under {@link sameSourceAccount}'s local
 * contract; otherwise this fails closed with {@link claudeCredentialSourceChangedError},
 * spending no grant and writing nothing. The lock taken here serialises this plugin's own
 * cooperating processes; whether the `claude` CLI locks this path the same way is not
 * established, so no coordination with it is claimed.
 * @param session - the session TokenManager wants refreshed.
 * @param doRefresh - the actual OAuth refresh-token grant (network call).
 * @param onWarn - sink for a write-back that did not land; absent stays quiet.
 * @returns the freshest available session.
 * @throws LlmError `CLAUDE_CREDENTIAL_SOURCE_CHANGED` when the store's credential changed and
 *   this account cannot be confirmed against it, unknown identity included.
 */
export async function refreshClaudeSynced(
  session: ClaudeSession,
  doRefresh: (session: ClaudeSession) => Promise<ClaudeSession>,
  onWarn?: (message: string) => void,
): Promise<ClaudeSession> {
  // Held across read-refresh-write so two cooperating processes sharing the account cannot both
  // rotate its refresh token, which would invalidate whichever side lost the race. A lock that
  // cannot be acquired fails this write rather than running it unowned.
  const path = credentialsFilePath()
  // The lock lives beside the credential file; the directory must exist before it can be created.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const outcome = await withStoreLockOwned(path, async () => {
    const fromSource = readClaudeCodeCredentials()
    const sourceRotation = fromSource !== undefined && fromSource.accessToken !== session.accessToken
      ? fromSource
      : undefined
    if (sourceRotation !== undefined && !sameSourceAccount(sourceRotation, session)) {
      throw claudeCredentialSourceChangedError()
    }
    // The stored record is the reference every branch answers with: an adopted external
    // rotation and a freshly granted token are both credentials from elsewhere, and neither
    // states this account's ownership mode or local binding. Losing them here would re-infer
    // the mode as `independent-oauth` on the next read and start rotating the shared grant on
    // this plugin's own timer.
    const base = withClaudeCredentialReference(session, sourceRotation ?? session)
    if (base.expiresAt > Date.now() + 60_000) return base
    const next = await doRefresh(base)
    // The grant is spent; this plugin must still store the result even when the external copy
    // cannot be updated. The boolean is not ignored: a failed write-back is reported so the
    // operator knows Claude Code's copy no longer matches, and no token is deleted either way.
    if (!writeBackClaudeCodeCredentials(next, base.accessToken)) {
      onWarn?.(
        "dsh-plugin-subscriptions: the refreshed Claude credential could not be written back to "
        + "Claude Code's credential store; that copy is now stale and must be imported again",
      )
    }
    return withClaudeCredentialReference(session, next)
  })
  if (!outcome.acquired) {
    throw new LlmError(
      'dsh-plugin-subscriptions: another process holds Claude Code\'s credential lock; '
      + 'the refreshed credential was not written back, retry shortly',
      'REFRESH_BUSY',
    )
  }
  return outcome.value
}

/**
 * The scope a read-only source must grant before this plugin serves it.
 *
 * It is the capability every Messages request needs and the one the pinned client's own
 * first-party credentials carry, so a source without it cannot serve a request: the use stops
 * there rather than sending a token the provider will refuse.
 */
const REQUIRED_SOURCE_SCOPE = 'user:inference'

/**
 * The failure for a read-only credential whose external source cannot serve a request at all.
 *
 * `INVALID_CREDENTIAL` is deliberate: until the user imports again this account cannot serve,
 * so the pool parks it as an authentication failure and the status reports `reauth_required`.
 * Nothing is deleted and nothing is refreshed — the stored record is a reference to an
 * externally owned credential, and a source that is missing, expired or under-scoped must not
 * retire that authorization, nor make this plugin spend the shared grant.
 * @param reason - what the source failed to provide.
 * @returns the error to throw.
 */
function claudeReadOnlySourceError(reason: 'missing' | 'expired' | 'scope'): LlmError {
  const detail = reason === 'missing'
    ? 'Claude Code no longer holds a credential for this account'
    : reason === 'expired'
      ? "Claude Code's credential for this account has expired and this plugin does not refresh it"
      : `Claude Code's credential for this account does not grant ${REQUIRED_SOURCE_SCOPE}`
  return new LlmError(
    `${detail}; import it again from Claude Code, or sign in with the browser flow`,
    'INVALID_CREDENTIAL',
    { retryDisposition: 'forbid' },
  )
}

/**
 * Resolve the credential one read-only use serves.
 *
 * The external store is read again on every use and its current winner is adopted, so a
 * rotation the `claude` CLI performed is served without this plugin ever spending the shared
 * grant or writing back. The stored record is a reference, never a fallback: a source that is
 * absent, expired, under-scoped or unconfirmable for this account stops the use, and no token
 * is read from the local record.
 *
 * The scope gate reads what the SOURCE declared, not the recorded shape: the local record
 * carries the pinned default set when the blob stated none, so judging it there would let a
 * credential that declares nothing be served as if it granted inference.
 *
 * The served session keeps the reference fields the stored record owns (see
 * {@link withClaudeCredentialReference}): a consumer that persists an identity backfill must
 * not lose the mode, and dropping the device binding would re-run that backfill every request.
 * @param session - the stored read-only record this account is served under.
 * @param source - the external credential as the source states it, or `undefined` when it holds
 *   none for this account.
 * @returns the winner to serve, carrying the record's own reference fields.
 * @throws LlmError `CLAUDE_CREDENTIAL_SOURCE_CHANGED` when the source cannot be confirmed as
 *   this account's, and `INVALID_CREDENTIAL` when it cannot serve a request at all.
 */
export function resolveClaudeReadOnlyCredential(
  session: ClaudeSession,
  source: ClaudeSourceCredential | undefined,
): ClaudeSession {
  if (source === undefined) throw claudeReadOnlySourceError('missing')
  const winner = source.session
  if (!sameSourceAccount(winner, session)) throw claudeCredentialSourceChangedError()
  if (!Number.isFinite(winner.expiresAt) || winner.expiresAt <= Date.now()) {
    throw claudeReadOnlySourceError('expired')
  }
  if (source.declaredScopes === undefined
    || !source.declaredScopes.split(/\s+/).includes(REQUIRED_SOURCE_SCOPE)) {
    throw claudeReadOnlySourceError('scope')
  }
  return withClaudeCredentialReference(session, winner)
}

/**
 * Resolve the credential one refresh WINDOW serves for a read-only record.
 *
 * The use path normally answers a read-only account before the token manager loads a credential,
 * so reaching a refresh means the record's ownership moved inside the manager's own window. This
 * runs there, under the manager's durable lock, so it judges the reference the manager is already
 * holding and never reads the plugin's store again.
 *
 * The manager answers a non-permanent refresh failure with the credential it loaded — the stored
 * reference, which is exactly the local cached token the read-only mode forbids — so a source that
 * cannot serve is reported as a missing credential, the one failure the manager propagates without
 * falling back to that copy and without deleting the record. Its message is the source's own.
 * @param session - the read-only reference the manager holds.
 * @param readSource - reads Claude Code's own credential source.
 * @returns the external winner to serve.
 * @throws LlmError `MISSING_CREDENTIAL` when the source cannot serve this account: it holds
 *   nothing, holds a credential that cannot serve it, or cannot be read at all.
 */
export function resolveClaudeReadOnlyRefresh(
  session: ClaudeSession,
  readSource: () => ClaudeSourceCredential | undefined,
): ClaudeSession {
  try {
    // One read of the source, taken INSIDE this guard: the reference the manager handed over is
    // judged against the credential this read produced, and a read that fails for any reason a
    // real credential-store read can fail takes the same stop as a source that holds nothing.
    // Reading it outside would let that failure reach the manager untranslated, where an
    // unexpired reference is answered with the stored copy this mode forbids.
    const source = readSource()
    if (source === undefined) throw claudeReadOnlySourceError('missing')
    return resolveClaudeReadOnlyCredential(session, source)
  } catch (error: unknown) {
    throw new LlmError(
      error instanceof Error ? error.message : String(error),
      'MISSING_CREDENTIAL',
      { cause: error, retryDisposition: 'forbid' },
    )
  }
}

/**
 * The use-path preparation for one Claude account.
 *
 * Answers `undefined` for every mode that does not read an external store, so the caller keeps
 * the manager's own load-and-refresh path unchanged. A read-only account answers the winner
 * re-read from the source, which is what makes the check reachable from every credential use —
 * a Messages request, a forced refresh after a 401, usage, model discovery and the maintenance
 * reads — while a list, snapshot or status read never touches that source.
 * @param account - the canonical account key.
 * @param readSource - reads Claude Code's own credential source.
 * @returns the credential to serve, or `undefined` when the account is not read-only.
 * @throws LlmError as {@link resolveClaudeReadOnlyCredential} does.
 */
export async function claudeReadOnlyUse(
  account: string,
  readSource: () => ClaudeSourceCredential | undefined,
): Promise<ClaudeSession | undefined> {
  const stored = await getAccountSession('claude', account)
  if (stored === undefined || claudeCredentialModeOf(stored) !== 'read-only-import') return undefined
  return resolveClaudeReadOnlyCredential(stored, readSource())
}
