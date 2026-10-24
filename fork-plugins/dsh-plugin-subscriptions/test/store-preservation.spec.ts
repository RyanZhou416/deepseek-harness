/**
 * Credential preservation in the auth store.
 *
 * A credential may disappear only through an explicit `deleteAccountSession`
 * (the Settings logout). Every other path — a read, a status fan-out, a token
 * refresh, a migration, an unrelated provider's write — must leave every
 * provider and account entry the file holds, including entries this build
 * cannot parse. Where both values cannot coexist in the file, the write is
 * refused and the file stays byte-for-byte as it was.
 *
 * Each test uses its own temp path, so nothing here depends on `$DSH_HOME` or
 * touches a developer's real store.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  accountKeyOf,
  deleteAccountSession,
  getAccountSession,
  listAccounts,
  loadStore,
  resolveAccountKey,
  saveAccountSession,
} from '../src/auth/store.js'
import type { ClaudeSession, CodexSession, GrokSession } from '../src/auth/store.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { LlmError } from '@deepseek-ai/dsh-llm'

const TEMP_DIRS: string[] = []

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

/** A store path inside a temp directory removed when the file finishes. */
function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'store-preservation-'))
  TEMP_DIRS.push(dir)
  return join(dir, 'auth.json')
}

/** Write one JSON store fixture. */
function writeStore(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 })
}

/** The store file's exact bytes. */
function storeText(path: string): string {
  return readFileSync(path, 'utf8')
}

/** The parsed store file. */
function readStore(path: string): Record<string, unknown> {
  return JSON.parse(storeText(path)) as Record<string, unknown>
}

const CODEX: CodexSession = {
  accessToken: 'codex-at',
  refreshToken: 'codex-rt',
  expiresAt: Date.now() + 3_600_000,
  accountId: 'acct-1',
}

const CLAUDE: ClaudeSession = {
  accessToken: 'claude-at',
  refreshToken: 'claude-rt',
  expiresAt: Date.now() + 3_600_000,
  scopes: 'user:inference',
  emailAddress: 'alice@example.com',
}

const GROK: GrokSession = {
  accessToken: 'grok-at',
  refreshToken: 'grok-rt',
  expiresAt: Date.now() + 3_600_000,
  tokenEndpoint: 'https://auth.example.test/token',
  account: 'alice@example.com',
}

const EMPTY_TOKENS = { accessToken: '', refreshToken: '', expiresAt: 0 }

test('a malformed Claude account survives a Codex status read and write verbatim', async () => {
  const path = storePath()
  const malformed = { ...EMPTY_TOKENS, note: 'kept because it cannot be parsed' }
  writeStore(path, {
    codex: { default: 'acct-1', accounts: { 'acct-1': CODEX } },
    claude: { default: 'broken@example.com', accounts: { 'broken@example.com': malformed } },
  })

  // The status read fans out to every provider and reports only what it can use.
  assert.equal((await listAccounts('codex', path)).length, 1)
  assert.equal((await listAccounts('claude', path)).length, 0)

  await saveAccountSession('codex', 'acct-1', { ...CODEX, accessToken: 'codex-at-2' }, path)

  const disk = readStore(path)
  assert.deepEqual(
    (disk.claude as { accounts: Record<string, unknown> }).accounts['broken@example.com'],
    malformed,
    'the Claude account this build cannot parse is still on disk, field for field',
  )
  assert.equal(
    (disk.codex as { accounts: Record<string, ClaudeSession> }).accounts['acct-1'].accessToken,
    'codex-at-2',
    'the write that triggered the rewrite still landed',
  )
})

test('a malformed top-level provider value is preserved through an unrelated write', async () => {
  const path = storePath()
  writeStore(path, {
    codex: { default: 'acct-1', accounts: { 'acct-1': CODEX } },
    claude: 'not-an-object',
    antigravity: { accounts: 'not-a-map' },
    // A provider this build does not know at all.
    futureprovider: { default: 'x', accounts: { x: { accessToken: 'future-at', refreshToken: 'future-rt' } } },
    mystery: { number: 42 },
  })

  await saveAccountSession('codex', 'acct-1', CODEX, path)

  const disk = readStore(path)
  assert.equal(disk.claude, 'not-an-object')
  assert.deepEqual(disk.antigravity, { accounts: 'not-a-map' })
  assert.deepEqual(disk.futureprovider, {
    default: 'x',
    accounts: { x: { accessToken: 'future-at', refreshToken: 'future-rt' } },
  })
  assert.deepEqual(disk.mystery, { number: 42 })
})

