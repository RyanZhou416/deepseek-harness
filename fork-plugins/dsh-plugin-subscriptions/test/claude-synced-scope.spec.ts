/**
 * Fail-closed source-account verification in `refreshClaudeSynced`.
 *
 * Claude Code's credential store is a single file shared by every consumer, so it can be
 * switched to a different login between the moment this plugin imported an account and the
 * moment it refreshes. Adopting that rotation would serve one account's tokens under another
 * account's key, so the source is adopted only when this account can be confirmed against it:
 * a comparable email that matches, or an unchanged credential lineage. A known conflict
 * rejects, and a source this account cannot be confirmed against fails closed with
 * `CLAUDE_CREDENTIAL_SOURCE_CHANGED`.
 *
 * Every case uses a private temporary `CLAUDE_CONFIG_DIR`; the real harness home, the user's
 * `~/.claude/.credentials.json` and the macOS Keychain are never touched. The darwin reader
 * consults the Keychain first and these cases exercise the file branch only, so the suite is
 * skipped on darwin rather than running `/usr/bin/security`.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import './keep-alive.js'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { claudeReadOnlyUse, readClaudeCodeCredentials, refreshClaudeSynced } from '../src/auth/claude-code-creds.js'
import type { ClaudeSourceCredential } from '../src/auth/claude-code-creds.js'
import { claudeCredentialModeOf } from '../src/auth/claude-credential-ownership.js'
import { getAccountSession, saveAccountSession } from '../src/auth/store.js'
import type { ClaudeSession } from '../src/auth/store.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { CLAUDE_PREEMPT_MS, isClaudePermanentRefreshError } from '../src/providers/claude.js'
import { classifyPoolFailure } from '../src/providers/pool-health.js'
import { DEFAULT_RETRY, subscriptionRetryPolicy } from '../src/providers/rate-limit.js'

/** The plugin-local code this guard fails with; deliberately not `AUTH`. */
const SOURCE_CHANGED_CODE = 'CLAUDE_CREDENTIAL_SOURCE_CHANGED'

const TEMP_DIRS: string[] = []

/** A temp directory removed when the file finishes. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.push(dir)
  return dir
}

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

/** Restore an environment variable, keeping "unset" distinct from "empty". */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/**
 * The darwin reader answers from the Keychain before it looks at the file, and this suite must
 * not invoke `/usr/bin/security`, so the platform difference is documented instead of being
 * exercised with a synthetic Keychain entry.
 */
const fileStoreOnly: { skip?: string } = process.platform === 'darwin'
  ? { skip: 'the darwin reader consults the Keychain first; this suite covers the file branch without running /usr/bin/security' }
  : {}

/** One private credentials directory holding one synthetic blob. */
function writeSource(prefix: string, session: ClaudeSession): { dir: string; file: string; before: string } {
  const dir = tempDir(prefix)
  const file = join(dir, '.credentials.json')
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { ...session } }), { mode: 0o600 })
  return { dir, file, before: readFileSync(file, 'utf8') }
}

/** Run one call against a private credentials directory. */
async function withConfigDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  try {
    return await run()
  } finally {
    restoreEnv('CLAUDE_CONFIG_DIR', saved)
  }
}

/** A session for one account, with a token that never appears in the source store. */
function callerSession(identity: Pick<ClaudeSession, 'emailAddress' | 'accountUuid'> = {}): ClaudeSession {
  return {
    accessToken: 'at-caller',
    refreshToken: 'rt-caller',
    expiresAt: Date.now() - 1_000,
    scopes: 'user:inference',
    ...identity,
  }
}

/**
 * Call `refreshClaudeSynced` against one source blob and report what happened.
 * @param source - the session written into Claude Code's store.
 * @param caller - the session the plugin holds.
 * @returns the outcome, the number of grants spent, and the store text afterwards.
 */
