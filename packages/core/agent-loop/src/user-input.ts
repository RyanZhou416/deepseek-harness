/** Constant-size projection used by same-session revision admission. */
import { z } from 'zod'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { UserInputProjection } from '@deepseek-ai/dsh-agent'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const seq = z.number().int().nonnegative().transform(SessionSeq)
const stateSchema: z.ZodType<UserInputProjection> = z.object({
  latest: z.object({ seq, textOnly: z.boolean() }).nullable(),
  pending: z.object({ seq, replaces: seq }).nullable(),
})

/** Latest human input facts; consumers separately check current surface membership. */
export const userInputProjectionDefinition = {
  key: 'userInput',
  stateVersion: 1,
  stateSchema,
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
