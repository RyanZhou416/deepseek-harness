/**
 * Persistent native AetherShell sessions owned by one live Agent.
 *
 * A session is one long-lived `ae agent interactive` process holding native
 * mutable state: variables, functions, and the process-global current
 * directory and environment. The interpreter keeps that state per process, so
 * one handle owns exactly one interpreter process. That isolates the
 * interpreter's own mutable state: a second handle cannot observe or disturb
 * the first's variables, functions, or working directory. Everything outside
 * the process belongs to the host instead — files, network access, and
 * external services are shared by every session and by the harness itself, and
 * a session's programs really read and write them. The process is registered
 * with the plugin's own {@link AetherProcesses} registry from before its first
 * lookup, so plugin teardown terminates and joins it like any other managed
 * range.
 *
 * Five lifecycle rules hold here.
 *
 * A handle has exactly one closing promise. Every closer — an explicit close, a
 * deadline, a caller cancellation, a policy change, the owner's disposal, and
 * plugin teardown — reuses it, so concurrent closers all await the same
 * process join instead of racing separate teardowns.
 *
 * A handle's lifetime is bounded by its owner's. The first session an agent
 * opens registers one effect on that agent's context; disposing the agent
 * closes every session it holds, and the returned promise is awaited so a
 * disposer never reports completion while an interpreter is still running.
 *
 * Startup is cancellable. The handle's own abort signal is fused into the
 * preparation, so an owner that goes away, a policy change, or a plugin unload
 * cancels a lookup or a confinement that is still in flight. Nothing awaits
 * between that guard and the spawn, so no process can be created after the
 * handle was closed.
 *
 * The handle carries the exact file-effect policy its process was confined
 * under, and every new native request re-resolves the calling session's policy
 * first. A policy that changed no longer describes what this process may do, so
 * the session is closed — and the close is awaited — instead of letting a
 * privileged process keep running.
 *
 * One request is outstanding per handle. A second concurrent evaluation is
 * refused rather than queued, because an unbounded queue would hide a caller's
 * mistake behind an unpredictable latency and would make a timeout ambiguous.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/sessions
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { ConfinedSandboxMode, SandboxEnforcement, SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { isRunnerSpawnFailure, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ResolvedConfig } from './config.ts'
import { describeError, toolAborted } from './errors.ts'
import { AETHER_TIMEOUT_CODE, aetherEnvironment } from './exec.ts'
import type { AetherProcesses, AetherTrackedProcess } from './exec.ts'
import type { AetherDiagnostics, AetherFailure } from './outcome.ts'
import { isJsonObject, jsonKindOf } from './outcome.ts'
import { assertRequestBytes } from './request.ts'
import {
  AetherSessionDecoder,
  aetherSessionId,
  assertSessionValueFidelity,
  classifySessionReply,
  sessionCloseCall,
  sessionEvalCall,
  sessionNonceWrapper,
  sessionOpenCall,
  sessionUsageCall,
} from './session-protocol.ts'
import type { AetherSessionId } from './session-protocol.ts'

/** The exact live Agent object a session belongs to. */
export type AetherSessionOwner = Agent

/** Deployment budgets for the persistent session surface. */
export interface AetherSessionSettings {
  /** Handles one owner may hold at once. */
  readonly maxSessionsPerOwner: number
  /** Close a handle idle for this long; `0` disables idle reaping. */
  readonly sessionIdleTimeoutMs: number
  /** Deadline for starting one interpreter process, fused with the open call's own deadline. */
  readonly sessionStartupTimeoutMs: number
}

/** Capability services, resolved configuration, and plugin-owned state the manager reads. */
export interface AetherSessionDependencies {
  /** Context supplying `agents`, `subprocess`, `sandbox`, and the optional `shellEnv`. */
  readonly ctx: Context
  /** Resolved deployment configuration. */
  readonly config: ResolvedConfig
  /** Live-process registry owned by the plugin fiber. */
  readonly processes: AetherProcesses
  /** Interpreter resolver shared with the foreground tools. */
  readonly resolveExecutable: (signal?: AbortSignal) => Promise<string>
}

/** One call's cancellation and deadline, resolved by the tool layer. */
export interface AetherSessionCall {
  /** The calling tool execution's cancellation. */
  readonly signal: AbortSignal
  /** Deadline in milliseconds, already resolved against the deployment budgets. */
  readonly timeoutMs: number
}

/** The file-effect facts a session was opened under. */
export interface AetherSessionPolicyFacts {
  /** The DSH file-effect mode the interpreter process runs under. */
  readonly mode: SandboxMode
  /** Absolute root a `workspace-write` session may write under. */
  readonly workspaceRoot: string
  /**
   * How completely the selected backend enforces that mode, when a backend
   * wrapped the argv. Absent under `danger-full-access`, where nothing did.
   */
  readonly enforcement?: SandboxEnforcement
}

/** The handle one `open` call returns. */
export interface AetherSessionOpened {
  /** Opaque host-generated identity; the interpreter's own session id is never exposed. */
  readonly sessionId: AetherSessionId
  /** Caller-supplied label, when the call gave one. */
  readonly name?: string
  /** Absolute working directory the interpreter process started in. */
  readonly cwd: string
  readonly policy: AetherSessionPolicyFacts
}

/** Bounded diagnostics one session request produced. */
export interface AetherSessionLogs {
  /** Unrelated stdout — the banner and anything the evaluated program or a child printed. */
  readonly stdout: AetherDiagnostics
  /** The interpreter's own diagnostic stream for this request. */
  readonly stderr: AetherDiagnostics
}