async function runSynced(
  source: ClaudeSession,
  caller: ClaudeSession,
): Promise<{ outcome: 'adopted' | 'granted' | 'rejected'; grants: number; returned?: ClaudeSession; code?: string; after: string }> {
  const { dir, file } = writeSource('claude-synced-', source)
  let grants = 0
  try {
    const returned = await withConfigDir(dir, () => refreshClaudeSynced(caller, async (session) => {
      grants += 1
      return { ...session, accessToken: 'at-grant', refreshToken: 'rt-grant', expiresAt: Date.now() + 3_600_000 }
    }))
    return {
      outcome: returned.accessToken === source.accessToken ? 'adopted' : 'granted',
      grants,
      returned,
      after: readFileSync(file, 'utf8'),
    }
  } catch (error) {
    return {
      outcome: 'rejected',
      grants,
      code: error instanceof LlmError ? error.code : `not-an-LlmError:${String(error)}`,
      after: readFileSync(file, 'utf8'),
    }
  }
}

const FRESH = Date.now() + 3_600_000

/** A source session for account B, with tokens that differ from every caller session. */
function sourceSession(identity: Pick<ClaudeSession, 'emailAddress' | 'accountUuid'> = {}): ClaudeSession {
  return {
    accessToken: 'at-source-b',
    refreshToken: 'rt-source-b',
    expiresAt: FRESH,
    scopes: 'user:inference',
    ...identity,
  }
}

// ---------------------------------------------------------------------------
// A known identity conflict rejects, without a grant or a write
// ---------------------------------------------------------------------------

test('a source for a different login email is rejected without spending a grant or writing', fileStoreOnly, async () => {
  const result = await runSynced(
    sourceSession({ emailAddress: 'other@example.test' }),
    callerSession({ emailAddress: 'synthetic@example.test' }),
  )
  assert.equal(result.outcome, 'rejected')
  assert.equal(result.code, SOURCE_CHANGED_CODE)
  assert.equal(result.grants, 0, 'no grant is spent on a foreign credential')
  assert.ok(result.after.includes('at-source-b'), 'the source blob is untouched')
})

test('an identity conflict outranks a shared refresh-token lineage', fileStoreOnly, async () => {
  const source = { ...sourceSession({ emailAddress: 'other@example.test' }), refreshToken: 'rt-caller' }
  const result = await runSynced(source, callerSession({ emailAddress: 'synthetic@example.test' }))
  assert.equal(result.outcome, 'rejected', 'two known emails that differ are never one account')
  assert.equal(result.code, SOURCE_CHANGED_CODE)
})

test('the source side carries no account uuid, so that identity cannot be compared', fileStoreOnly, async () => {
  // The reader maps only the login email and the plan name off the blob. This is why the email,
  // and not `accountUuid`, is the identity `sameSourceAccount` compares.
  const { dir } = writeSource('claude-synced-uuid-', { ...sourceSession(), accountUuid: 'uuid-b' })
  const stored = await withConfigDir(dir, async () => readClaudeCodeCredentials())
  assert.equal(stored?.accountUuid, undefined, 'a blob uuid is not carried into the session')
  assert.equal(stored?.accessToken, 'at-source-b', 'the rest of the blob still reads normally')
})

// ---------------------------------------------------------------------------
// Identity absent or unusable: only a shared lineage may stand in
// ---------------------------------------------------------------------------

test('a fully changed token pair with no identity metadata is rejected, not guessed', fileStoreOnly, async () => {
  const result = await runSynced(sourceSession(), callerSession())
  assert.equal(result.outcome, 'rejected', 'an unconfirmed source fails closed')
  assert.equal(result.code, SOURCE_CHANGED_CODE)
  assert.equal(result.grants, 0)
})

test('one-sided metadata with no shared lineage is rejected', fileStoreOnly, async () => {
  // A one-sided email is not itself evidence; rejection here comes from the absent lineage.
  const result = await runSynced(sourceSession({ emailAddress: 'synthetic@example.test' }), callerSession())
  assert.equal(result.outcome, 'rejected')
  assert.equal(result.code, SOURCE_CHANGED_CODE)
})

test('one-sided metadata with a shared refresh lineage is still adopted', fileStoreOnly, async () => {
  const result = await runSynced(
    { ...sourceSession({ emailAddress: 'synthetic@example.test' }), refreshToken: 'rt-caller' },
    callerSession(),
  )
  assert.equal(result.outcome, 'adopted', 'a shared lineage suffices when no identity can conflict')
  assert.equal(result.grants, 0)
})

