import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const buildLauncher = join(repositoryRoot, 'build.cmd')
const cleanLauncher = join(repositoryRoot, 'clean.cmd')
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Windows fork launchers', () => {
  it('delegates cleanup to the repository cleaner without raw deletion commands', () => {
    const source = readFileSync(cleanLauncher, 'utf8')
    expect(source).toContain('call pnpm run clean')
    expect(source).toContain('if exist "node_modules\\tsx\\package.json" goto :clean')
    expect(source).not.toMatch(/\b(?:del|erase|rd|rmdir)\b/i)
    expect(source).not.toContain('DSH_HOME')
  })

  it('bounds pnpm install workers in both Windows entry points', () => {
    for (const launcher of [buildLauncher, cleanLauncher]) {
      const source = readFileSync(launcher, 'utf8')
      expect(source).toContain('if not defined DSH_PNPM_CHILD_CONCURRENCY set "DSH_PNPM_CHILD_CONCURRENCY=4"')
      expect(source).toContain('call pnpm install --child-concurrency=%DSH_PNPM_CHILD_CONCURRENCY%')
    }
  })

  it.skipIf(process.platform !== 'win32')('prepares the pinned pnpm shim and runs only the clean script', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-windows-clean-'))
    temporaryRoots.push(root)
    const bin = join(root, 'bin')
    const shims = join(root, 'dsh-corepack-shims')
    const log = join(root, 'launcher.log')
    mkdirSync(bin)
    mkdirSync(shims)
    writeFileSync(join(bin, 'node.cmd'), '@exit /b 0\r\n')
    writeFileSync(join(bin, 'corepack.cmd'), '@echo corepack %*>>"%DSH_TEST_LOG%"\r\n@exit /b 0\r\n')
    writeFileSync(join(shims, 'pnpm.cmd'), '@echo pnpm %*>>"%DSH_TEST_LOG%"\r\n@exit /b 0\r\n')

    const command = process.env.ComSpec
    if (command === undefined || !existsSync(command)) throw new Error('ComSpec does not name cmd.exe')
    const result = spawnSync(command, ['/d', '/c', cleanLauncher], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        TEMP: root,
        TMP: root,
        DSH_TEST_LOG: log,
      },
    })

    expect(result.signal, result.stderr || result.stdout).toBeNull()
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(result.stdout).toContain('Repository build outputs cleaned successfully.')
    const calls = readFileSync(log, 'utf8').trim().split(/\r?\n/)
    expect(calls[0]).toContain('corepack enable pnpm --install-directory')
    expect(calls[1]).toBe('pnpm run clean')
    expect(calls).toHaveLength(2)
  })
})
