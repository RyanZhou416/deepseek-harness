/**
 * Device identity: the machine read, its normalization, and the derived wire id.
 *
 * Every case drives the module through explicit synthetic seams. The suite deliberately
 * never calls `readLocalDeviceFingerprint`, so no case reads this machine's real registry
 * value, machine-id file, or platform UUID.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import { LlmError } from '@deepseek-ai/dsh-llm'

import {
  DEVICE_IDENTITY_UNAVAILABLE,
  DeviceIdentityError,
  createDeviceFingerprintReader,
  deriveAccountDeviceId,
  readLocalDeviceFingerprint,
  resolveDeviceFingerprint,
} from '../src/providers/claude-device.js'
import type { DeviceFingerprintSeams } from '../src/providers/claude-device.js'
import { idleWatchdog, mapFetchFailure } from '../src/providers/common.js'

/** A synthetic account key, in the shape the parent passes for a disclosed account uuid. */
const ACCOUNT = 'uuid:3f1c8a52-0d47-4b90-8e21-77c9a4f10b6d'

/** A second account on the same machine. */
const OTHER_ACCOUNT = 'uuid:9a0e5b74-2c31-4f68-b1dd-40e7f2a83c59'

/** Synthetic machine identifiers: GUID-shaped, and never this host's own values. */
const MACHINE_A = '4f2a1c9e-7b3d-4e51-9a86-2c0d5fe71b40'
const MACHINE_B = 'b7d1305c-88a4-4c2f-9d19-6ae0f3c2a75e'

const HEX64 = /^[0-9a-f]{64}$/u

/**
 * The Windows registry command the module is expected to run, as one line.
 * @param windowsDirectory - the Windows directory the environment resolved to.
 * @returns the command line.
 */
function windowsRegistryCommand(windowsDirectory: string): string {
  return `${windowsDirectory}\\System32\\reg.exe QUERY `
    + 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid /reg:64'
}

/** The registry command for a default Windows installation. */
const WINDOWS_REGISTRY_COMMAND = windowsRegistryCommand('C:\\Windows')

/** The macOS command the module is expected to run, as one line. */
const DARWIN_COMMAND = '/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice'

/** One synthetic host: the files it can read, the commands it can run, and what it was asked. */
interface SyntheticHost extends DeviceFingerprintSeams {
  /** Every read and command this host was asked for, in order. */
  readonly calls: string[]
}

/**
 * Build one synthetic host.
 * @param spec - the platform, environment, file contents and command outputs to serve.
 * @returns the seams, with the calls they recorded.
 */
function host(spec: {
  platform: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
  files?: Readonly<Record<string, string>>
  commands?: Readonly<Record<string, string>>
}): SyntheticHost {
  const calls: string[] = []
  const files = spec.files ?? {}
  const commands = spec.commands ?? {}
  return {
    platform: spec.platform,
    env: spec.env ?? {},
    readFile: path => {
      calls.push(`read ${path}`)
      const contents = files[path]
      if (contents === undefined) throw new Error(`no such file: ${path}`)
      return contents
    },
    execFile: (file, args) => {
      const command = [file, ...args].join(' ')
      calls.push(`exec ${command}`)
      const stdout = commands[command]
      if (stdout === undefined) throw new Error(`command failed: ${file}`)
      return stdout
    },
    calls,
  }
}

/**
 * A `reg QUERY` transcript carrying one machine GUID, in reg.exe's own layout.
 * @param guid - the value to report.
 * @returns the transcript.
 */
function regQueryOutput(guid: string): string {
  return '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n'
    + `    MachineGuid    REG_SZ    ${guid}\r\n\r\n`
}

/**
 * An `ioreg` transcript carrying one platform UUID.
 * @param uuid - the value to report.
 * @returns the transcript.
 */
function ioregOutput(uuid: string): string {
  return [
    '+-o IOPlatformExpertDevice  <class IOPlatformExpertDevice, id 0x100000100, registered>',
    '  {',
    '    "IOPlatformSerialNumber" = "SYNTHETIC0001"',
    `    "IOPlatformUUID" = "${uuid}"`,
    '  }',
  ].join('\n')
}

/**
 * A Linux host whose machine-id file carries one identifier.
 * @param contents - the file's bytes.
 * @returns the seams.
 */
function linuxHost(contents: string): SyntheticHost {
  return host({ platform: 'linux', files: { '/etc/machine-id': contents } })
}

/**
 * A Windows host reporting one machine GUID.
 * @param guid - the value reg.exe reports.
 * @returns the seams.
 */
function windowsHost(guid: string): SyntheticHost {
  return host({
    platform: 'win32',
    env: { windir: 'C:\\Windows' },
    commands: { [WINDOWS_REGISTRY_COMMAND]: regQueryOutput(guid) },
  })
}

