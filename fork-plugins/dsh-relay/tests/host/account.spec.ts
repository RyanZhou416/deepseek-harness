import { describe, expect, it } from 'vitest'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { RelayAccountStore, RELAY_ACCOUNT_KEY } from '../../src/account.ts'
import { RelayError } from '../../src/errors.ts'

function createStore(): { store: RelayAccountStore; records: Map<CredentialKey, CredentialRecord> } {
  const records = new Map<CredentialKey, CredentialRecord>()
  const store = new RelayAccountStore({
    readRecord: async (key) => records.get(key),
    modifyRecord: async (key, mutate) => {
      const current = records.get(key)
      const next = await mutate(current)
      if (next === undefined) return current
      records.set(key, next)
      return next
    },
  })
  return { store, records }
}

const KEY = 'dshk_' + 'A'.repeat(43)
const PASSWORD = 'at least ten characters'

describe('relay account store', () => {
  it('stores the account and reports presence without secrets', async () => {
    const { store } = createStore()
    const view = await store.save({
      domain: 'https://relay.example.com/',
      username: 'ryan',
      password: PASSWORD,
      clientKey: KEY,
      autoConnect: true,
    })
    expect(view).toEqual({
      domain: 'relay.example.com',
      username: 'ryan',
      hasPassword: true,
      hasClientKey: true,
      autoConnect: true,
    })
    expect(JSON.stringify(view)).not.toContain(PASSWORD)
    expect(JSON.stringify(view)).not.toContain(KEY)
  })

  it('keeps an omitted or empty password and client key', async () => {
    const { store } = createStore()
    await store.save({ domain: 'relay.example.com', username: 'ryan', password: PASSWORD, clientKey: KEY })
    await store.save({ domain: 'relay.example.com', username: 'ryan', password: '', clientKey: '' })
    const account = await store.read()
    expect(account?.password).toBe(PASSWORD)
    expect(account?.clientKey).toBe(KEY)
  })

  it('requires a password on the first save', async () => {
    const { store } = createStore()
    await expect(store.save({ domain: 'relay.example.com', username: 'ryan', clientKey: KEY }))
      .rejects.toMatchObject({ code: 'password-required' })
  })

  it('rejects an invalid field before writing', async () => {
    const { store, records } = createStore()
    await expect(store.save({ domain: 'not a domain', username: 'ryan', password: PASSWORD, clientKey: KEY }))
      .rejects.toBeInstanceOf(RelayError)
    await expect(store.save({ domain: 'relay.example.com', username: 'Ryan', password: PASSWORD, clientKey: KEY }))
      .rejects.toMatchObject({ code: 'username-invalid' })
    await expect(store.save({ domain: 'relay.example.com', username: 'ryan', password: PASSWORD, clientKey: 'bad' }))
      .rejects.toMatchObject({ code: 'client-key-format-invalid' })
    expect(records.size).toBe(0)
  })

  it('reports a corrupted record and lets a save replace it', async () => {
    const { store, records } = createStore()
    records.set(RELAY_ACCOUNT_KEY, { kind: 'api-key', key: 'x' })
    await expect(store.view()).rejects.toMatchObject({ code: 'credentials-unavailable' })
    const view = await store.save({ domain: 'relay.example.com', username: 'ryan', password: PASSWORD, clientKey: KEY })
    expect(view.hasPassword).toBe(true)
  })

  it('changes only the auto-connect flag', async () => {
    const { store } = createStore()
    await store.save({ domain: 'relay.example.com', username: 'ryan', password: PASSWORD, clientKey: KEY })
    await store.setAutoConnect(true)
    const account = await store.read()
    expect(account?.autoConnect).toBe(true)
    expect(account?.password).toBe(PASSWORD)
    await store.setAutoConnect(false)
    expect((await store.read())?.autoConnect).toBe(false)
  })
})
