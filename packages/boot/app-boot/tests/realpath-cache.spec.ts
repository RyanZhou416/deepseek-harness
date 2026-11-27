import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createRealpathCache } from '../src/profile-resolution/realpath-cache.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A directory link that needs no symlink privilege on Windows. */
function linkDir(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

/** The outcome `fs.realpathSync` reports, as a comparable value. */
function outcome(read: (path: string) => string, path: string): string {
  try {
    return read(path)
  } catch (error) {
    return `error:${String((error as NodeJS.ErrnoException).code)}`
  }
}

describe('createRealpathCache', () => {
  it('returns what fs.realpathSync returns for plain, linked, chained, dangling, relative, and missing paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-realpath-'))
    roots.push(root)
    const store = join(root, 'store', 'pkg@1', 'node_modules', 'pkg')
    mkdirSync(join(store, 'lib'), { recursive: true })
    mkdirSync(join(root, 'app', 'node_modules'), { recursive: true })
    linkDir(store, join(root, 'app', 'node_modules', 'pkg'))
    linkDir(join(root, 'app'), join(root, 'app-link'))
    linkDir(join(root, 'app-link', 'node_modules', 'pkg'), join(root, 'chained'))
    linkDir(join(root, 'gone'), join(root, 'dangling'))
    const inputs = [
      root,
      store,
      join(root, 'app', 'node_modules', 'pkg'),
      join(root, 'app', 'node_modules', 'pkg', 'lib'),
      join(root, 'app-link', 'node_modules', 'pkg', 'lib'),
      join(root, 'chained'),
      join(root, 'chained', 'lib'),
      join(root, 'dangling'),
      join(root, 'missing', 'deeper'),
      relative(process.cwd(), join(root, 'app-link', 'node_modules')),
    ]
    const cached = createRealpathCache()
    // Twice each: the second pass is served from the shared cache.
    for (const path of [...inputs, ...inputs]) {
      expect(outcome(cached, path), path).toBe(outcome(realpathSync, path))
    }
  })

  it('keeps its cache per instance', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-realpath-'))
    roots.push(root)
    mkdirSync(join(root, 'first'))
    mkdirSync(join(root, 'second'))
    linkDir(join(root, 'first'), join(root, 'current'))
    const before = createRealpathCache()
    expect(before(join(root, 'current'))).toBe(realpathSync(join(root, 'first')))
    rmSync(join(root, 'current'), { recursive: false, force: true })
    linkDir(join(root, 'second'), join(root, 'current'))
    // A new pass sees the replaced link; the earlier cache still describes its own pass.
    expect(createRealpathCache()(join(root, 'current'))).toBe(realpathSync(join(root, 'second')))
    expect(before(join(root, 'current'))).toBe(realpathSync(join(root, 'first')))
  })
})