test('an empty email on both sides is not a known identity, so the lineage decides', fileStoreOnly, async () => {
  const rejected = await runSynced(sourceSession({ emailAddress: '' }), callerSession({ emailAddress: '' }))
  assert.equal(rejected.outcome, 'rejected', 'empty emails must not compare as equal')
  assert.equal(rejected.code, SOURCE_CHANGED_CODE)

  const adopted = await runSynced(
    { ...sourceSession({ emailAddress: '' }), refreshToken: 'rt-caller' },
    callerSession({ emailAddress: '' }),
  )
  assert.equal(adopted.outcome, 'adopted', 'the shared lineage still decides')
})

test('a whitespace-only email is not a known identity', fileStoreOnly, async () => {
  const result = await runSynced(sourceSession({ emailAddress: '   ' }), callerSession({ emailAddress: '\t' }))
  assert.equal(result.outcome, 'rejected')
  assert.equal(result.code, SOURCE_CHANGED_CODE)
})

test('a known email is compared as written, without case folding', fileStoreOnly, async () => {
  const differingCase = await runSynced(
    sourceSession({ emailAddress: 'Synthetic@Example.Test' }),
    callerSession({ emailAddress: 'synthetic@example.test' }),
  )
  assert.equal(differingCase.outcome, 'rejected', 'case differences stay a conflict, never widened')

  const surroundingSpace = await runSynced(
    sourceSession({ emailAddress: '  synthetic@example.test  ' }),
    callerSession({ emailAddress: 'synthetic@example.test' }),
  )
  assert.equal(surroundingSpace.outcome, 'adopted', 'only surrounding whitespace is trimmed away')
})

test('the same refresh token still establishes one lineage without identity metadata', fileStoreOnly, async () => {
  const result = await runSynced({ ...sourceSession(), refreshToken: 'rt-caller' }, callerSession())
  assert.equal(result.outcome, 'adopted')
  assert.equal(result.grants, 0)
})

test('a shared email still identifies the same account when the tokens are fully rotated', fileStoreOnly, async () => {
  const result = await runSynced(sourceSession({ emailAddress: 'synthetic@example.test' }), callerSession({ emailAddress: 'synthetic@example.test' }))
  assert.equal(result.outcome, 'adopted')
  assert.equal(result.grants, 0)
})

test('the same access token is served as before, with no identity check needed', fileStoreOnly, async () => {
  const result = await runSynced({ ...sourceSession(), accessToken: 'at-caller' }, callerSession())
  assert.equal(result.outcome, 'granted', 'the caller copy is the base when the access token already matches')
  assert.equal(result.grants, 1)
  assert.equal(result.returned?.accessToken, 'at-grant')
})

// ---------------------------------------------------------------------------
// Negative controls: the same account still syncs
// ---------------------------------------------------------------------------

test('a fresher source rotation for the same email is still adopted', fileStoreOnly, async () => {
  const result = await runSynced(
    sourceSession({ emailAddress: 'synthetic@example.test' }),
    callerSession({ emailAddress: 'synthetic@example.test' }),
  )
  assert.equal(result.outcome, 'adopted')
  assert.equal(result.grants, 0, 'the store already rotated the token')
  assert.equal(result.after.includes('at-source-b'), true, 'an adoption never rewrites the source')
})

test('a fresher source rotation for the same account uuid is still adopted', fileStoreOnly, async () => {
  // The uuid is not read from the source side, but a caller that carries one must not obstruct
  // an adoption the shared email already establishes.
  const result = await runSynced(
    sourceSession({ accountUuid: 'uuid-a', emailAddress: 'synthetic@example.test' }),
    callerSession({ accountUuid: 'uuid-a', emailAddress: 'synthetic@example.test' }),
  )
  assert.equal(result.outcome, 'adopted')
})

test('a completed grant for the source account is written back as before', fileStoreOnly, async () => {
  const expired = { ...sourceSession({ emailAddress: 'synthetic@example.test' }), expiresAt: 0 }
  const result = await runSynced(expired, callerSession({ emailAddress: 'synthetic@example.test' }))
  assert.equal(result.outcome, 'granted')
  assert.equal(result.grants, 1)
  assert.equal(result.after.includes('at-grant'), true, 'the rotation lands in the source store')
})

