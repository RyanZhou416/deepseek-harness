import { describe, expect, it } from 'vitest'
import {
  changeRelayPassword,
  RelayRpcError,
  readRelayStatus,
  saveRelayAccount,
  startRelayConnection,
  stopRelayConnection,
} from '../../src/client/relay-rpc.ts'
import type { RelayRpcCaller } from '../../src/client/relay-rpc.ts'

function caller(result: { ok: boolean; value?: unknown; error?: { code: string; message: string; details?: Record<string, unknown> } } | Error): {
  rpc: RelayRpcCaller
  calls: { channel: string; endpoint: string; payload: unknown }[]
} {
  const calls: { channel: string; endpoint: string; payload: unknown }[] = []
  return {
    calls,
    rpc: {
      call: async (channel, endpoint, payload) => {
        calls.push({ channel, endpoint, payload })
        if (result instanceof Error) throw result
        return result
      },
    },
  }
}

describe('relay RPC caller', () => {
  it('calls each endpoint on the /api channel with the relay prefix', async () => {
    const { rpc, calls } = caller({ ok: true, value: { phase: 'unconfigured', account: { hasPassword: false, hasClientKey: false, autoConnect: false } } })
    await readRelayStatus(rpc)
    await saveRelayAccount(rpc, { domain: 'relay.example.com', username: 'ryan', autoConnect: false })
    await startRelayConnection(rpc)
    await stopRelayConnection(rpc)
    await changeRelayPassword(rpc, { currentPassword: 'old', newPassword: 'new' })
    expect(calls.map(call => call.endpoint)).toEqual([
      'relay.status', 'relay.save', 'relay.connect', 'relay.disconnect', 'relay.password',
    ])
    expect(calls.every(call => call.channel === '/api')).toBe(true)
    expect(calls[4]?.payload).toEqual({ currentPassword: 'old', newPassword: 'new' })
  })

  it('turns a host failure envelope into a typed error', async () => {
    const { rpc } = caller({ ok: false, error: { code: 'credentials-invalid', message: 'wrong password' } })
    await expect(readRelayStatus(rpc)).rejects.toMatchObject({ code: 'credentials-invalid' })
  })

  it('passes the relay-reported minimum password length through the failure envelope', async () => {
    const { rpc } = caller({ ok: false, error: { code: 'password-too-short', message: 'too short', details: { minPassword: 10 } } })
    await expect(readRelayStatus(rpc)).rejects.toMatchObject({ code: 'password-too-short', minPassword: 10 })
    const absent = caller({ ok: false, error: { code: 'password-too-short', message: 'too short' } })
    await expect(readRelayStatus(absent.rpc)).rejects.toMatchObject({ code: 'password-too-short', minPassword: undefined })
  })

  it('turns a transport rejection into a network failure', async () => {
    const { rpc } = caller(new Error('socket closed'))
    await expect(readRelayStatus(rpc)).rejects.toBeInstanceOf(RelayRpcError)
    await expect(readRelayStatus(rpc)).rejects.toMatchObject({ code: 'network-unreachable' })
  })
})
