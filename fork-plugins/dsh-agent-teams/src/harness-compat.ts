/**
 * Version-specific subagent adapters for the exact Harness releases exercised
 * by AgentTeams. Public model messaging and host-authored Queue/Steer delivery
 * remain separate because they carry different provenance and turn semantics.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SubagentError } from '@deepseek-ai/dsh-subagent'

/** Host FIFO adapter used by Harness 0.1.2 Alpha.5 and RC.1. */
const hostPromptQueue = Symbol.for('dsh.subagent.queuePrompt')
/** Unified Host Queue/Steer adapter used by Harness 0.1.3 Alpha.2. */
const hostPromptDelivery = Symbol.for('dsh.subagent.deliverPrompt')

type Setup = (childCtx: Context) => () => void
type Followup = (parent: Agent, childId: SessionId, content: ContentBlock[], options: {
  source: MessageSource; signal: AbortSignal
}) => Promise<MessageId>
type Queue = (
  parent: Agent,
  childId: SessionId,
  content: ContentBlock[],
  source: MessageSource,
  signal: AbortSignal,
) => Promise<MessageId>
type Delivery = (
  parent: Agent,
  childId: SessionId,
  content: ContentBlock[],
  source: MessageSource,
  signal: AbortSignal,
  delivery: 'queue' | 'steer',
) => Promise<MessageId>
type Send = (
  sender: Agent,
  targetId: SessionId,
  content: ContentBlock[],
  options: { signal: AbortSignal },
) => Promise<MessageId>

interface RuntimeBoundary {
  followup?: Followup
  registerContinuableSetup?: (setup: Setup) => () => void
  sendMessage?: Send
  [hostPromptQueue]?: Queue
  [hostPromptDelivery]?: Delivery
}

function boundary(runtime: Context['subagents']): RuntimeBoundary {
  return runtime as unknown as RuntimeBoundary
}

function unsupported(detail: string): never {
  throw new Error(
    `agent-teams: unsupported Harness subagent contract (${detail}); use an explicitly tested Harness version and a coherent dependency installation`,
  )
}

/** Read child-owned history without a descriptor inherited from its parent. */
export function sessionOwnEvents(session: Session): readonly SessionEvent[] {
  const current = session as unknown as { ownEvents?: () => readonly SessionEvent[] }
  if (typeof current.ownEvents === 'function') return current.ownEvents.call(session)
  const legacy = session as unknown as { events?: readonly SessionEvent[]; header: { seedLength?: number } }
  if (!Array.isArray(legacy.events)) return unsupported('missing ownEvents/legacy session log')
  return legacy.events.slice(legacy.header.seedLength ?? 0)
}

/** Install member setup before the first request, including cold resume. */
export function installContinuableMemberSetup(ctx: Context, setup: Setup): void {
  const runtime = boundary(ctx.subagents)
  if (typeof runtime.registerContinuableSetup === 'function') {
    runtime.registerContinuableSetup.call(ctx.subagents, setup)
    return
  }
  const hasHostDelivery = typeof runtime[hostPromptQueue] === 'function'
    || typeof runtime[hostPromptDelivery] === 'function'
  if (!hasHostDelivery || typeof runtime.sendMessage !== 'function') {
    return unsupported('missing continuable setup and Host delivery')
  }
  const installed = new WeakSet<Agent>()
  const active = new Set<() => void>()
  ctx.effect(() => {
    const stop = ctx.on('agent/session-start', ({ agent }) => {
      if (installed.has(agent)) return
      let teardown: () => void
      try {
        // This notification is synchronous; setup must win the first request.
        teardown = setup(agent.ctx)
      } catch (error: unknown) {
        const failure = new Error(
          `agent-teams: member initialization failed: ${String(error)}`,
          { cause: error },
        )
        ctx.logger.warn(failure.message)
        teardown = agent.ctx.on('agent/request', () => { throw failure })
      }
      installed.add(agent)
      let disposed = false
      const dispose = (): void => {
        if (disposed) return
        disposed = true
        active.delete(dispose)
        installed.delete(agent)
        teardown()
      }
      active.add(dispose)
      try {
        agent.ctx.effect(() => dispose, 'agent-teams: child compatibility setup')
      } catch (error) {
        dispose()
        throw error
      }
    })
    return () => {
      stop()
      for (const dispose of [...active]) dispose()
    }
  }, 'agent-teams: member lifecycle compatibility')
}

/** Queue a distinct host-authored turn on a supported legacy Harness. */
export async function queueMemberPrompt(
  runtime: Context['subagents'],
  parent: Agent,
  childId: SessionId,
  content: ContentBlock[],
  signal: AbortSignal,
): Promise<MessageId> {
  const host = boundary(runtime)
  const source: MessageSource = { kind: 'plugin', plugin: 'dsh-agent-teams' }
  if (typeof host.followup === 'function') {
    return host.followup.call(runtime, parent, childId, content, { source, signal })
  }
  const queue = host[hostPromptQueue]
  if (typeof queue === 'function') {
    return queue.call(runtime, parent, childId, content, source, signal)
  }
  const delivery = host[hostPromptDelivery]
  if (typeof delivery === 'function') {
    return delivery.call(runtime, parent, childId, content, source, signal, 'queue')
  }
  return unsupported('missing Host FIFO delivery')
}