/** The outcome of one evaluated program, a usage read, or a close. */
export interface AetherSessionEvaluation {
  readonly kind: 'value' | 'error'
  /** The evaluated program's value, present when `kind` is `value`. */
  readonly value?: JsonValue
  /** JSON kind of `value`, matching the `aether_eval` vocabulary. */
  readonly resultType?: string
  /** The failure the interpreter reported, present when `kind` is `error`. */
  readonly error?: AetherFailure
  readonly logs: AetherSessionLogs
}

/** One handle's current state, without any wall-clock fact. */
export interface AetherSessionSummary {
  readonly sessionId: AetherSessionId
  readonly name?: string
  readonly cwd: string
  /** `starting` before the native session exists, `ready` or `busy` while live, `destroyed` once closed. */
  readonly phase: 'starting' | 'ready' | 'busy' | 'destroyed'
  readonly policyMode: SandboxMode
  /** Why the handle was closed; present only for `destroyed`. */
  readonly reason?: string
}

/** The result of closing one handle. */
export interface AetherSessionClosed {
  readonly sessionId: AetherSessionId
  /** False when no handle of this owner carried that id. */
  readonly closed: boolean
  /** Whether the interpreter's own `sess_close` reported the native session closed. */
  readonly nativeClosed: boolean
}

/** One drain of a session's unread output. */
export interface AetherSessionRead {
  readonly sessionId: AetherSessionId
  /** Everything the session wrote since the previous drain, bounded like every other log. */
  readonly logs: AetherSessionLogs
}

/** What one outstanding request resolves to. */
type AetherDispatch =
  | { readonly kind: 'reply'; readonly ok: true; readonly value: JsonValue }
  | { readonly kind: 'reply'; readonly ok: false; readonly error: AetherFailure }
  | { readonly kind: 'fault'; readonly detail: string }

/** How a request settled, once cancellation is folded in. */
type AetherRequestOutcome = AetherDispatch | { readonly kind: 'timeout' } | { readonly kind: 'cancelled' }

/** How the wrapped call is invoked after the nonce wrapper is built. */
type AetherSessionCallBuilder = () => string

/** Failure codes this module reports; each names the correction in its message. */
const E_OWNER = 'E_SESSION_OWNER'
const E_LIMIT = 'E_SESSION_LIMIT'
const E_UNKNOWN = 'E_SESSION_UNKNOWN'
const E_FOREIGN = 'E_SESSION_FOREIGN'
const E_POLICY = 'E_SESSION_POLICY'
const E_TIMEOUT = 'E_SESSION_TIMEOUT'
const E_PROTOCOL = 'E_SESSION_PROTOCOL'
const E_DISPOSED = 'E_SESSION_DISPOSED'

/** Error code reported when a session already has a request in flight. */
export const AETHER_SESSION_BUSY = 'E_SESSION_BUSY'

/**
 * Await one preparation step under the call's cancellation.
 *
 * A resolver or sandbox provider that ignores its signal still cannot hold a
 * session start open: the race settles on abort, and the abandoned operation's
 * later settlement is consumed here so it never surfaces as an unhandled
 * rejection and never reaches a spawn.
 * @param work - the preparation promise to await.
 * @param signal - the fused cancellation for this start.
 * @returns the work's result when it wins the race.
 * @throws the signal's abort reason when cancellation wins.
 */
