import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RelaySection } from '../../src/client/RelaySection.tsx'
import { en } from '../../src/client/locales.ts'
import type { RelayKey } from '../../src/client/locales.ts'
import type { RelayRpcCaller } from '../../src/client/relay-rpc.ts'
import type { RelaySaveRequest, RelayStatus } from '../../src/shared.ts'

function translate(key: RelayKey, params?: Record<string, string | number>): string {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

const CONFIGURED = {
  domain: 'relay.example.com',
  username: 'ryan',
  hasPassword: true,
  hasClientKey: true,
  autoConnect: false,
}

interface FakeHost {
  rpc: RelayRpcCaller
  calls: { save: RelaySaveRequest[]; password: unknown[]; endpoints: string[] }
  status: () => RelayStatus
}

function createFakeHost(initial: RelayStatus): FakeHost {
  let status = initial
  const calls: FakeHost['calls'] = { save: [], password: [], endpoints: [] }
  return {
    calls,
    status: () => status,
    rpc: {
      call: async (_channel, endpoint, payload) => {
        calls.endpoints.push(endpoint)
        switch (endpoint) {
          case 'relay.status':
            return { ok: true, value: status }
          case 'relay.save': {
            const request = payload as RelaySaveRequest
            calls.save.push(request)
            status = {
              phase: 'disconnected',
              account: {
                domain: request.domain,
                username: request.username,
                hasPassword: status.account.hasPassword || request.password !== undefined,
                hasClientKey: status.account.hasClientKey || request.clientKey !== undefined,
                autoConnect: request.autoConnect ?? status.account.autoConnect,
              },
            }
            return { ok: true, value: status }
          }
          case 'relay.connect':
            status = {
              ...status,
              phase: 'connected',
              url: `https://${status.account.username}.${status.account.domain}/`,
              remotePort: 13080,
              frpcVersion: '0.71.0',
              lastConnectedAt: '2026-01-02T03:04:05.000Z',
            }
            return { ok: true, value: status }
          case 'relay.disconnect':
            status = { ...status, phase: 'disconnected' }
            return { ok: true, value: status }
          case 'relay.password':
            calls.password.push(payload)
            return { ok: true, value: { changed: true } }
          default:
            return { ok: false, error: { code: 'bad-request', message: endpoint } }
        }
      },
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('relay settings section', () => {
  it('starts with the unconfigured status and an address hint', async () => {
    const host = createFakeHost({
      phase: 'unconfigured',
      account: { hasPassword: false, hasClientKey: false, autoConnect: false },
    })
    render(<RelaySection rpc={host.rpc} t={translate} />)
    expect(await screen.findByText('Not configured')).toBeTruthy()
    expect(screen.getByText('Fill in a valid domain and username to see the address')).toBeTruthy()
  })

  it('saves the entered fields, derives the address, and clears the secret inputs', async () => {
    const host = createFakeHost({
      phase: 'unconfigured',
      account: { hasPassword: false, hasClientKey: false, autoConnect: false },
    })
    render(<RelaySection rpc={host.rpc} t={translate} />)
    fireEvent.change(screen.getByLabelText('Server domain'), { target: { value: 'relay.example.com' } })
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ryan' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'at least ten characters' } })
    fireEvent.change(screen.getByLabelText('Client key'), { target: { value: 'dshk_' + 'A'.repeat(43) } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(host.calls.save).toHaveLength(1) })
    expect(host.calls.save[0]).toEqual({
      domain: 'relay.example.com',
      username: 'ryan',
      autoConnect: false,
      password: 'at least ten characters',
      clientKey: 'dshk_' + 'A'.repeat(43),
    })
    expect(await screen.findByRole('link', { name: 'https://ryan.relay.example.com/' })).toBeTruthy()
    await waitFor(() => {
      const password = screen.getByLabelText('Password') as HTMLInputElement
      expect(password.value).toBe('')
      expect(password.placeholder).toBe('Saved')
    })
  })

  it('keeps the stored secrets out of a save with empty inputs', async () => {
    const host = createFakeHost({ phase: 'disconnected', account: CONFIGURED })
    render(<RelaySection rpc={host.rpc} t={translate} />)
    await screen.findByDisplayValue('relay.example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(host.calls.save).toHaveLength(1) })
    expect(host.calls.save[0]).toEqual({
      domain: 'relay.example.com',
      username: 'ryan',
      autoConnect: false,
    })
  })

  it('connects, shows the remote port and last success, then disconnects', async () => {
    const host = createFakeHost({ phase: 'disconnected', account: CONFIGURED })
    render(<RelaySection rpc={host.rpc} t={translate} />)
    await screen.findByText('Not connected')
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('Connected')).toBeTruthy()
    expect(screen.getByText(/Remote port/)).toBeTruthy()
    expect(screen.getByText(/Last connected/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'https://ryan.relay.example.com/' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(await screen.findByText('Not connected')).toBeTruthy()
  })

  it('saves an edited password before connecting so the relay receives it', async () => {
    const host = createFakeHost({ phase: 'disconnected', account: CONFIGURED })
    render(<RelaySection rpc={host.rpc} t={translate} />)
    await screen.findByText('Not connected')
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-longer-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('Connected')).toBeTruthy()
    expect(host.calls.save).toHaveLength(1)
    expect(host.calls.save[0]?.password).toBe('a-longer-password')
    expect(host.calls.endpoints.indexOf('relay.save')).toBeLessThan(host.calls.endpoints.indexOf('relay.connect'))
  })

  it('names the relay-reported minimum when the relay refuses a short password', async () => {
    const host = createFakeHost({ phase: 'disconnected', account: CONFIGURED })
    const base = host.rpc.call
    host.rpc.call = async (channel, endpoint, payload) => (endpoint === 'relay.connect'
      ? { ok: false, error: { code: 'password-too-short', message: '密码太短', details: { minPassword: 10 } } }
      : base(channel, endpoint, payload))
    render(<RelaySection rpc={host.rpc} t={translate} />)
    await screen.findByText('Not connected')
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('The relay requires at least 10 characters')).toBeTruthy()
  })

  it('validates and submits a password change', async () => {
    const host = createFakeHost({ phase: 'disconnected', account: CONFIGURED })
    render(<RelaySection rpc={host.rpc} t={translate} />)
    await screen.findByText('Not connected')
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old-password' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password' } })
    fireEvent.change(screen.getByLabelText('Repeat new password'), { target: { value: 'different' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('The two new passwords do not match')).toBeTruthy()
    expect(host.calls.password).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('Repeat new password'), { target: { value: 'new-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => { expect(host.calls.password).toHaveLength(1) })
    expect(host.calls.password[0]).toEqual({ currentPassword: 'old-password', newPassword: 'new-password' })
    expect(await screen.findByText('Password changed')).toBeTruthy()
  })

  it('shows download progress while frpc is fetched', async () => {
    const host = createFakeHost({
      phase: 'downloading',
      account: CONFIGURED,
      download: { received: 50, total: 100 },
    })
    render(<RelaySection rpc={host.rpc} t={translate} />)
    expect(await screen.findByText('Downloading 50%')).toBeTruthy()
  })

  it('maps a host failure code to readable copy', async () => {
    const host = createFakeHost({ phase: 'failed', account: CONFIGURED, errorCode: 'credentials-invalid' })
    render(<RelaySection rpc={host.rpc} t={translate} />)
    expect(await screen.findByText('Wrong password')).toBeTruthy()
  })

  it('reports a rejected save with its localized reason', async () => {
    const rpc: RelayRpcCaller = {
      call: async (_channel, endpoint) => (endpoint === 'relay.save'
        ? { ok: false, error: { code: 'client-key-invalid', message: 'refused' } }
        : { ok: true, value: { phase: 'unconfigured', account: { hasPassword: false, hasClientKey: false, autoConnect: false } } }),
    }
    render(<RelaySection rpc={rpc} t={translate} />)
    await screen.findByText('Not configured')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('The client key is unknown or was revoked')).toBeTruthy()
  })
})