test('an empty accounts map and its provider fields survive an unrelated write', async () => {
  const path = storePath()
  const emptyProvider = { default: 'gone@example.com', accounts: {}, note: 'provider metadata' }
  writeStore(path, {
    codex: { default: 'acct-1', accounts: { 'acct-1': CODEX } },
    claude: emptyProvider,
  })

  await saveAccountSession('codex', 'acct-1', CODEX, path)

  assert.deepEqual(readStore(path).claude, emptyProvider)
})

test('a valid Claude login lands beside a corrupt sibling instead of replacing it', async () => {
  const path = storePath()
  const malformed = { ...EMPTY_TOKENS, legacyNote: 'corrupt import' }
  writeStore(path, {
    claude: { default: 'broken@example.com', accounts: { 'broken@example.com': malformed } },
  })

  await saveAccountSession('claude', 'alice@example.com', CLAUDE, path)

  const disk = readStore(path) as {
    claude: { default: string; accounts: Record<string, unknown> }
  }
  assert.deepEqual(disk.claude.accounts['broken@example.com'], malformed)
  assert.deepEqual(disk.claude.accounts['alice@example.com'], CLAUDE)
  assert.equal(disk.claude.default, 'alice@example.com', 'the usable account becomes the default')
  assert.equal((await getAccountSession('claude', 'alice@example.com', path))?.accessToken, 'claude-at')
})

test('an account entry with an unusable ownership mode is preserved, never dropped', async () => {
  const path = storePath()
  const malformed = { ...EMPTY_TOKENS, credentialOwnershipMode: 'made-up-mode' }
  writeStore(path, {
    codex: { default: 'acct-1', accounts: { 'acct-1': CODEX } },
    claude: { default: 'broken@example.com', accounts: { 'broken@example.com': malformed } },
  })

  await saveAccountSession('codex', 'acct-1', CODEX, path)

  assert.deepEqual(
    (readStore(path).claude as { accounts: Record<string, unknown> }).accounts['broken@example.com'],
    malformed,
  )
})

test('an ownership mode this build does not implement refuses every write and leaves the file untouched', async () => {
  const path = storePath()
  writeStore(path, {
    codex: { default: 'acct-1', accounts: { 'acct-1': CODEX } },
    claude: {
      default: 'alice@example.com',
      accounts: { 'alice@example.com': { ...CLAUDE, credentialOwnershipMode: 'made-up-mode' } },
    },
  })
  const before = storeText(path)

  await assert.rejects(loadStore(path), /credentialOwnershipMode/)
  await assert.rejects(
    saveAccountSession('codex', 'acct-1', { ...CODEX, accessToken: 'codex-at-2' }, path),
    /credentialOwnershipMode/,
    'the write path refuses to replace the file with a store it cannot read back',
  )
  assert.equal(storeText(path), before, 'the file was not touched')
})

test('a permanent refresh failure leaves the stored credential for an explicit logout', async () => {
  const path = storePath()
  const expired: ClaudeSession = { ...CLAUDE, expiresAt: Date.now() - 60_000, accessToken: 'expired-at' }
  await saveAccountSession('claude', 'alice@example.com', expired, path)
  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Claude',
    makeOptions: () => ({
      preemptMs: 0,
      refresh: () => Promise.reject(new Error('invalid_grant')),
      isPermanent: () => true,
    }),
    io: {
      list: () => listAccounts('claude', path),
      get: account => getAccountSession('claude', account, path),
      save: async (account, value) => {
        await saveAccountSession('claude', account, value, path)
      },
      remove: async account => deleteAccountSession('claude', account, path),
      resolve: account => resolveAccountKey('claude', account, path),
    },
  })

  await assert.rejects(
    tokens.session('alice@example.com'),
    (error: unknown) => error instanceof LlmError && error.code === 'INVALID_CREDENTIAL',
  )
  assert.deepEqual(
    await getAccountSession('claude', 'alice@example.com', path),
    expired,
    'the tokens are not deleted or blanked by the refresh failure',
  )
  assert.equal((await listAccounts('claude', path)).length, 1, 'the account stays listed until an explicit logout')

  // The only removal path is the explicit one, and it still works.
  assert.equal(await deleteAccountSession('claude', 'alice@example.com', path), true)
  assert.equal(await getAccountSession('claude', 'alice@example.com', path), undefined)
})