// ---------------------------------------------------------------------------
// Through the real AccountTokenManager: the code is neither parked nor retried
// ---------------------------------------------------------------------------

interface ManagerRun {
  served?: ClaudeSession
  error?: unknown
  outerCalls: number
  grants: number
  removed: boolean
}

/**
 * Drive a real `AccountTokenManager` through the same refresh closure the plugin wires when
 * `syncClaudeCodeCredentials` is on, against one private source store.
 * @param stored - the session the account store holds.
 * @param source - the session Claude Code's store holds.
 * @param force - pass `true` to model a 401-driven refresh.
 * @returns what the manager served or threw, and the side effects observed.
 */
async function runManager(
  stored: ClaudeSession,
  source: ClaudeSession,
  force: boolean,
): Promise<ManagerRun> {
  const { dir } = writeSource('claude-synced-manager-', source)
  let outerCalls = 0
  let grants = 0
  let removed = false
  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Claude (Subscription)',
    makeOptions: () => ({
      preemptMs: CLAUDE_PREEMPT_MS,
      refresh: (session) => {
        outerCalls += 1
        return withConfigDir(dir, () => refreshClaudeSynced(session, async (current) => {
          grants += 1
          return { ...current, accessToken: 'at-grant', refreshToken: 'rt-grant', expiresAt: FRESH }
        }))
      },
      isPermanent: isClaudePermanentRefreshError,
    }),
    io: {
      list: async () => [{ key: 'acct', session: stored }],
      get: async () => stored,
      save: async () => undefined,
      remove: async () => { removed = true },
    },
  })
  try {
    const served = await tokens.session('acct', force)
    return { served, outerCalls, grants, removed }
  } catch (error: unknown) {
    return { error, outerCalls, grants, removed }
  }
}

test('a forced refresh against another account fails with the plugin-local code, unremoved and unretried', fileStoreOnly, async () => {
  const run = await runManager(
    callerSession({ emailAddress: 'synthetic@example.test' }),
    sourceSession({ emailAddress: 'other@example.test' }),
    true,
  )
  assert.ok(run.error instanceof LlmError, 'the failure is an LlmError so its code survives')
  assert.equal((run.error as LlmError).code, SOURCE_CHANGED_CODE)
  assert.match((run.error as LlmError).message, /re-import|browser flow/)
  assert.equal(run.removed, false, 'the account is not removed')
  assert.equal(run.outerCalls, 1, 'the refresh is attempted once, never retried')
  assert.equal(run.grants, 0, 'no grant is spent on the foreign credential')

  const action = classifyPoolFailure(run.error, 'claude')
  assert.deepEqual(action, { action: 'throw' }, 'the code neither parks nor switches the account')
  const policy = subscriptionRetryPolicy(DEFAULT_RETRY, { wait: true, maxWaitMs: 60_000 }, 'claude: synced-source test')
  const retryable = 'retryableCodes' in policy ? policy.retryableCodes : []
  assert.equal(retryable.includes(SOURCE_CHANGED_CODE), false, 'the code is not auto-retried')
})

test('an expired session against another account throws instead of serving the source', fileStoreOnly, async () => {
  const run = await runManager(
    callerSession({ emailAddress: 'synthetic@example.test' }),
    sourceSession({ emailAddress: 'other@example.test' }),
    false,
  )
  assert.ok(run.error instanceof LlmError)
  assert.equal((run.error as LlmError).code, SOURCE_CHANGED_CODE)
  assert.notEqual((run.error as LlmError).code, 'AUTH', 'the credential is sound; the account is not parked')
})

test('a still-valid session inside the preempt window keeps its own credential and never adopts the source', fileStoreOnly, async () => {
  const stored = {
    ...callerSession({ emailAddress: 'synthetic@example.test' }),
    expiresAt: Date.now() + 60_000,
  }
  const run = await runManager(stored, sourceSession({ emailAddress: 'other@example.test' }), false)
  assert.equal(run.served?.accessToken, 'at-caller', 'the caller keeps the credential it already had')
  assert.notEqual(run.served?.accessToken, 'at-source-b', 'the foreign source is never served')
  assert.equal(run.grants, 0)
  assert.equal(run.removed, false)
})

