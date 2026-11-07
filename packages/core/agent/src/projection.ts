/** Shared pure folds of the Session's turn, step, and human-input events. */
import type { TurnBoundaryProjection, UserInputProjection } from './types.ts'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { brandNumber } from '@deepseek-ai/dsh-brand'
import { z as zod } from 'zod'

const sessionSeqSchema = zod.number().int().nonnegative().transform(brandNumber<SessionSeq>)

const turnBoundaryProjectionSchema: zod.ZodType<TurnBoundaryProjection> = zod.object({
  openTurnStartSeq: sessionSeqSchema.nullable(),
  lastStepStartSeq: sessionSeqSchema.nullable(),
  lastStepBoundary: zod.object({
    kind: zod.union([zod.literal('start'), zod.literal('end')]),
    seq: sessionSeqSchema,
  }).nullable(),
  lastTurn: zod.number().int().nonnegative(),
})

/** Host projection of agent turn and step boundaries. */
export const turnBoundaryProjectionDefinition = {
  key: 'turnBoundary',
  stateVersion: 2,
  stateSchema: turnBoundaryProjectionSchema,
  init: () => ({
    openTurnStartSeq: null,
    lastStepStartSeq: null,
    lastStepBoundary: null,
    lastTurn: 0,
  }),
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start':
        return {
          ...state,
          openTurnStartSeq: event.seq,
          lastTurn: event.data.turn,
        }
      case 'turn/end':
        return {
          ...state,
          openTurnStartSeq: null,
        }
      case 'step/start':
        return {
          ...state,
          lastStepStartSeq: event.seq,
          lastStepBoundary: { kind: 'start', seq: event.seq },
        }
      case 'step/end':
        return {
          ...state,
          lastStepBoundary: { kind: 'end', seq: event.seq },
        }
      default:
        return state
    }
  },
} satisfies ProjectionDefinition<'turnBoundary', TurnBoundaryProjection>

const userInputProjectionSchema: zod.ZodType<UserInputProjection> = zod.object({
  latest: zod.object({ seq: sessionSeqSchema, textOnly: zod.boolean() }).nullable(),
  pending: zod.object({ seq: sessionSeqSchema, replaces: sessionSeqSchema }).nullable(),
})

/** Host projection of the latest human input and its pending revision coordinates. */
export const userInputProjectionDefinition = {
  key: 'userInput',
  stateVersion: 1,
  stateSchema: userInputProjectionSchema,
  init: () => ({ latest: null, pending: null }),
  apply: (state, event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return state
    const source = event.data.source
    const replaces = 'replacesUserMessage' in source ? source.replacesUserMessage : undefined
    let latest = { seq: event.seq, textOnly: event.data.content.every(block => block.type === 'text') }
    let pending = state.pending
    if ('pendingRevision' in source && replaces !== undefined) {
      pending = { seq: event.seq, replaces }
    } else if (replaces !== undefined && pending !== null && pending.replaces === replaces) {
      if (state.latest !== null && state.latest.seq !== pending.seq) latest = state.latest
      pending = null
    }
    return { latest, pending }
  },
} satisfies ProjectionDefinition<'userInput', UserInputProjection>
