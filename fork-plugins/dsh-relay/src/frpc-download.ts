/**
 * frpc acquisition.
 *
 * The relay states which frp release it runs; the client downloads that
 * release's official asset for this platform, checks the archive against the
 * pinned SHA-256, and only then extracts the executable. An unknown version or
 * a mismatching archive is refused rather than run.
 *
 * @module dsh-relay/frpc-download
 */
import { createHash } from 'node:crypto'
import { chmod, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { FRPC_PLATFORM_KEYS, frpcAssetName, frpcHashKey } from './config.ts'
import { isAbortError, relayError } from './errors.ts'
import { extractFrpcBinary } from './frpc-archive.ts'
import { ensurePrivateDirectory, writePrivateBinaryFile, writePrivateFile } from './frpc-config.ts'

/** GitHub release host for the public frp project. */
const FRP_RELEASE_BASE = 'https://github.com/fatedier/frp/releases/download'

/** Installation directory below the Harness home. */
const RELAY_HOME_DIRECTORY = 'dsh-relay'

/** Subdirectory holding the downloaded executable. */
const BIN_DIRECTORY = 'bin'

/** Marker recording which version/platform the installed executable belongs to. */
const MARKER_FILE = 'frpc.installed.json'

/** Executable mode. */
const EXECUTABLE_MODE = 0o700

/** Stored marker contents. */
interface InstalledMarker {
  readonly version: string
  readonly platformKey: string
  readonly sha256: string
}

/**
 * `<platform>-<arch>` key from Node platform and architecture names.
 * @param platform - Node platform name.
 * @param arch - Node architecture name.
 * @returns the manifest key.
 * @throws RelayError `frpc-unsupported` for a platform the frp release does not cover.
 */
export function frpcPlatformKey(platform: string, arch: string): string {
  const key = `${platform}-${arch === 'x64' ? 'x64' : arch}`
  if (!(FRPC_PLATFORM_KEYS as readonly string[]).includes(key)) {
    throw relayError('frpc-unsupported', `no frpc build is available for ${platform}-${arch}`)
  }
  return key
}

/**
 * Resolve the pinned archive hash for one release and platform.
 * @param hashes - configured hash table.
 * @param version - frp release version.
 * @param platformKey - `<platform>-<arch>`.
 * @returns the lowercase SHA-256.
 * @throws RelayError `frpc-unsupported` when the table has no entry.
 */
export function expectedFrpcHash(
  hashes: Readonly<Record<string, string>>,
  version: string,
  platformKey: string,
): string {
  const key = frpcHashKey(version, platformKey)
  const expected = hashes[key]
  if (expected === undefined || !/^[0-9a-fA-F]{64}$/u.test(expected)) {
    throw relayError('frpc-unsupported', `no pinned SHA-256 for frp ${version} on ${platformKey}`)
  }
  return expected.toLowerCase()
}

/**
 * Download URL of one official frp release asset.
 * @param version - frp release version.
 * @param platform - Node platform name.
 * @param arch - Node architecture name.
 * @returns the release URL.
 */
export function frpcDownloadUrl(version: string, platform: string, arch: string): string {
  return `${FRP_RELEASE_BASE}/v${version}/${frpcAssetName(version, platform, arch)}`
}

/**
 * Directory holding downloaded executables for one Harness home.
 * @param home - absolute Harness home.
 * @returns `<home>/dsh-relay/bin`.
 */
export function frpcInstallDirectory(home: string): string {
  return join(home, RELAY_HOME_DIRECTORY, BIN_DIRECTORY)
}

/**
 * Executable path for one platform.
 * @param home - absolute Harness home.
 * @param platform - Node platform name.
 * @returns `<home>/dsh-relay/bin/frpc[.exe]`.
 */
export function frpcExecutablePath(home: string, platform: string): string {
  return join(frpcInstallDirectory(home), platform === 'win32' ? 'frpc.exe' : 'frpc')
}

/** Options for {@link installFrpc}. */
export interface InstallFrpcOptions {
  /** frp release version the relay reported. */
  readonly version: string
  /** Node platform name. */
  readonly platform: string
  /** Node architecture name. */
  readonly arch: string
  /** Configured archive hash table. */
  readonly hashes: Readonly<Record<string, string>>
  /** Absolute Harness home. */
  readonly home: string
  /** Download deadline in milliseconds. */
  readonly timeoutMs: number
  /** Cancellation signal from the owning connection attempt. */
  readonly signal?: AbortSignal
  /** Fetch implementation; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch
  /** Release-download base URL; defaults to the official frp releases. Tests point it at a local server. */
  readonly downloadBaseUrl?: string
  /** Receives byte progress while the archive downloads. */
  readonly onProgress?: (received: number, total: number | undefined) => void
}

/** Result of {@link installFrpc}. */
export interface InstalledFrpc {
  /** Absolute executable path. */
  readonly path: string
  /** frp release version. */
  readonly version: string
  /** Whether this call downloaded the archive. */
  readonly downloaded: boolean
}

async function readMarker(path: string): Promise<InstalledMarker | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<InstalledMarker>
    if (typeof raw.version !== 'string' || typeof raw.platformKey !== 'string' || typeof raw.sha256 !== 'string') {
      return undefined
    }
    return { version: raw.version, platformKey: raw.platformKey, sha256: raw.sha256 }
  } catch {
    return undefined
  }
}

