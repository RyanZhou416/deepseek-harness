/**
 * Credential ownership: the persisted mode, its validation, the mode a record without one
 * implies, the conversions allowed between modes, and the read-only use contract.
 *
 * Every case uses the shipped store in the private test `DSH_HOME`; no case reads or writes a
 * real credential source, and the read-only source is an injected reader over an in-memory
 * value, so nothing here runs `/usr/bin/security`, opens the user's credential file or performs
 * a request.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { LlmError } from '@deepseek-ai/dsh-llm'

import './keep-alive.js'
import {
  CLAUDE_CREDENTIAL_IS_FIRST_PARTY_OAUTH,
  CLAUDE_CREDENTIAL_MODES,
  claudeCredentialArmsOwnTimer,
  claudeCredentialCoordinationUnproven,
  claudeCredentialIsExternal,
  claudeCredentialModeOf,
  claudeCredentialWritesBack,
  isClaudeCredentialMode,
  planClaudeCredentialConversion,
  resolveClaudeCredentialMode,
  withClaudeCredentialReference,
} from '../src/auth/claude-credential-ownership.js'
import { claudeReadOnlyUse, resolveClaudeReadOnlyCredential } from '../src/auth/claude-code-creds.js'
import type { ClaudeSourceCredential } from '../src/auth/claude-code-creds.js'
import {
  authFilePath,
  getAccountCredential,
  listAccounts,
  loadStore,
  saveAccountSession,
} from '../src/auth/store.js'
import type { ClaudeSession } from '../src/auth/store.js'
import { settle } from './claude-maintenance-fixtures.js'

after(async () => { await settle(4) })

/** Temporary roots removed when the file finishes; the private home is the launcher's own. */
const TEMP_DIRS: string[] = []

