/**
 * The durable pending-refresh journal beside the auth store.
 *
 * A refresh spends a single-use grant, so the credential it mints must survive a crash at every
 * point between the request and the store write. These cases inject a failure at each step:
 * before the request, after the response before the journal record, after the record before the
 * store save, and after the save before the marker is cleared. They also cover restart recovery,
 * the marker's on-disk form and permissions, and the lock that keeps two writers apart.
 *
 * Every case uses its own temp store path; nothing here depends on `$DSH_HOME` or touches a
 * developer's real store.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  beginPendingRefreshRotation,
  completePendingRefreshRotation,
  deleteAccountSession,
  getAccountSession,
  pendingRefreshJournalPath,
  pendingRotationAccounts,
  recordPendingRefreshRotation,
  recoverPendingRefreshRotations,
  saveAccountSession,
} from '../src/auth/store.js'
import type { ClaudeSession } from '../src/auth/store.js'
import {
  CREDENTIAL_JOURNAL_UNAVAILABLE_CODE,
  CREDENTIAL_NOT_PERSISTED_CODE,
  TokenManager,
} from '../src/providers/common.js'

const TEMP_DIRS: string[] = []

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

/** A store path inside a temp directory removed when the file finishes. */
function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'refresh-journal-'))
  TEMP_DIRS.push(dir)
  return join(dir, 'auth.json')
}

const ACCOUNT = 'journal-a@example.invalid'

function session(accessToken: string, expiresInMs = 3_600_000, refreshToken = `${accessToken}-rt`): ClaudeSession {
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresInMs,
    scopes: 'user:inference',
    emailAddress: ACCOUNT,
  }
}

/** The journal document as written. */
function journalDocument(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(pendingRefreshJournalPath(path), 'utf8')) as Record<string, unknown>
}

/** One account's marker in the journal, when present. */
function journalMarker(path: string, provider = 'claude', account = ACCOUNT): Record<string, unknown> | undefined {
  const rotations = journalDocument(path).rotations
  if (typeof rotations !== 'object' || rotations === null) return undefined
  const providerMap = (rotations as Record<string, unknown>)[provider]
  if (typeof providerMap !== 'object' || providerMap === null) return undefined
  const marker = (providerMap as Record<string, unknown>)[account]
  return typeof marker === 'object' && marker !== null ? marker as Record<string, unknown> : undefined
}

/** A TokenManager over an in-memory store whose journal can fail at any step. */
function crashHarness(options: {
  beginFails?: boolean
  recordFails?: boolean
  completeFails?: boolean
  saveFails?: boolean
  refreshFails?: boolean
  expired?: boolean
} = {}) {
  const stored = session('old-at', options.expired === true ? -1_000 : 30_000, 'old-rt')
  const minted = session('new-at', 3_600_000, 'new-rt')
  const calls: string[] = []
  const warnings: string[] = []
  let current = stored
  let marker: 'pending' | 'completed' | undefined
  const manager = new TokenManager<ClaudeSession>({
    displayName: 'Claude',
    preemptMs: 60_000,
    load: async () => current,
    save: async (next) => {
      calls.push('save')
      if (options.saveFails === true) throw new Error('the store is not writable')
      current = next
    },
    refresh: async () => {
      calls.push('refresh')
      if (options.refreshFails === true) throw new Error('invalid_grant')
      return minted
    },
    isPermanent: error => error instanceof Error && error.message === 'invalid_grant',
    rotationJournal: {
      begin: async () => {
        calls.push('begin')
        if (options.beginFails === true) throw new Error('the journal is not writable')
        marker = 'pending'
      },
      record: async () => {
        calls.push('record')
        if (options.recordFails === true) throw new Error('the journal is not writable')
        marker = 'completed'
      },
      complete: async () => {
        calls.push('complete')
        if (options.completeFails === true) throw new Error('the journal could not be cleared')
        marker = undefined
      },
    },
    onWarn: message => warnings.push(message),
  })
  return { manager, calls, warnings, stored, minted, marker: () => marker, current: () => current }
}

test('a journal that cannot record the intent spends no grant and serves the still-valid token', async () => {
  const h = crashHarness({ beginFails: true })

  const served = await h.manager.session()

  assert.deepEqual(h.calls, ['begin'], 'the request was never sent')
  assert.equal(served.accessToken, 'old-at', 'the still-valid stored token is served')
  assert.equal(h.current().accessToken, 'old-at')
})