test('an explicit logout removes that account and keeps a corrupt sibling', async () => {
  const path = storePath()
  const malformed = { ...EMPTY_TOKENS, note: 'keep me' }
  writeStore(path, {
    claude: {
      default: 'alice@example.com',
      accounts: {
        'alice@example.com': { ...CLAUDE, emailAddress: 'alice@example.com' },
        'broken@example.com': malformed,
      },
    },
  })

  assert.equal(await deleteAccountSession('claude', 'alice@example.com', path), true)

  const disk = readStore(path) as { claude: { accounts: Record<string, unknown> } }
  assert.equal(disk.claude.accounts['alice@example.com'], undefined, 'the explicit removal deleted its account')
  assert.deepEqual(disk.claude.accounts['broken@example.com'], malformed, 'the corrupt sibling is untouched')

  // Removing the last usable account of a provider with no corrupt sibling removes the entry.
  const clean = storePath()
  await saveAccountSession('claude', 'alice@example.com', CLAUDE, clean)
  await deleteAccountSession('claude', 'alice@example.com', clean)
  assert.equal(readStore(clean).claude, undefined)
})

test('a single-account store migrates without losing unknown fields', async () => {
  const path = storePath()
  const futureSession = { ...CODEX, emailAddress: 'alice@example.com', futureField: { nested: [1, 2, 3] } }
  writeStore(path, {
    codex: futureSession,
    mystery: { untouched: true },
  })

  // Reading migrates the legacy shape in memory; the write persists it.
  await saveAccountSession('codex', accountKeyOf('codex', futureSession), futureSession, path)

  const disk = readStore(path) as {
    codex: { default: string; accounts: Record<string, unknown> }
    mystery: unknown
  }
  const key = accountKeyOf('codex', futureSession)
  assert.equal(disk.codex.default, key)
  assert.deepEqual(disk.codex.accounts[key], futureSession, 'the migrated account keeps every unknown field')
  assert.deepEqual(disk.mystery, { untouched: true }, 'an unknown top-level entry survives the migration')
})

test('unknown provider metadata and revision tombstones survive a write', async () => {
  const path = storePath()
  writeStore(path, {
    codex: {
      default: 'acct-1',
      accounts: { 'acct-1': { ...CODEX, futureAccountField: 'keep' } },
      note: 'provider metadata',
      futureProviderField: { enabled: true },
    },
    revisions: {
      claude: { 'gone@example.com': 7 },
      futureprovider: { 'x': 3 },
    },
  })

  await saveAccountSession('codex', 'acct-2', { ...CODEX, accountId: 'acct-2' }, path)
  await saveAccountSession('grok', 'alice@example.com', GROK, path)

  const disk = readStore(path) as {
    codex: { note: string; futureProviderField: unknown; accounts: Record<string, unknown> }
    revisions: Record<string, Record<string, number>>
  }
  assert.equal(disk.codex.note, 'provider metadata')
  assert.deepEqual(disk.codex.futureProviderField, { enabled: true })
  assert.deepEqual(disk.codex.accounts['acct-1'], { ...CODEX, futureAccountField: 'keep' })
  assert.deepEqual(disk.revisions.claude, { 'gone@example.com': 7 })
  assert.deepEqual(disk.revisions.futureprovider, { x: 3 })
})

test('a provider entry that cannot be merged with a new login refuses the write and keeps the file', async () => {
  const path = storePath()
  writeStore(path, { claude: 'not-an-object', codex: { default: 'acct-1', accounts: { 'acct-1': CODEX } } })
  const before = storeText(path)

  await assert.rejects(
    saveAccountSession('claude', 'alice@example.com', CLAUDE, path),
    /refus|preserv|cannot be written/i,
    'the scalar value and an accounts entry cannot both be written, so nothing is',
  )
  assert.equal(storeText(path), before)

  const legacy = storePath()
  const unusableLegacy = { accessToken: '', refreshToken: '', expiresAt: 0, marker: 'keep' }
  writeStore(legacy, { claude: unusableLegacy })
  const legacyBefore = storeText(legacy)
  await assert.rejects(
    saveAccountSession('claude', 'alice@example.com', CLAUDE, legacy),
    /refus|preserv|cannot be written/i,
  )
  assert.equal(storeText(legacy), legacyBefore)
})

