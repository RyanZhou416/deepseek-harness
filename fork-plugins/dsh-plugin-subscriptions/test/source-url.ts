/**
 * Locate a source module from either layout a spec runs in: `test/` under tsx, or
 * `lib-test/test/` after the suite compiles. Source-inspecting guards read the
 * module text, so they must resolve the same file in both layouts.
 */
import { existsSync } from 'node:fs'

/**
 * Resolve one module's source file below `src`.
 * @param relative - the module path below `src`, for example `providers/unified-rate-limit.ts`.
 * @returns the existing source file URL.
 */
export function sourceUrl(relative: string): URL {
  for (const candidate of [
    new URL(`../src/${relative}`, import.meta.url),
    new URL(`../../src/${relative}`, import.meta.url),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`source not found: ${relative}`)
}
