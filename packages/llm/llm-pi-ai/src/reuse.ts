/**
 * Reuse surface for a provider plugin that mounts its own fixed route set.
 *
 * A plugin that owns its route facts outright — the mac-pool plugin is the
 * first — still needs the same generic pieces this package's own plugin
 * composes: profile resolution, the auth injection a `Models` collection is
 * built with, and the durable request-diagnostic sink. The adapter helpers
 * themselves stay package-internal; this module is the contract such a plugin
 * may rely on, so it reuses the transport instead of restating it.
 *
 * Nothing here reads a settings namespace, registers a route, or offers
 * discovery: those remain the mounting plugin's decisions.
 *
 * @module dsh-llm-pi-ai/reuse
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PiAiAdapterOptions, PiAiAuthInjection, PiAiRequestDiagnostic } from './adapter.ts'
import { authContextFrom, credentialStoreFrom } from './auth.ts'
import { resolveProfiles, resolveRequestLog } from './config.ts'
import type { PiAiProviderProfile, PiAiRequestLogProfile, ResolvedPiAiProviderProfile } from './config.ts'
import { redactEndpoint, RequestDiagnosticLog } from './request-log.ts'

/**
 * Resolve one fixed provider-profile map with full validation.
 *
 * Strict resolution is the write path: a profile that cannot be served throws
 * where the plugin mounts, rather than leaving a route that fails at its first
 * request.
 * @param providers - provider profiles keyed by route.
 * @returns the resolved profiles in configuration order.
 * @throws {PiAiCatalogError} when a profile or model cannot be served.
 */
export function resolvePiAiProfiles(
  providers: Readonly<Record<string, PiAiProviderProfile>>,
): Map<string, ResolvedPiAiProviderProfile> {
  return resolveProfiles(providers, 'strict')
}

/**
 * The auth injection a reused `PiAiAdapter` needs.
 *
 * Both halves read through `ctx` per call, so they stay correct across a
 * mounting plugin's own lifecycle; a fixed route that always supplies its
 * request-level `apiKey` never asks them for a credential, but pi-ai's
 * collection contract still requires the store and ambient context.
 * @param ctx - the mounting plugin's context.
 * @returns the credential store and auth context pair.
 */
export function piAiAuthFrom(ctx: Context): PiAiAuthInjection {
  return { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) }
}

/** The durable sink a mounting plugin appends request diagnostics to. */
export interface PiAiRequestLogSink {
  /**
   * Queue one diagnostic record; performs no I/O on the caller's path.
   * @param event - the request or settled-response diagnostic.
   */
  append(event: PiAiRequestDiagnostic): void
  /**
   * Stop accepting records and wait for the queued writes.
   * @returns a promise that settles when the queue has drained.
   */
  close(): Promise<void>
}

/** The route set of a fixed-route plugin that configures no request log. */
const NO_LOG_ROUTES: ReadonlySet<string> = new Set()

/**
 * Whether a request-log profile names at least one setting.
 *
 * A loader schema materializes an absent nested object as `{}`, so the presence
 * of the key does not distinguish a configured profile from an absent one. A
 * real setting carries a value.
 * @param config - the operator's request-log settings.
 * @returns whether any field carries a value.
 */
function isRequestLogConfigured(config: PiAiRequestLogProfile | undefined): config is PiAiRequestLogProfile {
  return config !== undefined && Object.values(config).some(value => value !== undefined)
}

/**
 * Create the durable NDJSON sink for a fixed route set, when one applies.
 *
 * The same defaults the plugin itself uses: a configured `path` locates the
 * file, an unconfigured sink exists while `sessionHeaders` names a route,
 * `enabled: false` disables it, and `enabled: true` widens it to every route.
 * A fixed-route plugin that must not write implicitly passes `implicit: false`
 * and its own `defaultPath`, so an unconfigured plugin leaves no file and an
 * enabled one never shares the pi-ai file. An empty profile is unconfigured:
 * a loader-materialized `{}` must not turn that opted-out plugin on.
 * @param options - sink settings and the mounting plugin's warning channel.
 * @param options.config - the operator's request-log settings; an absent profile,
 *   or one whose every field is empty, keeps the route defaults.
 * @param options.sessionHeaders - routes that carry the pool session identity.
 * @param options.warn - receives the first write failure.
 * @param options.implicit - whether an unconfigured sink follows `sessionHeaders` (default true).
 * @param options.defaultPath - file used when the configuration names none.
 * @returns the sink, or undefined when no file should be written.
 */