test('an unreadable store file is never replaced: structurally broken JSON stays put', async () => {
  const path = storePath()
  writeFileSync(path, '{"claude": ', { mode: 0o600 })
  const before = storeText(path)

  await assert.rejects(loadStore(path), /not valid JSON/)
  await assert.rejects(saveAccountSession('claude', 'alice@example.com', CLAUDE, path), /not valid JSON/)
  assert.equal(storeText(path), before)

  const arrayPath = storePath()
  writeFileSync(arrayPath, '[]', { mode: 0o600 })
  const arrayBefore = storeText(arrayPath)
  await assert.rejects(loadStore(arrayPath), /must be a JSON object/)
  await assert.rejects(saveAccountSession('claude', 'alice@example.com', CLAUDE, arrayPath), /must be a JSON object/)
  assert.equal(storeText(arrayPath), arrayBefore)
})

test('concurrent writes each preserve the malformed entries another started from', async () => {
  const path = storePath()
  const malformed = { ...EMPTY_TOKENS, note: 'concurrent' }
  writeStore(path, {
    codex: { default: 'acct-1', accounts: { 'acct-1': CODEX } },
    claude: { default: 'broken@example.com', accounts: { 'broken@example.com': malformed } },
  })

  await Promise.all([
    saveAccountSession('codex', 'acct-1', { ...CODEX, accessToken: 'codex-at-2' }, path),
    saveAccountSession('grok', 'alice@example.com', GROK, path),
    saveAccountSession('copilot', 'alice', {
      accessToken: 'copilot-at', refreshToken: 'copilot-rt', expiresAt: Date.now() + 3_600_000, account: 'alice',
    }, path),
  ])

  const disk = readStore(path)
  assert.deepEqual(
    (disk.claude as { accounts: Record<string, unknown> }).accounts['broken@example.com'],
    malformed,
    'no overlapping write dropped the unparseable entry',
  )
  assert.equal((disk.codex as { accounts: Record<string, ClaudeSession> }).accounts['acct-1'].accessToken, 'codex-at-2')
  assert.ok(disk.grok !== undefined)
  assert.ok(disk.copilot !== undefined)
})

test('a status read does not rewrite a store whose entries it cannot parse', async () => {
  const path = storePath()
  writeStore(path, {
    codex: { default: 'acct-1', accounts: { 'acct-1': CODEX } },
    claude: { default: 'broken@example.com', accounts: { 'broken@example.com': EMPTY_TOKENS } },
  })
  const before = storeText(path)

  await Promise.all([listAccounts('codex', path), listAccounts('claude', path), listAccounts('grok', path)])

  assert.equal(storeText(path), before)
})

test('a write keeps the previous generation in .bak before replacing the live file', async () => {
  const path = storePath()
  await saveAccountSession('claude', 'alice@example.com', CLAUDE, path)
  const first = storeText(path)

  await saveAccountSession('claude', 'alice@example.com', { ...CLAUDE, accessToken: 'claude-at-2' }, path)

  assert.equal(readFileSync(`${path}.bak`, 'utf8'), first, '.bak holds the generation the write replaced')
  assert.equal(
    (readStore(path).claude as { accounts: Record<string, ClaudeSession> }).accounts['alice@example.com'].accessToken,
    'claude-at-2',
  )
})

test('a write that cannot keep its backup fails and leaves the live file untouched', async () => {
  const path = storePath()
  await saveAccountSession('claude', 'alice@example.com', CLAUDE, path)
  const before = storeText(path)
  // A directory where the backup file must go makes the backup step fail. The live store must
  // survive that, because a write without a recovery copy is the write this guards against.
  mkdirSync(`${path}.bak`)

  await assert.rejects(
    saveAccountSession('claude', 'alice@example.com', { ...CLAUDE, accessToken: 'claude-at-2' }, path),
  )
  assert.equal(storeText(path), before)
})

test('a store lock held by another process fails the write and leaves the file untouched', async () => {
  const path = storePath()
  await saveAccountSession('claude', 'alice@example.com', CLAUDE, path)
  const before = storeText(path)
  mkdirSync(`${path}.lock`)
  writeFileSync(`${path}.lock/owner`, 'another-process')

  await assert.rejects(
    saveAccountSession('claude', 'alice@example.com', { ...CLAUDE, accessToken: 'claude-at-2' }, path),
    /holds the store lock/,
    'a write never degrades to running unowned',
  )
  assert.equal(storeText(path), before)
})