// ---------------------------------------------------------------------------
// read-only-import: every use re-reads its external source
//
// These cases drive the shipped `AccountTokenManager` with the preparation hook the plugin
// wires for the Claude route, over the private test home's own store. The source is an injected
// reader, so no case runs `/usr/bin/security` or opens a real credential file — and unlike the
// synced-write-back cases above, these run on every platform.
// ---------------------------------------------------------------------------

/** A synthetic read-only account key unique to one case. */
function readOnlyAccount(label: string): string {
  return `${label}-${randomBytes(4).toString('hex')}@example.invalid`
}

/** One read-only use, with what it served and what it spent. */
interface ReadOnlyRun {
  served?: ClaudeSession
  error?: unknown
  grants: number
  reads: number
}

/**
 * One external source as the reader reports it.
 * @param session - the session shape the plugin records.
 * @param declaredScopes - what the source itself declared; defaults to the session's own scopes.
 * @returns the source credential.
 */
function sourceOf(session: ClaudeSession, declaredScopes?: string): ClaudeSourceCredential {
  return declaredScopes === undefined
    ? { session, declaredScopes: session.scopes }
    : { session, declaredScopes }
}

/**
 * Drive one use through the shipped manager and the production preparation hook.
 * @param stored - the read-only record the account is stored under.
 * @param readSource - the external source as it stands at the moment of the use.
 * @param force - pass `true` to model the forced refresh a 401 asks for.
 * @returns what was served, what failed, and the side effects observed.
 */
async function runReadOnly(
  stored: ClaudeSession,
  readSource: () => ClaudeSourceCredential | undefined,
  force = false,
): Promise<ReadOnlyRun> {
  const account = stored.emailAddress!
  await saveAccountSession('claude', account, stored)
  let grants = 0
  let reads = 0
  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Claude (read-only use test)',
    makeOptions: () => ({
      preemptMs: CLAUDE_PREEMPT_MS,
      refresh: async (current) => {
        grants += 1
        return { ...current, accessToken: 'at-grant', refreshToken: 'rt-grant', expiresAt: FRESH }
      },
      isPermanent: isClaudePermanentRefreshError,
    }),
    prepareSession: account => claudeReadOnlyUse(account, () => { reads += 1; return readSource() }),
  })
  try {
    return { served: await tokens.session(account, force), grants, reads }
  } catch (error: unknown) {
    return { error, grants, reads }
  }
}

/** A stored read-only record, deliberately holding a stale token of its own. */
function readOnlyRecord(account: string, overrides: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    accessToken: 'at-stored-stale',
    refreshToken: 'rt-stored',
    expiresAt: Date.now() - 1_000,
    scopes: 'user:inference',
    emailAddress: account,
    keychainBound: true,
    credentialOwnershipMode: 'read-only-import',
    ...overrides,
  }
}

test('a read-only use serves the external source and never spends a grant', async () => {
  const account = readOnlyAccount('read-only')
  const run = await runReadOnly(readOnlyRecord(account), () => sourceOf({
    ...sourceSession({ emailAddress: account }),
    accessToken: 'at-source-live',
  }))
  assert.equal(run.served?.accessToken, 'at-source-live', 'the external winner is served, not the stored copy')
  assert.equal(run.served?.credentialOwnershipMode, 'read-only-import', 'and its ownership mode rides along')
  assert.equal(run.reads, 1, 'the source was read for this use')
  assert.equal(run.grants, 0, 'a read-only credential never spends the shared grant')
  const stored = await getAccountSession('claude', account)
  assert.equal(stored?.accessToken, 'at-stored-stale', 'the stored record is a reference and is never rewritten')
})

test('a forced refresh for a read-only account still serves the source and spends nothing', async () => {
  const account = readOnlyAccount('read-only-forced')
  const run = await runReadOnly(
    readOnlyRecord(account),
    () => sourceOf({ ...sourceSession({ emailAddress: account }), accessToken: 'at-source-live' }),
    true,
  )
  assert.equal(run.served?.accessToken, 'at-source-live', 'the 401 path reads the source too')
  assert.equal(run.grants, 0, 'and it never reaches the token endpoint')
})