test('a journal that cannot record the intent refuses an expired refresh', async () => {
  const h = crashHarness({ beginFails: true, expired: true })

  await assert.rejects(h.manager.session(), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, CREDENTIAL_JOURNAL_UNAVAILABLE_CODE)
    return true
  })
  assert.deepEqual(h.calls, ['begin'], 'no grant was spent')
})

test('the journal steps run in order around the grant and the store write', async () => {
  const h = crashHarness()

  const served = await h.manager.session()

  assert.deepEqual(h.calls, ['begin', 'refresh', 'record', 'save', 'complete'])
  assert.equal(served.accessToken, 'new-at')
  assert.equal(h.marker(), undefined, 'the marker is cleared after the store accepted the session')
})

test('a rotated credential whose journal record fails is still stored and reported', async () => {
  const h = crashHarness({ recordFails: true })

  const served = await h.manager.session()

  assert.equal(served.accessToken, 'new-at', 'the store write lands')
  assert.equal(h.current().accessToken, 'new-at')
  assert.deepEqual(h.calls, ['begin', 'refresh', 'record', 'save', 'complete'])
  assert.equal(h.warnings.length, 1)
  assert.match(h.warnings[0]!, /refresh journal entry could not be written/)
  assert.equal(h.marker(), undefined, 'the pending marker is cleared after the landed save')
})

test('a rotated credential whose store save fails keeps the completed marker and reports CREDENTIAL_NOT_PERSISTED', async () => {
  const h = crashHarness({ saveFails: true })

  await assert.rejects(h.manager.session(), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, CREDENTIAL_NOT_PERSISTED_CODE)
    return true
  })
  assert.equal(h.marker(), 'completed', 'the new credential stays in the journal for recovery')
  assert.equal(h.current().accessToken, 'old-at', 'the stored token is never blanked or replaced')
  assert.deepEqual(h.calls.filter(call => call === 'save'), ['save', 'save', 'save'], 'the save is retried')
  assert.equal(h.calls.includes('complete'), false, 'the marker is not cleared before the save lands')
})

test('a rotated credential that can be neither journaled nor stored reports CREDENTIAL_NOT_PERSISTED', async () => {
  const h = crashHarness({ recordFails: true, saveFails: true })

  await assert.rejects(h.manager.session(), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, CREDENTIAL_NOT_PERSISTED_CODE)
    assert.match(error.message, /neither journal nor/)
    return true
  })
  assert.equal(h.marker(), 'pending', 'the intent marker is left for inspection')
  assert.equal(h.current().accessToken, 'old-at')
})

test('a journal that cannot be cleared after a landed save keeps the marker and warns', async () => {
  const h = crashHarness({ completeFails: true })

  const served = await h.manager.session()

  assert.equal(served.accessToken, 'new-at')
  assert.equal(h.current().accessToken, 'new-at')
  assert.equal(h.marker(), 'completed', 'recovery reconciles a marker the store already satisfies')
  assert.equal(h.warnings.length, 1)
  assert.match(h.warnings[0]!, /refresh journal entry could not be cleared/)
})

test('a failed grant clears its intent marker and leaves the stored credential', async () => {
  const h = crashHarness({ refreshFails: true, expired: true })

  await assert.rejects(h.manager.session(), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'INVALID_CREDENTIAL')
    return true
  })
  assert.equal(h.marker(), undefined, 'an attempt with no minted credential leaves no marker')
  assert.equal(h.current().accessToken, 'old-at', 'the credential is parked, not deleted')
})

test('the journal lives beside the store, carries hashes only while pending, and is 0600', async () => {
  const path = storePath()
  const stored = session('old-at', 3_600_000, 'old-rt')
  await saveAccountSession('claude', ACCOUNT, stored, path)

  await beginPendingRefreshRotation('claude', ACCOUNT, stored, 7, path)

  const journal = pendingRefreshJournalPath(path)
  assert.equal(journal, `${path}.pending-refresh.json`)
  const document = journalDocument(path)
  assert.equal(document.version, 1)
  const marker = journalMarker(path)
  assert.ok(marker !== undefined)
  assert.equal(marker.phase, 'pending')
  assert.equal(marker.provider, 'claude')
  assert.equal(marker.account, ACCOUNT)
  assert.equal(marker.priorRevision, 7)
  assert.match(String(marker.priorFingerprint), /^sha256:[0-9a-f]{64}$/)
  assert.equal(typeof marker.startedAt, 'number')
  const raw = JSON.stringify(document)
  assert.equal(raw.includes('old-at'), false, 'the spent access token is never written to the journal')
  assert.equal(raw.includes('old-rt'), false, 'the spent refresh token is never written to the journal')
  if (process.platform !== 'win32') {
    assert.equal(statSync(journal).mode & 0o777, 0o600, 'the journal is owner-only')
  }
})

