/**
 * The Host reads and writes the CC subscription pool page performs, bound in
 * the plugin body.
 *
 * The credential literal never rides a read: the page learns only whether the
 * reference resolves, which layer supplies it, and whether this Host can write
 * it. The catalogue stays in the settings document and is written through the
 * shared configuration form (`ctx.configForms`), not through these callbacks.
 * The pool listing is the one read that leaves the settings document: the
 * Host's registered discovery asks the pool which models it serves, and the
 * page's cancellation lets it stop waiting on that request.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge (the generated `credentials` and `llm`
// namespaces) into this program.
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-api-remotes/client'
import { CC_POOL_PROVIDER } from './contract.ts'

/** Credential facts the page shows for the pool reference. */
export interface CcPoolCredentialView {
  /** Whether resolving the reference would currently return a value. */
  configured: boolean
  /** Source layer currently supplying the value; absent while unconfigured. */
  source?: string
  /** Whether this Host can write the reference. */
  writable: boolean
  /** Why the read failed, when it did; the page shows the Host diagnostic verbatim. */
  error?: string
}

/** What one pool listing interrogation answered. */
export type CcPoolDiscoveryOutcome =
  /** The models the pool disclosed, in its own order. */
  | { readonly kind: 'found'; readonly models: readonly LlmDiscoveredModel[] }
  /** The interrogation was refused, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** The one discovery request the page sends: the pool route describes its own catalogue. */
export const CC_POOL_DISCOVERY_REQUEST: LlmModelDiscoveryRequest = Object.freeze({ provider: CC_POOL_PROVIDER })

/** The Host operations the page invokes. */
export interface CcPoolOperations {
  /**
   * Read the pool reference's configured state, source, and writability.
   * @param ref - credential reference name.
   * @returns the Host's answer, or a non-writable view carrying the read failure.
   */
  describeCredential(ref: string): Promise<CcPoolCredentialView>
  /**
   * Store one credential literal under its reference.
   * @param ref - credential reference name.
   * @param value - the literal to store; it never returns through any read.
   * @returns the Host's refusal message, or undefined once stored.
   */
  storeCredential(ref: string, value: string): Promise<string | undefined>
  /**
   * Ask the pool which models it currently serves.
   * @param settingsNs - namespace whose registered discovery answers.
   * @param request - the pool route to describe.
   * @param signal - cancellation owned by the page: a sync it gives up on settles
   *   immediately with a rejection, and the late answer is dropped. Omitted keeps
   *   plain waiting for the Host.
   * @returns the pool's listing, or the Host's refusal.
   */
  discoverModels(
    settingsNs: string,
    request: LlmModelDiscoveryRequest,
    signal?: AbortSignal,
  ): Promise<CcPoolDiscoveryOutcome>
}

/**
 * Settle with one Host read, or reject as soon as its caller stops waiting.
 *
 * The Remote call cannot be called off, so a cancelled read still runs out its
 * own settlement and its answer is dropped; what the signal releases is the
 * page waiting on it, which is the state the sync control shows. An already
 * cancelled signal never starts the read at all.
 * @param start - begins the Remote call; runs only once the signal allows it.
 * @param signal - the page's cancellation; omitted keeps plain waiting.
 * @returns the operation's answer.
 * @throws the signal's reason, or an Error when the reason is not one.
 */
async function untilCancelled<T>(start: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return start()
  if (signal.aborted) throw cancellationOf(signal)
  const operation = start()
  const cancelled = Promise.withResolvers<never>()
  const onAbort = (): void => { cancelled.reject(cancellationOf(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([operation, cancelled.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Read one cancellation's reason as a thrown value.
 * @param signal - the cancelled signal.
 * @returns its reason when that is an Error, otherwise a description of the cancellation.
 */
function cancellationOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error('the pool discovery was cancelled')
}

/**
 * Bind the page's credential and discovery operations to the plugin's Remote namespaces.
 * @param ctx - the page plugin's context, whose `inject` declares `remote.credentials` and `remote.llm`.
 * @returns the callbacks the page is injected with.
 */
export function createCcPoolOperations(ctx: ClientContext): CcPoolOperations {
  return {
    describeCredential: async (ref) => {
      const response = await ctx.remote.credentials.describe([ref])
      if (!response.ok) return { configured: false, writable: false, error: response.error.message }
      const view = response.value[ref]
      return {
        configured: view?.configured ?? false,
        ...view?.source === undefined ? {} : { source: view.source },
        // An unknown reference stays writable so the control remains usable and
        // the Host is what refuses, instead of the page guessing a refusal.
        writable: view?.writable ?? true,
      }
    },
    storeCredential: async (ref, value) => {
      const response = await ctx.remote.credentials.set(ref, value)
      return response.ok ? undefined : response.error.message
    },
    discoverModels: async (settingsNs, request, signal) => {
      const response = await untilCancelled(() => ctx.remote.llm.discoverModels(settingsNs, request), signal)
      return response.ok
        ? { kind: 'found', models: response.value }
        : { kind: 'refused', message: response.error.message }
    },
  }
}
