/**
 * dsh-relay: publish the local DSH Web Host through a DshRelay server.
 *
 * The node half owns one tunnel per plugin lifetime. The settings page reads
 * and writes the account through `/api/relay.*`, which sits behind the
 * connection plugin's authenticated `/api` channel. Nothing in the plugin
 * configuration names a deployment: the user enters the relay domain,
 * username, password, and personal client key in the settings page, and they
 * are stored in the DSH credential service.
 *
 * @module dsh-relay
 */
import type { Context } from '@deepseek-ai/cordis'
import { RelayAccountStore } from './account.ts'
import { resolveRelayConfig } from './config.ts'
import type { RelayConfig } from './config.ts'
import { RelayController } from './controller.ts'
import { registerRelayRpc } from './rpc.ts'

export { Config, DEFAULT_FRPC_HASHES, PINNED_FRP_VERSION, frpcAssetName, resolveRelayConfig } from './config.ts'
export type { RelayConfig, ResolvedRelayConfig } from './config.ts'
export { RELAY_ERROR_CODES } from './errors.ts'
export type { RelayErrorCode } from './errors.ts'
export type { RelayDownload, RelayPhase, RelayStatus, RelayAccountView } from './shared.ts'
export { RelayController } from './controller.ts'
export { RelayAccountStore, RELAY_ACCOUNT_KEY, accountIsConfigured, accountView, normalizeDomain, validateClientKey, validateUsername } from './account.ts'
export { BROWSER_SESSION_KEY, browserCookieName, mintBrowserCookie, readBrowserSessionSecret, resolveCookieMaxAgeDays } from './cookie.ts'
export { relayAuthority } from './host.ts'
export { parseConnectResult, parseTunnel, relayApiBaseUrl, RelayProtocolClient } from './protocol.ts'
export type { ConnectInput, ConnectResult, RelayTunnel } from './protocol.ts'
export { renderFrpcConfig } from './frpc-config.ts'
export { FrpcSupervisor, frpcLaunch, scrubChildEnvironment } from './frpc-process.ts'
export { installFrpc } from './frpc-download.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-relay'

/** The plugin needs the credential service before it can read or store the account. */
export const inject = ['credentials']

/**
 * Mount the relay tunnel and its settings RPC.
 *
 * Registration waits for `connection` (the authenticated `/api` channel) and
 * `webServer` (the local listener whose port the relay forwards to). A
 * composition without them still loads the plugin; it simply has no tunnel to
 * offer.
 * @param ctx - host plugin context.
 * @param config - plugin configuration, with defaults applied by the Loader or by `resolveRelayConfig`.
 */
export function apply(ctx: Context, config: RelayConfig = {}): void {
  const resolved = resolveRelayConfig(config)
  const store = new RelayAccountStore(ctx.credentials)
  const controller = new RelayController({
    ctx,
    config: resolved,
    store,
    credentials: ctx.credentials,
    log: message => { ctx.logger.debug(message) },
  })
  ctx.effect(() => () => controller.dispose(), 'dsh-relay: tunnel lifetime')
  registerRelayRpc(ctx, controller)
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      let cancelled = false
      const waitForBoundPort = async (): Promise<boolean> => {
        const deadline = Date.now() + resolved.connectStartupTimeoutMs
        while (!cancelled) {
          const webServer = scope.get('webServer') as { port?: number | undefined } | undefined
          if (webServer?.port !== undefined) return true
          if (Date.now() > deadline) return false
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        return false
      }
      const autoConnect = async (): Promise<void> => {
        try {
          const view = await store.view()
          if (cancelled) return
          if (!view.autoConnect || view.domain === undefined || view.username === undefined
            || !view.hasPassword || !view.hasClientKey) return
          if (!await waitForBoundPort()) return
          await controller.start()
        } catch (error) {
          scope.logger.warn('dsh-relay: automatic connection could not start')
          scope.logger.warn(error)
        }
      }
      void autoConnect()
      return () => { cancelled = true }
    }, 'dsh-relay: automatic connection')
  })
}