test('a completed marker records the minted session and clears on completion', async () => {
  const path = storePath()
  const stored = session('old-at', 3_600_000, 'old-rt')
  const minted = session('new-at', 3_600_000, 'new-rt')
  await saveAccountSession('claude', ACCOUNT, stored, path)
  await beginPendingRefreshRotation('claude', ACCOUNT, stored, 3, path)
  assert.deepEqual(await pendingRotationAccounts('claude', path), new Set(),
    'a pending intent is not a state the status reports as needing re-authentication')

  await recordPendingRefreshRotation('claude', ACCOUNT, minted, stored, 3, path)
  assert.deepEqual(await pendingRotationAccounts('claude', path), new Set([ACCOUNT]),
    'a completed marker is the state status reports as needing re-authentication')

  const marker = journalMarker(path)
  assert.ok(marker !== undefined)
  assert.equal(marker.phase, 'completed')
  assert.deepEqual(marker.session, minted)

  await completePendingRefreshRotation('claude', ACCOUNT, path)
  assert.equal(journalMarker(path), undefined)
  assert.deepEqual(await pendingRotationAccounts('claude', path), new Set())
})

test('a backfill on the old credential does not discard a completed rotation', async () => {
  const path = storePath()
  const stored = session('old-at', 3_600_000, 'old-rt')
  const minted = session('new-at', 3_600_000, 'new-rt')
  await saveAccountSession('claude', ACCOUNT, stored, path)
  await beginPendingRefreshRotation('claude', ACCOUNT, stored, 1, path)
  await recordPendingRefreshRotation('claude', ACCOUNT, minted, stored, 1, path)

  // An identity backfill derives from the stored credential and stores the same tokens again.
  const backfilled: ClaudeSession = { ...stored, deviceId: 'd'.repeat(64) }
  assert.equal(await saveAccountSession('claude', ACCOUNT, backfilled, path), true)
  assert.equal(journalMarker(path)?.phase, 'completed', 'the rotated token is still recoverable')

  const report = await recoverPendingRefreshRotations({ path })

  assert.equal(report.applied, 1)
  assert.equal((await getAccountSession('claude', ACCOUNT, path))?.accessToken, 'new-at')
  assert.equal(journalMarker(path), undefined)
})

test('a completed marker from before a crash is applied on restart', async () => {
  const path = storePath()
  const stored = session('old-at', 3_600_000, 'old-rt')
  const minted = session('new-at', 3_600_000, 'new-rt')
  await saveAccountSession('claude', ACCOUNT, stored, path)
  // The crash: the grant was spent and journaled, then the process died before the store write.
  await beginPendingRefreshRotation('claude', ACCOUNT, stored, 1, path)
  await recordPendingRefreshRotation('claude', ACCOUNT, minted, stored, 1, path)

  const report = await recoverPendingRefreshRotations({ path })

  assert.deepEqual(report.unresolved, [])
  assert.equal(report.applied, 1)
  assert.deepEqual(await getAccountSession('claude', ACCOUNT, path), minted, 'the journal credential wins over the old one')
  assert.equal(journalMarker(path), undefined, 'the recovered marker is cleared')
})

test('a completed marker the store already satisfies is cleared without a second write', async () => {
  const path = storePath()
  const stored = session('old-at', 3_600_000, 'old-rt')
  const minted = session('new-at', 3_600_000, 'new-rt')
  await saveAccountSession('claude', ACCOUNT, stored, path)
  await beginPendingRefreshRotation('claude', ACCOUNT, stored, 1, path)
  await recordPendingRefreshRotation('claude', ACCOUNT, minted, stored, 1, path)
  // The store write landed but the process died before clearing the marker.
  writeFileSync(path, JSON.stringify({
    claude: { default: ACCOUNT, accounts: { [ACCOUNT]: minted } },
  }), { mode: 0o600 })

  const report = await recoverPendingRefreshRotations({ path })

  assert.equal(report.applied, 0)
  assert.equal(report.cleared, 1)
  assert.equal(journalMarker(path), undefined)
  assert.deepEqual(await getAccountSession('claude', ACCOUNT, path), minted)
})