export function createPiAiRequestLog(options: {
  config: PiAiRequestLogProfile | undefined
  sessionHeaders: ReadonlySet<string>
  warn: (message: string) => void
  implicit?: boolean
  defaultPath?: string
}): PiAiRequestLogSink | undefined {
  const config = isRequestLogConfigured(options.config) ? options.config : undefined
  const routes = options.implicit === false && config === undefined
    ? NO_LOG_ROUTES
    : options.sessionHeaders
  const resolved = resolveRequestLog(config, routes, options.defaultPath)
  return resolved === undefined ? undefined : new RequestDiagnosticLog(resolved, options.warn)
}

/** The logger calls one diagnostic channel writes through. */
export interface PiAiDiagnosticLogger {
  /** Record a non-retained route's attempt. */
  debug: (line: string, fields: object) => void
  /** Record a retained route's attempt. */
  info: (line: string, fields: object) => void
  /** Record a settled failure or a degraded replay. */
  warn: (line: string, fields?: object) => void
}

/** What one plugin's diagnostic channel needs to report attempts. */
export interface PiAiDiagnosticChannel {
  /** Package prefix every line carries, e.g. `llm-pi-ai`. */
  label: string
  /** Routes whose attempts stay at INFO; other routes log at DEBUG. */
  retainedRoutes: ReadonlySet<string>
  /** Receives every diagnostic for persistence; omitted when no sink exists. */
  append?: (event: PiAiRequestDiagnostic) => void
  /** The mounting plugin's logger. */
  logger: PiAiDiagnosticLogger
}

/**
 * The process-log fields one retained route may report.
 *
 * A retained route is the one a durable sink records, so its process line is
 * read beside that file and carries the same facts: the endpoint is reduced to
 * its origin and path exactly as the durable record reduces it, and the
 * provider's own failure text stays out, because either can echo a credential
 * or request content. `code`, `status`, and the pool request id stay, because
 * they are the facts diagnosis needs.
 * @param event - the request or settled-response diagnostic.
 * @returns the fields to hand to the logger.
 */
function retainedRouteLogFields(event: PiAiRequestDiagnostic): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    provider: event.provider,
    model: event.model,
    endpoint: redactEndpoint(event.endpoint),
    stream: event.stream,
    ...event.sessionId === undefined ? {} : { sessionId: event.sessionId },
    ...event.clientRequestId === undefined ? {} : { clientRequestId: event.clientRequestId },
    ...event.attempt === undefined ? {} : { attempt: event.attempt },
  }
  if (event.kind !== 'response') return fields
  return {
    ...fields,
    ...event.status === undefined ? {} : { status: event.status },
    ...event.poolRequestId === undefined ? {} : { poolRequestId: event.poolRequestId },
    ...event.code === undefined ? {} : { code: event.code },
  }
}

/**
 * Build the adapter diagnostic callbacks for one plugin.
 *
 * The rule is the same for any pi-ai-backed route set: a failure logs at WARN,
 * a route carrying the pool session identity logs at INFO where a deployment's
 * default sink retains it, every other route stays at DEBUG, and a degraded
 * replay warns once. `append` decides persistence because its owner knows the
 * sink's own scope (for example, only routes the sink was enabled for).
 * @param channel - label, retained routes, logger, and optional persistence.
 * @returns the two callbacks `PiAiAdapterOptions` accepts.
 */
export function piAiDiagnosticHooks(channel: PiAiDiagnosticChannel): Pick<
  PiAiAdapterOptions,
  'onReplayDegrade' | 'onRequestDiagnostic'
> {
  return {
    onReplayDegrade: ({ provider, model, reason }) => {
      channel.logger.warn(
        `${channel.label}: unusable replay state on assistant history for route "${provider}/${model}";`
        + ` sending that message as provider-neutral content (${reason})`,
      )
    },
    onRequestDiagnostic: (event) => {
      const { kind, ...fields } = event
      const retained = channel.retainedRoutes.has(event.provider)
      if (kind === 'response' && event.code !== undefined) {
        channel.logger.warn(
          `${channel.label}: model request failed %o`,
          retained ? retainedRouteLogFields(event) : fields,
        )
      } else {
        const line = kind === 'request'
          ? `${channel.label}: model request %o`
          : `${channel.label}: model request response %o`
        if (retained) channel.logger.info(line, retainedRouteLogFields(event))
        else channel.logger.debug(line, fields)
      }
      channel.append?.(event)
    },
  }
}
