/**
 * Subscription OAuth login page, browser half. Registers the Subscriptions
 * settings section; every login state fact arrives through the node half's
 * `/subscriptions-auth` RPC channel — this plugin holds no credential state of its
 * own. Section copy rides the client locale service: one 'settings.subscriptions'
 * namespace with zh/en dictionaries, rebound per read so the nav label and
 * page text follow the active locale.
 *
 * The browser half builds ONE subscription cache per plugin application and
 * hands the same one to every contribution that shows usage, so the composer
 * badge and the Settings page never run one identical read loop each. The
 * cache reaches components only through the inject `hooks` compartment, which
 * the renderer binds to `use<Name>` selector hooks.
 */
// Type-only: pulls the `ctx.slots` Context merge (dsh-client-runtime owned it
// on rc.2; ui-renderer's augmentation carries it on the 0.1.2-alpha line).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls ui-conversation's SlotMap merge. The installed `0.1.7-rc.1`
// contract predates the fork's additive model-menu row child, so that one key is
// mirrored below (see the SlotMap merge).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the Connection plugin's `connection/reset` Events merge.
import type {} from '@deepseek-ai/dsh-client-connection/client'
// Type-only: the slash-command registry contract (the /fast contribution).
import type { CommandUiContract } from '@deepseek-ai/dsh-client-ui-commands/client'
// `.js` extension: this package's tsconfig lacks the reference repo's
// allowImportingTsExtensions/rewriteRelativeImportExtensions pair; under
// nodenext the .js specifier resolves to the .tsx source (see README note).
import { SubscriptionsSection } from './SubscriptionsSection.js'
import type { SubscriptionsSectionInjected, SubscriptionProvider } from './SubscriptionsSection.js'
import { ImageGenerateToolview, createImageLoader } from './ImageGenerateToolview.js'
import type { ImageGenerateToolviewInjected } from './ImageGenerateToolview.js'
import { VideoGenerateToolview, createVideoLoader } from './VideoGenerateToolview.js'
import type { VideoGenerateToolviewInjected } from './VideoGenerateToolview.js'
import {
  SpeedSelect, createSpeedLoader, createSpeedSetter, modelSelectionSource, resolveCurrentModel, settleSpeedTier,
} from './SpeedSelect.js'
import type { ModelDirectoriesLike, ModelDirectoryLike, ModelRef, SpeedSelectInjected, SpeedTier } from './SpeedSelect.js'
import { SubscriptionUsageBadge } from './SubscriptionUsageBadge.js'
import type { SubscriptionUsageBadgeInjected } from './SubscriptionUsageBadge.js'
import { createSubscriptionsCache } from './subscriptions-cache.js'
import type { ObservableSnapshot } from './subscriptions-cache.js'
import { en, zh } from './locales.js'
import type { SubscriptionsKey } from './locales.js'

