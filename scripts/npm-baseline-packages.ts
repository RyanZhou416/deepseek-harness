/** Manifest discovery for the npm baseline's vendor, harness, and application packages. */

import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES } from './experimental-package-policy.ts'

const PACKAGE_PATTERNS = [
  'vendor/*/package.json',
  'packages/*/*/package.json',
  'apps/*/package.json',
] as const

/**
 * Whether one discovered manifest declares itself private.
 *
 * A private package never publishes, so the baseline leaves it out even when its
 * directory is not on the configured denylist; the fork-only packages are the
 * current example.
 * @param root - repository root the manifest path resolves against.
 * @param manifestPath - repository-relative manifest path.
 * @returns whether the manifest carries `"private": true`.
 */
function isPrivateManifest(root: string, manifestPath: string): boolean {
  const parsed: unknown = JSON.parse(readFileSync(join(root, manifestPath), 'utf8'))
  return typeof parsed === 'object' && parsed !== null && (parsed as { private?: unknown }).private === true
}

/**
 * Discover baseline manifests, leaving out private packages and the configured
 * private experimental directories.
 * @param root - repository root to scan.
 * @param privateDirectories - repository-relative experimental directories excluded from publication.
 * @returns Sorted repository-relative manifest paths with forward slashes.
 */
export function discoverNpmBaselineManifests(
  root: string,
  privateDirectories: readonly string[] = PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES,
): string[] {
  return globSync(PACKAGE_PATTERNS, {
    cwd: root,
    exclude: privateDirectories.map(directory => `${directory}/package.json`),
  }).map(path => path.replaceAll('\\', '/')).filter(path => !isPrivateManifest(root, path)).sort()
}
