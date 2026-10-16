/**
 * The durable `policy_limits` projection: its on-disk document, its strict validation and its
 * compare-and-swap removal.
 *
 * The store's job is to keep a restart from relaxing a gate. These cases own that contract:
 * only a file that is genuinely absent is a cold start, anything else is reported as
 * untrustworthy rather than read as empty, a write never replaces a document it could not
 * trust, and a removal only ever deletes the exact record its caller still holds. The
 * projection itself is the owner's (covered by the integration spec); this spec writes
 * records directly, which is how a hostile or older file is modelled.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ClaudePersistedPolicyLimitsIdentity,
  ClaudePersistedPolicyLimitsRecord,
  ClaudePolicyLimitsStateFailure,
} from '../src/providers/claude-policy-limits-state.js'

const root = mkdtempSync(join(tmpdir(), 'claude-policy-limits-store-'))
process.on('exit', () => { rmSync(root, { recursive: true, force: true }) })

const { FileClaudePolicyLimitsState, CLAUDE_POLICY_LIMITS_STATE_LIMIT } =
  await import('../src/providers/claude-policy-limits-state.js')

/** A path inside this spec's own directory, so no real home is touched. */
function pathFor(name: string): string {
  return join(root, `${name}.json`)
}

/** The identity the recorded examples belong to. */
const IDENTITY: ClaudePersistedPolicyLimitsIdentity = {
  account: 'acct',
  accountUuid: 'uuid-a',
  origin: 'https://api.anthropic.com',
  profileFingerprint: 'fp',
  epoch: 'lease-1',
}

/** One complete record, with every member the store requires. */
function record(overrides: Partial<ClaudePersistedPolicyLimitsRecord> = {}): ClaudePersistedPolicyLimitsRecord {
  return {
    identity: IDENTITY,
    revision: 3,
    validator: 'sha256:abc',
    receivedAt: 1_700_000_000_000,
    restrictions: [
      { key: 'allow_model_catalog', allowed: false },
      { key: 'allow_web_fetch', allowed: true },
    ],
    taints: ['hipaa'],
    lossyTaints: false,
    noticePresent: false,
    defaults: [],
    unknownDefaults: 0,
    coreSkillsPresent: false,
    unknownKeys: 0,
    ...overrides,
  }
}

/** The store failure one call produced. */
async function failureOf(run: () => Promise<unknown>): Promise<ClaudePolicyLimitsStateFailure> {
  try {
    await run()
  } catch (error: unknown) {
    assert.ok(error instanceof Error, 'a store failure is thrown as an error')
    return error as ClaudePolicyLimitsStateFailure
  }
  return assert.fail('the call was expected to fail')
}

test('a store that was never written is cold, and a written record round-trips', async () => {
  const path = pathFor('roundtrip')
  const store = new FileClaudePolicyLimitsState({ path })
  assert.deepEqual(await store.load(), { status: 'cold' })

  await store.save([record()])
  const loaded = await store.load()
  assert.equal(loaded.status, 'loaded')
  assert.deepEqual(loaded.status === 'loaded' ? loaded.records : [], [record()])
  // The file is this module's own document, at the version it accepts.
  const document = JSON.parse(readFileSync(path, 'utf8')) as { version: number; accounts: unknown[] }
  assert.equal(document.version, 1)
  assert.equal(document.accounts.length, 1)
})

test('a record outside the pinned registry is counted, never stored by name', async () => {
  const path = pathFor('unknown-key')
  const store = new FileClaudePolicyLimitsState({ path })
  await store.save([record({
    restrictions: [
      { key: 'allow_model_catalog', allowed: false },
      { key: 'allow_something_private', allowed: true },
    ],
    unknownKeys: 0,
  })])
  const loaded = await store.load()
  assert.equal(loaded.status, 'loaded')
  const first = loaded.status === 'loaded' ? loaded.records[0] : undefined
  assert.deepEqual(first?.restrictions, [{ key: 'allow_model_catalog', allowed: false }])
  assert.equal(first?.unknownKeys, 1, 'the key this build cannot state survives as its count')
  assert.equal(readFileSync(path, 'utf8').includes('allow_something_private'), false)
})