/**
 * A macOS host reporting one platform UUID.
 * @param uuid - the value ioreg reports.
 * @returns the seams.
 */
function darwinHost(uuid: string): SyntheticHost {
  return host({
    platform: 'darwin',
    commands: { [DARWIN_COMMAND]: ioregOutput(uuid) },
  })
}

/**
 * The module's own source, from whichever layout this suite runs in.
 *
 * The compiled suite runs from `lib-test/test`, the source suite from `test`.
 * @returns the source text.
 */
async function moduleSource(): Promise<string> {
  for (const relative of ['../src/providers/claude-device.ts', '../../src/providers/claude-device.ts']) {
    try {
      return await readFile(new URL(relative, import.meta.url), 'utf8')
    } catch (missingLayout: unknown) {
      // The other layout is the one that exists; only a source that is in neither fails.
      void missingLayout
    }
  }
  throw new Error('claude-device.ts was not found in either test layout')
}

test('one account on one machine always derives the same id', () => {
  const fingerprint = resolveDeviceFingerprint(linuxHost(`${MACHINE_A}\n`))
  const id = deriveAccountDeviceId(ACCOUNT, fingerprint)
  assert.match(id, HEX64)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(deriveAccountDeviceId(ACCOUNT, fingerprint), id)
  }
})

test('two accounts on one machine do not share a device', () => {
  const fingerprint = resolveDeviceFingerprint(linuxHost(`${MACHINE_A}\n`))
  assert.notEqual(
    deriveAccountDeviceId(ACCOUNT, fingerprint),
    deriveAccountDeviceId(OTHER_ACCOUNT, fingerprint),
  )
})

test('one account on two machines does not share a device', () => {
  const first = deriveAccountDeviceId(ACCOUNT, resolveDeviceFingerprint(linuxHost(`${MACHINE_A}\n`)))
  const second = deriveAccountDeviceId(ACCOUNT, resolveDeviceFingerprint(linuxHost(`${MACHINE_B}\n`)))
  assert.notEqual(first, second)
})

test('the id survives the loss of every harness cache', () => {
  // Nothing but the account key and the machine fingerprint is an input, so a process that
  // lost its store, its credential record, and DSH_HOME rebuilds the same id from the same
  // two facts. Resolving through independent seam sets stands in for the fresh process.
  const account = ACCOUNT
  const before = deriveAccountDeviceId(account, resolveDeviceFingerprint(linuxHost(`${MACHINE_A}\n`)))
  const after = deriveAccountDeviceId(account, resolveDeviceFingerprint(linuxHost(`${MACHINE_A}\n`)))
  assert.equal(before, after)
  assert.match(after, HEX64)
})

test('the raw machine identifier never appears in a returned value', () => {
  const fingerprint = resolveDeviceFingerprint(linuxHost(`${MACHINE_A}\n`))
  const id = deriveAccountDeviceId(ACCOUNT, fingerprint)
  assert.ok(!fingerprint.includes(MACHINE_A), 'the fingerprint must not carry the identifier')
  assert.ok(!id.includes(MACHINE_A), 'the device id must not carry the identifier')
  assert.ok(!id.includes(ACCOUNT), 'the device id must not carry the account key')
})

test('an empty account key is refused rather than collapsed to the machine', () => {
  const fingerprint = resolveDeviceFingerprint(linuxHost(`${MACHINE_A}\n`))
  assert.throws(() => deriveAccountDeviceId('   ', fingerprint), DeviceIdentityError)
})

test('an empty machine fingerprint is refused', () => {
  assert.throws(() => deriveAccountDeviceId(ACCOUNT, ''), DeviceIdentityError)
})

test('a missing identifier is typed, not auth, and is not reclassified as transport', () => {
  const seams = host({ platform: 'linux' })
  let thrown: unknown
  try {
    resolveDeviceFingerprint(seams)
  } catch (error: unknown) {
    thrown = error
  }
  assert.ok(thrown instanceof DeviceIdentityError)
  assert.ok(thrown instanceof LlmError, 'a classifier must return it unchanged')
  assert.equal(thrown.code, DEVICE_IDENTITY_UNAVAILABLE)
  assert.notEqual(thrown.code, 'AUTH', 'the credential is sound and no account is at fault')
  // The exact classifier the adapter runs around a request: an LlmError passes through with
  // its code intact, where a plain Error would become a retryable TRANSPORT failure.
  const watchdog = idleWatchdog(undefined, 1_000)
  try {
    assert.equal(mapFetchFailure('claude', thrown, watchdog, undefined), thrown)
  } finally {
    watchdog.stop()
  }
})

