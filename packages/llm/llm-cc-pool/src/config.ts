/**
 * Loader configuration for the fixed mac-pool route.
 *
 * The route, endpoint, credential reference, and headers are plugin-version
 * facts, so they are not configurable. The deployment-varying choices are: the
 * durable request-diagnostic sink, because a host's log location and retention
 * bounds differ per installation, the model catalogue, because a pool
 * deployment may serve a different model set than the built-in one, and the
 * prompt-cache policy, because how long a cached prefix must survive and which
 * markers carry it are the deployment's cost decision. The catalogue is a live
 * field: the settings service projects it, and an edit reaches the next request
 * and the next model listing without remounting the plugin. The cache policy is
 * loader configuration read when the plugin mounts.
 *
 * @module dsh-llm-cc-pool/config
 */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CACHE_MARKER_POLICIES, PiAiRequestLogProfileSchema } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiCacheMarkerPolicy, PiAiRequestLogProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { CACHE_TTLS, MODELS, REASONING_LEVELS } from './pool.ts'
import type { CcPoolCacheTtl, CcPoolModel } from './pool.ts'

/** Loader configuration for the mac-pool route. */
export interface Config {
  /**
   * Optional durable NDJSON sink for the same request/response diagnostics the
   * plugin logger records. It is off by default: a pool route carrying session
   * headers does not imply a file, because a deployment may collect the logger
   * or another provider's sink instead. Configure `requestLog` — `enabled:
   * true` or any field such as `path` — to turn it on. Without `path` the pool
   * route writes to `$DSH_HOME/logs/llm-cc-pool-requests.jsonl`, its own file,
   * so an enabled pi-ai sink on its default path never gains a second writer.
   * `enabled: false` turns the file off, and `maxFileBytes` and `maxFiles`
   * bound the retained set. Records carry identity and outcome only: the
   * endpoint is reduced to its origin and path, and no message, cause, request
   * body, credential, token count, or session title is written. Loader
   * configuration is read when the plugin mounts.
   */
  requestLog?: PiAiRequestLogProfile
  /**
   * Prompt-cache TTL this route declares for a request's `cache_control`
   * markers: `5m` keeps the API's default five-minute lifetime, `1h` asks for
   * the extended one, and `none` sends no marker. The default `1h` is the
   * lifetime the route serves now; `5m` and `none` are refused while
   * {@link cacheMarkerPolicy} is `cc3`, because that policy writes one-hour
   * markers on its own. The value reaches the wire only through this route's
   * profile, so no other provider's request changes.
   */
  cacheTtl: CcPoolCacheTtl
  /**
   * Declare `extended-cache-ttl-2025-04-11` on this route's Anthropic Messages
   * requests. The default `true` is what the default `cacheTtl: 1h` and
   * {@link cacheMarkerPolicy} require; an explicit `false` is refused instead
   * of producing a request the provider would reject.
   */
  extendedCacheBeta: boolean
  /**
   * Prompt-cache marker placement this route asks pi-ai to perform. The
   * default `cc3` places the Claude Code 2.1.288 layout — the client identity
   * system block, the harness system block, and the last cacheable user content
   * block — with `{type: "ephemeral", ttl: "1h"}` on each slot, and no marker on
   * any tool declaration or on a message before the last user turn. The policy
   * owns placement, so it takes precedence over the lifetime {@link cacheTtl}
   * selects, and it also writes the pinned client's top-level field order with
   * an empty `metadata` placeholder in its canonical slot for the pool's
   * `user_id` splice. It requires `cacheTtl: "1h"` and {@link extendedCacheBeta}:
   * an impossible combination is refused at load and on a settings write, never
   * at request time. No other provider route reads this value.
   */
  cacheMarkerPolicy?: PiAiCacheMarkerPolicy
  /**
   * The catalogue selector surfaces offer, replacing the built-in four-model
   * catalogue wholesale. Absent, or reset through the settings service, serves
   * the built-in catalogue. A provided list resolves through this package's
   * strict catalogue check: at least one model, every non-empty id once,
   * non-empty names, positive integer capacities, and a default effort among
   * the five pool levels. Invalid input fails the plugin at load and is refused
   * before a settings write persists.
   */
  models: Volatile<CcPoolModel[]>
}

/** Plain loader configuration a composition writes, before schema defaults apply. */
export type Options = {
  requestLog?: PiAiRequestLogProfile
  cacheTtl?: CcPoolCacheTtl
  extendedCacheBeta?: boolean
  cacheMarkerPolicy?: PiAiCacheMarkerPolicy
  models?: CcPoolModel[]
}

/** Runtime schema for one configured catalogue entry. */
const modelSetting: z<CcPoolModel> = z.object({
  id: z.string().min(1).required(),
  name: z.string().min(1).required(),
  contextWindow: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  defaultReasoning: z.union(REASONING_LEVELS).required(),
})

/** The schema default: the built-in catalogue, detached from the frozen {@link MODELS}. */
const builtInModels: CcPoolModel[] = MODELS.map(model => ({ ...model }))

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  requestLog: PiAiRequestLogProfileSchema,
  cacheTtl: z.union(CACHE_TTLS).default('1h'),
  extendedCacheBeta: z.boolean().default(true),
  cacheMarkerPolicy: z.union(CACHE_MARKER_POLICIES).default('cc3'),
  models: z.array(modelSetting).default(builtInModels).volatile(),
})
