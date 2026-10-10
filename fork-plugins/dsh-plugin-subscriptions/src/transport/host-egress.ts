/**
 * The host's published egress policy, as the running plugin can read it.
 *
 * The launcher resolves one outbound proxy policy before any plugin mounts and publishes
 * the resolved values into this process's environment, which is how every
 * environment-reading consumer and every spawned child sees the one answer. A mandatory
 * Claude route is published as `DSH_CLAUDE_PROXY_URL`, a general route as
 * `HTTP_PROXY` / `HTTPS_PROXY`, and the dispatcher the host installed is what applies
 * either to an ordinary `fetch`.
 *
 * This plugin declares no dependency on the host's transport package, so the published
 * environment is the only part of that seam it can read. These facts let it stay inside a
 * published route: whether the host requires one, which scheme it routes, and which of
 * this plugin's transports cannot reach it at all.
 */

/** Environment name the host publishes a mandatory Claude route under; both casings are published together. */
export const HOST_CLAUDE_ROUTE_ENV = 'DSH_CLAUDE_PROXY_URL'

/** Environment names carrying the host's resolved proxy for `https:` and `http:` destinations, lowercase first. */
const HOST_HTTPS_PROXY_ENV: readonly string[] = ['https_proxy', 'HTTPS_PROXY']
const HOST_HTTP_PROXY_ENV: readonly string[] = ['http_proxy', 'HTTP_PROXY']

/** Suffixes of the Claude destinations this plugin contacts: the Anthropic API and the claude.com OAuth origin. */
const CLAUDE_EGRESS_SUFFIXES: readonly string[] = ['anthropic.com', 'claude.com']

/**
 * The first set name carried by the environment, treating a blank value as unset.
 *
 * @param names - The spellings to read, most preferred first.
 * @param env - The process environment.
 * @returns The value found, or undefined when none is set.
 */
function publishedValue(names: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

/**
 * The mandatory Claude route the host published in this process.
 *
 * The host writes both spellings and reads the lowercase one first, so this reads the
 * same way.
 *
 * @param env - The process environment.
 * @returns The published proxy URL, or undefined when the host requires no Claude route.
 */
export function hostClaudeRoute(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return publishedValue([HOST_CLAUDE_ROUTE_ENV.toLowerCase(), HOST_CLAUDE_ROUTE_ENV], env)
}

/**
 * The proxy the host published for a destination's scheme.
 *
 * The launcher publishes its resolved `httpsProxy` / `httpProxy` fields under these names,
 * so a value here means the dispatcher the host installed routes that scheme through a
 * proxy. The policy's own matching is deliberately not repeated: `NO_PROXY` entries,
 * loopback destinations, unsupported schemes and refused values are applied by that
 * dispatcher, and a request left to it is routed by the policy rather than around it.
 *
 * @param destination - The request URL, or undefined when this module could not parse it.
 * @param env - The process environment.
 * @returns The published proxy URL for the scheme, or undefined when the host routes that scheme directly.
 */
export function hostProxyForScheme(
  destination: URL | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (destination === undefined) return undefined
  if (destination.protocol === 'https:') return publishedValue(HOST_HTTPS_PROXY_ENV, env)
  if (destination.protocol === 'http:') return publishedValue(HOST_HTTP_PROXY_ENV, env)
  return undefined
}

/**
 * Reports whether a hostname is one of the Claude destinations this plugin sends to:
 * `api.anthropic.com` for Messages, usage, profile, file and bootstrap calls, and
 * `platform.claude.com` for the OAuth token exchange. Matching covers subdomains,
 * ignores case, and ignores a terminal DNS root dot.
 *
 * @param hostname - The request's hostname.
 * @returns True for a destination the host's mandatory Claude route covers.
 */
export function isClaudeEgressDestination(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/u, '')
  return CLAUDE_EGRESS_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))
}

/**
 * Names the mandatory route in a refusal without repeating proxy credentials.
 *
 * @param route - The published proxy URL.
 * @returns The variable name, followed by the route's credential-free origin when it parses.
 */
export function describeHostClaudeRoute(route: string): string {
  let origin = ''
  try {
    origin = ` (${new URL(route).origin})`
  } catch {
    // The host validates this value at boot, so an unparseable one still only needs the variable named.
    origin = ''
  }
  return `${HOST_CLAUDE_ROUTE_ENV}${origin}`
}
