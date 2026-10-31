/**
 * Framework-independent contracts for one Claude subscription account's Messages call.
 *
 * Nothing here imports the harness, Cordis, the home directory, the environment, the account
 * pool or file credentials: a caller (the Mac worker today) supplies the credential, the
 * runtime identity and the transport, and this module describes only what crosses that seam.
 * The wire protocol, billing header and beta composition stay owned by the maintained
 * `@tormentalabs/claude-code-wire-compat` package, which the request builder delegates to.
 *
 * @module dsh-plugin-subscriptions/claude-engine/types
 */

import type { ClaudeCodeTurnPosition } from '@tormentalabs/claude-code-wire-compat'

/** The platform the caller's client runs on, as the wire vocabulary spells it. */
export type ClaudeEngineOs = 'darwin' | 'linux' | 'win32'

/** The JavaScript runtime issuing the request. */
export type ClaudeEngineRuntime = 'node' | 'bun'

/**
 * The identity one request presents.
 *
 * Every field is the caller's: this engine derives none of them and hardcodes no platform. An
 * absent or empty field is refused as an incoherent profile rather than filled with a guess,
 * because the identity is what the service attributes the call to.
 */
export interface ClaudeEngineIdentity {
  /** Account uuid the request is attributed to. */
  readonly accountUuid: string
  /** Stable device uuid for this installation. */
  readonly deviceUuid: string
  /** Conversation/session uuid this request belongs to. */
  readonly sessionUuid: string
  /** Platform the client runs on. */
  readonly os: ClaudeEngineOs
  /** CPU architecture string the client reports. */
  readonly arch: string
  /** Runtime issuing the request. */
  readonly runtime: ClaudeEngineRuntime
  /** Runtime version the client reports. */
  readonly runtimeVersion: string
}

/** One entry of the caller-supplied `previous_request_id` chain, when the caller keeps one. */
export interface ClaudeEngineChain {
  /** The `request-id` the service returned for the previous request in this session. */
  readonly previousRequestId?: string
  /** The account's ATIS token for this session span, when the caller holds one. */
  readonly atis?: string
}

/**
 * The prompt anchor one Messages request is attributed to.
 *
 * The client reads both values off the transcript message of the prompt the request
 * serves and repeats them for that prompt's tool-continuation steps. The engine cannot
 * derive them from a raw body: a body does not say which prompt is the anchor, so the
 * caller that keeps a transcript states them and a caller that does not omits the field.
 * The pinned builder applies the client's own guards and omits a value it cannot state.
 */
export interface ClaudeEngineTurn {
  /** `cc_turn_origin`: the prompt's origin (`human`, `sdk`, and the client's other values). */
  readonly turnOrigin?: string
  /** `cc_prompt_index` and `cc_turn_index`: the transcript's prompt and turn ordinals. */
  readonly turnPosition?: ClaudeCodeTurnPosition
}

/** A header name/value pair as the request builder produces them. */
export type ClaudeEngineHeaderPair = readonly [name: string, value: string]

/** The request one caller hands to the transport verbatim. */
export interface ClaudeEngineRequest {
  /** Absolute endpoint to POST. */
  readonly url: string
  /** Always POST for a Messages call. */
  readonly method: 'POST'
  /** Header pairs in the order the builder composed them. */
  readonly headers: readonly ClaudeEngineHeaderPair[]
  /** The serialized JSON body. */
  readonly body: string
  /** Opaque, non-secret facts about what was sent, for the caller's own diagnostics. */
  readonly evidence: ClaudeEngineRequestEvidence
}

/**
 * What a build reported about the request, without any secret.
 *
 * The caller may log this: it names the protocol identity that was built and the shape of the
 * body by count and digest, never a header value, a token or a body fragment.
 */
export interface ClaudeEngineRequestEvidence {
  /** Wire-profile id the request was built from. */
  readonly profileId: string
  /** Endpoint the request addresses. */
  readonly url: string
  /** Model family the body declares. */
  readonly modelFamily: string
  /** Beta identifiers the request carries. */
  readonly betaFeatures: readonly string[]
  /** Lowercased names of the headers the request carries. */
  readonly headerNames: readonly string[]
  /** Digest of the serialized body. */
  readonly bodySha256: string
  /** Serialized body length in bytes. */
  readonly bodyByteLength: number
}

/** The scope a failure is evidence about, mirroring the plugin classifier's vocabulary. */
export type ClaudeEngineScope = 'operation' | 'account' | 'provider-profile' | 'model' | 'unknown'

/** Whether automatic recovery may still run for a decided failure. */
export type ClaudeEngineRetryDisposition = 'forbid' | 'allow'

/**
 * A typed failure.
 *
 * The engine returns these as values rather than throwing harness errors, so a caller outside
 * the harness can route on them. No variant carries a credential, a prompt or a raw provider
 * body.
 */