test('a divergent stored credential is never overwritten by the journal', async () => {
  const path = storePath()
  const stored = session('old-at', 3_600_000, 'old-rt')
  const minted = session('new-at', 3_600_000, 'new-rt')
  const winner = session('winner-at', 3_600_000, 'winner-rt')
  await saveAccountSession('claude', ACCOUNT, stored, path)
  await beginPendingRefreshRotation('claude', ACCOUNT, stored, 1, path)
  await recordPendingRefreshRotation('claude', ACCOUNT, minted, stored, 1, path)
  // A login landed after the crash: neither the prior nor the journal credential.
  writeFileSync(path, JSON.stringify({
    claude: { default: ACCOUNT, accounts: { [ACCOUNT]: winner } },
  }), { mode: 0o600 })

  const report = await recoverPendingRefreshRotations({ path })

  assert.equal(report.applied, 0)
  assert.equal(report.unresolved.length, 1)
  assert.deepEqual(await getAccountSession('claude', ACCOUNT, path), winner, 'the newer credential is kept')
  assert.equal(journalMarker(path)?.phase, 'completed', 'the marker is left for inspection')
})

test('a completed marker whose account was logged out is discarded, never resurrected', async () => {
  const path = storePath()
  const stored = session('old-at', 3_600_000, 'old-rt')
  const minted = session('new-at', 3_600_000, 'new-rt')
  await saveAccountSession('claude', ACCOUNT, stored, path)
  await beginPendingRefreshRotation('claude', ACCOUNT, stored, 1, path)
  await recordPendingRefreshRotation('claude', ACCOUNT, minted, stored, 1, path)
  writeFileSync(path, JSON.stringify({}), { mode: 0o600 })

  const report = await recoverPendingRefreshRotations({ path })

  assert.equal(report.applied, 0)
  assert.equal(report.cleared, 1)
  assert.equal(await getAccountSession('claude', ACCOUNT, path), undefined, 'the logout is not undone')
  assert.equal(journalMarker(path), undefined)
})

test('a pending-only marker is cleared with a warning and the stored credential is kept', async () => {
  const path = storePath()
  const stored = session('old-at', 3_600_000, 'old-rt')
  await saveAccountSession('claude', ACCOUNT, stored, path)
  await beginPendingRefreshRotation('claude', ACCOUNT, stored, 1, path)

  const warnings: string[] = []
  const report = await recoverPendingRefreshRotations({ path, onWarn: message => warnings.push(message) })

  assert.equal(report.cleared, 1)
  assert.equal(journalMarker(path), undefined)
  assert.deepEqual(await getAccountSession('claude', ACCOUNT, path), stored)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /interrupted refresh/)
})

test('an unreadable journal is never replaced, and a refresh refuses to spend a grant', async () => {
  const path = storePath()
  const stored = session('old-at', 3_600_000, 'old-rt')
  await saveAccountSession('claude', ACCOUNT, stored, path)
  const journal = pendingRefreshJournalPath(path)
  writeFileSync(journal, '{not json', { mode: 0o600 })
  const before = readFileSync(journal, 'utf8')

  await assert.rejects(recoverPendingRefreshRotations({ path }), /not valid JSON/)
  await assert.rejects(
    beginPendingRefreshRotation('claude', ACCOUNT, stored, 1, path),
    /not valid JSON/,
  )
  assert.equal(readFileSync(journal, 'utf8'), before, 'the unreadable journal is left untouched')
})

test('an explicit logout clears a completed marker', async () => {
  const path = storePath()
  const stored = session('old-at', 3_600_000, 'old-rt')
  const minted = session('new-at', 3_600_000, 'new-rt')
  await saveAccountSession('claude', ACCOUNT, stored, path)
  await beginPendingRefreshRotation('claude', ACCOUNT, stored, 1, path)
  await recordPendingRefreshRotation('claude', ACCOUNT, minted, stored, 1, path)

  assert.equal(await deleteAccountSession('claude', ACCOUNT, path), true)

  assert.equal(await getAccountSession('claude', ACCOUNT, path), undefined)
  assert.equal(journalMarker(path), undefined, 'the logout removes the marker with the credential')
})

test('a live journal lock prevents recording intent, so no grant is spent', async () => {
  const path = storePath()
  const stored = session('old-at', 3_600_000, 'old-rt')
  await saveAccountSession('claude', ACCOUNT, stored, path)
  const journal = pendingRefreshJournalPath(path)
  mkdirSync(`${journal}.lock`)
  writeFileSync(`${journal}.lock/owner`, 'another-process')

  await assert.rejects(
    beginPendingRefreshRotation('claude', ACCOUNT, stored, 1, path),
    /holds the store lock/,
  )
  assert.equal(existsSync(journal), false, 'no marker was created')
})