test('a capability default this build cannot type is counted, never stored by name', async () => {
  const path = pathFor('unknown-default')
  const store = new FileClaudePolicyLimitsState({ path })
  await store.save([record({
    defaults: [
      { key: 'remote_control_at_startup', value: true },
      { key: 'some_private_capability', value: false },
    ],
    unknownDefaults: 0,
  })])
  const loaded = await store.load()
  assert.equal(loaded.status, 'loaded')
  const first = loaded.status === 'loaded' ? loaded.records[0] : undefined
  assert.deepEqual(first?.defaults, [{ key: 'remote_control_at_startup', value: true }], 'a known boolean default round-trips')
  assert.equal(first?.unknownDefaults, 1, 'a name this build does not know survives as a count')
  assert.equal(readFileSync(path, 'utf8').includes('some_private_capability'), false)
})

test('a taint this build cannot re-state is dropped and marks the record lossy', async () => {
  const path = pathFor('taint')
  const store = new FileClaudePolicyLimitsState({ path })
  await store.save([record({ taints: ['hipaa'], lossyTaints: false })])
  // An older or hostile file that carries an unusable taint is read as lossy rather than as
  // an account whose taint set is complete.
  const stored = JSON.parse(readFileSync(path, 'utf8')) as { accounts: { taints: unknown[] }[] }
  stored.accounts[0]!.taints = ['hipaa', 'NOT A TAINT', 'hipaa']
  writeFileSync(path, JSON.stringify(stored))
  const loaded = await store.load()
  const first = loaded.status === 'loaded' ? loaded.records[0] : undefined
  assert.deepEqual(first?.taints, ['hipaa'])
  assert.equal(first?.lossyTaints, true)
})

test('a corrupt file fails closed and is never replaced by a write', async () => {
  const path = pathFor('corrupt')
  const corrupt = '{"version":1,"accounts":[{"identity":'
  writeFileSync(path, corrupt)
  const store = new FileClaudePolicyLimitsState({ path })
  const loaded = await store.load()
  assert.equal(loaded.status, 'unavailable')
  assert.equal(loaded.status === 'unavailable' ? loaded.error.code : '', 'state_corrupt')

  const failure = await failureOf(() => store.save([record()]))
  assert.equal(failure.code, 'state_untrusted_write')
  assert.equal(readFileSync(path, 'utf8'), corrupt, 'a document this process cannot trust is left exactly as it is')
})

test('an unsupported version, an oversized document and an unreadable path all fail closed', async () => {
  const versioned = pathFor('version')
  writeFileSync(versioned, JSON.stringify({ version: 99, accounts: [] }))
  const versionResult = await new FileClaudePolicyLimitsState({ path: versioned }).load()
  assert.equal(versionResult.status === 'unavailable' ? versionResult.error.code : '', 'state_version_unsupported')

  const oversized = pathFor('oversized')
  writeFileSync(oversized, 'x'.repeat(CLAUDE_POLICY_LIMITS_STATE_LIMIT + 1))
  const oversizedResult = await new FileClaudePolicyLimitsState({ path: oversized }).load()
  assert.equal(oversizedResult.status === 'unavailable' ? oversizedResult.error.code : '', 'state_oversized')

  // A directory where the file belongs is not an absent file: only ENOENT is a cold start.
  const unreadable = pathFor('unreadable')
  mkdirSync(unreadable)
  const unreadableResult = await new FileClaudePolicyLimitsState({ path: unreadable }).load()
  assert.equal(unreadableResult.status === 'unavailable' ? unreadableResult.error.code : '', 'state_unreadable')
})