test('the unavailability message names no identifier, path, or environment', () => {
  let thrown: unknown
  try {
    // The file is readable but carries a value that identifies no machine.
    resolveDeviceFingerprint(linuxHost('uninitialized'))
  } catch (error: unknown) {
    thrown = error
  }
  assert.ok(thrown instanceof DeviceIdentityError)
  for (const forbidden of [MACHINE_A, '/etc/machine-id', '/var/lib/dbus/machine-id',
    'uninitialized', 'windir', 'SystemRoot']) {
    assert.ok(!thrown.message.includes(forbidden), `the message must not carry ${forbidden}`)
  }
})

test('the Windows identifier is read from the Cryptography registry value', () => {
  const seams = windowsHost(MACHINE_A)
  const fingerprint = resolveDeviceFingerprint(seams)
  assert.match(fingerprint, HEX64)
  assert.deepEqual(seams.calls, [`exec ${WINDOWS_REGISTRY_COMMAND}`])
})

test('the Windows directory comes from the environment, not this host', () => {
  // The variable is spelled the way a shell may export it rather than the way `process.env`
  // indexes it, and the trailing separator is normalized away before the command is built.
  const command = windowsRegistryCommand('D:\\Windows')
  const seams = host({
    platform: 'win32',
    env: { SystemRoot: 'D:\\Windows\\' },
    commands: { [command]: regQueryOutput(MACHINE_A) },
  })
  assert.match(resolveDeviceFingerprint(seams), HEX64)
  assert.deepEqual(seams.calls, [`exec ${command}`])
})

test('the registry value is normalized before it is hashed', () => {
  const canonical = resolveDeviceFingerprint(windowsHost(MACHINE_A))
  const shouted = resolveDeviceFingerprint(windowsHost(`  ${MACHINE_A.toUpperCase()}  `))
  assert.equal(shouted, canonical, 'case and padding must not move a fingerprint')
  assert.notEqual(resolveDeviceFingerprint(windowsHost(MACHINE_B)), canonical)
})

test('a registry transcript naming no value is unavailable', () => {
  const seams = host({
    platform: 'win32',
    env: { windir: 'C:\\Windows' },
    commands: { [WINDOWS_REGISTRY_COMMAND]: 'ERROR: The system was unable to find the specified registry key or value.\r\n' },
  })
  assert.throws(() => resolveDeviceFingerprint(seams), DeviceIdentityError)
})

test('a registry command that cannot run is unavailable', () => {
  assert.throws(
    () => resolveDeviceFingerprint(host({ platform: 'win32', env: { windir: 'C:\\Windows' } })),
    DeviceIdentityError,
  )
})

test('the Linux identifier is normalized across a file newline and case', () => {
  const padded = resolveDeviceFingerprint(linuxHost(`  ${MACHINE_A.toUpperCase()}\n`))
  const plain = resolveDeviceFingerprint(linuxHost(MACHINE_A))
  assert.equal(padded, plain)
})

test('an unusable machine-id file falls back to the D-Bus copy', () => {
  // A distro that keeps the identifier only in the D-Bus file must resolve to the same
  // fingerprint as one whose /etc/machine-id carries it, so replacing a placeholder file
  // cannot move the device id.
  const fallback = host({
    platform: 'linux',
    files: { '/etc/machine-id': `${'0'.repeat(32)}\n`, '/var/lib/dbus/machine-id': `${MACHINE_B}\n` },
  })
  assert.equal(
    resolveDeviceFingerprint(fallback),
    resolveDeviceFingerprint(host({ platform: 'linux', files: { '/var/lib/dbus/machine-id': `${MACHINE_B}\n` } })),
  )
  assert.deepEqual(fallback.calls, ['read /etc/machine-id', 'read /var/lib/dbus/machine-id'])
})

test('identifier files that are empty, all zero, or placeholder are refused', () => {
  for (const contents of ['', '\n', '   ', '0'.repeat(32), '00000000-0000-0000-0000-000000000000',
    'uninitialized\n', 'to be filled by o.e.m.', 'x']) {
    assert.throws(
      () => resolveDeviceFingerprint(linuxHost(contents)),
      DeviceIdentityError,
      `"${contents}" identifies no machine`,
    )
  }
})

test('an all-ones identifier is refused in either spelling', () => {
  for (const contents of ['f'.repeat(32), 'ffffffff-ffff-ffff-ffff-ffffffffffff']) {
    assert.throws(() => resolveDeviceFingerprint(linuxHost(contents)), DeviceIdentityError)
  }
})

