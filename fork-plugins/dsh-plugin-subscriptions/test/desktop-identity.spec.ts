import assert from 'node:assert/strict'
import test from 'node:test'
import { totalmem } from 'node:os'

import { readFile } from 'node:fs/promises'

import {
  CLAUDE_CLIENT_ARCH,
  CLAUDE_CLIENT_OS,
  CLAUDE_CLIENT_RUNTIME_VERSION,
} from '../src/providers/claude-wire.js'
import { deriveClaudeDeviceId } from '../src/providers/claude.js'
import {
  CLAUDE_DESKTOP_APP_VERSION,
  desktopApplicationHeaders,
  desktopClientHeaders,
  desktopDeviceClass,
  desktopMachineProfile,
} from '../src/providers/claude-desktop.js'

/** Sizes a plausible desktop reports, and the bucket each must land in. */
const EXPECTED_BUCKET: ReadonlyArray<readonly [number, string]> = [
  [8, '8'],
  [16, '16'],
  [32, 'gt16'],
]

test('the reported machine size is never this host’s own', () => {
  const hostGb = Math.round(totalmem() / 1024 ** 3)
  const reported = new Set<number>()
  for (let i = 0; i < 200; i += 1) {
    const profile = desktopMachineProfile(`device-${i}`)
    reported.add(profile.totalMemoryGb)
    assert.notEqual(
      profile.totalMemoryGb,
      hostGb,
      'a distinctive host size must never be reported',
    )
  }
  assert.deepEqual([...reported].sort((a, b) => a - b), [8, 16, 32])
})

test('one account always presents the same machine', () => {
  const first = desktopMachineProfile('account-device-id')
  const second = desktopMachineProfile('account-device-id')
  assert.deepEqual(first, second)
})

test('two accounts do not present the same machine', () => {
  const profiles = new Set(
    Array.from({ length: 64 }, (_unused, i) => JSON.stringify(desktopMachineProfile(`acct-${i}`))),
  )
  assert.ok(profiles.size > 1, 'distinct accounts must not all collapse to one machine')
})

test('the reported pair is self-consistent', () => {
  for (const [gb, bucket] of EXPECTED_BUCKET) {
    assert.equal(desktopDeviceClass(gb * 1024 ** 3), bucket)
  }
  for (let i = 0; i < 100; i += 1) {
    const profile = desktopMachineProfile(`seed-${i}`)
    assert.equal(
      profile.deviceClass,
      desktopDeviceClass(profile.totalMemoryGb * 1024 ** 3),
      'the class must bucket the size the same request reports',
    )
  }
})

test('a Messages request carries only the two headers the client composes', () => {
  // The application composes five, but for its own calls. The environment it hands the
  // client names two, and the client composes exactly those: the other three names appear
  // nowhere in the client, so sending them would be three headers no request ever had.
  const headers = desktopClientHeaders()
  assert.deepEqual(Object.keys(headers), [
    'anthropic-client-platform',
    'anthropic-client-version',
  ])
  assert.equal(headers['anthropic-client-platform'], 'desktop_app')
  assert.equal(headers['anthropic-client-version'], CLAUDE_DESKTOP_APP_VERSION)
})

test('the application headers keep the machine pair described and self-consistent', () => {
  const profile = desktopMachineProfile('account-device-id')
  const headers = desktopApplicationHeaders(profile)
  assert.deepEqual(Object.keys(headers), [
    'anthropic-client-platform',
    'anthropic-client-app',
    'anthropic-client-version',
    'anthropic-client-device-class',
    'anthropic-client-total-memory-gb',
  ])
  assert.equal(headers['anthropic-client-total-memory-gb'], String(profile.totalMemoryGb))
  assert.equal(headers['anthropic-client-device-class'], profile.deviceClass)
})

test('the request claims the anchored platform rather than this host', () => {
  assert.equal(CLAUDE_CLIENT_OS, 'Windows')
  assert.equal(CLAUDE_CLIENT_ARCH, 'x64')
  assert.match(CLAUDE_CLIENT_RUNTIME_VERSION, /^\d+\.\d+\.\d+$/)
})

test('no host value can reach a request', async () => {
  const source = await readFile(
    new URL('../../src/providers/claude-wire.ts', import.meta.url),
    'utf8',
  )
  for (const forbidden of ['process.platform', 'process.arch', 'process.versions', 'totalmem']) {
    assert.ok(
      !source.includes(forbidden),
      `${forbidden} would publish this host in every request`,
    )
  }
})

test('the device id is the client’s format and belongs to the account alone', () => {
  const id = deriveClaudeDeviceId('someone@example.com')
  assert.match(id, /^[0-9a-f]{64}$/, 'the client uses 64 lowercase hex characters')
  assert.equal(id, deriveClaudeDeviceId('someone@example.com'), 'stable for one account')
  assert.notEqual(id, deriveClaudeDeviceId('other@example.com'), 'distinct per account')
})

test('signing out and in again presents the same device', () => {
  // The credential record is deleted on logout, so an id stored inside it would be lost.
  // Deriving from the account key instead keeps the device stable across the whole cycle.
  const before = deriveClaudeDeviceId('member@example.com')
  const after = deriveClaudeDeviceId('member@example.com')
  assert.equal(before, after)
  assert.deepEqual(
    desktopMachineProfile(before),
    desktopMachineProfile(after),
    'the machine values derived from it survive the cycle too',
  )
})
