/**
 * Desktop identity for the Claude provider.
 *
 * The Windows desktop application runs this same client with its own entrypoint and adds
 * five client headers. Three are constants; two describe the machine, and upstream derives
 * both from the host's physical memory — bucketing it for the class and rounding it to
 * gigabytes.
 *
 * Reporting this host's memory would publish the machine's real size on every request and
 * would make every account served here look like the same machine. Neither is acceptable
 * when several accounts share a host: a distinctive memory size identifies the operator,
 * and one device presenting several accounts is not something the genuine client ever
 * does. The pair is therefore derived once per account from that account's device id and
 * then frozen, so one account always presents one plausible machine, and no two accounts
 * present the same one.
 */

import { createHash } from 'node:crypto'

/** Application version the desktop reports, from its release manifest. */
export const CLAUDE_DESKTOP_APP_VERSION = '2.19675.1'

/** Platform value the desktop declares. */
const CLIENT_PLATFORM = 'desktop_app'

/** Bundle identifier the desktop declares. */
const CLIENT_APP = 'com.anthropic.claudefordesktop'

/**
 * Memory sizes a plausible desktop reports, weighted toward the common ones.
 *
 * The client never sends these on a Messages request: the three names that carry them exist
 * only in the desktop application's own Electron code, and the environment that application
 * hands its Claude Code child names exactly two headers, platform and version. They are kept
 * because the profile's identity is described by them, and because a future caller that
 * reproduces one of the application's own requests would need them; nothing on the Messages
 * path may use them.
 *
 * Both extremes are excluded deliberately: a 4 GB machine is rare enough to stand out, and
 * a 64 GB one is distinctive enough to identify its operator.
 */
const PLAUSIBLE_MEMORY_GB = [8, 16, 16, 16, 32] as const

/** The machine values the desktop declares, as one self-consistent pair. */
export interface DesktopMachineProfile {
  /** Total physical memory in gigabytes, as the desktop rounds it. */
  readonly totalMemoryGb: number
  /** Memory bucket that size falls in, computed as the desktop computes it. */
  readonly deviceClass: string
}

/**
 * Memory bucket the desktop declares for a total memory size.
 *
 * Upstream buckets on total memory in bytes: below 6 GB, below 12 GB, below 20 GB, else
 * the largest bucket.
 *
 * @param totalMemoryBytes - Total physical memory in bytes.
 * @returns The bucket identifier.
 */
export function desktopDeviceClass(totalMemoryBytes: number): string {
  if (totalMemoryBytes < 6e9) return 'le4'
  if (totalMemoryBytes < 12e9) return '8'
  if (totalMemoryBytes < 2e10) return '16'
  return 'gt16'
}

/**
 * The machine profile one account presents.
 *
 * Deterministic in the seed, so an account presents the same machine for as long as its
 * device id lives, and two accounts differ unless their digests collide. The bucket is
 * computed from the reported size with the desktop's own function, so the pair is always
 * self-consistent: a client that reported 16 GB under the `gt16` bucket would contradict
 * itself.
 *
 * @param deviceId - Seed identifying the account; its device id.
 * @returns Memory size and the bucket that size falls in.
 */
export function desktopMachineProfile(deviceId: string): DesktopMachineProfile {
  const digest = createHash('sha256').update(deviceId).digest()
  const index = digest[0] === undefined ? 0 : digest[0] % PLAUSIBLE_MEMORY_GB.length
  const totalMemoryGb = PLAUSIBLE_MEMORY_GB[index] ?? PLAUSIBLE_MEMORY_GB[0]
  return { totalMemoryGb, deviceClass: desktopDeviceClass(totalMemoryGb * 1024 ** 3) }
}

/**
 * The headers the client itself adds to a Messages request.
 *
 * Only two. The desktop application composes five, but it composes them for its own calls;
 * what it puts in the spawned client's environment is the platform and the version, and the
 * client composes exactly those two when the environment does not already carry them. The
 * remaining three names appear nowhere in the client, so sending them would be three headers
 * no genuine Messages request has ever carried.
 *
 * @returns Header name/value pairs, in the order the client composes them.
 */
export function desktopClientHeaders(): Record<string, string> {
  return {
    'anthropic-client-platform': CLIENT_PLATFORM,
    'anthropic-client-version': CLAUDE_DESKTOP_APP_VERSION,
  }
}

/**
 * The five headers the desktop application composes for its own Electron-side calls.
 *
 * Not for the Messages path: see {@link desktopClientHeaders}. Kept so the machine values a
 * desktop would report stay described, and so the account-derived pair can be checked for the
 * self-consistency the application's own bucketing guarantees.
 *
 * @param profile - The account's machine profile.
 * @returns Header name/value pairs, in the order the application composes them.
 */
export function desktopApplicationHeaders(profile: DesktopMachineProfile): Record<string, string> {
  return {
    'anthropic-client-platform': CLIENT_PLATFORM,
    'anthropic-client-app': CLIENT_APP,
    'anthropic-client-version': CLAUDE_DESKTOP_APP_VERSION,
    'anthropic-client-device-class': profile.deviceClass,
    'anthropic-client-total-memory-gb': String(profile.totalMemoryGb),
  }
}
