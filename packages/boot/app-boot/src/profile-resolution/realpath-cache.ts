/**
 * Node's JavaScript `fs.realpathSync` algorithm with a cache shared across calls.
 *
 * Module resolution compares package directories with the paths Node's ESM
 * loader reports, which come from the JavaScript `realpathSync`; its spelling
 * can differ from `realpathSync.native` (letter case, substituted and mapped
 * drives). That algorithm checks every path component with `lstat`, so
 * canonicalizing hundreds of package directories one call at a time repeats
 * the same component checks thousands of times. This implementation follows
 * the same steps and returns the same spelling, and it shares one cache of
 * resolved components across the calls made with it, as Node's loader does
 * with its own cache. A cache describes the file system when it was filled:
 * create one per resolution pass, not per process.
 *
 * @module @deepseek-ai/dsh-app-boot/profile-resolution/realpath-cache
 */

import { lstatSync, readlinkSync, statSync } from 'node:fs'
import { parse, resolve, sep } from 'node:path'

/**
 * Create a canonicalizer whose calls share resolved path components.
 * @returns a function with the result and failures of `fs.realpathSync(path)`.
 */
export function createRealpathCache(): (path: string) => string {
  // Hard components map to themselves; link components map to their link target, which may still contain links.
  const cache = new Map<string, string>()
  // Complete results, kept apart so a link component never answers as a canonical path.
  const results = new Map<string, string>()
  // Roots whose existence was checked (Node checks them on Windows; a POSIX root always exists).
  const roots = new Set<string>()
  const checkRoot = (root: string): void => {
    if (roots.has(root)) return
    lstatSync(root)
    roots.add(root)
  }
  return (input: string): string => {
    let path = resolve(input)
    const original = path
    const known = results.get(path)
    if (known !== undefined) return known
    // Every path below is resolved, so it carries only native separators and a normalized root.
    let current = parse(path).root
    let base = current
    let pos = current.length
    checkRoot(base)
    while (pos < path.length) {
      const separator = path.indexOf(sep, pos)
      const previous = current
      if (separator === -1) {
        const last = path.slice(pos)
        current += last
        base = previous + last
        pos = path.length
      } else {
        current += path.slice(pos, separator + 1)
        base = previous + path.slice(pos, separator)
        pos = separator + 1
      }
      let resolvedLink = cache.get(base)
      if (resolvedLink === base) continue
      if (resolvedLink === undefined) {
        if (!lstatSync(base).isSymbolicLink()) {
          cache.set(base, base)
          continue
        }
        // Like Node: a dangling link fails here, then its target is read.
        statSync(base)
        resolvedLink = resolve(previous, readlinkSync(base))
        cache.set(base, resolvedLink)
      }
      path = resolve(resolvedLink, path.slice(pos))
      current = parse(path).root
      base = current
      pos = current.length
      checkRoot(base)
    }
    results.set(original, path)
    return path
  }
}
