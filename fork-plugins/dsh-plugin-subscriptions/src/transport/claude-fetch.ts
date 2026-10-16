/**
 * The Claude fetch used by the subscription provider.
 *
 * Only the Messages request is issued by the Bun transport, because that is the
 * request whose reproduction the transport exists for. Every other destination —
 * token refresh, usage, profile, file upload, model listing, the other providers —
 * keeps the existing client, so a call whose identity this module does not pin can
 * never be sent under the bridge's anonymous defaults.
 *
 * The bridge is on by default. `DSH_SUBSCRIPTIONS_BRIDGE=off` restores the previous
 * path explicitly. A bridge that cannot start, a child that has exited, a proxy
 * the bridge cannot honour, or a host that requires a Claude route this child cannot
 * reach is a hard error naming that switch, never a silent fallback: falling back
 * would restore exactly the transport this exists to replace, and a host-mandated
 * route bypassed in silence is the failure this refusal exists to prevent.
 */

import { fileURLToPath } from 'node:url'
import { proxiedFetch, proxyAppliesTo } from '../http.js'
import { BunBridge, DEFAULT_MAX_QUEUED_BYTES, spawnBunChild } from './bridge.js'
import { resolveBunRuntime } from './bun-runtime.js'
import { describeHostClaudeRoute, hostClaudeRoute } from './host-egress.js'

/** Environment variable that turns the bridge off. */
const BRIDGE_SWITCH_ENV = 'DSH_SUBSCRIPTIONS_BRIDGE'

/**
 * Runtime flag that stops the child from loading `.env` files out of its working directory.
 *
 * Bun loads `.env`, `.env.local` and the mode-specific variants automatically, so a file beside
 * the directory the Host was launched in would reach the process that issues the Messages request
 * whatever `childEnvironment` filtered out: it could set NODE_TLS_REJECT_UNAUTHORIZED, a proxy, or
 * a trust anchor. The flag makes the child's environment the allowlist and nothing else.
 */
const BUN_NO_ENV_FILE_FLAG = '--no-env-file'

/** Host and path whose traffic the bridge carries, and nothing else. */
const CLAUDE_MESSAGES_HOST = 'api.anthropic.com'
const CLAUDE_MESSAGES_PATH = '/v1/messages'

/** Failure raised when the bridge cannot serve a request. */
export class BridgeUnavailableError extends Error {
  /**
   * @param detail - What failed and which switch restores the previous path.
   */
  constructor(detail: string) {
    super(`${detail} (set ${BRIDGE_SWITCH_ENV}=off to use the previous transport)`)
    this.name = 'BridgeUnavailableError'
  }
}

let bridge: BunBridge | undefined
let starting: Promise<BunBridge> | undefined
let maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES

/**
 * Configure the unread response limit before the shared child starts.
 *
 * A child that has already ended holds no limit: the next request starts a new one, so the
 * limit is changeable again. A live child captured its limit at construction, and a start
 * in progress captured it too, so both still refuse a change rather than letting a running
 * child keep enforcing a value the operator replaced.
 *
 * @param value - Positive safe-integer byte limit for each response body.
 * @throws RangeError for an invalid limit; Error if a live bridge or a start in progress
 *   holds another limit.
 */
export function configureClaudeTransport(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('claudeTransportMaxQueuedBytes must be a positive safe integer')
  }
  if ((liveBridge() !== undefined || starting !== undefined) && value !== maxQueuedBytes) {
    throw new Error('Stop the Claude transport before changing its unread response limit')
  }
  maxQueuedBytes = value
}

/** The bridge that can still serve a request, or undefined once it has ended. */
function liveBridge(): BunBridge | undefined {
  return bridge !== undefined && !bridge.dead ? bridge : undefined
}

/** Child entry emitted next to this module by the build. */
function childScript(): string {
  return fileURLToPath(new URL('./bun-child.js', import.meta.url))
}

/**
 * Returns the shared bridge, starting one when no live child serves requests.
 *
 * A bridge that ended is not an answer for the next request: a child that crashed, was
 * killed, or desynchronized its frame stream is replaced here, so a request that arrives
 * after it starts a fresh child instead of failing for the life of the process. Nothing is
 * replayed — the request that failed stays failed — and nothing falls back to the Node
 * transport. The start in progress is shared by concurrent callers and cleared when it
 * settles, so a rejection is never remembered as the standing answer.
 *
 * @returns The live bridge, or the start in progress.
 */
function startBridge(): Promise<BunBridge> {
  const live = liveBridge()
  if (live !== undefined) return Promise.resolve(live)
  if (starting !== undefined) return starting
  const attempt = (async () => {
    const runtime = resolveBunRuntime()
    const started = new BunBridge(
      spawnBunChild({ command: runtime, args: [BUN_NO_ENV_FILE_FLAG, childScript()] }),
      { maxQueuedBytes },
    )
    // The bridge this replaces ended without `stopBridge`, so its child is terminated
    // with it rather than left behind holding a request nobody can read.
    const replaced = bridge
    bridge = started
    replaced?.dispose()
    return started
  })()
  starting = attempt
  // Only the start this call owns may clear the slot: `stopBridge` clears it too, and a
  // later start that took the slot keeps it.
  const settled = (): void => {
    if (starting === attempt) starting = undefined
  }
  attempt.then(settled, settled)
  return attempt
}

/** Reports whether the bridge is currently enabled by configuration. */
export function bridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[BRIDGE_SWITCH_ENV]
  return value !== 'off' && value !== 'false' && value !== '0'
}

/**
 * Reports whether a URL is the Messages request the bridge carries.
 *
 * @param url - Request URL.
 * @returns true for the pinned host and path, with or without a query string.
 */
function isClaudeMessagesRequest(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.hostname === CLAUDE_MESSAGES_HOST && parsed.pathname === CLAUDE_MESSAGES_PATH
  } catch {
    return false
  }
}

/**
 * Fetches a request through the configured transport.
 *
 * @param input - Request URL.
 * @param init - Method, headers, body and optional abort signal.
 * @returns The response, streamed.
 */
export async function claudeApiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!isClaudeMessagesRequest(url) || !bridgeEnabled()) {
    return proxiedFetch(input, init)
  }
  // The host's mandatory Claude route is a process-wide decision this child cannot be
  // given: it runs its own runtime and the plugin's spawn allowlist carries no such
  // variable. Refuse rather than send Messages outside the route the host required.
  const hostRoute = hostClaudeRoute()
  if (hostRoute !== undefined) {
    throw new BridgeUnavailableError(
      `the host requires Claude traffic to use ${describeHostClaudeRoute(hostRoute)} and this transport cannot route through it`,
    )
  }
  if (await proxyAppliesTo(CLAUDE_MESSAGES_HOST)) {
    throw new BridgeUnavailableError(
      'an HTTP proxy is configured for api.anthropic.com and this transport cannot route through it',
    )
  }
  let active: BunBridge
  try {
    active = await startBridge()
  } catch (error) {
    throw new BridgeUnavailableError(
      error instanceof Error ? error.message : 'the Bun transport could not start',
    )
  }
  if (active.dead) {
    const failure = active.failure
    throw new BridgeUnavailableError(
      `the Bun transport child has exited (${failure?.message ?? 'unknown reason'})`,
    )
  }
  return active.request(url, init)
}

/** Stops the bridge child; called by profile teardown and by tests. */
export async function stopBridge(): Promise<void> {
  const stopped = bridge
  // The module state is cleared before the child is signalled, so nothing observes a
  // bridge that is being torn down as the live one.
  bridge = undefined
  starting = undefined
  stopped?.dispose()
}