/**
 * Deliver a member message with Alpha.2's nearest-step policy.
 *
 * A resident member receives Steer so guidance is visible at its next model
 * step. An inactive member receives Queue, which may cold-resume it as a
 * distinct turn.
 */
export async function deliverMemberPrompt(
  ctx: Context,
  parent: Agent,
  childId: SessionId,
  content: ContentBlock[],
  signal: AbortSignal,
): Promise<MessageId> {
  const host = boundary(ctx.subagents)
  if (
    typeof host.registerContinuableSetup === 'function'
    && typeof host.followup === 'function'
  ) {
    return queueMemberPrompt(ctx.subagents, parent, childId, content, signal)
  }
  const delivery = host[hostPromptDelivery]
  if (typeof delivery !== 'function') {
    return queueMemberPrompt(ctx.subagents, parent, childId, content, signal)
  }
  const source: MessageSource = { kind: 'plugin', plugin: 'dsh-agent-teams' }
  const mode = ctx.agents.get(childId) === undefined ? 'queue' : 'steer'
  return delivery.call(ctx.subagents, parent, childId, content, source, signal, mode)
}

/** Guard every resumable delivery path while preserving native receivers. */
export function guardSubagentDelivery(
  ctx: Context,
  isRetired: (sender: Agent, targetId: SessionId) => Promise<boolean>,
): void {
  const runtime = ctx.subagents
  const host = boundary(runtime)
  const legacy = host.followup
  const queue = host[hostPromptQueue]
  const delivery = host[hostPromptDelivery]
  const send = host.sendMessage
  if (
    typeof legacy !== 'function'
    && typeof queue !== 'function'
    && typeof delivery !== 'function'
  ) {
    return unsupported('cannot install retired-member Host delivery guard')
  }
  if (typeof delivery === 'function' && typeof send !== 'function') {
    return unsupported('cannot install retired-member public messaging guard')
  }
  ctx.effect(() => {
    const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>([
      ['followup', Object.getOwnPropertyDescriptor(host, 'followup')],
      [hostPromptQueue, Object.getOwnPropertyDescriptor(host, hostPromptQueue)],
      [hostPromptDelivery, Object.getOwnPropertyDescriptor(host, hostPromptDelivery)],
      ['sendMessage', Object.getOwnPropertyDescriptor(host, 'sendMessage')],
    ])
    let active = true
    const check = async (sender: Agent, targetId: SessionId): Promise<void> => {
      if (active && await isRetired(sender, targetId)) {
        throw new SubagentError(
          `AgentTeams member "${targetId}" was retired and cannot be resumed`,
          'NOT_RESUMABLE',
        )
      }
    }
    const guardedLegacy: Followup = async (parent, childId, content, options) => {
      await check(parent, childId)
      return legacy!.call(runtime, parent, childId, content, options)
    }
    const guardedQueue: Queue = async (parent, childId, content, source, signal) => {
      await check(parent, childId)
      return queue!.call(runtime, parent, childId, content, source, signal)
    }
    const guardedDelivery: Delivery = async (
      parent,
      childId,
      content,
      source,
      signal,
      mode,
    ) => {
      await check(parent, childId)
      return delivery!.call(runtime, parent, childId, content, source, signal, mode)
    }
    const guardedSend: Send = async (sender, targetId, content, options) => {
      await check(sender, targetId)
      return send!.call(runtime, sender, targetId, content, options)
    }
    if (typeof legacy === 'function') host.followup = guardedLegacy
    if (typeof queue === 'function') host[hostPromptQueue] = guardedQueue
    if (typeof delivery === 'function') host[hostPromptDelivery] = guardedDelivery
    if (typeof send === 'function') host.sendMessage = guardedSend

    const restore = (key: PropertyKey, installed: unknown): void => {
      if (Object.getOwnPropertyDescriptor(host, key)?.value !== installed) return
      const original = descriptors.get(key)
      if (original === undefined) Reflect.deleteProperty(host, key)
      else Object.defineProperty(host, key, original)
    }
    return () => {
      active = false
      if (typeof legacy === 'function') restore('followup', guardedLegacy)
      if (typeof queue === 'function') restore(hostPromptQueue, guardedQueue)
      if (typeof delivery === 'function') restore(hostPromptDelivery, guardedDelivery)
      if (typeof send === 'function') restore('sendMessage', guardedSend)
    }
  }, 'agent-teams: retired member guard')
}