test('a refresh result that cannot be stored is reported and never answered with the stale session', async () => {
  const path = storePath()
  // Still valid, but inside the preempt window: a transient failure would otherwise fall back to
  // this token. The refresh was spent, so answering with it is unsafe.
  const stored: ClaudeSession = { ...CLAUDE, expiresAt: Date.now() + 30_000 }
  await saveAccountSession('claude', 'alice@example.com', stored, path)
  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Claude',
    makeOptions: () => ({
      preemptMs: 60_000,
      refresh: async current => ({
        ...current,
        accessToken: 'claude-at-refreshed',
        refreshToken: 'claude-rt-refreshed',
        expiresAt: Date.now() + 3_600_000,
      }),
      isPermanent: () => false,
    }),
    io: {
      list: () => listAccounts('claude', path),
      get: account => getAccountSession('claude', account, path),
      save: async () => {
        throw new Error('the store is not writable')
      },
      remove: async account => deleteAccountSession('claude', account, path),
      resolve: account => resolveAccountKey('claude', account, path),
    },
  })

  await assert.rejects(
    tokens.session('alice@example.com'),
    (error: unknown) => error instanceof LlmError && error.code === 'CREDENTIAL_NOT_PERSISTED',
  )
  assert.deepEqual(
    await getAccountSession('claude', 'alice@example.com', path),
    stored,
    'the token the store held is unchanged; the unpersisted rotation was not silently dropped',
  )
})

test('a provider whose default is not a string is preserved through an unrelated write', async () => {
  const path = storePath()
  const malformed = {
    default: 42,
    accounts: { 'alice@example.com': CLAUDE },
    note: 'provider metadata',
  }
  writeStore(path, {
    codex: { default: 'acct-1', accounts: { 'acct-1': CODEX } },
    claude: malformed,
  })

  await saveAccountSession('codex', 'acct-1', CODEX, path)

  assert.deepEqual(readStore(path).claude, malformed)
})

test('a provider carrying both a bare session and an accounts map is preserved, never half-read', async () => {
  const path = storePath()
  const hybrid = {
    accessToken: 'legacy-at',
    refreshToken: 'legacy-rt',
    expiresAt: Date.now() + 3_600_000,
    note: 'both shapes',
    accounts: { 'alice@example.com': CLAUDE },
  }
  writeStore(path, { claude: hybrid, codex: { default: 'acct-1', accounts: { 'acct-1': CODEX } } })

  await saveAccountSession('codex', 'acct-1', CODEX, path)
  assert.deepEqual(readStore(path).claude, hybrid)

  const before = storeText(path)
  await assert.rejects(
    saveAccountSession('claude', 'bob@example.com', { ...CLAUDE, emailAddress: 'bob@example.com' }, path),
    /refus|preserv|cannot be written/i,
    'a new account cannot be written beside the ambiguous value without deciding which half wins',
  )
  assert.equal(storeText(path), before)
})

test('the pre-rename store is retired only after the migrated file carries every entry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'store-migration-'))
  TEMP_DIRS.push(root)
  const home = join(root, 'home')
  const legacyPath = join(home, 'plugins', 'router', 'auth.json')
  mkdirSync(join(home, 'plugins', 'router'), { recursive: true })
  const legacy = {
    codex: { ...CODEX, emailAddress: 'alice@example.com' },
    claude: { accounts: { 'broken@example.com': { ...EMPTY_TOKENS, note: 'keep' } } },
    mystery: { keep: true },
  }
  writeFileSync(legacyPath, JSON.stringify(legacy))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // The default path has no file yet, so this read migrates the pre-rename store.
    await saveAccountSession('codex', 'acct-1', CODEX)
    const newPath = join(home, 'plugins', 'subscriptions', 'auth.json')
    const disk = readStore(newPath)
    assert.deepEqual(disk.mystery, { keep: true }, 'an unknown top-level entry survives the migration')
    assert.deepEqual(
      (disk.claude as { accounts: Record<string, unknown> }).accounts['broken@example.com'],
      { ...EMPTY_TOKENS, note: 'keep' },
      'the unreadable account survives the migration',
    )
    assert.equal(existsSync(legacyPath), false, 'the pre-rename file is retired after the new file is verified')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})