test('a plain 32-hex machine id is accepted, and its case does not matter', () => {
  // The real `/etc/machine-id` form. Refusing placeholders must not reach a legitimate value.
  const machine = '4f2a1c9e7b3d4e519a862c0d5fe71b40'
  const fingerprint = resolveDeviceFingerprint(linuxHost(`${machine}\n`))
  assert.match(fingerprint, HEX64)
  assert.equal(resolveDeviceFingerprint(linuxHost(machine.toUpperCase())), fingerprint)
  const id = deriveAccountDeviceId(ACCOUNT, fingerprint)
  assert.match(id, HEX64)
  assert.ok(!fingerprint.includes(machine) && !id.includes(machine))
})

test('a file that is not an identifier at all is refused', () => {
  for (const contents of ['{"machineId": 42}', 'a'.repeat(200), 'not an id\nsecond line']) {
    assert.throws(() => resolveDeviceFingerprint(linuxHost(contents)), DeviceIdentityError)
  }
})

test('the macOS platform UUID is read from ioreg', () => {
  const seams = darwinHost(MACHINE_A)
  assert.match(resolveDeviceFingerprint(seams), HEX64)
  assert.deepEqual(seams.calls, [`exec ${DARWIN_COMMAND}`])
})

test('two macOS machines derive two fingerprints', () => {
  assert.notEqual(
    resolveDeviceFingerprint(darwinHost(MACHINE_A)),
    resolveDeviceFingerprint(darwinHost(MACHINE_B)),
  )
})

test('an ioreg transcript without a platform UUID is unavailable', () => {
  const seams = host({
    platform: 'darwin',
    commands: { [DARWIN_COMMAND]: '+-o IOPlatformExpertDevice\n  {\n    "IOPlatformSerialNumber" = "SYNTHETIC0001"\n  }' },
  })
  assert.throws(() => resolveDeviceFingerprint(seams), DeviceIdentityError)
})

test('a platform whose identifier this module cannot read is unavailable', () => {
  let thrown: unknown
  try {
    resolveDeviceFingerprint(host({ platform: 'freebsd', files: { '/etc/hostid': MACHINE_A } }))
  } catch (error: unknown) {
    thrown = error
  }
  assert.ok(thrown instanceof DeviceIdentityError)
  assert.match(thrown.message, /freebsd/u)
})

test('one reader reads the machine once and returns the same fingerprint', () => {
  const seams = linuxHost(`${MACHINE_A}\n`)
  const read = createDeviceFingerprintReader(seams)
  const first = read()
  assert.match(first, HEX64)
  assert.equal(read(), first)
  assert.equal(read(), first)
  assert.deepEqual(seams.calls, ['read /etc/machine-id'])
})

test('a read that failed is not cached as a permanent verdict', () => {
  const files: Record<string, string> = {}
  const seams = host({ platform: 'linux', files })
  const read = createDeviceFingerprintReader(seams)
  assert.throws(() => read(), DeviceIdentityError)
  assert.equal(seams.calls.length, 2, 'both candidate paths were tried and neither answered')
  files['/etc/machine-id'] = `${MACHINE_A}\n`
  assert.match(read(), HEX64)
  assert.equal(seams.calls.length, 3, 'the failed read was retried rather than cached')
})

/**
 * The module's source with its comments blanked, so a guard reads the code plane.
 *
 * The module's own contract text names the paths it must never take — `DSH_HOME` among
 * them — so scanning the raw text would reject the documentation that states the invariant.
 * @param source - the module's full source text.
 * @returns the source with block and line comments removed.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/[^\n]*/gu, ' ')
}

test('the module reaches no credential, no cache path, and no output sink', async () => {
  const code = codeOnly(await moduleSource())
  for (const forbidden of ['accessToken', 'refreshToken', 'expiresAt', 'DSH_HOME',
    'console.', 'process.stdout', 'process.stderr', '../auth/']) {
    assert.ok(!code.includes(forbidden), `${forbidden} must not be reachable from device identity`)
  }
})

test('the host seam set is built only inside the exported reader', async () => {
  const source = await moduleSource()
  const constructions = source.match(/createDeviceFingerprintReader\(hostDeviceSeams\(\)\)/gu) ?? []
  assert.equal(constructions.length, 1, 'importing the module must read nothing from the host')
  assert.match(
    source,
    /export function readLocalDeviceFingerprint\(\): string \{\n\s+localFingerprintReader \?\?= createDeviceFingerprintReader\(hostDeviceSeams\(\)\)/u,
  )
})

test('the production reader is exported and this suite never invokes it', () => {
  // Named, not called: an accidental call would read this machine's real identifier.
  assert.equal(typeof readLocalDeviceFingerprint, 'function')
  assert.equal(readLocalDeviceFingerprint.length, 0)
})
