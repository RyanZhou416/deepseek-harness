import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import koffi from 'koffi'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { targetEnvironment } from '../src/runner-launch.ts'
import { bindManagedProcess, spawnSubprocess } from '../src/spawn.ts'
import type { LocalSubprocessHandle } from '../src/spawn.ts'
import LocalSubprocessRuntime from '../src/index.ts'
import { launchWindowsJob, probeWindowsJob } from '../src/windows-job.ts'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-native-windows-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

function spec(argv: string[], graceMs = 100, env?: NodeJS.ProcessEnv): SubprocessSpawnSpec {
  return {
    argv,
    cwd: scratch,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64_000 },
      stderr: { maxBytes: 64_000 },
    },
    graceMs,
    env,
  }
}

async function observe(handle: LocalSubprocessHandle) {
  try {
    const outcome = await handle.done
    const rangeEmpty = await handle.waitForExit()
    return {
      outcome,
      rangeEmpty,
      stdout: handle.collected.stdout?.readFrom(0).text,
      stderr: handle.collected.stderr?.readFrom(0).text,
    }
  } finally {
    handle.terminate()
    await Promise.allSettled([handle.done, handle.waitForExit()])
  }
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(path, 'utf8').trim())
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch {
      // Target has not written its descendant pid yet.
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`pid file ${path} was not written`)
}

async function waitGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`pid ${pid} remained alive`)
}

function cleanup(pid: number): void {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

type SpawnFailure = NodeJS.ErrnoException & { path?: string }

function expectedSpawnFailure(error: SpawnFailure): Record<string, unknown> {
  const expected: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    code: error.code,
    syscall: error.syscall,
  }
  if (Object.hasOwn(error, 'path')) expected.path = error.path
  return expected
}

function directSpawnFailure(argv: readonly string[], cwd = scratch): Promise<SpawnFailure> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(argv[0] as string, argv.slice(1), { cwd, stdio: 'ignore' })
      child.once('error', resolve)
      child.once('spawn', () => { reject(new Error(`expected ${argv[0]} to fail before spawn`)) })
    } catch (error) {
      resolve(error as SpawnFailure)
    }
  })
}

const isWindows = process.platform === 'win32'
const windowsNative = isWindows && probeWindowsJob()

it.skipIf(!isWindows)('requires the native Windows Job launch used by ordinary commands', () => {
  expect(probeWindowsJob()).toBe(true)
})

