/**
 * Version coherence for a pinned client profile.
 *
 * The version a client claims is not decoration: it appears in the user agent and in
 * the billing header's `cc_version`, the beta set that travels alongside it is
 * version-specific, and the service both refuses requests whose claimed version is
 * below a managed floor and withholds models whose catalogue entry names a newer
 * minimum. A profile whose parts disagree therefore misrepresents the client in ways a
 * server can see, without any code being wrong in isolation.
 *
 * This module states those relationships once, so a profile that violates them fails
 * loudly in the test suite instead of quietly on the wire.
 */

/** A profile's version-bearing fields, as the coherence rules see them. */
export interface VersionBearingProfile {
  /** Profile identifier, conventionally `claude-code-<cli>-sdk-<sdk>`. */
  readonly id: string;
  /** Client version the profile claims. */
  readonly cliVersion: string;
  /** SDK package version the profile claims. */
  readonly sdkVersion: string;
  /**
   * Value of `CLAUDE_CODE_ENTRYPOINT` the client ran with, absent when unset.
   *
   * The user agent spells an unset entrypoint `cli` while the billing segment
   * spells it `unknown`, so the absent case is not the same claim in both.
   */
  readonly entrypoint?: string;
  /** User agent sent with every request. */
  readonly userAgent: string;
}

/**
 * Beta identifiers introduced after the version this package was pinned at.
 *
 * Read from the carved builds: each entry was absent from 2.1.280 and present from the
 * version named here. A profile claiming an older client must not emit them, because a
 * request carrying a beta the claimed client did not yet know is internally inconsistent.
 */
export const BETA_INTRODUCED_IN: ReadonlyMap<string, string> = new Map([
  ["cache-keepalive-2026-09-03", "2.1.288"],
]);

/**
 * Beta identifiers withdrawn at a version.
 *
 * The converse inconsistency: a profile claiming this version or newer must not emit a
 * beta that the client had already dropped.
 */
export const BETA_REMOVED_IN: ReadonlyMap<string, string> = new Map([
  ["compact-2026-01-12", "2.1.288"],
  ["skills-2025-10-02", "2.1.288"],
  ["user-profiles-2026-03-24", "2.1.288"],
]);

/**
 * Composes the user agent from the fields it must agree with.
 *
 * @param cliVersion - Client version to claim.
 * @param entrypoint - Value of `CLAUDE_CODE_ENTRYPOINT`, undefined when unset.
 * @returns The user agent string for that pair.
 */
export function composeUserAgent(
  cliVersion: string,
  entrypoint?: string,
): string {
  return `claude-cli/${cliVersion} (external, ${entrypoint ?? "cli"})`;
}


/**
 * Compares two dotted numeric versions.
 *
 * @param left - First version.
 * @param right - Second version.
 * @returns Negative, zero or positive as the first sorts before, with, or after the second.
 */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10));
  const b = right.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Reports every way a profile's version-bearing fields disagree.
 *
 * @param profile - Profile to check.
 * @returns One message per disagreement, empty when the profile is coherent.
 */
export function checkProfileCoherence(profile: VersionBearingProfile): readonly string[] {
  const problems: string[] = [];
  const expectedUserAgent = composeUserAgent(profile.cliVersion, profile.entrypoint);
  if (profile.userAgent !== expectedUserAgent) {
    problems.push(
      `user agent '${profile.userAgent}' does not name the claimed client: expected '${expectedUserAgent}'`,
    );
  }
  if (!profile.id.includes(profile.cliVersion)) {
    problems.push(`profile id '${profile.id}' does not carry its client version ${profile.cliVersion}`);
  }
  if (!profile.id.includes(profile.sdkVersion)) {
    problems.push(`profile id '${profile.id}' does not carry its SDK version ${profile.sdkVersion}`);
  }
  return problems;
}

/**
 * Reports betas whose vintage disagrees with the claimed client version.
 *
 * Takes the identifiers actually composed for a request rather than a profile field,
 * because the emitted set depends on the request: a beta the claimed client had not yet
 * learned, or had already dropped, makes that request internally inconsistent whatever
 * the profile says.
 *
 * @param cliVersion - Version the request claims.
 * @param betas - Beta identifiers the request will carry.
 * @returns One message per disagreement, empty when they agree.
 */
export function checkBetaVintage(cliVersion: string, betas: readonly string[]): readonly string[] {
  const problems: string[] = [];
  for (const beta of betas) {
    const introduced = BETA_INTRODUCED_IN.get(beta);
    if (introduced !== undefined && compareVersions(cliVersion, introduced) < 0) {
      problems.push(`beta '${beta}' was introduced at ${introduced} but the claim is ${cliVersion}`);
    }
    const removed = BETA_REMOVED_IN.get(beta);
    if (removed !== undefined && compareVersions(cliVersion, removed) >= 0) {
      problems.push(`beta '${beta}' was withdrawn at ${removed} but the claim is ${cliVersion}`);
    }
  }
  return problems;
}

/**
 * Reports how far a claimed version trails a newer one, for operator visibility.
 *
 * Deliberately local: the caller supplies the newest version it knows, so this never
 * performs a request.
 *
 * @param profile - Profile in use.
 * @param newestKnown - Newest client version the caller has observed.
 * @returns A message when the claim trails, otherwise null.
 */
export function describeStaleness(
  profile: VersionBearingProfile,
  newestKnown: string,
): string | null {
  if (compareVersions(profile.cliVersion, newestKnown) >= 0) return null;
  return `profile claims ${profile.cliVersion} while ${newestKnown} has been observed`;
}
