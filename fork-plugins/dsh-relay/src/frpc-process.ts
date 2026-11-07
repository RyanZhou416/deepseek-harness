/**
 * frpc supervision.
 *
 * One supervised child process: output is parsed for frp's own startup
 * markers, unexpected exits are restarted with a growing delay, and teardown
 * waits for the child to exit. The supervisor owns every timer and handler it
 * creates, so a disposed plugin leaves no process or callback behind.
 *
 * @module dsh-relay/frpc-process
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { relayError } from './errors.ts'

/** Grace period between the terminate signal and a forced kill. */
const KILL_GRACE_MS = 3_000

/** Longest log line retained for marker matching. */
const MAX_LINE_LENGTH = 4_096

/** One supervised launch command. */
export interface FrpcLaunch {
  /** Executable path. */
  readonly command: string
  /** Arguments, normally `['-c', configPath]`. */
  readonly args: readonly string[]
  /** Working directory of the process. */
  readonly cwd: string
}

/** Events the supervisor reports. */
export type FrpcSupervisorEvent =
  | { readonly type: 'connected' }
  | { readonly type: 'startup-failed'; readonly detail: string }
  | { readonly type: 'exited'; readonly detail: string; readonly restarts: number }
  | { readonly type: 'retrying'; readonly delayMs: number; readonly restarts: number }

/** Options of {@link FrpcSupervisor}. */
export interface FrpcSupervisorOptions {
  /** Command, arguments, and working directory. */
  readonly launch: FrpcLaunch
  /** How long the process may take to report both startup successes. */
  readonly startupTimeoutMs: number
  /** First restart delay. */
  readonly initialDelayMs: number
  /** Restart-delay ceiling. */
  readonly maxDelayMs: number
  /** Receives every event. */
  readonly onEvent: (event: FrpcSupervisorEvent) => void
  /** Receives every output line; defaults to dropping them. */
  readonly onLine?: (line: string) => void
  /** Spawn implementation; tests inject one. */
  readonly spawnImpl?: typeof spawn
  /** Base environment; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Remove credential-shaped variables from a child environment.
 *
 * frpc needs none of them, and a harness credential must not appear in a child
 * process environment.
 * @param environment - environment to copy.
 * @returns the scrubbed environment.
 */
export function scrubChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(environment)) {
    if (/key|secret|token|password/iu.test(name)) continue
    scrubbed[name] = value
  }
  return scrubbed
}

/** Supervises one frpc process for the lifetime of a connection. */
export class FrpcSupervisor {
  private child: ChildProcess | undefined
  private startupTimer: ReturnType<typeof setTimeout> | undefined
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private stopping = false
  private disposed = false
  private connected = false
  private failureReported = false
  private stopResolvers: (() => void)[] = []
  /** Number of process launches. */
  starts = 0
  /** Number of restarts in the current failure chain. */
  restarts = 0

  /**
   * @param options - launch command, timings, and event sink.
   */
  constructor(private readonly options: FrpcSupervisorOptions) {}

  /**
   * Launch the process unless it is already running or disposed.
   */
  start(): void {
    if (this.disposed || this.stopping || this.child !== undefined) return
    this.spawnOnce()
  }

  /**
   * Stop the process and every pending restart, then wait for the child to exit.
   * @returns a promise that settles after the child exited.
   */
  async stop(): Promise<void> {
    this.stopping = true
    this.clearRestart()
    if (this.child === undefined) return
    const child = this.child
    const exited = new Promise<void>((resolve) => { this.stopResolvers.push(resolve) })
    const killTimer = setTimeout(() => {
      if (this.child === child) child.kill('SIGKILL')
    }, KILL_GRACE_MS)
    killTimer.unref?.()
    child.kill('SIGTERM')
    try {
      await exited
    } finally {
      clearTimeout(killTimer)
    }
  }

