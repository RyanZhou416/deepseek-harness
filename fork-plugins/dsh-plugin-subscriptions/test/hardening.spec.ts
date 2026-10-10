/**
 * Contracts at the provider boundary: the OAuth endpoint override stays on https, a provider
 * error message carries the provider's own structured fields instead of raw body text, the
 * Codex search provider claims the shared web_search seam only with an account behind it, and
 * the transport child runs with a curated environment rather than the host's.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { httpLlmError } from '../src/providers/common.js'
import { CLAUDE_AUTHORIZE_URL, CLAUDE_TOKEN_URL } from '../src/providers/claude.js'
import { CodexWebSearchProvider } from '../src/providers/codex-search.js'
import { childEnvironment } from '../src/transport/bridge.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..', '..')

test('the OAuth endpoint override refuses anything but https', () => {
  // Importing the module is what reads the variable, so this runs in a child process.
  const program = "import('./src/providers/claude.js').then(() => process.exit(0), (error) => { console.error(error.message); process.exit(3) })"
  let failed = false
  try {
    execFileSync(process.execPath, ['--import', 'tsx/esm', '-e', program], {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, CLAUDE_CODE_CUSTOM_OAUTH_URL: 'http://attacker.invalid/oauth' },
      stdio: 'pipe',
    })
  } catch (error) {
    failed = true
    const stderr = String((error as { stderr?: Buffer }).stderr ?? '')
    assert.match(stderr, /must use https/, 'the refusal names the reason')
  }
  assert.equal(failed, true, 'an http endpoint is refused at load')
  assert.match(CLAUDE_TOKEN_URL, /^https:\/\//)
  assert.match(CLAUDE_AUTHORIZE_URL, /^https:\/\//)
})

test('a provider error message carries structured fields, never the raw body', async () => {
  const body = JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'max_tokens: 300000 > 64000' },
    echoed: 'sk-ant-SECRET-PLANTED',
  })
  const response = new Response(body, { status: 400, headers: { 'content-type': 'application/json' } })
  const error = await httpLlmError(response, 'claude API')
  assert.match(error.message, /HTTP 400/)
  assert.match(error.message, /invalid_request_error: max_tokens: 300000 > 64000/)
  assert.equal(error.message.includes('SECRET-PLANTED'), false, 'the message never carries raw body text')
  assert.match(String((error.cause as Error | undefined)?.message), /SECRET-PLANTED/, 'the body rides the cause')
})

test('a non-JSON gateway body still reports the status without quoting itself', async () => {
  const response = new Response('<html>502 Bad Gateway sk-ant-SECRET-PLANTED</html>', { status: 502 })
  const error = await httpLlmError(response, 'claude API')
  assert.match(error.message, /HTTP 502/)
  assert.equal(error.message.includes('SECRET-PLANTED'), false)
  assert.equal(error.code, 'SERVER')
})

test('the search provider only announces itself when a Codex account can serve it', () => {
  const tokens = { session: async () => { throw new Error('unused') } }
  const withAccount = new CodexWebSearchProvider({ tokens: tokens as never, hasAccount: () => true })
  const without = new CodexWebSearchProvider({ tokens: tokens as never, hasAccount: () => false })
  const unknown = new CodexWebSearchProvider({ tokens: tokens as never })
  const disabled = new CodexWebSearchProvider({
    tokens: tokens as never,
    hasAccount: () => true,
    enabled: () => false,
  })
  assert.equal(withAccount.available(), true)
  assert.equal(without.available(), false, 'no account means no claim on the shared seam')
  assert.equal(unknown.available(), false, 'an unknown account state is not a claim either')
  assert.equal(disabled.available(), false, 'the user switch still wins')
})

test('the transport child gets process basics, proxies and trust anchors only', () => {
  const kept = childEnvironment({
    PATH: '/usr/bin',
    HOME: '/home/u',
    SystemRoot: 'C:\\Windows',
    HTTPS_PROXY: 'http://127.0.0.1:7897',
    https_proxy: 'http://127.0.0.1:7897',
    NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
    AWS_SECRET_ACCESS_KEY: 'secret',
    GITHUB_TOKEN: 'secret',
    NODE_OPTIONS: '--max-old-space-size=4096',
    DSH_SUBSCRIPTIONS_BRIDGE: 'on',
    ANTHROPIC_API_KEY: 'sk-ant-SECRET-PLANTED',
  })
  assert.equal(kept['PATH'], '/usr/bin')
  assert.equal(kept['SystemRoot'], 'C:\\Windows')
  assert.equal(kept['HTTPS_PROXY'], 'http://127.0.0.1:7897')
  assert.equal(kept['NODE_EXTRA_CA_CERTS'], '/etc/ca.pem')
  for (const dropped of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY']) {
    assert.equal(dropped in kept, false, `${dropped} must not reach the child`)
  }
  assert.equal(Object.values(kept).includes('secret'), false)
})
