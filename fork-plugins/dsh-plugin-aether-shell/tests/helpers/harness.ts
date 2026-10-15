/**
 * Shared fixture wiring for the AetherShell suites.
 *
 * Every harness mounts the REAL tool registry, the REAL local subprocess
 * provider, the REAL sandbox-policy service and session-projection registry,
 * and the plugin under test with the deterministic interpreter fixture. The one
 * substituted collaborator is the OS sandbox runner: `ctx.sandbox` is a
 * recording provider whose default behavior spawns the caller's argv unchanged,
 * because the platform ACL/Landlock/Seatbelt runner is an external,
 * host-dependent boundary that cannot be part of a deterministic assertion.
 * Confinement arguments and policies are recorded so the suite can still prove
 * what the plugin asked the boundary to do.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxEnforcement, SandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as AetherShell from '../../src/index.ts'

/** Absolute path of the deterministic interpreter fixture every harness spawns. */
export const AETHER_FIXTURE = fileURLToPath(new URL('../fixtures/ae-fixture.mjs', import.meta.url))

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
  /** The exact argv the plugin asked to have confined, including the fixture argv. */
  argv: string[]
  /** The policy the plugin resolved for the calling session. */
  policy: SandboxPolicy
}

/** How the recording sandbox provider answers `confine`. */
export type SandboxBehavior = 'passthrough' | 'unavailable'

/** Options accepted by {@link createHarness}. */
export interface HarnessOptions {
  /** Plugin configuration overrides, merged over the fixture interpreter settings. */
  config?: AetherShell.Config
  /** Deployment file-effect mode the sandbox policy resolves (default `danger-full-access`). */
  mode?: SandboxMode
  /** Absolute workspace root the policy falls back to; a private temp directory by default. */
  workspaceRoot?: string
  /** Sandbox runner behavior for this harness (default `passthrough`). */
  sandbox?: SandboxBehavior
  /** Denial dialect the recording backend reports, so a suite can exercise the denied path. */
  denialSignatures?: readonly string[]
  /** Enforcement the recording backend claims (default `full`). */
  enforcement?: SandboxEnforcement
  /** Interpreter executable the plugin spawns (default the running Node). */
  executable?: string
  /** Trusted argv between the executable and the subcommand (default the fixture script). */
  executableArgs?: readonly string[]
  /** Mount the optional managed-`DSH_*` environment registry. */
  shellEnv?: boolean
}

/** A mounted plugin under test plus the observations a suite asserts on. */
export interface Harness {
  /** The mounted context. */
  ctx: Context
  /** Absolute workspace root given to the sandbox policy. */
  workspace: string
  /** Every `confine` call the plugin made, in order. */
  confineCalls: ConfineCall[]
  /** A session-shaped agent whose cwd is the workspace. */
  agent: object
  /** The plugin's own fiber, so a suite can dispose it while the rest of the context survives. */
  pluginFiber: { dispose(): Promise<void> }
  /**
   * Execute one tool through the real registry.
   * @param name - registered tool name.
   * @param args - lossless model arguments.
   * @param options - optional call identity; `agent: null` executes without a calling session.
   * @returns the materialized registry result.
   */
  call(name: string, args: unknown, options?: { agent?: object | null; signal?: AbortSignal }): Promise<ToolExecutionResult>
  /** Dispose the plugin fiber and remove the workspace. Safe to call once. */
  dispose(): Promise<void>
}

let callCounter = 0

/**
 * A session-shaped value carrying only what the plugin and the sandbox-policy
 * service read: an id, a header with an absolute cwd, and an in-memory event
 * log the projection registry can fold.
 * @param cwd - absolute session workspace.
 * @param id - session identity.
 * @param extraEvents - logged events after `turn/start`, for logs that carry a standing override.
 * @returns the fake agent handed to tool executions.
 */
export function sessionAgent(
  cwd: string,
  id = 'sess-aether',
  extraEvents: readonly { type: string; data: Record<string, unknown> }[] = [],
): object {
  const sessionId = SessionId(id)
  const events: Array<{ type: string; seq: ReturnType<typeof SessionSeq>; time: number; data: Record<string, unknown> }> = [
    { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
    ...extraEvents.map((event, index) => ({ type: event.type, seq: SessionSeq(index + 1), time: index + 1, data: event.data })),
  ]
  return {
    id: sessionId,
    session: {
      id: sessionId,
      header: { version: 0, id: sessionId, createdAt: 0, cwd, isSeeded: false },
      inheritedEventCount: SessionLogOffset(0),
      firstLiveSeq: SessionLogOffset(0),
      get seq() { return SessionLogOffset(events.length) },
      eventAt: (seq: ReturnType<typeof SessionSeq>) => events[seq],
      snapshotEvents: (
        from: ReturnType<typeof SessionLogOffset> = SessionLogOffset(0),
        to: ReturnType<typeof SessionLogOffset> = SessionLogOffset(events.length),
      ) => events.slice(from, to),
      append: (type: string, data: Record<string, unknown>) => {
        const event = { type, seq: SessionSeq(events.length), time: events.length, data }
        events.push(event)
        return event
      },
    },
  }
}

/** The caller's argv with this host's confinement facts attached, run unconfined. */
function passthrough(argv: readonly string[], enforcement: SandboxEnforcement, denialSignatures: readonly string[]): ConfinedArgv {
  return { argv: [...argv], enforcement, denialSignatures: [...denialSignatures], runnerFailureRules: [] }
}

/**
 * Mount the plugin under test over real capability services.
 * @param options - harness configuration; omitted fields use deterministic fixture defaults.
 * @returns the mounted harness, ready for tool calls.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const workspace = options.workspaceRoot ?? await mkdtemp(join(tmpdir(), 'dsh-aether-'))
  const ownedWorkspace = options.workspaceRoot === undefined
  const confineCalls: ConfineCall[] = []
  const behavior = options.sandbox ?? 'passthrough'

  class RecordingSandboxProvider extends SandboxProvider {
    override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
      void signal
      confineCalls.push({ argv: [...argv], policy })
      if (behavior === 'unavailable') {
        throw new SandboxUnavailableError(policy.mode, 'the recording test provider refuses every confinement')
      }
      return passthrough(argv, options.enforcement ?? 'full', options.denialSignatures ?? [])
    }
  }

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: options.mode ?? 'danger-full-access', workspaceRoot: workspace })
  await ctx.plugin(RecordingSandboxProvider)
  await ctx.plugin(LocalSubprocessRuntime)
  if (options.shellEnv === true) {
    const shellEnv = await import('@deepseek-ai/dsh-shell-env')
    await ctx.plugin(shellEnv)
  }
  const pluginConfig: AetherShell.Config = {
    executable: options.executable ?? process.execPath,
    executableArgs: [...(options.executableArgs ?? [AETHER_FIXTURE])],
    ...options.config,
  }
  const pluginFiber = await ctx.plugin(AetherShell, pluginConfig)

  const agent = sessionAgent(workspace)
  return {
    ctx,
    workspace,
    confineCalls,
    agent,
    pluginFiber,
    call: (name, args, callOptions = {}) => ctx.tools.execute({
      callId: ToolCallId(`aether-${++callCounter}`),
      name,
      arguments: args,
      signal: callOptions.signal ?? new AbortController().signal,
      ...callOptions.agent === null
        ? {}
        : { agent: (callOptions.agent ?? agent) as never },
    }),
    async dispose() {
      await ctx.fiber.dispose()
      if (ownedWorkspace) await rm(workspace, { recursive: true, force: true })
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