async function waitWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => undefined)
  if (signal.aborted) signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const abort = (): void => { cancelled.reject(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await Promise.race([work, cancelled.promise])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** One owned handle: the interpreter process, its framing state, and its policy. */
class AetherLiveSession {
  /** The interpreter's own session id; never leaves this module. */
  nativeId: string | undefined
  handle: SubprocessHandle | undefined
  decoder: AetherSessionDecoder | undefined
  tracked: AetherTrackedProcess | undefined
  phase: 'starting' | 'ready' | 'busy' | 'destroyed' = 'starting'
  reason: string | undefined
  pending: { readonly nonce: string; readonly code: string; readonly resolve: (outcome: AetherDispatch) => void } | undefined
  /** Resolved by the first stdout byte, proving the process is live. */
  readonly ready = Promise.withResolvers<void>()
  /** The provider's own settlement, so a request in flight cannot outlive the process. */
  done: Promise<void> | undefined
  /** Aborted when this handle must stop: teardown, owner disposal, a deadline, or a policy change. */
  readonly processorAbort = new AbortController()
  /** The single join promise; every closer reuses it so teardown happens exactly once. */
  closing: Promise<void> | undefined
  /** Enforcement the wrapping backend reported, when one wrapped the argv. */
  enforcement: SandboxEnforcement | undefined
  /** The stdout listener this manager attached, so it can be detached at join. */
  onStdout: ((chunk: string) => void) | undefined
  /** The stream-failure listener this manager attached to both pipes. */
  onStreamError: ((error: unknown) => void) | undefined
  /** Wall-clock facts the manager needs but the model never sees. */
  lastUsedAt: number
  stderrOffset = 0

  /**
   * @param id - the opaque handle identity.
   * @param owner - the exact live Agent object that owns this handle.
   * @param cwd - absolute working directory for the interpreter process.
   * @param policy - the file-effect policy resolved when the handle opened.
   * @param name - the caller's label, when it gave one.
   * @param createdAt - creation time, used for idle accounting only.
   */
  constructor(
    readonly id: AetherSessionId,
    readonly owner: AetherSessionOwner,
    readonly cwd: string,
    readonly policy: SandboxExecutionPolicy,
    readonly name: string | undefined,
    readonly createdAt: number,
  ) {
    this.lastUsedAt = createdAt
    // Consumed at construction, not only on the destroy path: a start that
    // fails after its reader was abandoned must never surface as an unhandled
    // rejection, and the handler has to exist before the first rejection.
    this.ready.promise.catch(() => undefined)
  }

  /** The policy identity this handle is bound to; a new resolution must match it exactly. */
  get policyFingerprint(): string {
    return `${this.policy.mode}\u0000${this.policy.workspaceRoot}\u0000${String(this.policy.sessionId ?? '')}`
  }

  /** True once a closer has taken ownership of this handle's teardown. */
  get closed(): boolean {
    return this.closing !== undefined
  }
}

/**
 * Owns every persistent native session the plugin's tools hand out.
 *
 * The manager is the single owner of handle identity, ownership, policy
 * binding, idle reaping, and teardown. It performs no tool registration of its
 * own: the caller registers the returned tools and disposes this manager from
 * the plugin fiber, so removal order stays the caller's decision.
 */
export class AetherSessions {
  private readonly byId = new Map<AetherSessionId, AetherLiveSession>()
  private readonly cleanups = new Set<Promise<void>>()
  private readonly pendingStarts = new Set<Promise<void>>()
  private readonly ownerEffects = new Map<AetherSessionOwner, () => Promise<void>>()
  /** Owners whose scope has already unwound; no handle can be tied to them again. */
  private readonly disposedOwners = new WeakSet<AetherSessionOwner>()
  private readonly agents: AgentRegistry
  private idleTimer: NodeJS.Timeout | undefined
  private disposed = false

  /**
   * @param dependencies - capability services, resolved configuration, and plugin-owned state.
   * @param settings - the deployment's session budgets.
   * @throws Error when no live-agent registry is mounted, because ownership could not then be proven.
   */
  constructor(
    private readonly dependencies: AetherSessionDependencies,
    private readonly settings: AetherSessionSettings,
  ) {
    const agents = dependencies.ctx.get('agents')
    if (agents === undefined) {
      throw new Error(`aether-shell [${E_OWNER}]: the persistent session tools require the live-agent registry; load them only where "agents" is mounted`)
    }
    this.agents = agents
  }

  /**
   * Start one interpreter process and open a native session inside it.
   * @param owner - the calling agent, which must be the live registered Agent for its own id.
   * @param request - working directory, label, deadline, cancellation, and managed environment.
   * @returns the opaque handle and the policy it runs under.
   * @throws Error when the caller is not a live agent, the owner is at its handle limit, or the process could not start.
   */
  async open(
    owner: AetherSessionOwner,
    request: AetherSessionCall & {
      readonly cwd?: string
      readonly name?: string
      readonly managedEnv?: Readonly<Record<string, string>>
    },
  ): Promise<AetherSessionOpened> {
    this.assertUsable(owner)
    if (this.ownedBy(owner).length >= this.settings.maxSessionsPerOwner) {
      throw new Error(`aether-shell [${E_LIMIT}]: this agent already holds ${this.settings.maxSessionsPerOwner} sessions, the configured maxSessionsPerOwner; close one with aether_session action:close before opening another`)
    }
    const policy = this.policyFor(owner)
    const live = new AetherLiveSession(
      aetherSessionId(randomUUID()),
      owner,
      this.resolveCwd(request.cwd, owner),
      policy,
      request.name,
      Date.now(),
    )
    // The handle is registered before its first asynchronous step so the limit
    // and the ownership rules see it, and so a failed start cannot leave an
    // untracked process behind.
    // Registered before the handle is visible: an agent that cannot own its
    // sessions must not end up with one that outlives it.
    this.registerOwnerEffect(owner)
    this.byId.set(live.id, live)
    const start = this.start(live, request)
    this.pendingStarts.add(start)
    try {
      await start
    } catch (error) {
      await this.destroy(live, `the session could not start: ${describeError(error)}`)
      throw error
    } finally {
      this.pendingStarts.delete(start)
    }
    this.armIdleTimer()
    return {
      sessionId: live.id,
      ...request.name === undefined ? {} : { name: request.name },
      cwd: live.cwd,
      policy: {
        mode: policy.mode,
        workspaceRoot: policy.workspaceRoot,
        ...live.enforcement === undefined ? {} : { enforcement: live.enforcement },
      },
    }
  }

  /**
   * Evaluate one program inside an owned session.
   *
   * The caller's program text reaches the interpreter unchanged: it is encoded
   * as a native string literal, so its own interpolation and its own errors are
   * the interpreter's, not this plugin's.
   * @param owner - the calling agent.
   * @param request - the handle, the program text, the deadline, and cancellation.
   * @returns the value or the failure the interpreter reported, with bounded logs.
   * @throws Error when the handle does not exist, belongs to another agent, is busy, or was opened under a different policy; throws the structured abort when the caller cancelled.
   */
  async evaluate(
    owner: AetherSessionOwner,
    request: AetherSessionCall & { readonly sessionId: AetherSessionId; readonly code: string },
  ): Promise<AetherSessionEvaluation> {
    const live = this.requireOwned(owner, request.sessionId)
    await this.assertPolicy(owner, live)
    assertRequestBytes(request.code, this.dependencies.config)
    return this.settle(live, () => sessionEvalCall(live.nativeId ?? '', request.code), request)
  }

  /**
   * Read the native counters of an owned session.
   * @param owner - the calling agent.
   * @param request - the handle, the deadline, and cancellation.
   * @returns the interpreter's usage record as a value result.
   * @throws Error as {@link evaluate}.
   */
  async usage(
    owner: AetherSessionOwner,
    request: AetherSessionCall & { readonly sessionId: AetherSessionId },
  ): Promise<AetherSessionEvaluation> {
    const live = this.requireOwned(owner, request.sessionId)
    await this.assertPolicy(owner, live)
    return this.settle(live, () => sessionUsageCall(live.nativeId ?? ''), request)
  }

  /**
   * Drain the output a session has written since the previous drain.
   *
   * A persistent session may host a child or a service that keeps writing while
   * no request is in flight, so this reads the pipes directly instead of
   * running another program. The same ownership and policy rules as every other
   * operation apply.
   * @param owner - the calling agent.
   * @param request - the handle to drain.
   * @returns the unread output, bounded like every other log.
   * @throws Error when the handle does not exist, belongs to another agent, was opened under a different policy, or has a request in flight.
   */
  async read(owner: AetherSessionOwner, request: { readonly sessionId: AetherSessionId }): Promise<AetherSessionRead> {
    const live = this.requireOwned(owner, request.sessionId)
    await this.assertPolicy(owner, live)
    if (live.pending !== undefined) {
      throw new Error(`aether-shell [${AETHER_SESSION_BUSY}]: this session has a request in flight; its output belongs to that call, so wait for it to settle before reading`)
    }
    return { sessionId: live.id, logs: this.drain(live) }
  }

  /**
   * Report this owner's handles.
   *
   * Each handle's policy is re-resolved first. A handle whose policy changed is
   * closed here — and the close is awaited — and reported as destroyed, so this
   * read can never present a handle as usable under privileges it no longer
   * has.
   * @param owner - the calling agent.
   * @returns one summary per handle this owner holds, including ones closed by this call.
   */
  async list(owner: AetherSessionOwner): Promise<readonly AetherSessionSummary[]> {
    this.assertOwner(owner)
    const summaries: AetherSessionSummary[] = []
    for (const live of this.ownedBy(owner)) {
      if (this.fingerprintFor(owner) !== live.policyFingerprint) {
        const reason = 'the DSH file policy changed since this session opened; it was closed rather than run with stale privileges'
        await this.destroy(live, reason)
        summaries.push({ ...this.summarize(live, 'destroyed'), reason })
        continue
      }
      summaries.push(this.summarize(live, live.phase))
    }
    return summaries
  }

  /**
   * Close one owned handle and join its process.
   *
   * Closing is unconditional: the native session is asked to close first so its
   * own state is released, and the process is terminated afterwards whatever
   * the interpreter answered — including when asking it failed. No policy
   * re-resolution happens here because closing grants nothing.
   * @param owner - the calling agent.
   * @param request - the handle, the deadline, and cancellation.
   * @returns whether the handle existed and whether the interpreter confirmed its own close.
   * @throws Error when the handle belongs to another agent, or when the close request itself failed.
   */
  async close(
    owner: AetherSessionOwner,
    request: AetherSessionCall & { readonly sessionId: AetherSessionId },
  ): Promise<AetherSessionClosed> {
    this.assertOwner(owner)
    const live = this.byId.get(request.sessionId)
    if (live === undefined) return { sessionId: request.sessionId, closed: false, nativeClosed: false }
    if (live.owner !== owner) {
      throw new Error(`aether-shell [${E_FOREIGN}]: session ${JSON.stringify(request.sessionId)} belongs to another agent; only its owner may close it`)
    }
    let nativeClosed = false
    let failure: unknown
    try {
      // A handle with a request in flight cannot answer a native close, and the
      // caller asked for the session to be gone either way, so the process is
      // terminated without asking and `native_closed: false` says so. Any other
      // failure of the native close is reported as the failure it is.
      if (live.nativeId !== undefined && live.pending === undefined && !this.dependencies.processes.disposed) {
        const outcome = await this.request(live, () => sessionCloseCall(live.nativeId ?? ''), request)
        nativeClosed = outcome.kind === 'reply' && outcome.ok === true && isJsonObject(outcome.value) && outcome.value.closed === true
      }
    } catch (error) {
      // An explicit close always releases the process, even when asking the
      // interpreter to close its own session could not be answered.
      failure = error
    }
    await this.destroy(live, 'the caller closed the session')
    if (failure !== undefined) throw failure
    return { sessionId: request.sessionId, closed: true, nativeClosed }
  }

  /**
   * Close every handle, join each process, and wait for the manager's own
   * cleanups and any in-flight start. Registered as a plugin effect, so the
   * plugin's unload closes all sessions before the process registry settles
   * their ranges.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    await Promise.all([...this.byId.values()].map(live => this.destroy(live, 'the plugin unloaded')))
    await Promise.allSettled([...this.pendingStarts])
    // A destroy started by an in-flight request can register its cleanup after
    // this loop began, so drain until the set stops growing.
    while (this.cleanups.size > 0) await Promise.allSettled([...this.cleanups])
    // Only now, with every handle already joined, may the per-owner
    // registrations be removed: their disposers close nothing, so awaiting them
    // cannot re-enter a join that is still running.
    const effects = [...this.ownerEffects.values()]
    this.ownerEffects.clear()
    for (const dispose of effects) await dispose()
  }

  /** Resolve the calling session's file-effect policy. */
  private policyFor(owner: AetherSessionOwner): SandboxExecutionPolicy {
    return this.dependencies.ctx.sandboxPolicy.resolve({ session: owner.session })
  }

  /** One policy identity string, used to compare a fresh resolution against a handle's. */
  private fingerprintFor(owner: AetherSessionOwner): string {
    const policy = this.policyFor(owner)
    return `${policy.mode}\u0000${policy.workspaceRoot}\u0000${String(policy.sessionId ?? '')}`
  }

  /** Resolve the model's working directory against the owning session's workspace. */
  private resolveCwd(requested: string | undefined, owner: AetherSessionOwner): string {
    const workspace = owner.session.header.cwd ?? process.cwd()
    if (requested === undefined || requested.trim().length === 0) return workspace
    if (isAbsolute(requested)) return requested
    return resolvePath(workspace, requested)
  }

  /** Reject a caller that is not the exact live registered Agent for its own id. */
  private assertOwner(owner: AetherSessionOwner): void {
    const registered = this.agents.get(owner.id)
    if (registered === undefined) {
      throw new Error(`aether-shell [${E_OWNER}]: agent ${JSON.stringify(owner.id)} is not a live registered agent, so a session lifetime cannot be tied to it`)
    }
    if (registered !== owner) {
      throw new Error(`aether-shell [${E_OWNER}]: the calling object is not the live agent registered for ${JSON.stringify(owner.id)}; sessions belong to the exact live Agent`)
    }
  }

  /** Reject every call against a manager, owner, or handle that must not be used. */
  private assertUsable(owner: AetherSessionOwner): void {
    if (this.disposed) throw new Error(`aether-shell [${E_DISPOSED}]: the plugin unloaded, so no session can be opened`)
    this.assertOwner(owner)
  }

  /** Every live handle this owner currently holds. */
  private ownedBy(owner: AetherSessionOwner): AetherLiveSession[] {
    return [...this.byId.values()].filter(live => live.owner === owner)
  }

  /** Resolve one owned handle, refusing an unknown id and a foreign owner before any I/O. */
  private requireOwned(owner: AetherSessionOwner, sessionId: AetherSessionId): AetherLiveSession {
    this.assertUsable(owner)
    const live = this.byId.get(sessionId)
    if (live === undefined) {
      throw new Error(`aether-shell [${E_UNKNOWN}]: no open session has the id ${JSON.stringify(sessionId)}; use aether_session action:open or action:list`)
    }
    if (live.owner !== owner) {
      throw new Error(`aether-shell [${E_FOREIGN}]: session ${JSON.stringify(sessionId)} belongs to another agent; sessions are private to the agent that opened them`)
    }
    return live
  }

  /**
   * Refuse to run new work under privileges this handle no longer has.
   *
   * A changed policy closes the session — and the join is awaited, so the
   * refusal is reported only once the process that held the stale privileges is
   * gone. The next call can open a fresh session under the current policy.
   */
  private async assertPolicy(owner: AetherSessionOwner, live: AetherLiveSession): Promise<void> {
    if (this.fingerprintFor(owner) === live.policyFingerprint) return
    const opened = `${live.policy.mode} in ${JSON.stringify(live.policy.workspaceRoot)}`
    await this.destroy(live, 'the DSH file policy changed')
    throw new Error(`aether-shell [${E_POLICY}]: this session was opened under ${opened}, and the calling session's DSH file policy has since changed; the session is closed and cannot be reused. Open a new session to run under the current policy.`)
  }

  /** One handle's model-facing facts. */
  private summarize(live: AetherLiveSession, phase: AetherSessionSummary['phase']): AetherSessionSummary {
    return {
      sessionId: live.id,
      ...live.name === undefined ? {} : { name: live.name },
      cwd: live.cwd,
      phase,
      policyMode: live.policy.mode,
    }
  }

  /**
   * Tie every handle of one owner to that owner's lifetime.
   *
   * One effect per owner, not per handle: its disposer closes all of the
   * owner's sessions and returns the join promise, and it never calls back into
   * a join that is already running. The registration is dropped when the owner
   * unwinds, so a long-lived manager holds no reference to an agent that is
   * gone, and an owner whose scope already unwound is marked so a later call
   * cannot reopen one under a lifetime nobody owns.
   * @param owner - the agent that will own the handle being opened.
   * @throws Error when the owner's scope has already disposed.
   */
  private registerOwnerEffect(owner: AetherSessionOwner): void {
    if (this.ownerEffects.has(owner)) return
    if (this.disposedOwners.has(owner)) throw this.ownerGoneError()
    let dispose: () => Promise<void>
    try {
      dispose = owner.ctx.effect(() => async () => {
        this.ownerEffects.delete(owner)
        this.disposedOwners.add(owner)
        await this.destroyOwnedBy(owner, 'the owning agent was disposed')
      }, 'aether-shell.sessions.owner')
    } catch (error) {
      this.disposedOwners.add(owner)
      throw new Error(`${this.ownerGoneError().message} (${describeError(error)})`)
    }
    this.ownerEffects.set(owner, dispose)
  }

  /** The refusal reported when a session cannot be tied to its caller's lifetime. */
  private ownerGoneError(): Error {
    return new Error(`aether-shell [${E_OWNER}]: the calling agent's scope is already disposed, so a session cannot be tied to its lifetime`)
  }

  /** Close every handle one owner holds and await each join. */
  private async destroyOwnedBy(owner: AetherSessionOwner, reason: string): Promise<void> {
    await Promise.all(this.ownedBy(owner).map(live => this.destroy(live, reason)))
  }

  /** Resolve the interpreter, confine it when the policy requires it, and spawn one interactive process. */
  private async start(
    live: AetherLiveSession,
    request: AetherSessionCall & { readonly managedEnv?: Readonly<Record<string, string>> },
  ): Promise<void> {
    const { ctx, config, processes } = this.dependencies
    const policy = live.policy
    const confinedPolicy = policy.mode === 'danger-full-access' ? undefined : { ...policy, mode: policy.mode }
    const startupMs = Math.min(this.settings.sessionStartupTimeoutMs, request.timeoutMs)
    // The handle's own cancellation is fused in from the first step, so an
    // owner that goes away, a policy change, or a plugin unload cancels a
    // lookup, a confinement, or a ready wait that is still in flight.
    const lifetime = AbortSignal.any([request.signal, live.processorAbort.signal])
    const execution = deadline(lifetime, startupMs, AETHER_TIMEOUT_CODE)
    try {
      const preparation = processes.beginPreparation(lifetime)
      let argv: readonly string[]
      let runnerProgram: string | undefined
      let confinedMode: ConfinedSandboxMode | undefined
      let enforcement: SandboxEnforcement | undefined
      try {
        const executable = await waitWithAbort(this.dependencies.resolveExecutable(preparation.signal), preparation.signal)
        argv = [executable, ...config.executableArgs, 'agent', 'interactive']
        if (confinedPolicy !== undefined) {
          const confined = await waitWithAbort(
            ctx.sandbox.confine(argv, confinedPolicy, preparation.signal),
            preparation.signal,
          )
          argv = confined.argv
          confinedMode = confinedPolicy.mode
          enforcement = confined.enforcement
          runnerProgram = confined.argv[0]
        }
        preparation.signal.throwIfAborted()
      } catch (error) {
        if (live.phase === 'destroyed') throw this.closedError(live)
        if (timeoutOf(execution.signal, AETHER_TIMEOUT_CODE) !== undefined) throw this.timeoutError(startupMs)
        if (request.signal.aborted) throw toolAborted()
        if (processes.disposed) throw new Error(`aether-shell [${E_DISPOSED}]: the plugin unloaded while this session was starting`)
        throw error
      } finally {
        preparation.release()
      }
      if (processes.disposed) throw new Error(`aether-shell [${E_DISPOSED}]: the plugin unloaded while this session was starting`)
      // Nothing below awaits before the spawn, so a close that raced this point
      // has already been observed and cannot be followed by a new process.
      if (live.phase === 'destroyed') throw this.closedError(live)
      live.decoder = new AetherSessionDecoder({
        maxFrameBytes: config.maxOutputBytes,
        maxDiagnosticBytes: config.maxOutputBytes,
      })
      const spec: SubprocessSpawnSpec = {
        argv,
        cwd: live.cwd,
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: { maxBytes: config.maxOutputBytes, spill: { maxBytes: config.maxSpillBytes } },
        },
        graceMs: config.graceMs,
        // The process outlives the open call, so its cancellation is the
        // handle's own; that signal already carries the open call's.
        signal: live.processorAbort.signal,
        env: aetherEnvironment(config, request.managedEnv ?? {}),
      }
      let handle: SubprocessHandle
      try {
        handle = ctx.subprocess.spawn(spec)
      } catch (error) {
        if (confinedMode !== undefined && isRunnerSpawnFailure(error, runnerProgram, live.cwd)) {
          throw new SandboxUnavailableError(confinedMode, describeError(error))
        }
        throw new Error(`aether-shell [E_SPAWN]: could not start ${JSON.stringify(argv[0] ?? config.executable)} for a session: ${describeError(error)}`)
      }
      live.handle = handle
      live.tracked = processes.track(handle)
      live.enforcement = enforcement
      live.done = handle.done.then(
        () => { this.failSession(live, 'the interpreter exited') },
        (error: unknown) => { this.failSession(live, `the interpreter process failed: ${describeError(error)}`) },
      )
      const stdin = handle.stdin
      const stdout = handle.stdout
      if (stdin === undefined) throw new Error('aether-shell [E_SPAWN]: the subprocess provider did not expose the session\'s stdin pipe')
      if (stdout === undefined) throw new Error('aether-shell [E_SPAWN]: the subprocess provider did not expose the session\'s stdout pipe')
      const onStdout = (chunk: string): void => { this.route(live, chunk) }
      // Both pipes fail asynchronously — a write to a child that already exited
      // reports EPIPE through the stream, not through the write call — so the
      // failure has to be observed here rather than caught at the write site.
      const onStreamError = (error: unknown): void => { this.failSession(live, `the interpreter's stream failed: ${describeError(error)}`) }
      live.onStdout = onStdout
      live.onStreamError = onStreamError
      stdout.setEncoding('utf8')
      stdout.on('data', onStdout)
      stdout.on('error', onStreamError)
      stdin.on('error', onStreamError)
      await waitWithAbort(live.ready.promise, execution.signal)
      // The native open shares the startup budget: a deadline that covers only
      // the spawn would let a silent interpreter hold the call open.
      const outcome = await this.request(live, sessionOpenCall, { signal: execution.signal, timeoutMs: startupMs })
      // A close that raced the open request owns the teardown and the error.
      if (live.closed) throw this.closedError(live)
      if (outcome.kind !== 'reply' || outcome.ok !== true) {
        throw new Error(`aether-shell [${E_PROTOCOL}]: ${this.describe(outcome)}`)
      }
      const value = outcome.value
      if (!isJsonObject(value) || typeof value.session !== 'string') {
        throw new Error(`aether-shell [${E_PROTOCOL}]: sess_open did not return a session id; the interpreter's session builtins may have changed`)
      }
      live.nativeId = value.session
      // The three-line interactive banner is read exactly once, here: it is
      // interpreter greeting, not output any caller asked for.
      live.decoder?.takeDiagnostics()
      live.phase = 'ready'
    } finally {
      execution[Symbol.dispose]()
    }
  }

  /** Run one generated call and fold its outcome into a result the tools can return. */
  private async settle(live: AetherLiveSession, call: AetherSessionCallBuilder, request: AetherSessionCall): Promise<AetherSessionEvaluation> {
    const outcome = await this.request(live, call, request)
    // Drained after the request, never before it: output a persistent child
    // wrote while this session was idle belongs to whoever reads next.
    const logs = this.drain(live)
    switch (outcome.kind) {
      case 'reply':
        if (outcome.ok) {
          assertSessionValueFidelity(outcome.value, logs.stderr.spillPath)
          return { kind: 'value', value: outcome.value, resultType: jsonKindOf(outcome.value), logs }
        }
        return { kind: 'error', error: outcome.error, logs }
      case 'timeout':
        return { kind: 'error', error: this.timeoutFailure(request.timeoutMs), logs }
      case 'cancelled':
        throw toolAborted()
      case 'fault':
        return { kind: 'error', error: { code: E_PROTOCOL, message: outcome.detail, retryable: false }, logs }
      /* v8 ignore next 2 -- the dispatch union is closed; this is the static exhaustiveness guard. */
      default: return assertNever(outcome)
    }
  }

  /**
   * Write one nonce-correlated request and wait for its answer.
   *
   * A deadline, a caller cancellation, or a lost correlation closes the whole
   * session and awaits the join: the interpreter cannot abandon a running
   * command, so a session that outlived one would hold an unknown amount of
   * work and a stream this plugin no longer trusts.
   */
  private async request(live: AetherLiveSession, call: AetherSessionCallBuilder, request: AetherSessionCall): Promise<AetherRequestOutcome> {
    const handle = live.handle
    if (live.phase === 'destroyed' || handle === undefined || live.decoder === undefined) {
      return { kind: 'fault', detail: `the session is closed (${live.reason ?? 'the interpreter is gone'})` }
    }
    if (live.pending !== undefined) {
      throw new Error(`aether-shell [${AETHER_SESSION_BUSY}]: this session already has a request in flight; one evaluation at a time is allowed, so wait for it to settle before sending another`)
    }
    const nonce = randomUUID()
    const code = sessionNonceWrapper(nonce, call())
    assertRequestBytes(code, this.dependencies.config)
    const execution = deadline(request.signal, request.timeoutMs, AETHER_TIMEOUT_CODE)
    const settled = Promise.withResolvers<AetherRequestOutcome>()
    live.pending = { nonce, code, resolve: (dispatch: AetherDispatch) => { settled.resolve(dispatch) } }
    live.phase = 'busy'
    const cancel = (): void => {
      settled.resolve(timeoutOf(execution.signal, AETHER_TIMEOUT_CODE) === undefined
        ? { kind: 'cancelled' }
        : { kind: 'timeout' })
    }
    execution.signal.addEventListener('abort', cancel, { once: true })
    if (execution.signal.aborted) cancel()
    else if (!this.writeRequest(live, code)) {
      const reason = 'the interpreter\'s request channel closed before the request was written'
      await this.destroy(live, reason)
      settled.resolve({ kind: 'fault', detail: reason })
    }
    try {
      const outcome = await settled.promise
      if (outcome.kind === 'timeout') {
        await this.destroy(live, `the call deadline of ${request.timeoutMs}ms elapsed`)
        return outcome
      }
      if (outcome.kind === 'cancelled') {
        await this.destroy(live, 'the call was cancelled')
        return outcome
      }
      // Every lost correlation joins the process before the caller sees the
      // failure, so a refused call never leaves a privileged process running.
      if (outcome.kind === 'fault') await this.destroy(live, outcome.detail)
      return outcome
    } finally {
      execution.signal.removeEventListener('abort', cancel)
      execution[Symbol.dispose]()
      if (live.pending?.nonce === nonce) live.pending = undefined
      live.lastUsedAt = Date.now()
      if (live.phase === 'busy') live.phase = 'ready'
      this.armIdleTimer()
    }
  }

  /** Write one JSON request line; false means the channel was already gone. */
  private writeRequest(live: AetherLiveSession, code: string): boolean {
    const stdin = live.handle?.stdin
    if (stdin === undefined || stdin.destroyed || stdin.writableEnded) return false
    try {
      stdin.write(`${JSON.stringify({ action: 'eval', code })}\n`, 'utf8', (error?: Error | null) => {
        if (error === undefined || error === null) return
        this.failSession(live, `writing a session request failed: ${describeError(error)}`)
      })
      return true
    } catch (error) {
      this.report(`aether-shell: writing a session request failed: ${describeError(error)}`)
      return false
    }
  }

  /** Frame one stdout chunk and deliver every complete document. */
  private route(live: AetherLiveSession, chunk: string): void {
    const decoder = live.decoder
    if (decoder === undefined || live.phase === 'destroyed') return
    live.ready.resolve()
    decoder.push(chunk)
    const failure = decoder.failure
    if (failure !== undefined) {
      this.failSession(live, failure)
      return
    }
    for (const document of decoder.takeDocuments()) {
      const pending = live.pending
      if (pending === undefined) {
        decoder.note(`${JSON.stringify(document)}\n`)
        continue
      }
      const reply = classifySessionReply(document, pending.nonce, pending.code)
      if (reply.kind === 'foreign') {
        decoder.note(`${JSON.stringify(document)}\n`)
        continue
      }
      live.pending = undefined
      if (reply.kind === 'desync') pending.resolve({ kind: 'fault', detail: `the interpreter could not evaluate the generated request: ${reply.detail}` })
      else pending.resolve(reply)
    }
  }

  /** Settle an outstanding request and close the handle after a stream or process failure. */
  private failSession(live: AetherLiveSession, detail: string): void {
    if (live.phase === 'destroyed') return
    live.ready.reject(new Error(detail))
    void this.destroy(live, detail)
  }

  /**
   * Close one handle: deregister it, abort whatever it is doing, end its
   * request channel, terminate its managed range, and join the process.
   *
   * The first caller creates the single join promise; every later caller
   * receives that same promise, so concurrent closers all await one teardown.
   * The returned promise never rejects — a cleanup failure is reported as a
   * diagnostic instead, because a rejecting disposer stops cordis from running
   * the disposers registered after it.
   */
  private destroy(live: AetherLiveSession, reason: string): Promise<void> {
    if (live.closing !== undefined) return live.closing
    live.phase = 'destroyed'
    live.reason = reason
    this.byId.delete(live.id)
    live.processorAbort.abort(new Error(reason))
    const pending = live.pending
    live.pending = undefined
    if (pending !== undefined) pending.resolve({ kind: 'fault', detail: reason })
    const cleanup = this.join(live).finally(() => { this.cleanups.delete(cleanup) })
    live.closing = cleanup
    this.cleanups.add(cleanup)
    this.armIdleTimer()
    return cleanup
  }

  /** Terminate one handle's managed range and await quiescence, reporting anything that resists. */
  private async join(live: AetherLiveSession): Promise<void> {
    const handle = live.handle
    if (handle === undefined) {
      this.release(live)
      return
    }
    this.detach(live, handle)
    try {
      // Ending the channel is best-effort and never awaited: a provider whose
      // pipe cannot flush must not hold teardown open.
      handle.stdin?.end()
    } catch (error) {
      this.report(`aether-shell: closing a session's request channel failed: ${describeError(error)}`)
    }
    try {
      handle.terminate()
    } catch (error) {
      this.report(`aether-shell: terminating a session's managed range failed: ${describeError(error)}`)
    }
    await handle.done.catch((error: unknown) => {
      this.report(`aether-shell: a session's interpreter exited with a provider failure: ${describeError(error)}`)
    })
    live.tracked?.release()
    live.tracked = undefined
    if (!await this.dependencies.processes.settle(handle, this.dependencies.config.graceMs)) {
      this.report('aether-shell: a closed session left work behind that the provider could not prove stopped')
    }
    this.release(live)
  }

  /** Remove this manager's stream listeners before the pipes are torn down. */
  private detach(live: AetherLiveSession, handle: SubprocessHandle): void {
    if (live.onStdout !== undefined) handle.stdout?.off('data', live.onStdout)
    if (live.onStreamError !== undefined) {
      handle.stdout?.off('error', live.onStreamError)
      handle.stdin?.off('error', live.onStreamError)
    }
    live.onStdout = undefined
    live.onStreamError = undefined
  }

  /** Drop everything this handle held once its process is gone. */
  private release(live: AetherLiveSession): void {
    live.handle = undefined
    live.decoder = undefined
    live.nativeId = undefined
    live.done = undefined
  }

  /** The failure reported when a handle was closed while its start was still running. */
  private closedError(live: AetherLiveSession): Error {
    return new Error(`aether-shell [${E_UNKNOWN}]: the session was closed while it was starting (${live.reason ?? 'closed'})`)
  }

  /** Arm the single idle timer at the earliest deadline any owned handle carries. */
  private armIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    const idleMs = this.settings.sessionIdleTimeoutMs
    if (this.disposed || idleMs <= 0) return
    let earliest: number | undefined
    for (const live of this.byId.values()) {
      if (live.phase === 'busy') continue
      const at = live.lastUsedAt + idleMs
      if (earliest === undefined || at < earliest) earliest = at
    }
    if (earliest === undefined) return
    const delay = Math.min(Math.max(0, earliest - Date.now()), MAX_TIMER_DELAY_MS)
    this.idleTimer = setTimeout(() => { this.sweepIdle() }, delay)
    this.idleTimer.unref()
  }

  /** Close every handle that stayed idle past the configured limit. */
  private sweepIdle(): void {
    this.idleTimer = undefined
    const idleMs = this.settings.sessionIdleTimeoutMs
    if (idleMs <= 0 || this.disposed) return
    const now = Date.now()
    for (const live of [...this.byId.values()]) {
      if (live.phase === 'busy' || now - live.lastUsedAt < idleMs) continue
      void this.destroy(live, `the session was idle for ${idleMs}ms and was closed`)
    }
    this.armIdleTimer()
  }

  /** Read the interpreter's diagnostic stream from the last consumed offset. */
  private readStderr(live: AetherLiveSession): AetherDiagnostics {
    const reader = live.handle?.collected.stderr
    if (reader === undefined) return { text: '', truncated: false }
    const read = reader.readFrom(live.stderrOffset)
    live.stderrOffset = read.nextOffset
    return {
      text: read.text,
      truncated: read.lossy,
      ...read.spillPath === undefined ? {} : { spillPath: read.spillPath },
    }
  }

  /**
   * Take everything one session has written since the previous drain.
   *
   * Both streams are consumed by this call, so a caller that receives output
   * never receives it twice and never loses output it did not ask for.
   */
  private drain(live: AetherLiveSession): AetherSessionLogs {
    const read = live.decoder?.takeDiagnostics()
    return {
      stdout: { text: read?.text ?? '', truncated: read?.truncated ?? false },
      stderr: this.readStderr(live),
    }
  }

  /** The failure reported when this plugin's own deadline ended a request. */
  private timeoutFailure(timeoutMs: number): AetherFailure {
    return {
      code: E_TIMEOUT,
      message: `the call deadline of ${timeoutMs}ms elapsed, so the session's interpreter process was terminated`,
      hint: 'the session is closed because the interpreter cannot abandon a running command; open a new session to continue, and raise timeoutMs for a program that legitimately needs longer',
      retryable: false,
    }
  }

  /** The error a start that ran out of startup budget throws. */
  private timeoutError(startupMs: number): Error {
    return new Error(`aether-shell [${E_TIMEOUT}]: the interpreter did not start an interactive session within ${startupMs}ms`)
  }

  /** Describe one request outcome for a failure message. */
  private describe(outcome: AetherRequestOutcome): string {
    if (outcome.kind === 'reply' && !outcome.ok) return outcome.error.message
    if (outcome.kind === 'fault') return outcome.detail
    if (outcome.kind === 'timeout') return 'the interpreter did not answer before the call deadline'
    if (outcome.kind === 'cancelled') return 'the call was cancelled'
    return 'the interpreter answered without a session id'
  }

  /** Report a non-fatal session diagnostic; never model-facing. */
  private report(message: string): void {
    this.dependencies.ctx.logger.warn(message)
  }
}

/** Compile-time exhaustiveness guard for the closed dispatch union. */
function assertNever(value: never): never {
  throw new Error(`aether-shell: unhandled session dispatch ${JSON.stringify(value)}`)
}
