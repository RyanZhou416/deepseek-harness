/**
 * Device identity for the Claude provider.
 *
 * The wire device id is derived from the caller's stable account key and this machine's own
 * operating-system identifier, so the same account on the same machine rebuilds one id after
 * the harness cache, the credential record, or `DSH_HOME` is lost. That identifier is the
 * operating system's installation identity, not immutable hardware: reinstalling or cloning
 * can change or duplicate it, and a clone presents the same identifier as its source. Nothing
 * here detects that, and no network address, hostname, OS version, or memory size is read.
 *
 * The raw identifier never leaves this module: the exported identity reads return a hash or
 * throw, and no message carries the registry value, the file's contents, or the platform UUID.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** Namespaces separating these hashes from every other hash of the same input. */
const FINGERPRINT_NAMESPACE = 'claude-device-fingerprint:'
const DEVICE_ID_NAMESPACE = 'claude-device-id:'

/**
 * The failure code a caller may key on when no machine identifier can be read. Deliberately
 * not `AUTH`: the credential is sound, no account is at fault, and no route may retry it.
 */
export const DEVICE_IDENTITY_UNAVAILABLE = 'CLAUDE_DEVICE_IDENTITY_UNAVAILABLE'

/**
 * No usable machine identifier on this host. An {@link LlmError}, so a classifier that
 * re-wraps a thrown fetch failure returns it unchanged instead of reclassifying it as a
 * retryable transport failure.
 */
export class DeviceIdentityError extends LlmError {
  /** @param message - what could not be read; never the value or the environment. */
  constructor(message: string) {
    super(message, DEVICE_IDENTITY_UNAVAILABLE)
    this.name = 'DeviceIdentityError'
  }
}

/**
 * The host reads one fingerprint is resolved from. Every access is a seam, so the resolution
 * can be exercised for Windows, Linux and macOS output on one machine and a test never reads
 * this host's real identifier.
 */
export interface DeviceFingerprintSeams {
  /** The host platform, as `process.platform`. */
  readonly platform: NodeJS.Platform
  /** The environment, read for the Windows directory only. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Read one small system file as UTF-8; throws when it cannot be read. */
  readonly readFile: (path: string) => string
  /** Run one bounded system command and return its stdout; throws on failure or timeout. */
  readonly execFile: (file: string, args: readonly string[]) => string
}

/** Accepted identifier length in characters; real machine ids are 32 to 36. */
const MIN_IDENTIFIER_CHARS = 8
const MAX_IDENTIFIER_CHARS = 128
/** Bounds on one identifier command, matching the credential keychain read. */
const IDENTIFIER_COMMAND_TIMEOUT_MS = 3_000
const IDENTIFIER_COMMAND_MAX_BUFFER = 256 * 1024
/** The Windows registry machine GUID, read in the 64-bit view. */
const WINDOWS_MACHINE_GUID_KEY = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography'
const WINDOWS_MACHINE_GUID_VALUE = 'MachineGuid'
const WINDOWS_REGISTRY_VIEW = '/reg:64'
/** The Linux files carrying the machine id, in the order they are tried. */
const LINUX_MACHINE_ID_PATHS: readonly string[] = ['/etc/machine-id', '/var/lib/dbus/machine-id']
/** The macOS command carrying the platform UUID. */
const DARWIN_IOREG = '/usr/sbin/ioreg'
/** Values an operating system reports that name no machine. */
const PLACEHOLDER_IDENTIFIERS =
  /^(?:uninitialized|none|null|unknown|undefined|not specified|to be filled by o\.e\.m\.|default string|n\/a)$/u

/**
 * The device id one account presents on one machine.
 *
 * Pure: the same account key and fingerprint always return the same id, in any process, with
 * no cache, store, or credential involved.
 *
 * @param accountKey - the stable account key the caller chose; a caller that has none must
 *   defer the derivation, because this module substitutes no fallback.
 * @param fingerprint - the machine fingerprint from {@link resolveDeviceFingerprint}.
 * @returns a 64-character lowercase hex id, the format the client uses.
 * @throws DeviceIdentityError when either input is empty.
 */
export function deriveAccountDeviceId(accountKey: string, fingerprint: string): string {
  if (accountKey.trim().length === 0) {
    throw new DeviceIdentityError('no device id was derived because the account key is empty')
  }
  if (fingerprint.trim().length === 0) {
    throw new DeviceIdentityError('no device id was derived because the machine fingerprint is empty')
  }
  // A JSON tuple frames both values, so one key cannot read as another key's fingerprint.
  return createHash('sha256').update(`${DEVICE_ID_NAMESPACE}${JSON.stringify([accountKey, fingerprint])}`).digest('hex')
}

/**
 * The fingerprint of this host's machine identifier.
 *
 * The hash carries the platform and the normalized identifier, never the source that supplied
 * it: on Linux the same id normally stands in both files, so a fingerprint that changed when
 * the first became readable would move the device id for no change in the machine.
 *
 * @param seams - the host reads to resolve through.
 * @returns a 64-character lowercase hex fingerprint.
 * @throws DeviceIdentityError when no source here yields a usable identifier.
 */
export function resolveDeviceFingerprint(seams: DeviceFingerprintSeams): string {
  const identifier = readMachineIdentifier(seams)
  if (identifier === undefined) {
    throw new DeviceIdentityError(
      `no usable machine identifier on ${seams.platform}; the device id is not derived from the account alone`,
    )
  }
  return createHash('sha256').update(`${FINGERPRINT_NAMESPACE}${seams.platform}\u0000${identifier}`).digest('hex')
}

