/**
 * Relay connection lifecycle.
 *
 * One controller owns the tunnel for the plugin's lifetime: it reads the stored
 * account, mints a fresh DSH cookie per connection, registers with the relay,
 * installs frpc, writes the owner-only run files, and supervises the child
 * process. A newer generation (disconnect, save, dispose) invalidates every
 * in-flight step, so a late response can never move the state of a later
 * connection.
 *
 * @module dsh-relay/controller
 */
import { stat } from 'node:fs/promises'
import type { spawn } from 'node:child_process'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { RelayAccountStore, accountIsConfigured, accountView } from './account.ts'
import type { RelayAccount, RelayAccountPatch, RelayAccountView } from './account.ts'
import type { ResolvedRelayConfig } from './config.ts'
import { readBrowserSessionSecret, mintBrowserCookie, resolveCookieMaxAgeDays } from './cookie.ts'
import { RelayError, asRelayError, relayError } from './errors.ts'
import type { RelayErrorCode } from './errors.ts'
import { installFrpc } from './frpc-download.ts'
import { relayAuthority, hostCookieMaxAgeDays } from './host.ts'
import type { HostWebServer, RelayHostContext } from './host.ts'
import { relayRunDirectory, writeRelayRunFiles } from './frpc-config.ts'
import { FrpcSupervisor, frpcLaunch } from './frpc-process.ts'
import type { FrpcSupervisorEvent, FrpcSupervisorOptions } from './frpc-process.ts'
import { RelayProtocolClient, relayApiBaseUrl } from './protocol.ts'
import type { ConnectResult } from './protocol.ts'
import type { RelayDownload, RelayPhase, RelayStatus } from './shared.ts'

export type { RelayDownload, RelayPhase, RelayStatus }

/** Dependencies of {@link RelayController}. */
export interface RelayControllerDeps {
  /** Host plugin context, used for the web server and loader services. */
  readonly ctx: RelayHostContext
  /** Resolved plugin configuration. */
  readonly config: ResolvedRelayConfig
  /** Durable account storage. */
  readonly store: RelayAccountStore
  /** Credential service, read for the browser-session signing key. */
  readonly credentials: Pick<CredentialProvider, 'readRecord'>
  /** Clock; tests inject one. */
  readonly now?: () => number
  /** Fetch implementation; tests inject one. */
  readonly fetchImpl?: typeof fetch
  /** Spawn implementation; tests inject one. */
  readonly spawnImpl?: typeof spawn
  /** Harness home; defaults to the running process's DSH_HOME. */
  readonly home?: () => string
  /** Supervisor constructor; tests inject one. */
  readonly supervisorFactory?: (options: FrpcSupervisorOptions) => FrpcSupervisor
  /** Receives sanitized diagnostic lines. */
  readonly log?: (message: string) => void
}

type ConcreteSupervisorFactory = (options: FrpcSupervisorOptions) => FrpcSupervisor

/** Outcome of one failed connection attempt. */
interface RelayFailure {
  readonly code: RelayErrorCode
  readonly detail: string | undefined
  readonly reconnecting: boolean
}

/** Owns the single relay tunnel. */
export class RelayController {
  private phase: RelayPhase = 'disconnected'
  private url: string | undefined
  private remotePort: number | undefined
  private frpcVersion: string | undefined
  private lastConnectedAt: string | undefined
  private failure: RelayFailure | undefined
  private download: RelayDownload | undefined
  private supervisor: FrpcSupervisor | undefined
  private abort: AbortController | undefined
  private generation = 0
  private disposed = false