test('a record whose own members are malformed fails the whole load closed', async () => {
  const path = pathFor('malformed')
  const store = new FileClaudePolicyLimitsState({ path })
  await store.save([record()])
  const document = JSON.parse(readFileSync(path, 'utf8')) as { accounts: Record<string, unknown>[] }
  delete document.accounts[0]!.unknownDefaults
  writeFileSync(path, JSON.stringify(document))
  const loaded = await store.load()
  assert.equal(loaded.status, 'unavailable')
  assert.equal(loaded.status === 'unavailable' ? loaded.error.code : '', 'state_corrupt')
})

test('a stale write of the same identity is dropped and another account is kept', async () => {
  const path = pathFor('merge')
  const store = new FileClaudePolicyLimitsState({ path })
  await store.save([record({ revision: 5 })])
  await store.save([record({ revision: 4 })])
  let loaded = await store.load()
  assert.equal(loaded.status === 'loaded' ? loaded.records[0]?.revision : undefined, 5, 'older evidence about one identity never replaces newer')

  await store.save([record({ identity: { ...IDENTITY, account: 'second' }, revision: 1 })])
  loaded = await store.load()
  assert.deepEqual(loaded.status === 'loaded' ? loaded.records.map(entry => entry.identity.account).sort() : [], ['acct', 'second'])
  await store.save([record({ revision: 6 })])
  loaded = await store.load()
  assert.equal(loaded.status === 'loaded' ? loaded.records.find(entry => entry.identity.account === 'acct')?.revision : undefined, 6)
  assert.equal(loaded.status === 'loaded' ? loaded.records.length : 0, 2, 'an account this call does not name is never dropped')
})

test('a removal deletes only the exact identity and revision its caller holds', async () => {
  const path = pathFor('cas')
  const store = new FileClaudePolicyLimitsState({ path })
  await store.save([record({ revision: 3 })])
  const stored = readFileSync(path, 'utf8')

  assert.deepEqual(await store.remove({ account: 'other', identity: IDENTITY, revision: 3 }), { status: 'absent' })
  assert.deepEqual(await store.remove({ account: 'acct', identity: IDENTITY, revision: 2 }), { status: 'superseded' })
  assert.deepEqual(await store.remove({
    account: 'acct',
    identity: { ...IDENTITY, epoch: 'lease-2' },
    revision: 3,
  }), { status: 'superseded' }, 'a later login with the same account key is never deleted')
  assert.equal(readFileSync(path, 'utf8'), stored, 'a refused removal leaves the document untouched')

  assert.deepEqual(await store.remove({ account: 'acct', identity: IDENTITY, revision: 3 }), { status: 'removed' })
  const loaded = await store.load()
  assert.deepEqual(loaded.status === 'loaded' ? loaded.records : [], [])
})

test('a removal against an untrusted document is retained rather than attempted', async () => {
  const path = pathFor('cas-untrusted')
  const corrupt = 'not json'
  writeFileSync(path, corrupt)
  const store = new FileClaudePolicyLimitsState({ path })
  const outcome = await store.remove({ account: 'acct', identity: IDENTITY, revision: 3 })
  assert.equal(outcome.status, 'retained')
  assert.equal(outcome.status === 'retained' ? outcome.error.code : '', 'state_corrupt')
  assert.equal(readFileSync(path, 'utf8'), corrupt)
})

test('a store another process owns reports a lock rather than writing', async () => {
  const path = pathFor('locked')
  const store = new FileClaudePolicyLimitsState({
    path,
    timing: { retries: 0, minTimeoutMs: 1, maxTimeoutMs: 1, staleMs: 120_000 },
  })
  // A freshly created lock directory is a live holder: its lease has not gone stale.
  mkdirSync(`${path}.lock`)
  const failure = await failureOf(() => store.save([record()]))
  assert.equal(failure.code, 'state_locked')
  const outcome = await store.remove({ account: 'acct', identity: IDENTITY, revision: 3 })
  assert.equal(outcome.status, 'retained')
  assert.equal(outcome.status === 'retained' ? outcome.error.code : '', 'state_locked')
  rmSync(`${path}.lock`, { recursive: true, force: true })
  await store.save([record()])
  const loaded = await store.load()
  assert.equal(loaded.status, 'loaded', 'the same store writes once the lock is gone')
})
