/**
 * Caller for the `/api/relay.*` endpoints.
 *
 * @module dsh-relay/client/relay-rpc
 */
import type { RelayPasswordRequest, RelaySaveRequest, RelayStatus } from '../shared.ts'

/** Result envelope the connection RPC returns. */
interface RpcResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

/** The subset of the connection handle this plugin calls. */
export interface RelayRpcCaller {
  call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult>
}

/** Business failure carrying the host's stable code. */
export class RelayRpcError extends Error {
  /** Host failure code, for the localized message. */
  readonly code: string

  /**
   * @param code - host failure code.
   * @param detail - host-provided safe detail, if any.
   */
  constructor(code: string, detail?: string) {
    super(detail ?? code)
    this.name = 'RelayRpcError'
    this.code = code
  }
}

async function callEndpoint<T>(
  rpc: RelayRpcCaller,
  endpoint: 'status' | 'save' | 'connect' | 'disconnect' | 'password',
  payload: unknown,
): Promise<T> {
  let result: RpcResult
  try {
    result = await rpc.call('/api', `relay.${endpoint}`, payload)
  } catch (error) {
    throw new RelayRpcError('network-unreachable', error instanceof Error ? error.message : undefined)
  }
  if (!result.ok) throw new RelayRpcError(result.error?.code ?? 'internal', result.error?.message)
  return result.value as T
}

/**
 * Read the current relay status.
 * @param rpc - connection RPC caller.
 * @returns the host status.
 */
export function readRelayStatus(rpc: RelayRpcCaller): Promise<RelayStatus> {
  return callEndpoint<RelayStatus>(rpc, 'status', {})
}

/**
 * Save the account.
 * @param rpc - connection RPC caller.
 * @param request - form payload.
 * @returns the status after the write.
 */
export function saveRelayAccount(rpc: RelayRpcCaller, request: RelaySaveRequest): Promise<RelayStatus> {
  return callEndpoint<RelayStatus>(rpc, 'save', request)
}

/**
 * Start a connection.
 * @param rpc - connection RPC caller.
 * @returns the status after the attempt started.
 */
export function startRelayConnection(rpc: RelayRpcCaller): Promise<RelayStatus> {
  return callEndpoint<RelayStatus>(rpc, 'connect', {})
}

/**
 * Stop the tunnel.
 * @param rpc - connection RPC caller.
 * @returns the status after the stop.
 */
export function stopRelayConnection(rpc: RelayRpcCaller): Promise<RelayStatus> {
  return callEndpoint<RelayStatus>(rpc, 'disconnect', {})
}

/**
 * Change the relay account password.
 * @param rpc - connection RPC caller.
 * @param request - current and new password.
 */
export async function changeRelayPassword(rpc: RelayRpcCaller, request: RelayPasswordRequest): Promise<void> {
  await callEndpoint<{ changed: true }>(rpc, 'password', request)
}
