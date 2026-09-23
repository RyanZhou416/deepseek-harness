/**
 * dsh-context — Client half (installed package bundle entry).
 *
 * Registers a "上下文/Context" tab in the conversation view ring
 * (`conversation.view` slot, beside Chat/Trajectory) and renders the
 * context-composition timeline: current makeup, per-request stacked-bar
 * history, context events, and the live message list.
 *
 * Since v0.9 the tab rides the harness's session-projection pipeline
 * (`contextTimeline` projection key), read from the framework standard kit
 * (`useProjection('contextTimeline')`, a standard prop on every session-scope
 * slot component). The wire value is the split generation's slim head; the
 * heavy collections arrive on demand from the host's detail endpoint, one
 * read per viewing client (timelineSource.ts). No polling, no stale-while-
 * revalidate cache.
 *
 * This module is the body of the package's `./client` bundle: tsdown
 * (tsdown.config.ts) bundles it (external `react` — the browser module table
 * supplies it via the injected `require`) into the web boot handoff
 * (`window.__ModuleLoader__.load({id, factory})`). All imports from other
 * client modules are inlined by the bundler; everything here is zero-runtime
 * beyond the bundled source.
 */

import { createElement as h } from 'react'
import { DICT_EN, DICT_ZH } from './i18n'
import { registerContextCommand } from './command'
import { makeContextModal } from './components/contextModal'
import { makeOverviewButton } from './components/overviewButton'
import { makeOverviewPanel } from './components/overviewPanel'
import { makeSettingsCard, makePluginConfigCard } from './components/settingsCard'
import { modalStoreOf } from './modalStore'
import type { ClientCtx } from './services'
import { createContextSettings, type ConfigFormsFace, type SettingsField, type SettingsScopeBinderFace } from './settings'
import { makeContextView } from './components/contextView'
import { makeContextJumpButton } from './components/contextJump'
import { watchHistoryFaces } from './historyPage'
import { watchPlacement } from './placement'
import { watchSidebarContextTab } from './sidebar'
import { makeViewKit } from './viewkit'

// Theme-native styles: the bundle's global-CSS channel injects each sheet as
// a plugin-owned <style data-plugin> tag at factory execution (the web boot
// loader and the HMR receiver claim tags carrying data-plugin). Import order
// IS cascade order across same-specificity rules: the Tailwind utilities
// first (the sibling sheets keep winning same-specificity ties), then base,
// then the per-component sheets in their original section order.
import './styles/tailwind.css'
import './styles/base.css'
import './styles/stats.css'
import './styles/jump.css'
import './styles/settings.css'
import './styles/stackedBar.css'
import './styles/trendChart.css'
import './styles/requestDetail.css'
import './styles/events.css'
import './styles/fileCard.css'
import './styles/modal.css'
import './styles/browser.css'
import './styles/detailSections.css'
import './styles/attachments.css'
import './styles/agentGraph.css'
import './styles/overview.css'

const NS = 'dsh-context'

