import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, NS } from '../../src/client/index.ts'
import { RelaySection } from '../../src/client/RelaySection.tsx'
import { en } from '../../src/client/locales.ts'

interface Registration {
  name: string
  id: string
  order: number
  label: () => string
  locale: string
  inject: () => unknown
}

interface FakeClient {
  context: Context
  dictionaries: Map<string, Record<string, Record<string, string>>>
  injected: string[]
  state: { registration?: Registration; component?: unknown }
}

function createFakeClient(options: { connection?: boolean; slots?: boolean } = {}): FakeClient {
  const context = new Context()
  const dictionaries = new Map<string, Record<string, Record<string, string>>>()
  const injected: string[] = []
  const state: FakeClient['state'] = {}
  context.provide('locale', {
    register: (namespace: string, values: Record<string, Record<string, string>>) => {
      dictionaries.set(namespace, values)
      return () => { dictionaries.delete(namespace) }
    },
    bind: (namespace: string) => (key: keyof typeof en) => dictionaries.get(namespace)?.en?.[key] ?? key,
  })
  if (options.connection !== false) {
    context.provide('connection', { rpc: { call: async () => ({ ok: true, value: {} }) } })
  }
  if (options.slots !== false) {
    context.provide('slots', {
      inject: (name: string, callback: () => void) => {
        injected.push(name)
        callback()
      },
      register: (registration: Registration, component: unknown) => {
        state.registration = registration
        state.component = component
        return () => {}
      },
    })
  }
  return { context, dictionaries, injected, state }
}

describe('relay client registration', () => {
  it('registers its dictionaries and one settings section', () => {
    const fake = createFakeClient()
    apply(fake.context)
    expect(fake.dictionaries.get(NS)?.en).toBe(en)
    expect(fake.dictionaries.get(NS)?.zh).toBeDefined()
    expect(fake.injected).toEqual(['settings.section'])
    expect(fake.state.registration?.name).toBe('settings.section')
    expect(fake.state.registration?.id).toBe('relay')
    expect(fake.state.registration?.locale).toBe(NS)
    expect(fake.state.registration?.order).toBe(88)
    expect(fake.state.registration?.label()).toBe('Remote access')
    expect(fake.state.registration?.inject()).toHaveProperty('rpc')
    expect(fake.state.component).toBe(RelaySection)
    fake.context.fiber.dispose()
  })

  it('waits for the connection service instead of throwing', () => {
    const fake = createFakeClient({ connection: false })
    expect(() => { apply(fake.context) }).not.toThrow()
    expect(fake.state.registration).toBeUndefined()
    fake.context.fiber.dispose()
  })

  it('waits for the slots service instead of throwing', () => {
    const fake = createFakeClient({ slots: false })
    expect(() => { apply(fake.context) }).not.toThrow()
    expect(fake.state.registration).toBeUndefined()
    fake.context.fiber.dispose()
  })
})
