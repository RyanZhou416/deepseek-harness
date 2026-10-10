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
import { BunBridge, spawnBunChild } from './bridge.js'
import { resolveBunRuntime } from './bun-runtime.js'
import { describeHostClaudeRoute, hostClaudeRoute } from './host-egress.js'

/** Environment variable that turns the bridge off. */
export const BRIDGE_SWITCH_ENV = 'DSH_SUBSCRIPTIONS_BRIDGE'

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

/** Child entry emitted next to this module by the build. */
function childScript(): string {
  return fileURLToPath(new URL('./bun-child.js', import.meta.url))
}

function startBridge(): Promise<BunBridge> {
  if (bridge !== undefined && !bridge.dead) return Promise.resolve(bridge)
  starting ??= (async () => {
    const runtime = resolveBunRuntime()
    const started = new BunBridge(spawnBunChild({ command: runtime, args: [childScript()] }))
    bridge = started
    return started
  })()
  // A failed start must not be cached: the operator's remedy is to install the
  // runtime or point the override at one, which cannot take effect if the rejection
  // is remembered for the life of the process.
  starting = starting.catch((error: unknown) => {
    starting = undefined
    bridge = undefined
    throw error
  })
  return starting
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
  bridge?.dispose()
  bridge = undefined
  starting = undefined
}