  /**
   * Stop the process, suppress every later restart, and release every timer and
   * handler this supervisor owns.
   * @returns a promise that settles after the child exited.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }

  private clearRestart(): void {
    if (this.restartTimer === undefined) return
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
  }

  private clearStartup(): void {
    if (this.startupTimer === undefined) return
    clearTimeout(this.startupTimer)
    this.startupTimer = undefined
  }

  private emit(event: FrpcSupervisorEvent): void {
    this.options.onEvent(event)
  }

  private scheduleRestart(): void {
    if (this.disposed || this.stopping) return
    const attempt = this.restarts
    this.restarts += 1
    const delayMs = Math.min(this.options.maxDelayMs, this.options.initialDelayMs * 2 ** attempt)
    this.emit({ type: 'retrying', delayMs, restarts: this.restarts })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (this.disposed || this.stopping) return
      this.spawnOnce()
    }, delayMs)
    this.restartTimer.unref?.()
  }

  private handleLine(line: string): void {
    if (line.length === 0) return
    this.options.onLine?.(line)
    if (/login to server success/iu.test(line)) this.sawLogin = true
    if (/start proxy success/iu.test(line)) this.sawProxy = true
    if (this.sawLogin || this.sawProxy) {
      if (this.sawLogin && this.sawProxy && !this.connected) {
        this.connected = true
        this.restarts = 0
        this.clearStartup()
        this.emit({ type: 'connected' })
      }
      return
    }
    if (!this.connected && !this.failureReported
      && /login to server failed|connect to server error|start error/iu.test(line)) {
      this.failureReported = true
      this.clearStartup()
      this.emit({ type: 'startup-failed', detail: line.slice(0, 500) })
      this.child?.kill('SIGTERM')
    }
  }

  private sawLogin = false
  private sawProxy = false

  private spawnOnce(): void {
    this.sawLogin = false
    this.sawProxy = false
    this.connected = false
    this.failureReported = false
    this.starts += 1
    const spawnImpl = this.options.spawnImpl ?? spawn
    let child: ChildProcess
    try {
      child = spawnImpl(this.options.launch.command, [...this.options.launch.args], {
        cwd: this.options.launch.cwd,
        env: scrubChildEnvironment(this.options.env ?? process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      this.failureReported = true
      this.emit({ type: 'startup-failed', detail: error instanceof Error ? error.message.slice(0, 500) : 'could not start frpc' })
      this.scheduleRestart()
      return
    }
    this.child = child
    const stdout = child.stdout
    const stderr = child.stderr
    let buffer = ''
    const consume = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/u, '').slice(0, MAX_LINE_LENGTH)
        buffer = buffer.slice(newline + 1)
        this.handleLine(line)
        newline = buffer.indexOf('\n')
      }
      if (buffer.length > MAX_LINE_LENGTH) buffer = buffer.slice(-MAX_LINE_LENGTH)
    }
    stdout?.on('data', consume)
    stderr?.on('data', consume)
    child.once('error', (error) => {
      if (this.child !== child || this.failureReported || this.connected) return
      this.failureReported = true
      this.clearStartup()
      this.emit({ type: 'startup-failed', detail: error.message.slice(0, 500) })
    })
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined
      if (this.child !== child || this.connected || this.failureReported) return
      this.failureReported = true
      this.emit({ type: 'startup-failed', detail: 'frpc did not report login and proxy startup in time' })
      child.kill('SIGTERM')
    }, this.options.startupTimeoutMs)
    this.startupTimer.unref?.()
    child.once('close', (code, signal) => {
      stdout?.removeListener('data', consume)
      stderr?.removeListener('data', consume)
      this.clearStartup()
      if (this.child === child) this.child = undefined
      const resolvers = this.stopResolvers
      this.stopResolvers = []
      for (const resolve of resolvers) resolve()
      if (this.disposed || this.stopping) return
      if (!this.failureReported) {
        this.emit({
          type: 'exited',
          detail: signal === null ? `frpc exited with code ${String(code)}` : `frpc exited on signal ${signal}`,
          restarts: this.restarts,
        })
      }
      this.scheduleRestart()
    })
  }
}

/**
 * Build the launch command for a downloaded frpc executable.
 * @param executable - absolute frpc path.
 * @param configPath - absolute configuration path.
 * @param runDirectory - working directory holding the referenced token/CA files.
 * @returns the launch command.
 */
export function frpcLaunch(executable: string, configPath: string, runDirectory: string): FrpcLaunch {
  if (executable === '' || configPath === '') throw relayError('frpc-unsupported', 'frpc or its configuration path is empty')
  return { command: executable, args: ['-c', configPath], cwd: runDirectory }
}