test('a second use adopts the rotation the external holder made in between', async () => {
  const account = readOnlyAccount('read-only-rotate')
  const record = readOnlyRecord(account)
  let source: ClaudeSession = { ...sourceSession({ emailAddress: account }), accessToken: 'at-source-1' }
  const first = await runReadOnly(record, () => sourceOf(source))
  assert.equal(first.served?.accessToken, 'at-source-1')
  source = { ...sourceSession({ emailAddress: account }), accessToken: 'at-source-2', refreshToken: 'rt-source-2' }
  const second = await runReadOnly(record, () => sourceOf(source))
  assert.equal(second.served?.accessToken, 'at-source-2', 'the current winner is adopted, not the first one or the cache')
  assert.equal(second.grants, 0)
})

test('a source whose scopes the document never states is refused', async () => {
  const account = readOnlyAccount('read-only-undeclared')
  // The session shape still carries a scope list, but the document declared none.
  const run = await runReadOnly(readOnlyRecord(account), () => sourceOf(
    { ...sourceSession({ emailAddress: account }), accessToken: 'at-source-live' },
    '',
  ))
  assert.ok(run.error instanceof LlmError, 'an undeclared scope set never authorizes a read-only use')
  assert.equal((run.error as LlmError).code, 'INVALID_CREDENTIAL')
  assert.equal(run.grants, 0)
})

test('a missing read-only source stops the use and keeps the stored authorization', async () => {
  const account = readOnlyAccount('read-only-missing')
  const run = await runReadOnly(readOnlyRecord(account), () => undefined)
  assert.ok(run.error instanceof LlmError, 'the use fails rather than falling back')
  assert.equal((run.error as LlmError).code, 'INVALID_CREDENTIAL')
  assert.equal((run.error as LlmError).failure.retryDisposition, 'forbid')
  assert.equal(run.grants, 0)
  assert.notEqual(await getAccountSession('claude', account), undefined, 'the old authorization is not deleted')
})

test('a foreign read-only source fails closed without a grant', async () => {
  const account = readOnlyAccount('read-only-foreign')
  const run = await runReadOnly(readOnlyRecord(account), () => sourceOf(sourceSession({ emailAddress: 'someone-else@example.test' })))
  assert.ok(run.error instanceof LlmError)
  assert.equal((run.error as LlmError).code, SOURCE_CHANGED_CODE)
  assert.equal(run.grants, 0)
  assert.notEqual(await getAccountSession('claude', account), undefined)
})

test('an account of another mode never consults the external source', async () => {
  for (const stored of [
    readOnlyRecord(readOnlyAccount('legacy'), { credentialOwnershipMode: 'legacy-writeback' }),
    readOnlyRecord(readOnlyAccount('independent'), { credentialOwnershipMode: 'independent-oauth' }),
  ]) {
    const account = stored.emailAddress!
    // Far outside the preempt window, so the manager serves the stored credential without
    // reaching the legacy write-back path — this case is about which modes read the source.
    const run = await runReadOnly({ ...stored, expiresAt: Date.now() + 3_600_000 }, () => undefined)
    assert.equal(run.reads, 0, `${String(stored.credentialOwnershipMode)} does not read the external source`)
    assert.equal(run.served?.accessToken, 'at-stored-stale', 'the manager path answers unchanged')
    assert.equal(run.grants, 0)
  }
})

// ---------------------------------------------------------------------------
// A refresh keeps the record's ownership mode, on both of its branches
//
// Neither `refreshClaudeSynced`'s adopted external rotation nor a token grant states this
// account's ownership, so the stored record must carry it across both. Losing it would re-infer
// the mode as `independent-oauth` and start rotating the shared grant on this plugin's own
// timer.
// ---------------------------------------------------------------------------

/** One refreshed legacy account, with what the store holds afterwards. */
interface LegacyRefresh {
  served?: ClaudeSession
  stored?: ClaudeSession
  error?: unknown
}

/**
 * Refresh one legacy record through the shipped manager over the private test home.
 * @param stored - the legacy record to persist first.
 * @param source - the credential Claude Code's own store holds.
 * @param grant - the token grant the refresh may spend.
 * @returns the served session and the durable record afterwards.
 */