export type ClaudeEngineFailure =
  /** The caller's raw request body failed validation. */
  | { readonly kind: 'invalid-request'; readonly field: string; readonly detail: string }
  /** A recognized feature this engine does not implement in V1. */
  | { readonly kind: 'unsupported'; readonly feature: string; readonly detail: string }
  /** The caller-supplied identity or protocol profile cannot be used as given. */
  | { readonly kind: 'incoherent-profile'; readonly detail: string }
  /** The service refused the request with a status. */
  | {
    readonly kind: 'http'
    readonly reason: string
    readonly status?: number
    readonly retryDisposition: ClaudeEngineRetryDisposition
    readonly scope: ClaudeEngineScope
  }
  /** The stream carried a refusal or ended without its business terminal state. */
  | {
    readonly kind: 'stream'
    readonly reason: string
    readonly retryDisposition: ClaudeEngineRetryDisposition
    readonly scope: ClaudeEngineScope
  }
  /** The caller's own hook refused the request before it was issued. */
  | { readonly kind: 'refused-before-send'; readonly reason: string }
  /** A caller hook threw; the engine reports which hook and keeps no part of what it said. */
  | { readonly kind: 'hook-failed'; readonly hook: string }
  /** The send failed before any response head, and the request never left this process. */
  | { readonly kind: 'transport'; readonly detail: string; readonly retryDisposition: ClaudeEngineRetryDisposition }
  /** The POST was issued and its outcome is unknown; it may not be replayed automatically. */
  | { readonly kind: 'ambiguous-send'; readonly detail: string }
  /** The caller aborted. */
  | { readonly kind: 'cancelled'; readonly detail: string }

/** Bounded usage facts the stream reported, for a side channel. */
export interface ClaudeEngineUsage {
  /** Input tokens the response stated, when it stated one. */
  readonly inputTokens?: number
  /** Output tokens the response stated, when it stated one. */
  readonly outputTokens?: number
  /** Cache-read tokens the response stated, when it stated one. */
  readonly cacheReadTokens?: number
  /** Cache-creation tokens the response stated, when it stated one. */
  readonly cacheWriteTokens?: number
  /** Reasoning tokens the response stated, when it stated one. */
  readonly reasoningTokens?: number
  /** Opaque, length-bounded request id the response carried, when it carried one. */
  readonly requestId?: string
}

/**
 * The response head, as the transport observed it.
 *
 * A head is transport fact, not a business outcome: receiving one says the request was accepted
 * for processing, not that a turn completed.
 */
export interface ClaudeEngineHead {
  /** HTTP status. */
  readonly status: number
  /** Lowercased response headers. */
  readonly headers: Readonly<Record<string, string>>
}

/** One event of a single-account turn. */
export type ClaudeEngineEvent =
  /** The response head arrived. */
  | { readonly type: 'head'; readonly head: ClaudeEngineHead }
  /** Raw SSE bytes exactly as received; the caller frames them if it wants to. */
  | { readonly type: 'bytes'; readonly bytes: Uint8Array }
  /** Bounded usage, reported once per turn. */
  | { readonly type: 'usage'; readonly usage: ClaudeEngineUsage }
  /**
   * The turn ended. `state` records which of the three lifecycle facts were known by the end, so
   * a caller can tell "never sent" from "sent, no answer" from "answered, no terminal event".
   */
  | {
    readonly type: 'terminal'
    readonly outcome: ClaudeEngineOutcome
    readonly state: ClaudeEngineLifecycle
    /** Present unless the outcome is `complete`. */
    readonly failure?: ClaudeEngineFailure
  }

/** Business outcome of one turn. */
export type ClaudeEngineOutcome = 'complete' | 'failed' | 'cancelled' | 'incomplete'

/**
 * The three lifecycle facts of one attempt, tracked separately.
 *
 * They are not one flag because they answer different questions: `issued` says the request may
 * have reached the service, `responseReceived` says a status came back, and `terminalKnown` says
 * the body carried a valid business terminal event. Only the last one means the turn completed.
 */
export interface ClaudeEngineLifecycle {
  /** The POST was issued (the request may have been received). */
  readonly issued: boolean
  /** A response head was observed. */
  readonly responseReceived: boolean
  /** A valid business terminal event was observed. */
  readonly terminalKnown: boolean
}

/** What the transport reports for one send. */
export type ClaudeEngineTransportResult =
  | {
    readonly kind: 'response'
    /** The head, available before the body is read. */
    readonly head: ClaudeEngineHead
    /** The response body, streamed as raw bytes. */
    readonly body: AsyncIterable<Uint8Array>
    /** Server-issued `request-id`, when the head carried one. */
    readonly requestId?: string
    /**
     * Release the response, when the transport owns something to release.
     *
     * Called on every path that abandons a response ? a classified failure, a recovery replay, or
     * a consumer that stopped reading ? so no response is left open behind the turn.
     */
    readonly release?: () => Promise<void>
  }
  /** The send failed before any response head. */
  | {
    readonly kind: 'failed'
    readonly detail: string
    /**
     * Whether the request had already left this process when the failure was observed. The
     * transport is the only layer that knows, and the answer decides whether the turn may be
     * repeated: a request that left may already have been acted on.
     */
    readonly issued: boolean
  }

/** One injected transport; the engine has no default and no network of its own. */
export type ClaudeEngineTransport = (request: ClaudeEngineRequest, signal: AbortSignal) => Promise<ClaudeEngineTransportResult>