after(async () => {
  await settle(4)
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

/** A synthetic account key unique to one case. */
function uniqueAccount(label: string): string {
  return `${label}-${randomBytes(4).toString('hex')}@example.invalid`
}

/** A synthetic Claude session for one account. */
function sessionFor(account: string, overrides: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    accessToken: `at-${account}`,
    refreshToken: `rt-${account}`,
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:profile user:inference',
    emailAddress: account,
    ...overrides,
  }
}

/**
 * One private store file for a case that writes a document this build must refuse.
 *
 * A corrupt store is a property of one file, not of the run: keeping it here stops a case that
 * deliberately writes an unusable mode from deciding what every later case reads.
 * @param label - a name for the temporary directory.
 * @returns the store file path.
 */
function tempStore(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ownership-${label}-`))
  TEMP_DIRS.push(dir)
  return join(dir, 'auth.json')
}

/** Read the durable store's raw text. */
function storeText(): string {
  return readFileSync(authFilePath(), 'utf8')
}

/** Read one store file's raw text. */
function storeTextAt(path: string): string {
  return readFileSync(path, 'utf8')
}

/** Overwrite the durable store with a hand-built document, as an older build left it. */
function writeStore(document: unknown): void {
  mkdirSync(dirname(authFilePath()), { recursive: true })
  writeFileSync(authFilePath(), JSON.stringify(document, null, 2), { mode: 0o600 })
}

/** Overwrite one store file with a hand-built document, as an older build left it. */
function writeStoreAt(path: string, document: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(document, null, 2), { mode: 0o600 })
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

// ---------------------------------------------------------------------------
// The resolution matrix
// ---------------------------------------------------------------------------

test('a record with no mode and keychainBound === true reads as legacy-writeback', () => {
  assert.equal(resolveClaudeCredentialMode({ keychainBound: true }), 'legacy-writeback')
  const mode = resolveClaudeCredentialMode({ keychainBound: true })
  assert.equal(claudeCredentialIsExternal(mode), true, 'the credential has an external source')
  assert.equal(claudeCredentialWritesBack(mode), true, 'only this mode may write back')
  assert.equal(claudeCredentialArmsOwnTimer(mode), false, 'it is never rotated on this plugin\'s timer')
  assert.equal(claudeCredentialCoordinationUnproven(mode), true, 'and the coordination premise is unproven')
})

test('a record with no mode and no imported fact reads as independent-oauth', () => {
  assert.equal(resolveClaudeCredentialMode({}), 'independent-oauth')
  assert.equal(resolveClaudeCredentialMode({ keychainBound: false }), 'independent-oauth')
  const mode = resolveClaudeCredentialMode({})
  assert.equal(claudeCredentialIsExternal(mode), false)
  assert.equal(claudeCredentialWritesBack(mode), false, 'an independent credential never writes to a foreign store')
  assert.equal(claudeCredentialArmsOwnTimer(mode), true, 'it is the only mode with a proactive timer')
  assert.equal(claudeCredentialCoordinationUnproven(mode), false)
})

test('a stated mode outranks the imported fact in both directions', () => {
  assert.equal(
    resolveClaudeCredentialMode({ credentialOwnershipMode: 'read-only-import', keychainBound: true }),
    'read-only-import',
  )
  assert.equal(
    resolveClaudeCredentialMode({ credentialOwnershipMode: 'independent-oauth', keychainBound: true }),
    'independent-oauth',
  )
  assert.equal(
    resolveClaudeCredentialMode({ credentialOwnershipMode: 'legacy-writeback', keychainBound: false }),
    'legacy-writeback',
  )
  // The durable field is the one the resolver reads: a record stating its mode is that fact,
  // with no renamed copy to keep in step.
  assert.equal(claudeCredentialModeOf(sessionFor('field-name', {
    keychainBound: true,
    credentialOwnershipMode: 'read-only-import',
  })), 'read-only-import')
})

test('the mode vocabulary is the closed set the RPC and the store validate against', () => {
  assert.deepEqual([...CLAUDE_CREDENTIAL_MODES], ['legacy-writeback', 'read-only-import', 'independent-oauth'])
  for (const mode of CLAUDE_CREDENTIAL_MODES) assert.equal(isClaudeCredentialMode(mode), true)
  for (const value of [undefined, null, '', 'legacy', 'READ-ONLY-IMPORT', 0, {}]) {
    assert.equal(isClaudeCredentialMode(value), false, `${String(value)} is not a mode`)
  }
})

test('firstPartyOAuth is a route fact, not the ownership mode', () => {
  // The constant is what the policy eligibility reads; a mode can never flip it.
  assert.equal(CLAUDE_CREDENTIAL_IS_FIRST_PARTY_OAUTH, true)
})

// ---------------------------------------------------------------------------
// Conversion rules
// ---------------------------------------------------------------------------

test('the two external modes convert into each other', () => {
  for (const [from, to] of [
    ['read-only-import', 'legacy-writeback'],
    ['legacy-writeback', 'read-only-import'],
  ] as const) {
    assert.deepEqual(
      planClaudeCredentialConversion({ from, to, externallySourced: true }),
      { kind: 'ok' },
      `${from} -> ${to} is a setting`,
    )
  }
})

test('an imported token cannot be renamed into an independent authorization', () => {
  const plan = planClaudeCredentialConversion({
    from: 'read-only-import',
    to: 'independent-oauth',
    externallySourced: true,
  })
  assert.equal(plan.kind, 'refused')
  if (plan.kind !== 'refused') return
  assert.equal(plan.reason, 'independent-requires-login')
  assert.match(plan.message, /sign-in flow/)
})

test('an account this plugin authorized itself has no external store to move to', () => {
  const plan = planClaudeCredentialConversion({
    from: 'independent-oauth',
    to: 'legacy-writeback',
    externallySourced: false,
  })
  assert.equal(plan.kind, 'refused')
  if (plan.kind !== 'refused') return
  assert.equal(plan.reason, 'account-is-not-external')
})

test('an account with no external provenance is refused the legacy mode', () => {
  const plan = planClaudeCredentialConversion({
    from: 'read-only-import',
    to: 'legacy-writeback',
    externallySourced: false,
  })
  assert.equal(plan.kind, 'refused')
  if (plan.kind !== 'refused') return
  assert.equal(plan.reason, 'account-is-not-external')
})

test('re-requesting the current mode is a no-op, never a refused conversion', () => {
  for (const mode of CLAUDE_CREDENTIAL_MODES) {
    assert.deepEqual(
      planClaudeCredentialConversion({ from: mode, to: mode, externallySourced: false }),
      { kind: 'ok' },
      mode,
    )
  }
})

// ---------------------------------------------------------------------------
// Durability: what a stored record means across a restart
// ---------------------------------------------------------------------------

test('an explicit mode is persisted and survives a fresh read of the store', async () => {
  const account = uniqueAccount('explicit')
  await saveAccountSession('claude', account, sessionFor(account, {
    keychainBound: true,
    credentialOwnershipMode: 'read-only-import',
  }))
  // A fresh read is the restart: the durable file is the only input.
  const reread = (await loadStore()).claude?.accounts[account]
  assert.equal(reread?.credentialOwnershipMode, 'read-only-import')
  assert.equal(claudeCredentialModeOf(reread!), 'read-only-import', 'the stated value outranks keychainBound')
  assert.equal((await getAccountCredential('claude', account))?.session.credentialOwnershipMode, 'read-only-import')
})

test('a record written before the field existed keeps its inferred mode and is not rewritten', async () => {
  const account = uniqueAccount('legacy-record')
  await saveAccountSession('claude', account, sessionFor(account, { keychainBound: true }))
  const before = storeText()
  const read = await getAccountCredential('claude', account)
  assert.equal(read?.session.credentialOwnershipMode, undefined, 'no mode was written by the read')
  assert.equal(claudeCredentialModeOf(read!.session), 'legacy-writeback')
  await listAccounts('claude')
  assert.equal(storeText(), before, 'no background pass rewrites an existing account\'s mode or tokens')
})

test('an unknown persisted mode fails the read instead of falling back to an inferred one', async () => {
  const path = tempStore('unknown')
  const account = uniqueAccount('unknown')
  const session = sessionFor(account, { keychainBound: true })
  writeStoreAt(path, {
    claude: {
      default: account,
      accounts: { [account]: { ...session, credentialOwnershipMode: 'shared-grant' } },
    },
  })
  await assert.rejects(
    getAccountCredential('claude', account, path),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /credentialOwnershipMode/)
      assert.match(error.message, new RegExp(account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.match(error.message, /read-only-import/)
      return true
    },
  )
  // The failure is the whole answer for the read: no provider is reported from a mode this
  // build cannot interpret, and the caller never sees a guessed mode.
  await assert.rejects(listAccounts('claude', path))
})

test('an unknown mode is refused before the store is written, leaving the old bytes intact', async () => {
  const path = tempStore('unknown-write')
  const kept = uniqueAccount('kept')
  await saveAccountSession('claude', kept, sessionFor(kept), path)
  const before = storeTextAt(path)
  const account = uniqueAccount('unknown-write')
  await assert.rejects(
    saveAccountSession('claude', account, sessionFor(account, {
      // A value only a hand-edited caller could produce; the write path is as strict as the read.
      credentialOwnershipMode: 'shared-grant' as never,
    }), path),
    /credentialOwnershipMode/,
  )
  assert.equal(storeTextAt(path), before, 'the refused write replaced nothing')
  assert.equal(await getAccountCredential('claude', account, path), undefined, 'and stored no record')
  assert.equal(
    (await getAccountCredential('claude', kept, path))?.session.accessToken,
    `at-${kept}`,
    'the store it refused to damage still reads',
  )
})

test('another provider\'s records are untouched by the mode validation', async () => {
  const account = uniqueAccount('codex')
  writeStore({
    claude: { default: 'kept', accounts: { kept: sessionFor('kept') } },
    codex: {
      default: account,
      accounts: {
        [account]: {
          accessToken: 'at-codex',
          refreshToken: 'rt-codex',
          expiresAt: Date.now() + 3_600_000,
          accountId: 'workspace',
        },
      },
    },
  })
  const store = await loadStore()
  assert.equal(store.codex?.accounts[account]?.accessToken, 'at-codex')
  assert.equal(claudeCredentialModeOf(store.claude!.accounts['kept']!), 'independent-oauth')
})

// ---------------------------------------------------------------------------
// The read-only use contract
// ---------------------------------------------------------------------------

test('every read-only use adopts the source winner and reads the source again', () => {
  const account = uniqueAccount('read-only')
  const stored = sessionFor(account, {
    keychainBound: true,
    credentialOwnershipMode: 'read-only-import',
    accountUuid: 'uuid-1',
    deviceId: 'device-1',
  })
  let reads = 0
  let source = sessionFor(account, { accessToken: 'at-source-1', refreshToken: 'rt-source-1' })
  const readSource = (): ClaudeSourceCredential | undefined => { reads += 1; return sourceOf(source) }

  const first = resolveClaudeReadOnlyCredential(stored, readSource())
  assert.equal(first.accessToken, 'at-source-1', 'the source winner is served, not the stored copy')
  assert.equal(first.credentialOwnershipMode, 'read-only-import',
    'the record\'s mode rides along, so a persisted identity backfill cannot infer another one')
  assert.equal(first.keychainBound, true, 'and so does the imported fact')
  assert.equal(first.accountUuid, 'uuid-1', 'the confirmed identity stays with the account')
  assert.equal(first.deviceId, 'device-1', 'so a request does not re-run the identity backfill')
  assert.equal(reads, 1)

  source = sessionFor(account, { accessToken: 'at-source-2', refreshToken: 'rt-source-2' })
  assert.equal(resolveClaudeReadOnlyCredential(stored, readSource()).accessToken, 'at-source-2',
    'a rotation the external holder made is served next')
  assert.equal(reads, 2, 'the source is read on every use')
  assert.equal(stored.accessToken, `at-${account}`, 'nothing was written back into the stored record')
})

test('the reference fields a credential must not erase are one rule', () => {
  const reference = sessionFor('reference', {
    keychainBound: true,
    credentialOwnershipMode: 'legacy-writeback',
    accountUuid: 'uuid-1',
    deviceId: 'device-1',
  })
  const fetched = sessionFor('reference', { accessToken: 'at-grant', refreshToken: 'rt-grant' })
  const merged = withClaudeCredentialReference(reference, fetched)
  assert.equal(merged.accessToken, 'at-grant', 'the credential from elsewhere wins')
  assert.equal(merged.credentialOwnershipMode, 'legacy-writeback', 'the mode cannot be re-inferred')
  assert.equal(merged.keychainBound, true)
  assert.equal(merged.accountUuid, 'uuid-1')
  assert.equal(merged.deviceId, 'device-1')
  // A record that states none contributes nothing, so an unknown field is never invented.
  const bare = withClaudeCredentialReference(sessionFor('bare'), fetched)
  assert.equal(bare.credentialOwnershipMode, undefined)
  assert.equal(bare.keychainBound, undefined)
})

test('a missing read-only source stops the use without falling back to the stored token', () => {
  const account = uniqueAccount('read-only-missing')
  const stored = sessionFor(account, { keychainBound: true, credentialOwnershipMode: 'read-only-import' })
  assert.throws(
    () => resolveClaudeReadOnlyCredential(stored, undefined),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'INVALID_CREDENTIAL')
      assert.equal(error.failure.retryDisposition, 'forbid', 'no automatic resend may substitute another account')
      assert.match(error.message, /no longer holds a credential/)
      return true
    },
  )
})

test('an expired source reads as a re-login, not as a refreshable credential', () => {
  const account = uniqueAccount('read-only-expired')
  const stored = sessionFor(account, { keychainBound: true, credentialOwnershipMode: 'read-only-import' })
  for (const expired of [
    sessionFor(account, { expiresAt: Date.now() - 1 }),
    sessionFor(account, { expiresAt: Number.NaN }),
  ]) {
    assert.throws(
      () => resolveClaudeReadOnlyCredential(stored, sourceOf(expired)),
      (error: unknown) => {
        assert.ok(error instanceof LlmError)
        assert.equal(error.code, 'INVALID_CREDENTIAL')
        assert.equal(error.failure.retryDisposition, 'forbid')
        return true
      },
      String(expired.expiresAt),
    )
  }
})

test('the read-only scope gate judges what the source declared, never the recorded default', () => {
  const account = uniqueAccount('read-only-scope')
  const stored = sessionFor(account, { keychainBound: true, credentialOwnershipMode: 'read-only-import' })
  // The local record carries the pinned default set because the blob stated none; that must not
  // stand in for a source that declares no scope at all.
  const recorded = sessionFor(account, { scopes: 'user:profile user:inference' })
  const undeclared: ClaudeSourceCredential[] = [
    { session: recorded },
    { session: recorded, declaredScopes: '' },
    { session: recorded, declaredScopes: '   ' },
    { session: recorded, declaredScopes: 'user:profile' },
  ]
  for (const source of undeclared) {
    assert.throws(
      () => resolveClaudeReadOnlyCredential(stored, source),
      (error: unknown) => {
        assert.ok(error instanceof LlmError)
        assert.equal(error.code, 'INVALID_CREDENTIAL')
        assert.equal(error.failure.retryDisposition, 'forbid')
        assert.match(error.message, /user:inference/)
        return true
      },
      `declared ${JSON.stringify(source.declaredScopes)}`,
    )
  }
  // A source that does declare the capability is served.
  assert.equal(
    resolveClaudeReadOnlyCredential(stored, { session: recorded, declaredScopes: 'user:inference' }).accessToken,
    recorded.accessToken,
  )
})

test('a source this account cannot be confirmed against fails closed in every mode', () => {
  const account = uniqueAccount('read-only-foreign')
  const stored = sessionFor(account, { keychainBound: true, credentialOwnershipMode: 'read-only-import' })
  const foreign = sessionFor(account, { emailAddress: 'someone-else@example.invalid' })
  assert.throws(
    () => resolveClaudeReadOnlyCredential(stored, sourceOf(foreign)),
    (error: unknown) => error instanceof LlmError && error.code === 'CLAUDE_CREDENTIAL_SOURCE_CHANGED',
  )
})

test('the use-path hook answers only for a read-only account', async () => {
  const account = uniqueAccount('hook')
  let reads = 0
  const readSource = (): ClaudeSourceCredential | undefined => { reads += 1; return sourceOf(sessionFor(account)) }

  await saveAccountSession('claude', account, sessionFor(account))
  assert.equal(await claudeReadOnlyUse(account, readSource), undefined, 'an independent account keeps the manager path')
  assert.equal(reads, 0, 'and its source is never read')

  await saveAccountSession('claude', account, sessionFor(account, {
    keychainBound: true,
    credentialOwnershipMode: 'legacy-writeback',
  }))
  assert.equal(await claudeReadOnlyUse(account, readSource), undefined, 'a legacy account keeps the compatibility path')
  assert.equal(reads, 0)

  await saveAccountSession('claude', account, sessionFor(account, {
    keychainBound: true,
    credentialOwnershipMode: 'read-only-import',
  }))
  const served = await claudeReadOnlyUse(account, readSource)
  assert.equal(served?.accessToken, `at-${account}`, 'a read-only account is served from its source')
  assert.equal(reads, 1)

  assert.equal(await claudeReadOnlyUse(uniqueAccount('absent'), readSource), undefined, 'an unknown account has no mode')
})
