/**
 * The explicit usage-refresh trace is diagnostic evidence: it must record the
 * safe cache outcome and must never carry a provider message, token, or body.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendUsageRefreshTrace, formatUsageRefreshTrace } from '../src/providers/usage-refresh-log.js'

test('usage refresh trace: serializes only fixed safe facts', () => {
  const trace = {
    at: 1_700_000_000_000,
    provider: 'claude',
    account: 'trace-test@example.invalid',
    mode: 'force' as const,
    phase: 'error' as const,
    durationMs: 12.4,
    state: 'error',
    reason: 'unauthorized',
    status: 401,
    code: 'invalid_grant',
    errorCode: 'AUTH',
  }
  const parsed = JSON.parse(formatUsageRefreshTrace(trace))
  assert.deepEqual(parsed, {
    v: 1,
    at: 1_700_000_000_000,
    provider: 'claude',
    account: 'trace-test@example.invalid',
    mode: 'force',
    phase: 'error',
    durationMs: 12,
    state: 'error',
    reason: 'unauthorized',
    status: 401,
    code: 'invalid_grant',
    errorCode: 'AUTH',
  })
  assert.equal(
    formatUsageRefreshTrace({
      at: trace.at,
      provider: trace.provider,
      account: trace.account,
      mode: trace.mode,
      phase: 'start',
      code: '<raw-secret>',
    }),
    '{"v":1,"at":1700000000000,"provider":"claude","account":"trace-test@example.invalid","mode":"force","phase":"start"}\n',
  )
})

test('usage refresh trace: appends JSON lines and creates the parent directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-usage-refresh-log-'))
  const file = join(directory, 'nested', 'usage-refresh.log')
  try {
    await appendUsageRefreshTrace(file, {
      at: 1,
      provider: 'claude',
      account: 'trace-test@example.invalid',
      mode: 'force',
      phase: 'ok',
      state: 'fresh',
    })
    await appendUsageRefreshTrace(file, {
      at: 2,
      provider: 'claude',
      account: 'trace-test@example.invalid',
      mode: 'force',
      phase: 'error',
      errorCode: 'AUTH',
    })
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0] ?? '').phase, 'ok')
    assert.equal(JSON.parse(lines[1] ?? '').errorCode, 'AUTH')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
