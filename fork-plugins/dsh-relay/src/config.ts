/**
 * Relay plugin configuration: every deployment-varying choice is a validated
 * schema field with no real deployment value in code or defaults. The pinned
 * frp archive hashes are release artifacts of the public frp project, not a
 * deployment value.
 *
 * @module dsh-relay/config
 */
import z from '@deepseek-ai/schemastery'

/** Largest delay a Node timer accepts. */
const MAX_TIMER_MS = 2_147_483_647

/** frp release the pinned hashes cover. */
export const PINNED_FRP_VERSION = '0.71.0'

/** frp platform keys the client downloads for, in the hash-table order. */
export const FRPC_PLATFORM_KEYS = [
  'win32-x64',
  'win32-arm64',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
] as const

/**
 * SHA-256 hashes of the official frp 0.71.0 release archives, keyed by
 * `<version>/<platform>-<arch>`.
 *
 * These are published release checksums, cross-checked against the release's
 * `frp_sha256_checksums.txt`; a downloaded archive that does not match is
 * refused. `frpcHashes` exists so a deployment may pin another frp release
 * without a code change.
 */
export const DEFAULT_FRPC_HASHES: Readonly<Record<string, string>> = Object.freeze({
  '0.71.0/win32-x64': '9e5062e3e5cf07e67144a3a4acf175ef6a2486f3605dd6cf288bae34ab39819f',
  '0.71.0/win32-arm64': 'b56a5c2a1a2a55d11bc27aeef6edabd39f3d194360ea66660cc27281b502cb1c',
  '0.71.0/darwin-x64': '1b1b4e2f1836e21e8733f1dddaacd4ed9ae67d7dbee39046b9d7b7eda6253637',
  '0.71.0/darwin-arm64': '45be02b186860d375ed49a8941ae9569628a54bf14e67fc36b29c98c99dabcc6',
  '0.71.0/linux-x64': '84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716',
  '0.71.0/linux-arm64': 'f33c293c275d8fc68c654b6fba8f10b2551d6463d09a9fc9cffb7227eae82266',
})

/** Raw plugin configuration as cordis.yml supplies it. */
export interface RelayConfig {
  /** Use an existing frpc executable instead of downloading one; no hash check applies. */
  frpcPath?: string
  /** Archive SHA-256 per `<version>/<platform>-<arch>`; defaults to {@link DEFAULT_FRPC_HASHES}. */
  frpcHashes?: Record<string, string>
  /** Deadline for one relay API request. Default: 20000 ms. */
  requestTimeoutMs?: number
  /** Deadline for one frpc archive download. Default: 300000 ms. */
  downloadTimeoutMs?: number
  /** How long frpc may take to report both startup successes before a restart. Default: 30000 ms. */
  connectStartupTimeoutMs?: number
  /** First restart delay after an frpc exit. Default: 1000 ms. */
  reconnectInitialDelayMs?: number
  /** Upper bound for the growing restart delay. Default: 60000 ms. */
  reconnectMaxDelayMs?: number
}

/** Configuration with every default applied. */
export interface ResolvedRelayConfig {
  readonly frpcPath: string | undefined
  readonly frpcHashes: Record<string, string>
  readonly requestTimeoutMs: number
  readonly downloadTimeoutMs: number
  readonly connectStartupTimeoutMs: number
  readonly reconnectInitialDelayMs: number
  readonly reconnectMaxDelayMs: number
}

/** Validated configuration schema. */
export const Config = z.object({
  frpcPath: z.string().min(1),
  frpcHashes: z.dict(z.string().pattern(/^[0-9a-fA-F]{64}$/u)).default({ ...DEFAULT_FRPC_HASHES }),
  requestTimeoutMs: z.natural().min(1).max(MAX_TIMER_MS).default(20_000),
  downloadTimeoutMs: z.natural().min(1).max(MAX_TIMER_MS).default(300_000),
  connectStartupTimeoutMs: z.natural().min(1).max(MAX_TIMER_MS).default(30_000),
  reconnectInitialDelayMs: z.natural().min(1).max(MAX_TIMER_MS).default(1_000),
  reconnectMaxDelayMs: z.natural().min(1).max(MAX_TIMER_MS).default(60_000),
})

/**
 * Validate raw configuration and apply every default.
 * @param config - configuration supplied by the Loader or a direct caller.
 * @returns complete configuration.
 * @throws RangeError when the reconnect ceiling is below the initial delay.
 */
export function resolveRelayConfig(config: RelayConfig = {}): ResolvedRelayConfig {
  const resolved = Config(config) as ResolvedRelayConfig
  if (resolved.reconnectMaxDelayMs < resolved.reconnectInitialDelayMs) {
    throw new RangeError('dsh-relay: reconnectMaxDelayMs must be at least reconnectInitialDelayMs')
  }
  return { ...resolved, frpcHashes: { ...resolved.frpcHashes } }
}

/**
 * Hash-table key for one frp version and platform.
 * @param version - frp release version, without a leading `v`.
 * @param platformKey - `<platform>-<arch>`.
 * @returns the table key.
 */
export function frpcHashKey(version: string, platformKey: string): string {
  return `${version}/${platformKey}`
}

/**
 * Official archive name for one frp release and platform.
 * @param version - frp release version, without a leading `v`.
 * @param platform - `win32`, `darwin`, or `linux`.
 * @param arch - `x64` or `arm64`.
 * @returns the release asset file name.
 */
export function frpcAssetName(version: string, platform: string, arch: string): string {
  const os = platform === 'win32' ? 'windows' : platform
  const cpu = arch === 'x64' ? 'amd64' : arch
  const extension = platform === 'win32' ? 'zip' : 'tar.gz'
  return `frp_${version}_${os}_${cpu}.${extension}`
}