describe.skipIf(!windowsNative)('Windows Job native containment', () => {
  it('gives the direct command a hidden console separate from its caller', async () => {
    const getConsoleWindow = koffi.load('kernel32.dll').func('GetConsoleWindow', 'void*', [])
    const callerConsole = koffi.address(getConsoleWindow()).toString()
    const koffiPath = createRequire(import.meta.url).resolve('koffi')
    const script = `
      const koffi = require(${JSON.stringify(koffiPath)})
      const getConsoleWindow = koffi.load('kernel32.dll').func('GetConsoleWindow', 'void*', [])
      process.stdout.write(koffi.address(getConsoleWindow()).toString())
    `
    const request = spec([process.execPath, '-e', script])
    const result = await observe(bindManagedProcess(request, launchWindowsJob(request, targetEnvironment(request))))
    expect(result.outcome).toEqual({ exitCode: 0, signal: null })
    expect(result.rangeEmpty).toBe(true)
    expect(result.stdout).not.toBe('0')
    expect(result.stdout).not.toBe(callerConsole)
  })

  it('contains a real console-wide CTRL_C_EVENT inside the direct command console', async () => {
    const getConsoleWindow = koffi.load('kernel32.dll').func('GetConsoleWindow', 'void*', [])
    const callerConsole = koffi.address(getConsoleWindow()).toString()
    const koffiPath = createRequire(import.meta.url).resolve('koffi')
    const script = `
      const koffi = require(${JSON.stringify(koffiPath)})
      const kernel32 = koffi.load('kernel32.dll')
      const ownConsole = koffi.address(kernel32.func('GetConsoleWindow', 'void*', [])()).toString()
      if (ownConsole === '0' || ownConsole === ${JSON.stringify(callerConsole)}) process.exit(42)
      if (!kernel32.func('SetConsoleCtrlHandler', 'int', ['void*', 'int'])(null, 1)) process.exit(43)
      if (!kernel32.func('GenerateConsoleCtrlEvent', 'int', ['uint32', 'uint32'])(0, 0)) process.exit(44)
      process.stdout.write('console-wide event stayed in child console')
    `
    const request = spec([process.execPath, '-e', script])
    const unisolated = await observe(spawnSubprocess(request, { platform: 'win32' }))
    expect(unisolated.outcome).toEqual({ exitCode: 42, signal: null })
    expect(unisolated.rangeEmpty).toBe(true)
    const isolated = await observe(bindManagedProcess(request, launchWindowsJob(request, targetEnvironment(request))))
    expect(isolated.outcome).toEqual({ exitCode: 0, signal: null })
    expect(isolated.rangeEmpty).toBe(true)
    expect(isolated.stdout).toBe('console-wide event stayed in child console')
    const followup = spec([process.execPath, '-e', "process.stdout.write('host-alive')"])
    const next = await observe(bindManagedProcess(followup, launchWindowsJob(followup, targetEnvironment(followup))))
    expect(next.outcome).toEqual({ exitCode: 0, signal: null })
    expect(next.rangeEmpty).toBe(true)
    expect(next.stdout).toBe('host-alive')
  })

  it('lets a restricted-token command inherit the outer runner console', async () => {
    const getConsoleWindow = koffi.load('kernel32.dll').func('GetConsoleWindow', 'void*', [])
    const callerConsole = koffi.address(getConsoleWindow()).toString()
    const koffiPath = createRequire(import.meta.url).resolve('koffi')
    const sandboxRunner = fileURLToPath(new URL('../../../sandbox/sandbox-windows-acl/src/runner.ts', import.meta.url))
    const probe = `
      const koffi = require(${JSON.stringify(koffiPath)})
      const kernel32 = koffi.load('kernel32.dll')
      const ownConsole = koffi.address(kernel32.func('GetConsoleWindow', 'void*', [])()).toString()
      if (ownConsole === '0' || ownConsole === ${JSON.stringify(callerConsole)}) process.exit(42)
      if (!kernel32.func('GenerateConsoleCtrlEvent', 'int', ['uint32', 'uint32'])(0, 0)) process.exit(44)
      process.stdout.write(ownConsole)
    `
    const request = spec([
      process.execPath, '--import', import.meta.resolve('tsx/esm'), sandboxRunner,
      '--workspace', scratch, '--temp', scratch, '--mode', 'read-only',
      '--', process.execPath, '-e', probe,
    ])
    const result = await observe(bindManagedProcess(request, launchWindowsJob(request, targetEnvironment(request))))
    expect(result.outcome, result.stderr).toEqual({ exitCode: 0, signal: null })
    expect(result.rangeEmpty).toBe(true)
    expect(result.stdout).not.toBe('0')
    expect(result.stdout).not.toBe(callerConsole)
  })

  it('keeps a terminal console-wide event inside its PTY', async () => {
    const getConsoleWindow = koffi.load('kernel32.dll').func('GetConsoleWindow', 'void*', [])
    const callerConsole = koffi.address(getConsoleWindow()).toString()
    const koffiPath = createRequire(import.meta.url).resolve('koffi')
    const barrier = join(scratch, 'terminal-console-signal-barrier')
    const script = `
      const koffi = require(${JSON.stringify(koffiPath)})
      const { existsSync } = require('node:fs')
      const kernel32 = koffi.load('kernel32.dll')
      const deadline = Date.now() + 10000
      const runAfterBarrier = () => {
        if (!existsSync(process.argv[1])) {
          if (Date.now() > deadline) process.exit(45)
          setTimeout(runAfterBarrier, 10)
          return
        }
        const ownConsole = koffi.address(kernel32.func('GetConsoleWindow', 'void*', [])()).toString()
        if (ownConsole === '0' || ownConsole === ${JSON.stringify(callerConsole)}) process.exit(42)
        if (!kernel32.func('SetConsoleCtrlHandler', 'int', ['void*', 'int'])(null, 1)) process.exit(43)
        if (!kernel32.func('GenerateConsoleCtrlEvent', 'int', ['uint32', 'uint32'])(0, 0)) process.exit(44)
        process.stdout.write('pty event stayed in terminal console')
      }
      runAfterBarrier()
    `
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    let terminal: Awaited<ReturnType<typeof ctx.subprocess.spawnTerminal>> | undefined
    try {
      terminal = await ctx.subprocess.spawnTerminal({
        argv: [process.execPath, '-e', script, barrier],
        cwd: scratch,
        rows: 24,
        cols: 80,
        terminalType: 'xterm-256color',
        graceMs: 1_000,
      })
      let output = ''
      terminal.output.on('data', (chunk) => { output += String(chunk) })
      const active = terminal
      const outputEnded = new Promise<void>((resolve, reject) => {
        active.output.once('end', resolve)
        active.output.once('error', reject)
      })
      active.output.resume()
      writeFileSync(barrier, 'go', { flag: 'wx' })
      await expect(active.done).resolves.toEqual({ exitCode: 0, signal: null })
      await outputEnded
      expect(output).toContain('pty event stayed in terminal console')
    } finally {
      if (terminal !== undefined) await terminal.terminate()
      await fiber.dispose()
    }
  })

  it('keeps ordinary descendants free of visible console windows', async () => {
    const fixture = fileURLToPath(new URL('../../win32-process/tests/fixtures/console-state.ts', import.meta.url))
    const script = `
      const { spawnSync } = require('node:child_process')
      const child = spawnSync(process.execPath, [process.argv[1]], { stdio: 'inherit' })
      if (child.error) throw child.error
      process.exitCode = child.status ?? 1
    `
    const request = spec([process.execPath, '-e', script, fixture])
    const handle = bindManagedProcess(request, launchWindowsJob(request, targetEnvironment(request)))
    try {
      expect(await handle.done).toEqual({ exitCode: 0, signal: null })
      expect(handle.collected.stderr?.readFrom(0).text).toBe('')
      expect(JSON.parse(handle.collected.stdout?.readFrom(0).text ?? '')).toMatchObject({ visible: false })
    } finally {
      handle.terminate()
      await handle.waitForExit()
    }
  })

  it('keeps raw stdin writable while the runner starts the target', async () => {
    const output = join(scratch, `stdin-${Date.now()}.txt`)
    const script = `
      const { writeFileSync } = require('node:fs')
      let input = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', chunk => { input += chunk })
      process.stdin.on('end', () => { writeFileSync(${JSON.stringify(output)}, input) })
    `
    const request = {
      ...spec([process.execPath, '-e', script]),
      stdio: { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' } as const,
    }
    const handle = bindManagedProcess(request, launchWindowsJob(request, targetEnvironment(request)))
    if (handle.stdin === undefined) throw new Error('expected piped stdin')
    await new Promise<void>((resolve, reject) => {
      handle.stdin?.once('error', reject)
      handle.stdin?.end('immediate-stdin', resolve)
    })
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(readFileSync(output, 'utf8')).toBe('immediate-stdin')
  })

  it('preserves direct Node null-device semantics for ignored stdin', async () => {
    const script = `
      const stat = require('node:fs').fstatSync(0)
      process.stdout.write(JSON.stringify({
        file: stat.isFile(),
        directory: stat.isDirectory(),
        block: stat.isBlockDevice(),
        character: stat.isCharacterDevice(),
        fifo: stat.isFIFO(),
        socket: stat.isSocket(),
      }))
    `
    const direct = spawnSync(process.execPath, ['-e', script], {
      cwd: scratch,
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
    })
    expect(direct.status).toBe(0)

    const request = spec([process.execPath, '-e', script])
    const handle = bindManagedProcess(request, launchWindowsJob(request, targetEnvironment(request)))
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(handle.collected.stdout?.readFrom(0).text).toBe(direct.stdout)
  })

  it('reports direct exit before terminating its default-inheritance descendant', async () => {
    const pidFile = join(scratch, `job-survivor-${Date.now()}.pid`)
    const factsFile = join(scratch, `job-facts-${Date.now()}.json`)
    const targetCwd = join(scratch, `target-cwd-${Date.now()}`)
    mkdirSync(targetCwd)
    const script = `
      const { spawn } = require('node:child_process')
      const { writeFileSync } = require('node:fs')
      const { dirname } = require('node:path')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dirname(process.execPath), stdio: 'ignore', detached: true })
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
      writeFileSync(${JSON.stringify(factsFile)}, JSON.stringify({ cwd: process.cwd(), value: process.env.TARGET_VALUE, arg: process.argv[1] }))
      child.unref()
      process.stdout.end()
      process.stderr.end()
      process.exitCode = 42
    `
    const request = {
      ...spec([process.execPath, '-e', script, 'literal $HOME ${UNCHANGED}'], 100, { TARGET_VALUE: 'explicit' }),
      cwd: targetCwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } as const,
    }
    const handle = bindManagedProcess(request, launchWindowsJob(request, targetEnvironment(request)))
    let descendant: number | undefined
    try {
      if (handle.stdout === undefined) throw new Error('expected piped stdout')
      if (handle.stderr === undefined) throw new Error('expected piped stderr')
      handle.stdout.resume()
      handle.stderr.resume()
      const stdoutEnded = new Promise<void>((resolve, reject) => {
        handle.stdout?.once('end', resolve)
        handle.stdout?.once('error', reject)
      })
      const stderrEnded = new Promise<void>((resolve, reject) => {
        handle.stderr?.once('end', resolve)
        handle.stderr?.once('error', reject)
      })
      descendant = await waitForPid(pidFile)
      await expect(handle.done).resolves.toEqual({ exitCode: 42, signal: null })
      await expect(Promise.race([
        Promise.all([stdoutEnded, stderrEnded]).then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => { resolve(false) }, 5_000)),
      ])).resolves.toBe(true)
      expect(readFileSync(factsFile, 'utf8')).toBe(JSON.stringify({
        cwd: targetCwd,
        value: 'explicit',
        arg: 'literal $HOME ${UNCHANGED}',
      }))
      await expect(handle.waitForExit(AbortSignal.timeout(30))).resolves.toBe(false)
      handle.terminate()
      await expect(handle.waitForExit()).resolves.toBe(true)
      await waitGone(descendant)
    } finally {
      handle.terminate()
      await Promise.allSettled([handle.done, handle.waitForExit()])
      if (descendant !== undefined) cleanup(descendant)
      rmSync(targetCwd, { recursive: true, force: true })
    }
  })

  it('preserves missing-target and invalid-executable rejection errors', async () => {
    const relativeExecutable = `relative-node-${String(Date.now())}.exe`
    copyFileSync(process.execPath, join(scratch, relativeExecutable))
    const relative = spec([relativeExecutable, '-e', 'process.exit(17)'])
    const relativeHandle = bindManagedProcess(relative, launchWindowsJob(relative, targetEnvironment(relative)))
    await expect(relativeHandle.done).resolves.toEqual({ exitCode: 17, signal: null })
    await expect(relativeHandle.waitForExit()).resolves.toBe(true)

    const missing = spec([`missing-native-target-${Date.now()}.exe`])
    const expectedMissing = await directSpawnFailure(missing.argv)
    const missingHandle = bindManagedProcess(missing, launchWindowsJob(missing, targetEnvironment(missing)))
    await expect(missingHandle.done).rejects.toMatchObject(expectedSpawnFailure(expectedMissing))
    await expect(missingHandle.waitForExit()).resolves.toBe(true)

    const expectedAccessDenied = await directSpawnFailure([scratch])
    const accessDenied = spec([scratch])
    const accessDeniedHandle = bindManagedProcess(accessDenied, launchWindowsJob(accessDenied, targetEnvironment(accessDenied)))
    await expect(accessDeniedHandle.done).rejects.toMatchObject(expectedSpawnFailure(expectedAccessDenied))
    await expect(accessDeniedHandle.waitForExit()).resolves.toBe(true)

    const missingCwd = join(scratch, `missing-cwd-${Date.now()}`)
    const cwdArgv = [process.execPath, '-e', 'process.exit(0)']
    const expectedCwd = await directSpawnFailure(cwdArgv, missingCwd)
    const invalidCwd = { ...spec(cwdArgv), cwd: missingCwd }
    const invalidCwdHandle = bindManagedProcess(invalidCwd, launchWindowsJob(invalidCwd, targetEnvironment(invalidCwd)))
    await expect(invalidCwdHandle.done).rejects.toMatchObject(expectedSpawnFailure(expectedCwd))
    await expect(invalidCwdHandle.waitForExit()).resolves.toBe(true)

    const invalidExecutable = join(scratch, `direct-${Date.now()}.exe`)
    writeFileSync(invalidExecutable, 'not a Windows executable\r\n')
    const directError = await directSpawnFailure([invalidExecutable])
    const invalid = spec([invalidExecutable])
    const invalidHandle = bindManagedProcess(invalid, launchWindowsJob(invalid, targetEnvironment(invalid)))
    await expect(invalidHandle.done).rejects.toMatchObject(expectedSpawnFailure(directError))
    await expect(invalidHandle.waitForExit()).resolves.toBe(true)
  })
})