async function runLegacyRefresh(
  stored: ClaudeSession,
  source: ClaudeSession,
  grant: (session: ClaudeSession) => Promise<ClaudeSession>,
): Promise<LegacyRefresh> {
  const account = stored.emailAddress!
  await saveAccountSession('claude', account, stored)
  const { dir } = writeSource('claude-legacy-refresh-', source)
  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Claude (legacy refresh test)',
    makeOptions: () => ({
      preemptMs: CLAUDE_PREEMPT_MS,
      refresh: session => withConfigDir(dir, () => refreshClaudeSynced(session, grant)),
      isPermanent: isClaudePermanentRefreshError,
    }),
  })
  const outcome = await tokens.session(account).then(
    (served: ClaudeSession) => ({ served }),
    (error: unknown) => ({ error }),
  )
  if ('error' in outcome) return outcome
  const persisted = await getAccountSession('claude', account)
  // These cases observe the refresh's own conditional write, so a record that is gone would
  // mean the refresh removed the account. Narrowing here asserts exactly that, rather than
  // widening the result type and letting a missing record read as an absent observation.
  assert.ok(persisted !== undefined, 'the refreshed account is still stored')
  return { served: outcome.served, stored: persisted }
}

test('an adopted external rotation keeps the legacy mode in the durable record', fileStoreOnly, async () => {
  const account = readOnlyAccount('legacy-adopt')
  const stored = readOnlyRecord(account, {
    accessToken: 'at-stored-stale',
    refreshToken: 'rt-stored',
    credentialOwnershipMode: 'legacy-writeback',
  })
  // This case is about the legacy path, so the fixture states that mode before the refresh runs:
  // the read-only default this helper is named for would put the assertions below on another
  // route and read green for the wrong reason.
  assert.equal(claudeCredentialModeOf(stored), 'legacy-writeback', 'the fixture is the legacy record this case is about')
  const run = await runLegacyRefresh(
    stored,
    { ...sourceSession({ emailAddress: account }), accessToken: 'at-source-rotated' },
    // The grant must never run on this branch: the source is already fresh.
    () => Promise.reject(new Error('no grant may be spent on an adopted rotation')),
  )
  assert.equal(run.served?.accessToken, 'at-source-rotated', 'the external rotation is adopted')
  assert.equal(run.served?.credentialOwnershipMode, 'legacy-writeback', 'and it carries the record\'s mode')
  assert.equal(run.stored?.credentialOwnershipMode, 'legacy-writeback', 'the durable record still states it')
  assert.equal(claudeCredentialModeOf(run.stored!), 'legacy-writeback', 'so the next read cannot re-infer it')
  assert.equal(run.stored?.keychainBound, true, 'and the imported fact survives too')
})

test('a granted refresh keeps the legacy mode in the durable record', fileStoreOnly, async () => {
  const account = readOnlyAccount('legacy-grant')
  const stored = readOnlyRecord(account, {
    accessToken: 'at-stored-stale',
    refreshToken: 'rt-stored',
    credentialOwnershipMode: 'legacy-writeback',
  })
  // As above: the mode is stated by the fixture, never inferred from the helper's default.
  assert.equal(claudeCredentialModeOf(stored), 'legacy-writeback', 'the fixture is the legacy record this case is about')
  let grants = 0
  const run = await runLegacyRefresh(
    stored,
    // The source itself is expired, so the pre-existing compatibility path spends its grant.
    { ...sourceSession({ emailAddress: account }), accessToken: 'at-source-expired', expiresAt: Date.now() - 1_000 },
    // The grant answers with a token document and nothing else: it states no ownership, so the
    // stored reference is the only thing that can carry the mode across it.
    async (session) => {
      grants += 1
      return { accessToken: 'at-granted', refreshToken: 'rt-granted', expiresAt: FRESH, scopes: session.scopes }
    },
  )
  assert.equal(run.error, undefined, String(run.error))
  assert.equal(run.served?.accessToken, 'at-granted', 'the granted credential is served')
  assert.equal(grants, 1, 'exactly one grant was spent')
  assert.equal(run.served?.credentialOwnershipMode, 'legacy-writeback', 'the served session keeps the mode')
  assert.equal(run.stored?.credentialOwnershipMode, 'legacy-writeback', 'the durable record still states it')
  assert.equal(claudeCredentialModeOf(run.stored!), 'legacy-writeback', 'and the next read resolves it as legacy')
})