  /**
   * @param deps - context, configuration, storage, credential service, and injectable boundaries.
   */
  constructor(private readonly deps: RelayControllerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private home(): string {
    return this.deps.home?.() ?? resolveDshHome()
  }

  private supervisorFactory(): ConcreteSupervisorFactory {
    return this.deps.supervisorFactory ?? (options => new FrpcSupervisor(options))
  }

  /**
   * Snapshot the connection state for the settings page.
   * @returns status without any secret.
   */
  async status(): Promise<RelayStatus> {
    let view: RelayAccountView
    try {
      view = await this.deps.store.view()
    } catch (error) {
      const failure = asRelayError(error)
      return {
        phase: 'failed',
        account: accountView(undefined),
        errorCode: failure.code,
        ...failure.detail === undefined ? {} : { errorDetail: failure.detail },
      }
    }
    const configured = view.domain !== undefined && view.username !== undefined
      && view.hasPassword && view.hasClientKey
    const phase: RelayPhase = configured ? this.phase : 'unconfigured'
    return {
      phase,
      account: view,
      ...this.url === undefined ? {} : { url: this.url },
      ...this.remotePort === undefined ? {} : { remotePort: this.remotePort },
      ...this.frpcVersion === undefined ? {} : { frpcVersion: this.frpcVersion },
      ...this.lastConnectedAt === undefined ? {} : { lastConnectedAt: this.lastConnectedAt },
      ...this.failure === undefined ? {} : { errorCode: this.failure.code, ...this.failure.detail === undefined ? {} : { errorDetail: this.failure.detail } },
      ...this.failure === undefined || !this.failure.reconnecting ? {} : { reconnecting: true },
      ...this.download === undefined ? {} : { download: this.download },
    }
  }

  /**
   * Read the stored account or fail with `not-configured`.
   * @returns the configured account.
   */
  private async requireAccount(): Promise<RelayAccount> {
    let account: RelayAccount | undefined
    try {
      account = await this.deps.store.read()
    } catch (error) {
      throw asRelayError(error)
    }
    if (!accountIsConfigured(account)) {
      throw relayError('not-configured', 'the relay account is incomplete')
    }
    return account
  }

  private fail(error: unknown, reconnecting = false): void {
    const failure = asRelayError(error)
    this.failure = { code: failure.code, detail: failure.detail, reconnecting }
    this.phase = 'failed'
    this.download = undefined
    this.deps.log?.(`dsh-relay: ${failure.code}${failure.detail === undefined ? '' : ` (${failure.detail})`}`)
  }

  /**
   * Start one connection attempt.
   *
   * Returns once the attempt reached a terminal phase or the supervisor took
   * over; the settings page polls {@link status} while the phase is
   * `downloading` or `connecting`.
   */
  async start(): Promise<void> {
    if (this.disposed) return
    if (this.phase === 'connected' || this.phase === 'connecting' || this.phase === 'downloading') return
    this.generation += 1
    const generation = this.generation
    const abort = new AbortController()
    this.abort = abort
    this.phase = 'connecting'
    this.failure = undefined
    this.download = undefined
    try {
      const account = await this.requireAccount()
      if (generation !== this.generation) return
      const webServer = this.deps.ctx.get('webServer') as HostWebServer | undefined
      if (webServer === undefined) throw relayError('web-server-unavailable', 'the DSH web server is not mounted')
      const port = webServer.port
      if (port === undefined) throw relayError('web-server-unavailable', 'the DSH web server has not bound a TCP port yet')
      const authority = relayAuthority(port)
      const secret = await readBrowserSessionSecret(this.deps.credentials)
      if (generation !== this.generation) return
      const cookie = mintBrowserCookie(
        secret,
        authority,
        resolveCookieMaxAgeDays(hostCookieMaxAgeDays(this.deps.ctx)),
        this.now(),
      )
      const client = new RelayProtocolClient({
        baseUrl: relayApiBaseUrl(account.domain),
        clientKey: account.clientKey,
        timeoutMs: this.deps.config.requestTimeoutMs,
        ...this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl },
      })
      const result = await client.connect({
        username: account.username,
        password: account.password,
        authority,
        cookie: cookie.header,
      }, abort.signal)
      if (generation !== this.generation) return
      this.applyConnect(result, account)
      const executable = await this.ensureFrpc(result.tunnel.frpVersion, generation, abort.signal)
      if (generation !== this.generation) return
      const runDirectory = relayRunDirectory(this.home())
      const files = await writeRelayRunFiles(runDirectory, {
        tunnel: result.tunnel,
        username: account.username,
        localPort: port,
      })
      if (generation !== this.generation) return
      this.phase = 'connecting'
      const supervisor = this.supervisorFactory()({        launch: frpcLaunch(executable, files.configPath, files.runDirectory),
        startupTimeoutMs: this.deps.config.connectStartupTimeoutMs,
        initialDelayMs: this.deps.config.reconnectInitialDelayMs,
        maxDelayMs: this.deps.config.reconnectMaxDelayMs,
        onEvent: event => { this.handleSupervisorEvent(event, generation) },
        onLine: line => { this.deps.log?.(`frpc: ${line.slice(0, 500)}`) },
        ...this.deps.spawnImpl === undefined ? {} : { spawnImpl: this.deps.spawnImpl },
      })
      this.supervisor = supervisor
      supervisor.start()
    } catch (error) {
      if (generation !== this.generation) return
      this.fail(error)
    }
  }

