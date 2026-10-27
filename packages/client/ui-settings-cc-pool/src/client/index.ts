/**
 * CC subscription pool settings page, browser half.
 *
 * The page edits the `llm-cc-pool` profile entry — the Host plugin that owns
 * the `cc-pool` route — through the settings domain's shared configuration
 * form, and the pool credential through the credentials domain. It registers
 * into the Settings navigation as its own section while the Host serves that
 * entry, so a deployment without the plugin shows no trace of it. The
 * catalogue is written whole on save; a sync asks the Host's pool discovery
 * what the pool serves and stages the merge without writing anything, and the
 * credential literal is the one value that leaves the document, because a
 * stored key never rides a read. A save the Host refuses for a concurrent edit
 * reports the conflict and retries against the revision it re-read, and a sync
 * the user dismisses is cancelled instead of left running.
 * Export discipline: packages/client/AGENTS.md.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge and the settings section slot
// declaration. Cross-plugin collaboration goes through the service, never a
// value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote merge, the `connection/reset` lifecycle event, and
// the forwarded-event key face the credential subscription rides.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/types'
import type {} from '@deepseek-ai/dsh-credentials/types'
import { CcPoolSection } from './CcPoolSection.tsx'
import { en, zh, type CcPoolSettingsLocaleKey } from './locales.ts'
import { createCcPoolOperations } from './operations.ts'
import { CcPoolSettingsPage } from './settings-controller.ts'
import type { CcPoolSectionFace } from './settings-controller.ts'
import { CC_POOL_NS, type CcPoolSettings } from './contract.ts'

export type { CcPoolSectionProps } from './CcPoolSection.tsx'
export type {
  CcPoolRowState, CcPoolSaveError, CcPoolSectionFace, CcPoolSettingsState, CcPoolSyncError, CcPoolSyncState,
  CcPoolTokenState,
} from './settings-controller.ts'
export type { CcPoolModel, CcPoolReasoningLevel, CcPoolSettings } from './contract.ts'
export type { CcPoolModelDraft } from './model-draft.ts'
export type { CcPoolSyncProblem } from './sync.ts'
export type { CcPoolSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** CC subscription pool settings page copy. */
    'settings.ccPool': CcPoolSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.ccPool'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'remote.llm', 'configForms']

/**
 * Mount the CC subscription pool page while the Host serves its entry, and
 * keep its credential state fresh on every credential change or reconnect.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-cc-pool: dictionaries')
  const page = new CcPoolSettingsPage(ctx.configForms.get<CcPoolSettings>(CC_POOL_NS), createCcPoolOperations(ctx))
  ctx.effect(() => {
    const disposers = [
      // A key can be rotated outside this page (the credentials domain and the
      // Models page address the same reference), so the badge re-reads it.
      ctx.remote.$on('credentials/reference-updated', () => { void page.refreshCredential() }),
      ctx.on('connection/reset', () => { void page.refreshCredential() }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
      page.dispose()
    }
  }, 'ui-settings-cc-pool: credential state')
  // The page is registered while the Host serves the pool entry, and withdrawn
  // when it stops: the form's own snapshot is what a stale registration renders.
  ctx.effect(() => ctx.configForms.whileServed([CC_POOL_NS], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'cc-pool',
    order: 16,
    label: () => t('nav'),
    locale: NS,
    inject: (): CcPoolSectionFace => page.inject(),
  }, CcPoolSection))), 'ui-settings-cc-pool: page')
}