function apply(ctx: ClientCtx): void {
  // Bilingual dictionaries, registered via ctx.effect so a stop or HMR reload
  // disposes them; the tab label thunk and all UI text follow the active
  // locale through the bound translate — missing keys resolve through the
  // harness chain (en fallback, then the key).
  ctx.effect(() => {
    return ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN })
  }, 'dsh-context: dictionaries')
  const t = ctx.locale.bind(NS)

  const kit = makeViewKit(t)
  // History face of the harness gateway remotes, resolved through the
  // DECLARED inject — a non-declared read of the traced `remote.session`
  // proxy throws ("cannot get property … without inject") and would take
  // the browser down with the view. Injection waits for the service; a
  // harness that never composes the namespace never fires the callback and
  // the targeted fetches simply stay absent.
  watchHistoryFaces(ctx)
  const settings = createContextSettings()
  const ContextView = makeContextView(ctx, kit, settings)

  // Placement: the per-user `defaultPlacement` preference picks which
  // registration carries the view — the conversation tab, the right Sidebar
  // (dsh 0.1.5-rc.1+, optional by contract), or both (the default). Each
  // mount owns its disposer so the watcher takes down exactly what a
  // preference flip drops (see placement.ts).
  ctx.effect(() => watchPlacement(settings, {
    tab: () => ctx.slots.inject('conversation.view', () => {
      return ctx.slots.register(
        // order 20 renders right of Chat (0) and Trajectory (10); the locale
        // namespace put the framework `t` seat on the component's props too.
        { name: 'conversation.view', id: 'context', order: 20, locale: NS, label: () => t('tab') },
        props => h(ContextView, props),
      )
    }),
    sidebar: () => watchSidebarContextTab(ctx, ContextView, t, NS),
  }), 'dsh-context: placement')

  // Chat → Context jump: an icon in each finalized reply's action row that
  // opens the Context tab on the right Sidebar pinned to that reply's turn —
  // falling back to the conversation tab wherever the sidebar serves no tab
  // (see contextJump.tsx; the relay and view activation live in viewFocus.ts).
  const ContextJump = makeContextJumpButton(ctx, kit)
  ctx.slots.inject('conversation.chat.assistant-actions', () => {
    return ctx.slots.register(
      // After the shipped feedback entry (10), still inside the icon row.
      { name: 'conversation.chat.assistant-actions', id: 'context-jump', order: 20, locale: NS },
      props => h(ContextJump, props),
    )
  })

  // `/context` slash command: opens the context modal (see command.ts for
  // the trigger source). The modal itself renders from the input overlay
  // slot, opened per session through the hooks-compartment store.
  registerContextCommand(ctx, kit)
  const ContextModal = makeContextModal(ctx, kit, settings)
  ctx.slots.inject('conversation.input.overlay', () => {
    return ctx.slots.register(
      { name: 'conversation.input.overlay', id: 'context-modal', order: 10, locale: NS,
        inject: (sessionId = '') => ({ hooks: { contextModal: modalStoreOf(sessionId) } }) },
      props => h(ContextModal, props),
    )
  })

  // The Context Dashboard (see components/overviewPanel.tsx): the cross-session
  // insight surface. The entry is a footer action — the harness stacks those
  // directly above Settings on the sidebar foot; the overlay it opens renders
  // from the frame-wide shell.overlay seat, and the module store
  // (overviewStore.ts) carries the open flag between the two registrations.
  // Both seats are root-scope list slots present since the supported baseline.
  const OverviewButton = makeOverviewButton(kit, settings)
  ctx.slots.inject('sidebar.footer.action', () => {
    return ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'context-overview', order: 10, locale: NS },
      // Root-scope seats: the owner props (wide, the standard kit) arrive untyped.
      props => h(OverviewButton, props as unknown as Parameters<typeof OverviewButton>[0]),
    )
  })
  const OverviewPanel = makeOverviewPanel(ctx, kit)
  ctx.slots.inject('shell.overlay', () => {
    return ctx.slots.register(
      { name: 'shell.overlay', id: 'context-overview', order: 10, locale: NS },
      props => h(OverviewPanel, props as unknown as Parameters<typeof OverviewPanel>[0]),
    )
  })

  /** The injected face both preference cards ride: the settings store as the
   *  framework's hooks-compartment `useContextSettings` seat, plus the set verb. */
  const cardFace = (): {
    hooks: { contextSettings: typeof settings.store }
    set: (field: SettingsField, value: string) => void
  } => ({
    hooks: { contextSettings: settings.store },
    set: (field, value) => { settings.set(field, value) },
  })

  // Per-user display preferences. Two generations, two transports and seats,
  // switched by SERVICE PRESENCE (each deferred inject fires on exactly one
  // side; a host without its service never runs the callback):
  //   - the settingsScope generation registers the card on the keyed
  //     `settings.plugin.item` slot (Settings → Plugins → Plugin
  //     configuration), binding the Host-served `dsh-context` namespace;
  //   - the Config-form generation (dsh 0.1.7+) retired that pair — there the
  //     card rides the configForms transport and the Plugins page's keyed
  //     `plugins.bundle.config` seat, alive only while the Host serves the
  //     namespace (the entry Config's volatile preference fields).
  ctx.inject(['settingsScope'], (raw) => {
    const c = raw as ClientCtx & { settingsScope?: SettingsScopeBinderFace }
    const binder = c.settingsScope
    if (binder === undefined) return
    c.effect(() => settings.attach(binder.bind({ namespace: NS })), 'dsh-context: settings scope')
    const SettingsCard = makeSettingsCard(kit)
    c.slots.inject('settings.plugin.item', () => {
      return c.slots.register(
        { name: 'settings.plugin.item', key: NS, locale: NS, inject: cardFace },
        // Root-scope keyed slot: no sessionId on these props — the face
        // (hooks + set) arrives through the registration's inject.
        props => h(SettingsCard, props as unknown as Parameters<typeof SettingsCard>[0]),
      )
    })
  })
  ctx.inject(['configForms'], (raw) => {
    const c = raw as ClientCtx & { configForms?: ConfigFormsFace }
    const forms = c.configForms
    if (forms === undefined || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return
    c.effect(() => settings.attach(forms.get(NS)), 'dsh-context: config forms')
    const PluginConfigCard = makePluginConfigCard(kit)
    c.effect(() => forms.whileServed([NS], () => {
      // slots.inject's disposer is the registration's disposer (the typed
      // local face reads unknown; the harness contract returns a disposer).
      return c.slots.inject('plugins.bundle.config', () => {
        return c.slots.register(
          { name: 'plugins.bundle.config', key: NS, locale: NS, inject: cardFace },
          props => h(PluginConfigCard, props as unknown as Parameters<typeof PluginConfigCard>[0]),
        )
      }) as () => void
    }), 'dsh-context: plugins-page card')
  })
}

module.exports = {
  name: 'dsh-context',
  inject: ['slots', 'locale'],
  apply,
}
