/**
 * Relay settings page, browser half.
 *
 * Registers one `settings.section` page and its own locale namespace. Every
 * relay fact comes from `/api/relay.*` on the node half; this half holds no
 * credential state, and the node half never returns a stored password or key.
 *
 * @module dsh-relay/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap and LocaleNamespaceMap merges.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, zh } from './locales.ts'
import type { RelayKey } from './locales.ts'
import { RelaySection } from './RelaySection.tsx'
import type { RelaySectionInjected, RelayTranslate } from './RelaySection.tsx'
import type { RelayRpcCaller } from './relay-rpc.ts'

export type { RelayKey } from './locales.ts'
export type { RelaySectionInjected, RelaySectionProps, RelayTranslate } from './RelaySection.tsx'
export type { RelayRpcCaller } from './relay-rpc.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Relay settings page copy. */
    'settings.relay': RelayKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.relay'

/** Structural face of the locale service. */
interface LocaleService {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(namespace: string): RelayTranslate
}

/** Structural face of the connection service the page calls through. */
interface ConnectionService {
  readonly rpc: RelayRpcCaller
}

/** Registration shape the settings shell accepts for one section. */
interface SectionRegistration {
  readonly name: 'settings.section'
  readonly id: string
  readonly order: number
  readonly label: () => string
  readonly locale: string
  readonly inject: () => RelaySectionInjected
}

/** Structural face of the slots service. */
interface SlotsService {
  inject(name: string, register: () => unknown): unknown
  register(registration: SectionRegistration, component: typeof RelaySection): unknown
}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the relay settings page.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  const locale = ctx.get('locale') as LocaleService | undefined
  if (locale === undefined) return
  ctx.effect(() => locale.register(NS, { en, zh }), 'dsh-relay: dictionaries')
  const t = locale.bind(NS)
  const connection = ctx.get('connection') as ConnectionService | undefined
  const slots = ctx.get('slots') as SlotsService | undefined
  if (connection === undefined || slots === undefined) return
  const injected = (): RelaySectionInjected => ({ rpc: connection.rpc })
  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'relay',
    order: 88,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, RelaySection))
}
