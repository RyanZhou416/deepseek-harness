/**
 * Locates the Bun runtime that carries the masqueraded transport.
 *
 * The runtime is a versioned artifact, not an ambient tool: the transport's whole
 * point is that the request is serialized and handshaked by a specific runtime, so
 * an unpinned `bun` on `PATH` would silently reintroduce the variance this exists
 * to remove. Resolution order is an explicit override, then the platform package
 * the plugin declares, and a missing runtime is a hard error rather than a
 * fallback.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Environment variable naming a Bun executable to use instead of the package. */
export const BUN_PATH_ENV = 'DSH_SUBSCRIPTIONS_BUN_PATH'

/** Failure raised when no usable Bun runtime can be located. */
export class BunRuntimeError extends Error {
  /**
   * @param detail - What was searched and what the caller can do about it.
   */
  constructor(detail: string) {
    super(detail)
    this.name = 'BunRuntimeError'
  }
}

/** Platform packages published for the supported targets. */
const PLATFORM_PACKAGES: Readonly<Record<string, string>> = {
  'win32-x64': '@oven/bun-windows-x64',
  'win32-arm64': '@oven/bun-windows-arm64',
  'darwin-arm64': '@oven/bun-darwin-arm64',
  'darwin-x64': '@oven/bun-darwin-x64',
  'linux-x64': '@oven/bun-linux-x64',
  'linux-arm64': '@oven/bun-linux-aarch64',
}

/** Executable name inside a platform package. */
function executableName(): string {
  return process.platform === 'win32' ? 'bun.exe' : 'bun'
}

/**
 * Resolves the Bun executable to run the transport child with.
 *
 * @param env - Environment to read the override from; defaults to `process.env`.
 * @param requireFrom - Module whose resolution paths locate the platform package.
 * @returns Absolute path to the executable.
 * @throws BunRuntimeError when the override is set but missing, the platform is
 *   unsupported, or the declared package is not installed.
 */
export function resolveBunRuntime(
  env: NodeJS.ProcessEnv = process.env,
  requireFrom: NodeRequire = createRequire(import.meta.url),
): string {
  const override = env[BUN_PATH_ENV]
  if (override !== undefined && override !== '') {
    if (!existsSync(override)) {
      throw new BunRuntimeError(`${BUN_PATH_ENV} points at a missing file: ${override}`)
    }
    return override
  }

  const key = `${process.platform}-${process.arch}`
  const packageName = PLATFORM_PACKAGES[key]
  if (packageName === undefined) {
    throw new BunRuntimeError(`no pinned Bun runtime is published for ${key}`)
  }

  // The platform packages do not expose `package.json` through `exports`, so the
  // loader's search paths are walked directly.
  const segments = packageName.split('/')
  for (const root of requireFrom.resolve.paths(packageName) ?? []) {
    const binary = join(root, ...segments, 'bin', executableName())
    if (existsSync(binary)) return binary
  }
  throw new BunRuntimeError(
    `${packageName} is not installed; install it or point ${BUN_PATH_ENV} at a Bun executable`,
  )
}
