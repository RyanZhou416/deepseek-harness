/**
 * Refusal shared by both `ask_user_question` definitions while unattended mode
 * is on.
 */

import type { Context } from '@deepseek-ai/cordis'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-unattended-mode'

/** Stable error code carried by the refusal. */
export const USER_AWAY = 'USER_AWAY'

/** Model-facing refusal: no human can answer, so the model decides from workspace guidance. */
export const userAwayMessage = 'The user is away: unattended mode is on, so nobody can answer this question. '
  + "Read AGENTS.md (or AGENT.md) at the workspace root for the user's standing guidance, decide on your own, and continue."

/**
 * Reject a question when the deployment runs without a human.
 * @param ctx - tool context; unattended mode is optional and read at execution time.
 * @throws UserQuestionError with code {@link USER_AWAY} while unattended mode is on.
 */
export function refuseWhenUnattended(ctx: Context): void {
  if (ctx.get('unattendedMode')?.enabled() !== true) return
  throw new UserQuestionError(userAwayMessage, USER_AWAY)
}