/**
 * A reader that resolves the fingerprint once and returns it for every later call. Only a
 * successful read is remembered, so a host that becomes readable later recovers and a failure
 * never becomes a permanent verdict.
 *
 * @param seams - the host reads to resolve through.
 * @returns the memoized reader.
 */
export function createDeviceFingerprintReader(seams: DeviceFingerprintSeams): () => string {
  let cached: string | undefined
  return () => {
    cached ??= resolveDeviceFingerprint(seams)
    return cached
  }
}

let localFingerprintReader: (() => string) | undefined

/**
 * This process's machine fingerprint, read once. The first call performs the platform's own
 * read, and later calls return the remembered fingerprint; only the hash is held, in this
 * process's memory, and it is never written to the store or to a log.
 *
 * @returns a 64-character lowercase hex fingerprint.
 * @throws DeviceIdentityError when this host's identifier cannot be read.
 */
export function readLocalDeviceFingerprint(): string {
  localFingerprintReader ??= createDeviceFingerprintReader(hostDeviceSeams())
  return localFingerprintReader()
}

/** Run one host read, or answer undefined when it fails: a failed source is an absent one. */
function attempt(probe: () => string): string | undefined {
  try {
    return probe()
  } catch (probeError: unknown) {
    // The raw output, the path and the environment stay out of every diagnostic.
    void probeError
    return undefined
  }
}

/** The canonical machine identifier for this platform, or undefined when it has none. */
function readMachineIdentifier(seams: DeviceFingerprintSeams): string | undefined {
  switch (seams.platform) {
    case 'win32': return canonicalIdentifier(readWindowsMachineGuid(seams))
    case 'linux': return firstIdentifierFile(seams)
    case 'darwin': return canonicalIdentifier(readDarwinPlatformUuid(seams))
    // No source is read on any other platform; a fabricated identifier would be worse.
    default: return undefined
  }
}

/** The Windows machine GUID, or undefined when the registry does not disclose one. */
function readWindowsMachineGuid(seams: DeviceFingerprintSeams): string | undefined {
  // One key, one value: a transcript carrying a second `REG_SZ` is not one this reads.
  const stdout = attempt(() => seams.execFile(`${windowsDirectoryOf(seams.env)}\\System32\\reg.exe`, [
    'QUERY', WINDOWS_MACHINE_GUID_KEY, '/v', WINDOWS_MACHINE_GUID_VALUE, WINDOWS_REGISTRY_VIEW,
  ]))
  const parts = stdout?.split('REG_SZ')
  return parts?.length === 2 ? parts[1] : undefined
}

/** The Windows directory from the environment, in any spelling it may have been set under. */
function windowsDirectoryOf(env: Readonly<Record<string, string | undefined>>): string {
  for (const name of ['windir', 'WINDIR', 'SystemRoot', 'SYSTEMROOT']) {
    const value = env[name]?.trim()
    if (value !== undefined && value.length > 0) return value.replace(/[\\/]+$/u, '')
  }
  return 'C:\\Windows'
}

/** The macOS platform UUID, or undefined when `ioreg` does not disclose one. */
function readDarwinPlatformUuid(seams: DeviceFingerprintSeams): string | undefined {
  const stdout = attempt(() => seams.execFile(DARWIN_IOREG, ['-rd1', '-c', 'IOPlatformExpertDevice']))
  const line = stdout?.split('\n').find(candidate => candidate.includes('IOPlatformUUID'))
  const parts = line?.split('" = "')
  return parts?.length === 2 ? parts[1]?.replace(/"\s*$/u, '') : undefined
}

/** The first machine-id file whose contents are a usable identifier. */
function firstIdentifierFile(seams: DeviceFingerprintSeams): string | undefined {
  for (const path of LINUX_MACHINE_ID_PATHS) {
    const canonical = canonicalIdentifier(attempt(() => seams.readFile(path)))
    if (canonical !== undefined) return canonical
  }
  return undefined
}

/**
 * The canonical identifier, or undefined for an empty, all-zero, all-ones, placeholder, or
 * non-identifier value. Whitespace, surrounding quotes and case are normalized away.
 *
 * @param raw - the value as the platform reported it.
 * @returns the canonical identifier, or undefined when the value names no machine.
 */
function canonicalIdentifier(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const unquoted = raw.trim().replace(/^"([^"]*)"$/u, '$1').trim()
  if (unquoted.length < MIN_IDENTIFIER_CHARS || unquoted.length > MAX_IDENTIFIER_CHARS) return undefined
  const canonical = unquoted.toLowerCase()
  if (!/^[0-9a-z][0-9a-z._:-]*$/u.test(canonical)) return undefined
  if (/^(?:0+|f+)$/u.test(canonical.replace(/[-:._]/gu, ''))) return undefined
  return PLACEHOLDER_IDENTIFIERS.test(canonical) ? undefined : canonical
}

/** This host's own reads, built only when {@link readLocalDeviceFingerprint} first runs. */
function hostDeviceSeams(): DeviceFingerprintSeams {
  return {
    platform: process.platform,
    env: process.env,
    readFile: path => readFileSync(path, 'utf8'),
    execFile: (file, args) => execFileSync(file, [...args], {
      encoding: 'utf8',
      timeout: IDENTIFIER_COMMAND_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: IDENTIFIER_COMMAND_MAX_BUFFER,
    }),
  }
}
