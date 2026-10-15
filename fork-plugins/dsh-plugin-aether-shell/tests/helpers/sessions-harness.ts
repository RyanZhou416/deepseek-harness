/**
 * Fixture wiring for the persistent-session suites.
 *
 * These suites mount the REAL tool registry, the REAL local subprocess
 * provider, the REAL sandbox-policy service and session-projection registry,
 * the REAL live-agent registry, and the REAL AetherShell interpreter. Session
 * behavior is process behavior, so a fixture interpreter would only prove the
 * fixture: the native state under test is the interpreter's own mutable
 * environment.
 *
 * The one substituted collaborator is the operating system's confinement
 * runner, replaced by a recording provider that spawns the caller's argv
 * unchanged; the platform ACL/Landlock/Seatbelt runner is an external,
 * host-dependent boundary that cannot be part of a deterministic assertion.
 *
 * Every stub agent follows the live-agent contract the session manager checks:
 * it is built over a real `Session` and its own scope context, and registered
 * in the live-agent registry so `agents.get(id)` returns that exact object.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxEnforcement, SandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from '../../src/config.ts'
import type { Config, ResolvedConfig } from '../../src/config.ts'
import { AetherProcesses, createExecutableResolver } from '../../src/exec.ts'
import { createAetherSessionTools } from '../../src/session-tools.ts'
import type { AetherSessions, AetherSessionSettings } from '../../src/sessions.ts'

/** The Windows installer's fixed location, checked before PATH. */
const WINDOWS_AETHER_INSTALL = 'C:\\Program Files\\AetherShell\\ae.exe'

/**
 * Resolve the installed AetherShell interpreter on this host.
 * @returns the installer's absolute path, the bare `ae` name when that runs, or undefined when this host has none.
 */
export function installedInterpreter(): string | undefined {
  if (existsSync(WINDOWS_AETHER_INSTALL)) return WINDOWS_AETHER_INSTALL
  const probe = spawnSync('ae', ['--version'], { encoding: 'utf8' })
  return probe.status === 0 ? 'ae' : undefined
}

/** One recorded `ctx.sandbox.confine` call. */
export interface ConfineCall {
  /** The exact argv the plugin asked to have confined. */
  argv: string[]
  /** The policy the plugin resolved for the calling session. */
  policy: SandboxPolicy
}

/**
 * A one-shot barrier placed inside the next `confine` call.
 *
 * A start that is held here is provably mid-flight, so a test can act on the
 * session — unload the plugin, dispose the owner — at a deterministic point
 * instead of racing a timer.
 */
export interface ConfineGate {
  /** Resolves once a `confine` call has reached the barrier. */
  readonly reached: Promise<void>
  /** Let every held `confine` call continue. */
  release(): void
}

/** Options accepted by {@link createSessionHarness}. */
export interface SessionHarnessOptions {
  /** Deployment file-effect mode the sandbox policy resolves (default `danger-full-access`). */
  mode?: SandboxMode
  /** Deployment session budgets, merged over the defaults. */
  settings?: Partial<AetherSessionSettings>
  /** Additional plugin configuration overrides. */
  config?: Config
  /** Enforcement the recording backend claims for a confined session (default `full`). */
  enforcement?: SandboxEnforcement
}

/** A mounted persistent-session surface plus the observations a suite asserts on. */
export interface SessionHarness {
  /** The mounted context. */
  ctx: Context
  /** Absolute workspace root the sandbox policy falls back to. */
  workspace: string
  /** The manager the mounted tools own. */
  sessions: AetherSessions
  /** Every `confine` call the plugin made, in order. */
  confineCalls: ConfineCall[]
  /**
   * Build and register one live stub agent.
   * @param id - session identity for the stub.
   * @param cwd - session working directory (default the harness workspace).
   * @returns the registered agent, which is the exact object ownership is keyed on.
   */
  agent(id: string, cwd?: string): Promise<Agent>
  /**
   * Execute one tool through the real registry.
   * @param name - registered tool name.
   * @param args - lossless model arguments.
   * @param options - calling agent and cancellation.
   * @returns the materialized registry result.
   */
  call(name: string, args: unknown, options?: { agent?: Agent; signal?: AbortSignal }): Promise<ToolExecutionResult>
  /** Dispose the session tools the way a plugin reload does, leaving the rest of the context alive. */
  unmount(): Promise<void>
  /**
   * Hold the next `confine` call at a barrier so a test can act on a provably in-flight start.
   * @returns the barrier's reached promise and its release.
   */
  holdConfine(): ConfineGate
  /**
   * Count interpreter processes this harness spawned and that have not exited.
   * @returns the live count, so a test can prove teardown awaited real process death.
   */
  liveProcesses(): number
  /** Dispose everything and remove the workspace. Safe to call once. */
  dispose(): Promise<void>
}

let callCounter = 0

/**
 * Build one live stub agent over a real session and its own scope context.
 * @param ctx - the mounted context that owns every registration.
 * @param rawId - session identity for the stub.
 * @param cwd - absolute session working directory.
 * @returns the registered agent.
 */
