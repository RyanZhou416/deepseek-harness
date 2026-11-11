/**
 * DshRelay client-protocol transport.
 *
 * One `POST` per operation against `https://<base domain>/__dsh/api/v1`,
 * carrying the personal client key as a bearer token. Every response is
 * validated here; a malformed or unexpected response becomes a typed failure
 * instead of reaching the tunnel code with guessed values.
 *
 * @module dsh-relay/protocol
 */
import { isAbortError, isProtocolErrorCode, relayError } from './errors.ts'
import type { RelayErrorCode } from './errors.ts'

/** Largest request body the relay accepts. */
export const MAX_REQUEST_BYTES = 16 * 1024

/** Largest accepted PEM certificate text. */
const MAX_PEM_BYTES = 64 * 1024

/** Largest accepted tunnel token or identity string. */
const MAX_TOKEN_LENGTH = 4096

/** Tunnel parameters returned by `POST /connect`. */
export interface RelayTunnel {
  /** frp release the relay runs. */
  readonly frpVersion: string
  /** frp server address. */
  readonly serverAddr: string
  /** frp server port. */
  readonly serverPort: number
  /** frpc websocket transport path. */
  readonly websocketPath: string
  /** TLS server name frpc verifies. */
  readonly tlsServerName: string
  /** PEM certificate of the frp server's CA. */
  readonly caPem: string
  /** Shared frps token. */
  readonly sharedToken: string
  /** Tunnel-layer user identity. */
  readonly user: string
  /** Per-user tunnel token sent as `metadatas.frpToken`. */
  readonly frpToken: string
  /** Relay-side loopback port the gate forwards to. */
  readonly remotePort: number
}

/** Successful `POST /connect` response. */
export interface ConnectResult {
  /** Signed-in username. */
  readonly username: string
  /** Whether this call created the account. */
  readonly created: boolean
  /** Public user address. */
  readonly url: string
  /** Tunnel parameters. */
  readonly tunnel: RelayTunnel
}

/** `POST /connect` request fields. */
export interface ConnectInput {
  /** Account username. */
  readonly username: string
  /** Account password; never logged. */
  readonly password: string
  /** Authority the relay sends as Host and Origin. */
  readonly authority: string
  /** One `name=value` DSH browser-session cookie. */
  readonly cookie: string
}

/** Dependencies of {@link RelayProtocolClient}. */
export interface RelayProtocolOptions {
  /** Exact API base URL, for example `https://relay.example.com/__dsh/api/v1`. */
  readonly baseUrl: string
  /** Personal client key; never logged. */
  readonly clientKey: string
  /** Per-request deadline in milliseconds. */
  readonly timeoutMs: number
  /** Fetch implementation; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value === '') {
    throw relayError('network-invalid-response', `the relay response has no usable ${field}`)
  }
  return value
}

function requireBoundedString(record: Record<string, unknown>, field: string, max: number): string {
  const value = requireString(record, field)
  if (value.length > max || /[\0\r\n]/u.test(value)) {
    throw relayError('network-invalid-response', `the relay response has an unusable ${field}`)
  }
  return value
}

function requirePort(record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw relayError('network-invalid-response', `the relay response has no usable ${field}`)
  }
  return value
}

/**
 * Validate the tunnel object of a successful response.
 * @param value - decoded `tunnel` field.
 * @returns the validated tunnel.
 * @throws RelayError `network-invalid-response` for any missing or malformed field.
 */
export function parseTunnel(value: unknown): RelayTunnel {
  if (!isRecord(value)) throw relayError('network-invalid-response', 'the relay response has no tunnel object')
  const frpVersion = requireBoundedString(value, 'frpVersion', 32)
  if (!/^\d+\.\d+\.\d+$/u.test(frpVersion)) {
    throw relayError('network-invalid-response', 'the relay response has an unusable frpVersion')
  }
  const websocketPath = requireBoundedString(value, 'websocketPath', 2048)
  if (!websocketPath.startsWith('/') || /\s/u.test(websocketPath)) {
    throw relayError('network-invalid-response', 'the relay response has an unusable websocketPath')
  }
  const caPem = requireString(value, 'caPem')
  if (caPem.length > MAX_PEM_BYTES
    || !caPem.trimStart().startsWith('-----BEGIN CERTIFICATE-----')
    || !caPem.trimEnd().endsWith('-----END CERTIFICATE-----')) {
    throw relayError('network-invalid-response', 'the relay response has an unusable caPem')
  }
  return {
    frpVersion,
    serverAddr: requireBoundedString(value, 'serverAddr', 253),
    serverPort: requirePort(value, 'serverPort'),
    websocketPath,
    tlsServerName: requireBoundedString(value, 'tlsServerName', 253),
    caPem,
    sharedToken: requireBoundedString(value, 'sharedToken', MAX_TOKEN_LENGTH),
    user: requireBoundedString(value, 'user', MAX_TOKEN_LENGTH),
    frpToken: requireBoundedString(value, 'frpToken', MAX_TOKEN_LENGTH),
    remotePort: requirePort(value, 'remotePort'),
  }
}

/**
 * Validate a successful `POST /connect` response.
 * @param value - decoded response body.
 * @returns the validated result.
 * @throws RelayError `network-invalid-response` for any missing or malformed field.
 */
export function parseConnectResult(value: unknown): ConnectResult {
  if (!isRecord(value)) throw relayError('network-invalid-response', 'the relay response is not an object')
  const url = requireBoundedString(value, 'url', 2048)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw relayError('network-invalid-response', 'the relay response has an unusable url')
  }
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw relayError('network-invalid-response', 'the relay response has an unusable url')
  }
  if (typeof value.created !== 'boolean') {
    throw relayError('network-invalid-response', 'the relay response has no usable created flag')
  }
  return {
    username: requireBoundedString(value, 'username', 64),
    created: value.created,
    url,
    tunnel: parseTunnel(value.tunnel),
  }
}