export type { SubscriptionsSectionInjected, SubscriptionsSectionProps } from './SubscriptionsSection.js'
export type { ImageGenerateToolviewInjected, ImageGenerateToolviewProps } from './ImageGenerateToolview.js'
export type { VideoGenerateToolviewInjected, VideoGenerateToolviewProps } from './VideoGenerateToolview.js'
export type { SpeedSelectInjected, SpeedSelectProps, SpeedState, SpeedTier } from './SpeedSelect.js'
export type { SubscriptionUsageBadgeInjected, SubscriptionUsageBadgeProps } from './SubscriptionUsageBadge.js'
export type { SubscriptionsKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Subscriptions settings page copy. */
    'settings.subscriptions': SubscriptionsKey
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Mirror of ui-conversation's additive model-menu row child
     * (`packages/client/ui-conversation/src/client/contract/slots.ts`), which the
     * installed `0.1.7-rc.1` contract does not declare. A later contract carrying
     * the same shape merges with this entry.
     */
    'conversation.input.model.row': { kind: 'list'; scope: 'session' }
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.subscriptions'

/**
 * Required services (cordis fiber inject): `slots` carries the registration
 * seat, `connection` the `/subscriptions-auth` RPC caller, and `locale` the copy
 * dictionaries.
 */
export const inject = ['slots', 'connection', 'locale']

/**
 * Register the Subscriptions section once the `settings.section` declaration
 * is on the ledger (the shell's apply order relative to this one is NOT
 * constrained; registration depends on the slot through `slots.inject()`).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-subscriptions: copy dictionaries')
  // Settings-shell nudge: the panel (nav title + header row + section body)
  // sits flush against the panel's top edge; push it down a little to leave
  // breathing room. Scoped by the settings panel's own dialog role + nav child
  // so other aria-modal dialogs (e.g. the attachment lightbox) are untouched.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin', 'dsh-plugin-subscriptions')
    style.textContent = 'div[role="dialog"][aria-modal="true"]:has(> nav) { padding-top: 14px; }'
    document.head.appendChild(style)
    return () => style.remove()
  }, 'dsh-plugin-subscriptions: settings panel breathing room')
  // The shell's Context merge types `connection` as the host handle; in the
  // browser shell the same key holds the full client ConnectionHandle.
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const t = ctx.locale.bind(NS) as SubscriptionsSectionInjected['t']
  /**
   * Sessions a rendered slot contribution currently holds a model source for,
   * with how many surfaces bind it. A forwarded Host event addresses only these;
   * the entry appears with the first subscription and leaves with the last.
   */
  const active = new Map<string, { directory: ModelDirectoryLike; bindings: number }>()
  // The /fast command entry point is the one model consumer with no slot scope;
  // it resolves the service per invocation so registration order never matters.
  const models = (): ModelDirectoriesLike | undefined =>
    ctx.get('modelDirectories') as ModelDirectoriesLike | undefined
  // The one cache this plugin application shares: created here, handed to every
  // contribution below, and torn down with this fiber.
  const cache = createSubscriptionsCache(connection.rpc)
  ctx.effect(() => () => cache.dispose(), 'dsh-plugin-subscriptions: shared usage cache')
  // A new connection generation's Host knows nothing the previous one answered:
  // forget the old roster and entries first, then read the new Host's roster.
  ctx.on('connection/reset', () => {
    cache.reset()
    void cache.readStatus({ fresh: true })
  })
  /**
   * Coalesce a burst of equal-signal events into one local roster read: a login
   * or logout made in another client, or a credential store change, arrives as
   * several forwarded events at once.
   */
  let rosterQueued = false
  const readRosterSoon = (): void => {
    if (rosterQueued) return
    rosterQueued = true
    queueMicrotask(() => {
      rosterQueued = false
      void cache.readStatus()
    })
  }
  // A finished run is the moment the host's usage numbers move while nothing in
  // the UI asked for them. `api-session/status` is the same forwarded event
  // ui-session consumes; only the true→false edge reads, and the read targets
  // the provider behind that session's current model. Credential changes are the
  // other source: a login or logout elsewhere must reach this page without
  // waiting for a window focus.
  //
  // Both listeners address only sessions the composer already holds a rendered
  // slot binding for. Resolving a directory for an arbitrary forwarded session
  // id would both throw for an unknown one and create directories for sessions
  // no client surface ever opened.
  ctx.inject(['remote'], (scope: ClientContext) => {
    const running = new Map<string, boolean>()
    scope.effect(() => {
      const stopStatus = scope.remote.$on('api-session/status', (sessionId: string, isRunning: boolean) => {
        const previous = running.get(sessionId)
        running.set(sessionId, isRunning)
        if (previous !== true || isRunning) return
        const provider = active.get(sessionId)?.directory.store.getSnapshot().current?.provider
        if (provider !== undefined) void cache.readProvider(provider as SubscriptionProvider, 'local')
      })
      const stopCredentials = scope.remote.$on('credentials/reference-updated', () => { readRosterSoon() })
      const stopAdapters = scope.remote.$on('llm/adapters-updated', () => { readRosterSoon() })
      return () => {
        stopStatus()
        stopCredentials()
        stopAdapters()
        running.clear()
      }
    }, 'dsh-plugin-subscriptions: host-event usage reads')
  })
  const injected = (): SubscriptionsSectionInjected => ({
    rpc: connection.rpc,
    t,
    readStatus: options => cache.readStatus(options),
    readUsage: (provider, account, mode) => cache.readUsage(provider, account, mode),
    hooks: { usage: cache.source },
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'subscriptions',
    order: 90,
    // A thunk re-evaluated per read, so the nav label follows the active locale.
    label: () => t('nav'),
    inject: injected,
  }, SubscriptionsSection))

  // The image_generate keyed toolview owns how image calls render inline; its
  // gallery bytes ride the same channel through the injected loader. The
  // framework synthesizes the toolview's own `t` seat from `locale: NS`.
  const toolviewInjected = (): ImageGenerateToolviewInjected => ({ load: createImageLoader(connection.rpc) })
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'image_generate',
    locale: NS,
    inject: toolviewInjected,
  }, ImageGenerateToolview))

  // The video_generate keyed toolview plays the saved MP4 inline; its bytes
  // ride the same channel's `video` endpoint through the injected loader.
  const videoToolviewInjected = (): VideoGenerateToolviewInjected => ({ loadVideo: createVideoLoader(connection.rpc) })
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'video_generate',
    locale: NS,
    inject: videoToolviewInjected,
  }, VideoGenerateToolview))

  // The Speed row lives inside the composer's model menu, under the model and
  // effort cells, so one setting has one control: ui-model-selection declares
  // `conversation.input.model.row` as an additive child of its `conversation.input.model`
  // seat, and this contribution renders the row. The framework synthesizes its `t` seat
  // from `locale: NS`. The row hides itself for models whose catalog advertises no fast
  // tier. Both model-facing contributions wait for the model-selection service
  // itself, so a directory registered after this plugin still owns the sources
  // they bind — there is no "absent" model source to fall back to.
  ctx.inject(['slots', 'modelDirectories'], (scope: ClientContext) => {
    const directories = scope.get('modelDirectories') as ModelDirectoriesLike
    /** The tracked model source for one session's rendered contribution. */
    const sourceFor = (sessionId: string): ObservableSnapshot<ModelRef | null> => {
      const directory = directories.directoryFor(sessionId)
      return retainedModelSource(sessionId, directory, active)
    }
    scope.slots.inject('conversation.input.model.row', () => scope.slots.register({
      name: 'conversation.input.model.row',
      id: 'codex-speed',
      order: 0,
      locale: NS,
      inject: (sessionId: string): SpeedSelectInjected => ({
        loadSpeed: createSpeedLoader(connection.rpc),
        setSpeed: createSpeedSetter(connection.rpc),
        hooks: { model: sourceFor(sessionId) },
      }),
    }, SpeedSelect))

    // The subscription usage badge renders a stats pill in the composer's dock
    // (conversation.composer.dock) — collapsed, the current model's provider
    // (e.g. "Codex 6d1h 25%"); clicking opens every provider's windows. A fresh
    // id means it appears beside the shipped StatsPills, never replacing them;
    // the current-model read shares the Speed row's model-selection source, and
    // the usage entries come from the application's shared cache.
    scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
      name: 'conversation.composer.dock',
      id: 'subscription-usage',
      order: 10,
      locale: NS,
      inject: (sessionId: string): SubscriptionUsageBadgeInjected => ({
        rpc: connection.rpc,
        readStatus: () => cache.readStatus(),
        readUsage: (provider, account, mode) => cache.readUsage(provider, account, mode),
        readProvider: (provider, mode) => cache.readProvider(provider, mode),
        readAll: mode => cache.readAll(mode),
        hooks: {
          usage: cache.source,
          model: sourceFor(sessionId),
        },
      }),
    }, SubscriptionUsageBadge))
  })

  // The /fast slash command offers the same Standard/Fast choice as a popup.
  // `available` is synchronous and sees only the session id, so the command
  // stays listed everywhere; `options` throws the friendly gate when the
  // session's current model is not a fast-capable codex model (the same
  // in-popup error posture the /model contribution uses for its guards).
  ctx.inject(['commandUi'], (scope: ClientContext) => {
    const command = scope.get('commandUi') as CommandUiContract
    scope.effect(() => command.register({
      name: 'fast',
      // The command registry evaluates `description` per candidate pass as a
      // locale resolver; a bare string throws inside that pass and takes the
      // whole `/` source down with it.
      description: () => t('commandFast'),
      available: () => true,
      ui: {
        kind: 'popupSelect',
        options: async (session) => {
          // A command entry point owns no slot hook, so it resolves the
          // session's model once through the directory's explicit read.
          const current = await resolveCurrentModel(models, session.sessionId)
          const state = await createSpeedLoader(connection.rpc)(current)
          if (!state.visible) throw new Error(t('commandFastUnavailable'))
          return ([
            { id: 'standard', label: t('speedStandard'), detail: t('speedStandardDescription') },
            { id: 'fast', label: t('speedFast'), detail: t('speedFastDescription') },
          ] as const).map(option => ({ ...option, active: option.id === state.tier }))
        },
        // This entry point owns no notice surface of its own, so a false answer
        // has to fail the selection: the shell states a settlement failure
        // through its own error strip.
        onSelect: async (option, session) => {
          const current = await resolveCurrentModel(models, session.sessionId)
          if (current === null) throw new Error(t('commandFastUnavailable'))
          await settleSpeedTier(createSpeedSetter(connection.rpc), current, option.id as SpeedTier, t)
        },
      },
    }), 'dsh-plugin-subscriptions: /fast contribution')
  })
}

/**
 * Wrap one session's model source so its bound lifetime is visible to the
 * plugin: the entry appears with the first subscriber (a mounted slot
 * contribution) and leaves with the last one. A forwarded Host event reads the
 * provider through this registry instead of resolving a directory for a session
 * id no surface ever opened.
 * @param sessionId - the owning session.
 * @param directory - the session's shared model directory.
 * @param active - the plugin's registry of bound sessions.
 * @returns the model source for the inject hooks compartment.
 */
function retainedModelSource(
  sessionId: string,
  directory: ModelDirectoryLike,
  active: Map<string, { directory: ModelDirectoryLike; bindings: number }>,
): ObservableSnapshot<ModelRef | null> {
  const source = modelSelectionSource(directory)
  return {
    getSnapshot: () => source.getSnapshot(),
    subscribe: (listener) => {
      const stop = source.subscribe(listener)
      const entry = active.get(sessionId)
      if (entry === undefined) active.set(sessionId, { directory, bindings: 1 })
      else entry.bindings += 1
      let released = false
      return () => {
        if (released) return
        released = true
        stop()
        const current = active.get(sessionId)
        if (current === undefined) return
        if (current.bindings > 1) current.bindings -= 1
        else active.delete(sessionId)
      }
    },
  }
}