async function liveStubAgent(ctx: Context, rawId: string, cwd: string): Promise<Agent> {
  const id = SessionId(rawId)
  const scope = ctx.plugin(() => {})
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    cwd,
    isSeeded: false,
  })
  const agent = {
    id,
    options: {},
    session,
    status: 'idle' as const,
    ctx: scope.ctx,
  } as Agent
  await ctx.agents.register(agent)
  return agent
}

/**
 * Mount the persistent-session tools over real capability services.
 * @param options - harness configuration; omitted fields use the defaults.
 * @returns the mounted harness, ready for tool calls.
 */
export async function createSessionHarness(options: SessionHarnessOptions = {}): Promise<SessionHarness> {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-aether-sessions-'))
  const confineCalls: ConfineCall[] = []
  let confineBarrier: { readonly wait: Promise<void>; readonly reached: () => void; readonly release: () => void } | undefined
  const mode = options.mode ?? 'danger-full-access'
  const ownedProcesses: AetherProcesses[] = []
  let sessions: AetherSessions | undefined
  let unmounted = false
  class RecordingSandboxProvider extends SandboxProvider {
    override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
      void signal
      confineCalls.push({ argv: [...argv], policy })
      const held = confineBarrier
      if (held !== undefined) {
        held.reached()
        await held.wait
      }
      const enforcement: SandboxEnforcement = options.enforcement ?? 'full'
      return { argv: [...argv], enforcement, denialSignatures: [], runnerFailureRules: [] }
    }
  }

  // The observing runtime counts spawned processes so a test can prove that a
  // close, an unload, or a cancelled start left no interpreter behind.
  const liveHandles = new Set<SubprocessHandle>()
  class ObservingSubprocessRuntime extends LocalSubprocessRuntime {
    override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      const handle = super.spawn(spec)
      liveHandles.add(handle)
      const settle = (): void => { liveHandles.delete(handle) }
      void handle.done.then(settle, settle)
      return handle
    }
  }

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
  await ctx.plugin(RecordingSandboxProvider)
  await ctx.plugin(ObservingSubprocessRuntime)
  await ctx.plugin(AgentRegistry)

  const resolved: ResolvedConfig = resolveConfig({
    executable: options.config?.executable ?? 'ae',
    executableArgs: [],
    mode: 'human',
    graceMs: 1_000,
    ...options.config,
  })
  const processes = new AetherProcesses(message => { ctx.logger.warn(message) })
  ownedProcesses.push(processes)
  const resolveExecutable = createExecutableResolver(ctx.subprocess, resolved.executable)
  const settings: AetherSessionSettings = {
    maxSessionsPerOwner: options.settings?.maxSessionsPerOwner ?? 4,
    sessionIdleTimeoutMs: options.settings?.sessionIdleTimeoutMs ?? 0,
    sessionStartupTimeoutMs: options.settings?.sessionStartupTimeoutMs ?? 15_000,
  }

  // Mirrors the plugin's own `agents`-scoped wiring: the tools exist only while
  // the live-agent registry does, and their disposer runs before the process
  // registry's.
  const mountFiber = await ctx.inject(['agents', 'tools', 'subprocess', 'sandbox', 'sandboxPolicy'], (scope) => {
    const built = createAetherSessionTools({ ctx: scope, config: resolved, processes, resolveExecutable }, settings)
    scope.effect(() => () => built.sessions.dispose(), 'test.sessions')
    for (const tool of built.tools) scope.tools.register(tool)
    sessions = built.sessions
  })
  const sessionManager = (): AetherSessions => {
    if (sessions === undefined) throw new Error('the session manager is not mounted')
    return sessions
  }
  const unmount = async (): Promise<void> => {
    if (unmounted) return
    unmounted = true
    await mountFiber.dispose()
  }

  return {
    ctx,
    workspace,
    get sessions(): AetherSessions {
      return sessionManager()
    },
    confineCalls,
    agent: (id, cwd = workspace) => liveStubAgent(ctx, id, cwd),
    call: (name, args, callOptions = {}) => ctx.tools.execute({
      callId: ToolCallId(`aether-session-${++callCounter}`),
      name,
      arguments: args,
      signal: callOptions.signal ?? new AbortController().signal,
      ...callOptions.agent === undefined ? {} : { agent: callOptions.agent },
    }),
    unmount,
    liveProcesses: () => liveHandles.size,
    holdConfine(): ConfineGate {
      const reached = Promise.withResolvers<void>()
      const wait = Promise.withResolvers<void>()
      confineBarrier = {
        wait: wait.promise,
        reached: () => { reached.resolve() },
        release: () => {
          confineBarrier = undefined
          wait.resolve()
        },
      }
      return {
        reached: reached.promise,
        release: () => { confineBarrier?.release() },
      }
    },
    async dispose() {
      await unmount()
      await ctx.fiber.dispose()
      for (const owned of ownedProcesses) await owned.dispose(resolved.graceMs)
      await rm(workspace, { recursive: true, force: true })
    },
  }
}

/** Join the text blocks of a tool result, which is the model-visible output. */
export function text(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/** Narrow a successful tool result to its canonical value, failing loudly on an error result. */
export function valueOf(result: ToolExecutionResult): Record<string, unknown> {
  if (result.isError) throw new Error(`expected a successful tool result, got: ${text(result)}`)
  return result.value as Record<string, unknown>
}
