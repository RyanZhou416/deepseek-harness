/**
 * Process-wide agent-step admission. The plugin delays proposed steps before
 * model-history assembly while either the concurrency limit or V8 heap
 * hysteresis is closed; admitted steps retain their slot through `step/end`.
 * @module @deepseek-ai/dsh-memory-admission
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { getHeapStatistics } from 'node:v8'
import { StepAdmissionGate, type GateConfig } from './gate.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Readiness service published after process-wide admission listeners are installed. */
    memoryAdmission: StepAdmissionGate
  }
}

export const name = 'memory-admission'
export const inject = ['agents']

/** Configurable process-wide admission limits. */
export interface Config {
  /** Maximum admitted agent steps across the process. Defaults to 8. */
  maxConcurrentSteps?: number
  /** Heap-used ratio that closes new admission. Defaults to 0.82. */
  heapHighWatermarkRatio?: number
  /** Heap-used ratio that reopens admission after pressure. Defaults to 0.72. */
  heapLowWatermarkRatio?: number
  /** Heap resampling interval while callers wait. Defaults to 100ms. */
  sampleIntervalMs?: number
}

export const Config: z<Config> = z.object({
  maxConcurrentSteps: z.number().step(1).min(1).default(8),
  heapHighWatermarkRatio: z.number().min(0.01).max(0.99).default(0.82),
  heapLowWatermarkRatio: z.number().min(0).max(0.98).default(0.72),
  sampleIntervalMs: z.number().step(1).min(10).max(10_000).default(100),
})

interface Reservation {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  readonly release: () => void
}

/** Validate hysteresis ordering after Schemastery resolves defaults. */
function resolveConfig(config: Config): GateConfig {
  const resolved = config as Required<Config>
  if (resolved.heapLowWatermarkRatio >= resolved.heapHighWatermarkRatio) {
    throw new Error('memory-admission: heapLowWatermarkRatio must be less than heapHighWatermarkRatio')
  }
  return resolved
}

/** Current V8 heap occupancy against the process heap limit. */
function heapRatio(): number {
  return process.memoryUsage().heapUsed / getHeapStatistics().heap_size_limit
}

/** Install the process-wide pre-step admission policy. */
export function apply(ctx: Context, config: Config): void {
  const gate = new StepAdmissionGate(resolveConfig(config), heapRatio)
  const reservations = new Map<SessionId, Reservation>()

  const release = (agent: Agent): void => {
    const reservation = reservations.get(agent.id)
    if (reservation?.agent !== agent) return
    reservations.delete(agent.id)
    reservation.release()
  }

  ctx.effect(() => () => {
    gate.close(new Error('memory-admission: plugin disposed'))
    for (const reservation of reservations.values()) reservation.release()
    reservations.clear()
  }, 'memory-admission.close')

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next): Promise<PreStepDecision> => {
    const releaseSlot = await gate.acquire(signal)
    let retained = false
    try {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      /* v8 ignore next -- one Agent driver cannot enter a second pre-step before its current step releases. */
      if (reservations.has(agent.id)) {
        throw new Error(`memory-admission: agent "${agent.id}" already holds a step reservation`)
      }
      reservations.set(agent.id, { agent, turn, step, release: releaseSlot })
      retained = true
      return decision
    } finally {
      if (!retained) releaseSlot()
    }
  })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'step/end') return
    const reservation = reservations.get(session.id)
    /* v8 ignore next -- a valid Session emits step/end only for the pre-step turn/step that owns its reservation. */
    if (reservation === undefined
      || reservation.turn !== event.data.turn
      || reservation.step !== event.data.step) return
    reservations.delete(session.id)
    reservation.release()
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') release(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => { release(agent) })
  ctx.provide('memoryAdmission', gate)
}