  private applyConnect(result: ConnectResult, account: RelayAccount): void {
    const expected = `https://${account.username}.${account.domain}/`
    if (result.url !== expected) {
      throw relayError('network-invalid-response', 'the relay returned a user address for another account')
    }
    this.url = result.url
    this.remotePort = result.tunnel.remotePort
    this.frpcVersion = result.tunnel.frpVersion
  }

  private async ensureFrpc(version: string, generation: number, signal: AbortSignal): Promise<string> {
    if (this.deps.config.frpcPath !== undefined) {
      const configured = this.deps.config.frpcPath
      try {
        const info = await stat(configured)
        if (!info.isFile() || info.size === 0) throw relayError('frpc-unsupported', 'the configured frpcPath is not a file')
      } catch (error) {
        if (error instanceof RelayError) throw error
        throw relayError('frpc-unsupported', 'the configured frpcPath does not exist', error)
      }
      return configured
    }
    this.phase = 'downloading'
    this.download = { received: 0 }
    try {
      const installed = await installFrpc({
        version,
        platform: process.platform,
        arch: process.arch,
        hashes: this.deps.config.frpcHashes,
        home: this.home(),
        timeoutMs: this.deps.config.downloadTimeoutMs,
        signal,
        ...this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl },
        onProgress: (received, total) => {
          if (generation !== this.generation) return
          this.download = { received, ...total === undefined ? {} : { total } }
        },
      })
      return installed.path
    } finally {
      this.download = undefined
    }
  }

  private handleSupervisorEvent(event: FrpcSupervisorEvent, generation: number): void {
    if (generation !== this.generation || this.disposed) return
    switch (event.type) {
      case 'connected':
        this.phase = 'connected'
        this.failure = undefined
        this.download = undefined
        this.lastConnectedAt = new Date(this.now()).toISOString()
        break
      case 'startup-failed':
        this.fail(relayError('frpc-start-failed', event.detail), true)
        break
      case 'exited':
        this.fail(relayError('frpc-exited', event.detail), true)
        break
      case 'retrying':
        if (this.phase === 'failed' && this.failure !== undefined) {
          this.failure = { ...this.failure, reconnecting: true }
        }
        break
    }
  }

  /**
   * Stop the tunnel and invalidate every in-flight step.
   */
  async disconnect(): Promise<void> {
    this.generation += 1
    this.abort?.abort()
    this.abort = undefined
    const supervisor = this.supervisor
    this.supervisor = undefined
    if (supervisor !== undefined) await supervisor.dispose()
    this.phase = 'disconnected'
    this.failure = undefined
    this.download = undefined
  }

  /**
   * Store a save request and drop a running tunnel whose settings changed.
   * @param patch - validated user input.
   * @returns the status after the write.
   */
  async save(patch: RelayAccountPatch): Promise<RelayStatus> {
    let before: RelayAccount | undefined
    try {
      before = await this.deps.store.read()
    } catch {
      before = undefined
    }
    await this.deps.store.save(patch)
    const after = await this.deps.store.read()
    const changed = before === undefined
      || after === undefined
      || before.domain !== after.domain
      || before.username !== after.username
      || before.password !== after.password
      || before.clientKey !== after.clientKey
    if (changed && (this.supervisor !== undefined
      || this.phase === 'connected' || this.phase === 'connecting' || this.phase === 'downloading')) {
      await this.disconnect()
    }
    return this.status()
  }

  /**
   * Change the relay account password and store the new one for future connects.
   * @param currentPassword - current password.
   * @param newPassword - replacement password.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    if (currentPassword === '') throw relayError('password-required', 'enter the current password')
    if (newPassword === '') throw relayError('password-required', 'enter the new password')
    const account = await this.requireAccount()
    const client = new RelayProtocolClient({
      baseUrl: relayApiBaseUrl(account.domain),
      clientKey: account.clientKey,
      timeoutMs: this.deps.config.requestTimeoutMs,
      ...this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl },
    })
    await client.changePassword({
      username: account.username,
      password: currentPassword,
      newPassword,
    })
    await this.deps.store.save({
      domain: account.domain,
      username: account.username,
      password: newPassword,
      autoConnect: account.autoConnect,
    })
  }

  /**
   * Stop everything this controller started and wait for the child to exit.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.abort?.abort()
    this.abort = undefined
    const supervisor = this.supervisor
    this.supervisor = undefined
    if (supervisor !== undefined) await supervisor.dispose()
    this.phase = 'disconnected'
  }
}
