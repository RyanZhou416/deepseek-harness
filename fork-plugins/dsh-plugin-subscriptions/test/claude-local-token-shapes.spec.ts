/**
 * Claude Code credential document shapes read from `.credentials.json`.
 *
 * The document-level shapes the reader must reject without throwing — a JSON root that is
 * `null`, an array, a primitive, or malformed — so `login('claude')` can fall back to the
 * browser flow instead of failing with an internal error. Valid wrapped / flat / already-expired
 * tuples are the negative controls that must keep importing, and the scope mapping is locked so
 * this fix cannot silently move it.
 *
 * Every read uses a private temporary `CLAUDE_CONFIG_DIR`. The real harness home, the user's
 * `~/.claude/.credentials.json` and the macOS Keychain are never touched: the darwin reader
 * consults the Keychain first and this suite exercises the file branch only, so every case is
 * skipped on darwin rather than running `/usr/bin/security`. `readClaudeCodeCredentials` exposes
 * no path parameter, so that environment variable is the only available seam.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import './keep-alive.js'
import { readClaudeCodeCredentials } from '../src/auth/claude-code-creds.js'

/** The reader's own fallback when a document carries no usable `scopes`. */
const DEFAULT_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers'

/** A complete, obviously synthetic tuple; `expiresAt` is far in the future. */
const TUPLE = { accessToken: 'shape-at', refreshToken: 'shape-rt', expiresAt: 4_102_444_800_000 }

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
 * The darwin reader answers from the Keychain before it ever looks at the file, and this suite
 * must not invoke `/usr/bin/security`, so the platform difference is documented here instead of
 * being exercised with a synthetic Keychain entry.
 */
const fileStoreOnly: { skip?: string } = process.platform === 'darwin'
  ? { skip: 'the darwin reader consults the Keychain first; this suite covers the file branch without running /usr/bin/security' }
  : {}

/**
 * Write one synthetic document into its own private directory and read it back.
 * @param raw - the file's text, or `undefined` to leave the file absent.
 * @returns what the reader reported.
 */
function readDocument(raw: string | undefined): ReturnType<typeof readClaudeCodeCredentials> {
  const dir = tempDir('claude-shapes-')
  if (raw !== undefined) writeFileSync(join(dir, '.credentials.json'), raw, { mode: 0o600 })
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  try {
    return readClaudeCodeCredentials()
  } finally {
    restoreEnv('CLAUDE_CONFIG_DIR', saved)
  }
}

// ---------------------------------------------------------------------------
// Documents with no usable root object
// ---------------------------------------------------------------------------

test('a JSON root that is not an object reports no credentials instead of throwing', fileStoreOnly, () => {
  const roots = [
    'null',
    '  null  ',
    '[]',
    '[{"accessToken":"array-at","refreshToken":"array-rt","expiresAt":4102444800000}]',
    '"bare-access-token"',
    '42',
    'true',
  ]
  for (const raw of roots) {
    assert.equal(readDocument(raw), undefined, `root ${JSON.stringify(raw)} must report no credentials`)
  }
})

test('malformed and empty documents report no credentials', fileStoreOnly, () => {
  for (const raw of ['{not json!!!', '', '   ', '{"claudeAiOauth":']) {
    assert.equal(readDocument(raw), undefined, `document ${JSON.stringify(raw)} must report no credentials`)
  }
})

test('a missing credentials file reports no credentials', fileStoreOnly, () => {
  assert.equal(readDocument(undefined), undefined)
})

// ---------------------------------------------------------------------------
// Negative controls: the shapes that must keep importing
// ---------------------------------------------------------------------------

test('a valid wrapped tuple still imports', fileStoreOnly, () => {
  const session = readDocument(JSON.stringify({
    claudeOauthAccount: { emailAddress: 'shape@example.test' },
    claudeAiOauth: {
      ...TUPLE,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      emailAddress: 'shape@example.test',
    },
  }))
  assert.equal(session?.accessToken, TUPLE.accessToken)
  assert.equal(session?.refreshToken, TUPLE.refreshToken)
  assert.equal(session?.expiresAt, TUPLE.expiresAt)
  assert.equal(session?.scopes, 'user:profile user:inference')
  assert.equal(session?.emailAddress, 'shape@example.test')
  assert.equal(session?.subscriptionType, 'max')
})

test('a valid flat tuple still imports', fileStoreOnly, () => {
  const session = readDocument(JSON.stringify(TUPLE))
  assert.equal(session?.accessToken, TUPLE.accessToken)
  assert.equal(session?.refreshToken, TUPLE.refreshToken)
  assert.equal(session?.scopes, DEFAULT_SCOPES)
})

test('an already-expired tuple still imports: expiry is not a read gate', fileStoreOnly, () => {
  const session = readDocument(JSON.stringify({ ...TUPLE, expiresAt: 0 }))
  assert.equal(session?.accessToken, TUPLE.accessToken)
  assert.equal(session?.expiresAt, 0)
})

test('a nested null still falls back to the wrapper fields', fileStoreOnly, () => {
  const session = readDocument(JSON.stringify({ ...TUPLE, claudeAiOauth: null }))
  assert.equal(session?.accessToken, TUPLE.accessToken)
})

test('a nested object still wins over flat fields', fileStoreOnly, () => {
  const session = readDocument(JSON.stringify({
    ...TUPLE,
    claudeAiOauth: { accessToken: 'nested-at', refreshToken: 'nested-rt', expiresAt: TUPLE.expiresAt },
  }))
  assert.equal(session?.accessToken, 'nested-at')
})

test('an incomplete tuple is still rejected', fileStoreOnly, () => {
  assert.equal(readDocument(JSON.stringify({ accessToken: 'only-access' })), undefined)
  assert.equal(readDocument(JSON.stringify({ claudeAiOauth: { ...TUPLE, refreshToken: '' } })), undefined)
  assert.equal(readDocument(JSON.stringify({
    claudeAiOauth: { accessToken: TUPLE.accessToken, refreshToken: TUPLE.refreshToken },
  })), undefined)
})

// ---------------------------------------------------------------------------
// Scope mapping: locked, not changed by this fix
// ---------------------------------------------------------------------------

test('scope sourcing keeps its current mapping', fileStoreOnly, () => {
  const withScopes = (scopes?: unknown) => readDocument(JSON.stringify({
    claudeAiOauth: { ...TUPLE, ...scopes === undefined ? {} : { scopes } },
  }))
  assert.equal(withScopes(undefined)?.scopes, DEFAULT_SCOPES)
  assert.equal(withScopes(['user:profile', 'user:inference'])?.scopes, 'user:profile user:inference')
  // Locked current behavior: an empty array maps to an empty scope string rather than the
  // default. The target's own refresh falls back to its default scope list for an empty array
  // (phase9 first-party-token-refresh.txt), so this remains a recorded divergence between the
  // reader and the target — not something the null-root fix changes.
  assert.equal(withScopes([])?.scopes, '')
  assert.equal(withScopes(42)?.scopes, DEFAULT_SCOPES)
})
