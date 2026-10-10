/**
 * The error line one provider card shows on the Subscriptions page.
 *
 * A failed `status` poll and a failed action are recorded apart. The poll
 * reports one failure for every provider and a successful poll clears it, while
 * an action reports a message about the provider the user just acted on and
 * refreshes the page right after it fails; one shared slot would let that
 * refresh erase the message before it is rendered. An action's own line
 * therefore outranks the poll's, and only the next action on that provider
 * replaces or clears it.
 */

import type { SubscriptionProvider } from './SubscriptionsSection.js'

/** The error lines recorded for one provider card. */
interface ProviderErrorLines {
  /** The status poll's line: set for every provider by a failed poll, cleared by a successful one. */
  poll?: string
  /** The action's line: set by the action that failed, cleared by the next action on that provider. */
  action?: string
}

/** The error lines of every provider card, keyed by provider. */
export type ProviderErrorState = Partial<Record<SubscriptionProvider, ProviderErrorLines>>

/**
 * The line one provider card renders.
 * @param state - the recorded lines.
 * @param provider - the provider whose card is rendered.
 * @returns the action's line when it has one, otherwise the poll's.
 */
export function errorLine(state: ProviderErrorState, provider: SubscriptionProvider): string | undefined {
  const lines = state[provider]
  return lines?.action ?? lines?.poll
}

/**
 * Record one provider's `status` poll: its failure, or undefined when it
 * succeeded.
 * @param state - the recorded lines.
 * @param provider - the provider the poll answered for.
 * @param message - the poll's failure message, or undefined on success.
 * @returns the recorded lines; an action's own line survives either outcome.
 */
export function withPollError(
  state: ProviderErrorState,
  provider: SubscriptionProvider,
  message: string | undefined,
): ProviderErrorState {
  return replace(state, provider, {
    ...state[provider]?.action === undefined ? {} : { action: state[provider]?.action },
    ...message === undefined ? {} : { poll: message },
  })
}

/**
 * Record one provider's action outcome: the message it failed with, or
 * undefined when the next action on it starts or a dismissal clears it.
 * @param state - the recorded lines.
 * @param provider - the provider the action ran on.
 * @param message - the action's failure message, or undefined to clear it.
 * @returns the recorded lines.
 */
export function withActionError(
  state: ProviderErrorState,
  provider: SubscriptionProvider,
  message: string | undefined,
): ProviderErrorState {
  return replace(state, provider, {
    ...state[provider]?.poll === undefined ? {} : { poll: state[provider]?.poll },
    ...message === undefined ? {} : { action: message },
  })
}

/** Replace one provider's entry, dropping it when it holds no line at all. */
function replace(
  state: ProviderErrorState,
  provider: SubscriptionProvider,
  lines: ProviderErrorLines,
): ProviderErrorState {
  const next = { ...state }
  if (lines.poll === undefined && lines.action === undefined) delete next[provider]
  else next[provider] = lines
  return next
}
