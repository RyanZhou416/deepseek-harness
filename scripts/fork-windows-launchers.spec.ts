import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const buildLauncher = join(repositoryRoot, 'build.cmd')
const cleanLauncher = join(repositoryRoot, 'clean.cmd')
const runLauncher = join(repositoryRoot, 'run.cmd')
const pnpmLauncher = join(repositoryRoot, 'scripts', 'fork-windows-pnpm.cmd')
const pnpmVersion = (JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as { packageManager: string })
  .packageManager.slice('pnpm@'.length)
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Windows fork launchers', () => {
  it('delegates cleanup to the repository cleaner without raw deletion commands', () => {
    const source = readFileSync(cleanLauncher, 'utf8')
    expect(source).toContain('scripts\\fork-windows-pnpm.cmd" run clean')
    expect(source).toContain('if exist "node_modules\\tsx\\package.json" goto :clean')
    expect(source).not.toMatch(/\b(?:del|erase|rd|rmdir)\b/i)
    expect(source).not.toContain('DSH_HOME')
  })

  it('bounds pnpm install workers in both Windows entry points', () => {
    for (const launcher of [buildLauncher, cleanLauncher]) {
      const source = readFileSync(launcher, 'utf8')
      expect(source).toContain('if not defined DSH_PNPM_CHILD_CONCURRENCY set "DSH_PNPM_CHILD_CONCURRENCY=4"')
      expect(source).toContain('scripts\\fork-windows-pnpm.cmd" install --child-concurrency=%DSH_PNPM_CHILD_CONCURRENCY%')
    }
  })

  it('does not route Windows launchers through Corepack', () => {
    for (const launcher of [buildLauncher, cleanLauncher, runLauncher]) {
      const source = readFileSync(launcher, 'utf8')
      expect(source).not.toContain('corepack enable')
      expect(source).toContain('scripts\\fork-windows-pnpm.cmd" --version')
    }
  })

  function fixture(brokenCache: boolean) {
    const root = mkdtempSync(join(tmpdir(), 'dsh windows clean-'))
    temporaryRoots.push(root)
    const bin = join(root, 'bin')
    const log = join(root, 'launcher.log')
    const entry = join(root, `dsh-pnpm-${pnpmVersion}`, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
    const privateBin = join(root, `dsh-pnpm-${pnpmVersion}`, 'node_modules', '.bin')
    const stub = join(root, 'pnpm-stub.mjs')
    mkdirSync(bin)
    mkdirSync(privateBin, { recursive: true })
    writeFileSync(join(privateBin, 'pnpm.cmd'), '@echo off\r\nnode "%~dp0..\\pnpm\\bin\\pnpm.mjs" %*\r\n')
    writeFileSync(join(bin, 'pnpm.cmd'), [
      '@echo off',
      'echo broken-corepack-shim>>"%DSH_TEST_LOG%"',
      'exit /b 33',
      '',
    ].join('\r\n'))
    writeFileSync(stub, [
      "import { appendFileSync } from 'node:fs'",
      `if (process.argv[2] === '--version') console.log(${JSON.stringify(pnpmVersion)})`,
      "else appendFileSync(process.env.DSH_TEST_LOG, `pnpm ${process.argv.slice(2).join(' ')}\\n`)",
      '',
    ].join('\n'))
    writeFileSync(join(bin, 'npm.cmd'), [
      '@echo off',
      'echo npm %*>>"%DSH_TEST_LOG%"',
      `if not exist "${join(root, `dsh-pnpm-${pnpmVersion}`, 'node_modules', 'pnpm', 'bin')}" mkdir "${join(root, `dsh-pnpm-${pnpmVersion}`, 'node_modules', 'pnpm', 'bin')}"`,
      `copy /y "${stub}" "${entry}" >nul`,
      'exit /b 0',
      '',
    ].join('\r\n'))
    if (brokenCache) {
      mkdirSync(join(root, `dsh-pnpm-${pnpmVersion}`, 'node_modules', 'pnpm', 'bin'), { recursive: true })
      writeFileSync(entry, 'console.log("0.0.0")\n')
    }
    return { root, bin, log, entry }
  }

  function launch(launcher: string, root: string, bin: string, log: string) {
    const command = process.env.ComSpec
    if (command === undefined || !existsSync(command)) throw new Error('ComSpec does not name cmd.exe')
    return spawnSync(command, ['/d', '/c', launcher], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      input: '\n',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        TEMP: root,
        TMP: root,
        COREPACK_HOME: join(root, 'broken-corepack-cache'),
        DSH_HOME: join(root, 'dsh-home'),
        DSH_TEST_LOG: log,
      },
    })
  }

  it.skipIf(process.platform !== 'win32')('repairs a broken private pnpm install without reading the Corepack cache', () => {
    const { root, bin, log } = fixture(true)
    const result = launch(cleanLauncher, root, bin, log)

    expect(result.signal, result.stderr || result.stdout).toBeNull()
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(result.stdout).toContain('Repository build outputs cleaned successfully.')
    const calls = readFileSync(log, 'utf8').trim().split(/\r?\n/)
    expect(calls[0]).toContain(`npm install --prefix "${join(root, `dsh-pnpm-${pnpmVersion}`)}"`)
    expect(calls[1]).toBe('pnpm run clean')
    expect(calls).toHaveLength(2)
  })

  it.skipIf(process.platform !== 'win32')('reuses a verified pnpm and drives build and run entry points', () => {
    const { root, bin, log, entry } = fixture(false)
    mkdirSync(join(root, `dsh-pnpm-${pnpmVersion}`, 'node_modules', 'pnpm', 'bin'), { recursive: true })
    writeFileSync(entry, readFileSync(join(root, 'pnpm-stub.mjs')))

    const build = launch(buildLauncher, root, bin, log)
    const run = launch(runLauncher, root, bin, log)

    expect(build.status, build.stderr || build.stdout).toBe(0)
    expect(run.status, run.stderr || run.stdout).toBe(0)
    expect(readFileSync(log, 'utf8').trim().split(/\r?\n/)).toEqual([
      'pnpm install --child-concurrency=4',
      'pnpm run build',
      'pnpm dsh web',
    ])
  })

  it.skipIf(process.platform !== 'win32')('keeps pnpm started by installation work off the broken Corepack shim', () => {
    const { root, bin, log } = fixture(false)
    writeFileSync(join(root, 'pnpm-stub.mjs'), [
      "import { appendFileSync } from 'node:fs'",
      "import { spawnSync } from 'node:child_process'",
      `if (process.argv[2] === '--version') console.log(${JSON.stringify(pnpmVersion)})`,
      'else {',
      "  appendFileSync(process.env.DSH_TEST_LOG, `pnpm ${process.argv.slice(2).join(' ')}\\n`)",
      "  if (process.argv[2] === 'install') {",
      "    const child = spawnSync(process.env.ComSpec, ['/d', '/c', 'pnpm --version'], { encoding: 'utf8' })",
      '    appendFileSync(process.env.DSH_TEST_LOG, `nested ${child.stdout.trim()}\\n`)',
      '    if (child.status !== 0) process.exit(child.status ?? 1)',
      '  }',
      '}',
      '',
    ].join('\n'))

    const result = launch(buildLauncher, root, bin, log)

    expect(result.signal).toBeNull()
    expect(result.status, result.stderr || result.stdout).toBe(0)
    const calls = readFileSync(log, 'utf8')
    expect(calls).toContain(`nested ${pnpmVersion}`)
    expect(calls).not.toContain('broken-corepack-shim')
  })

  it.skipIf(process.platform !== 'win32')('reports an incomplete npm install before invoking pnpm', () => {
    const { root, bin, log } = fixture(false)
    writeFileSync(join(bin, 'npm.cmd'), [
      '@echo off',
      'echo npm %*>>"%DSH_TEST_LOG%"',
      'exit /b 0',
      '',
    ].join('\r\n'))

    const result = launch(pnpmLauncher, root, bin, log)

    expect(result.signal).toBeNull()
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`Installed pnpm ${pnpmVersion} is incomplete`)
    expect(result.stdout).not.toContain('MODULE_NOT_FOUND')
    expect(readFileSync(log, 'utf8')).toContain('npm install --prefix')
  })
})