/** The relay client API surface. */
export interface RelayApi {
  /**
   * Sign in, create the account on first use, and return the tunnel parameters.
   * @param input - credentials and DSH session binding.
   * @param signal - cancellation signal from the owning connection attempt.
   * @returns the validated connect result.
   */
  connect(input: ConnectInput, signal?: AbortSignal): Promise<ConnectResult>

  /**
   * Change the account password.
   * @param input - username plus current and new passwords.
   * @param signal - cancellation signal.
   */
  changePassword(input: { username: string; password: string; newPassword: string }, signal?: AbortSignal): Promise<void>
}

/**
 * Build the exact client API base URL for one relay domain.
 * @param domain - normalized relay base domain.
 * @returns `https://<domain>/__dsh/api/v1`.
 */
export function relayApiBaseUrl(domain: string): string {
  return `https://${domain}/__dsh/api/v1`
}

/** HTTP client for the relay's client API. */
export class RelayProtocolClient implements RelayApi {
  private readonly fetchImpl: typeof fetch

  /**
   * @param options - base URL, client key, deadline, and optional fetch implementation.
   */
  constructor(private readonly options: RelayProtocolOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  /**
   * Call one endpoint and return its decoded success body.
   * @param endpoint - path segment below the API base, for example `connect`.
   * @param body - JSON request body.
   * @param signal - external cancellation signal.
   * @returns the success body including `ok: true`.
   */
  private async request(
    endpoint: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const payload = JSON.stringify(body)
    if (Buffer.byteLength(payload, 'utf8') > MAX_REQUEST_BYTES) {
      throw relayError('bad-request', 'the request body exceeds the relay limit')
    }
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}/${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${this.options.clientKey}`,
        },
        body: payload,
        signal: combined,
      })
    } catch (error) {
      if (isAbortError(error)) {
        throw relayError(signal?.aborted === true ? 'network-cancelled' : 'network-timeout', `the relay did not answer ${endpoint} in time`)
      }
      throw relayError('network-unreachable', `the relay request for ${endpoint} failed`, error)
    }
    let decoded: unknown
    try {
      decoded = await response.json()
    } catch (error) {
      if (isAbortError(error)) {
        throw relayError(signal?.aborted === true ? 'network-cancelled' : 'network-timeout', `the relay did not answer ${endpoint} in time`)
      }
      throw relayError('network-invalid-response', `the relay response for ${endpoint} is not JSON`, error)
    }
    if (!isRecord(decoded)) {
      throw relayError('network-invalid-response', `the relay response for ${endpoint} is not an object`)
    }
    if (decoded.ok === false) {
      const code = decoded.code
      if (typeof code === 'string' && isProtocolErrorCode(code)) {
        const minimum = decoded.minPassword
        throw relayError(code as RelayErrorCode, `the relay refused ${endpoint}`, undefined,
          typeof minimum === 'number' && Number.isSafeInteger(minimum) && minimum > 0 ? minimum : undefined)
      }
      throw relayError('network-invalid-response', `the relay refused ${endpoint} with an unknown code`)
    }
    if (decoded.ok !== true) {
      throw relayError('network-invalid-response', `the relay response for ${endpoint} has no ok field`)
    }
    if (response.status !== 200) {
      throw relayError('network-invalid-response', `the relay answered ${endpoint} with status ${String(response.status)}`)
    }
    return decoded
  }

  /**
   * Sign in and return the tunnel.
   * @param input - credentials and DSH session binding.
   * @param signal - cancellation signal from the owning connection attempt.
   * @returns the validated connect result.
   */
  async connect(input: ConnectInput, signal?: AbortSignal): Promise<ConnectResult> {
    const body = await this.request('connect', {
      username: input.username,
      password: input.password,
      dsh: { authority: input.authority, cookie: input.cookie },
    }, signal)
    return parseConnectResult(body)
  }

  /**
   * Change the account password.
   * @param input - username plus current and new passwords.
   * @param signal - cancellation signal.
   */
  async changePassword(
    input: { username: string; password: string; newPassword: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request('password', {
      username: input.username,
      password: input.password,
      newPassword: input.newPassword,
    }, signal)
  }
}