/**
 * Download one archive, reporting progress and enforcing the deadline.
 * @param url - release asset URL.
 * @param options - timeout, cancellation, fetch implementation, and progress sink.
 * @returns the archive bytes.
 */
export async function downloadFrpcArchive(
  url: string,
  options: {
    timeoutMs: number
    signal?: AbortSignal
    fetchImpl?: typeof fetch
    onProgress?: (received: number, total: number | undefined) => void
  },
): Promise<Buffer> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const combined = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let response: Response
  try {
    response = await fetchImpl(url, { signal: combined, redirect: 'follow' })
  } catch (error) {
    if (isAbortError(error)) {
      throw relayError(options.signal?.aborted === true ? 'network-cancelled' : 'network-timeout', 'the frpc download did not finish in time')
    }
    throw relayError('network-unreachable', 'the frpc download failed', error)
  }
  if (!response.ok) {
    throw relayError('frpc-download-failed', `the frpc download answered with status ${String(response.status)}`)
  }
  const totalHeader = response.headers.get('content-length')
  const total = totalHeader === null ? undefined : Number(totalHeader)
  const reader = response.body?.getReader()
  if (reader === undefined) {
    const buffer = Buffer.from(await response.arrayBuffer())
    options.onProgress?.(buffer.length, total)
    return buffer
  }
  const chunks: Buffer[] = []
  let received = 0
  while (true) {
    let result: ReadableStreamReadResult<Uint8Array>
    try {
      result = await reader.read()
    } catch (error) {
      if (isAbortError(error)) {
        throw relayError(options.signal?.aborted === true ? 'network-cancelled' : 'network-timeout', 'the frpc download did not finish in time')
      }
      throw relayError('frpc-download-failed', 'the frpc download stream failed', error)
    }
    if (result.done) break
    const chunk = Buffer.from(result.value)
    chunks.push(chunk)
    received += chunk.length
    options.onProgress?.(received, total)
  }
  return Buffer.concat(chunks)
}

/**
 * Ensure one frp release executable is installed and verified.
 *
 * A marker recording the version and platform lets a later connection reuse the
 * installed executable. A new download is checked before it is extracted, and
 * the extracted bytes are written owner-only.
 * @param options - release, platform, hashes, home, and download controls.
 * @returns the installed executable path.
 * @throws RelayError `frpc-unsupported`, `frpc-hash-mismatch`, `frpc-download-failed`,
 * `network-unreachable`, `network-timeout`, or `network-cancelled`.
 */
export async function installFrpc(options: InstallFrpcOptions): Promise<InstalledFrpc> {
  const platformKey = frpcPlatformKey(options.platform, options.arch)
  const expected = expectedFrpcHash(options.hashes, options.version, platformKey)
  const directory = frpcInstallDirectory(options.home)
  const executable = frpcExecutablePath(options.home, options.platform)
  const markerPath = join(directory, MARKER_FILE)
  const marker = await readMarker(markerPath)
  if (marker !== undefined && marker.version === options.version
    && marker.platformKey === platformKey && marker.sha256 === expected) {
    try {
      const info = await stat(executable)
      if (info.isFile() && info.size > 0) {
        return { path: executable, version: options.version, downloaded: false }
      }
    } catch {
      // Missing or unreadable: install it again below.
    }
  }
  const url = `${options.downloadBaseUrl ?? FRP_RELEASE_BASE}/v${options.version}/${frpcAssetName(options.version, options.platform, options.arch)}`
  const archive = await downloadFrpcArchive(url, {
    timeoutMs: options.timeoutMs,
    ...options.signal === undefined ? {} : { signal: options.signal },
    ...options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
    ...options.onProgress === undefined ? {} : { onProgress: options.onProgress },
  })
  const actual = createHash('sha256').update(archive).digest('hex')
  if (actual !== expected) {
    throw relayError('frpc-hash-mismatch', `the frp ${options.version} archive hash ${actual} does not match the pinned ${expected}`)
  }
  const binary = extractFrpcBinary(archive, options.platform)
  await ensurePrivateDirectory(directory)
  await writePrivateBinaryFile(executable, binary)
  await chmod(executable, EXECUTABLE_MODE).catch(() => {
    // Windows has no POSIX mode bits; the filesystem ACL is the owner boundary.
  })
  const markerValue: InstalledMarker = { version: options.version, platformKey, sha256: expected }
  await writePrivateFile(markerPath, `${JSON.stringify(markerValue, undefined, 2)}\n`)
  return { path: executable, version: options.version, downloaded: true }
}
