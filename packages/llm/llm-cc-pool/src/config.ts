/**
 * Loader configuration for the fixed mac-pool route.
 *
 * The route, endpoint, credential reference, and headers are plugin-version
 * facts, so they are not configurable. Three deployment-varying choices are: the
 * durable request-diagnostic sink, because a host's log location and retention
 * bounds differ per installation, the model catalogue, because a pool
 * deployment may serve a different model set than the built-in one, and the
 * prompt-cache TTL, because how long a cached prefix must survive is the
 * deployment's cost decision. The catalogue is a live field: the settings
 * service projects it, and an edit reaches the next request and the next model
 * listing without remounting the plugin. `cacheTtl` is loader configuration read
 * when the plugin mounts.
 *
 * @module dsh-llm-cc-pool/config
 */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PiAiRequestLogProfileSchema } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiRequestLogProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { CACHE_TTLS, MODELS, REASONING_LEVELS } from './pool.ts'
import type { CcPoolCacheTtl, CcPoolModel } from './pool.ts'

/** Loader configuration for the mac-pool route. */
export interface Config {
  /**
   * Durable NDJSON sink for the same request/response diagnostics the plugin
   * logger records. With no configuration the fixed pool route persists its
   * records to the shared pool log below the harness home, so a request that
   * never reaches the pool still leaves client-side evidence; `enabled: true`
   * persists every route, `enabled: false` turns the file off, and `path`,
   * `maxFileBytes`, and `maxFiles` locate and size the retained set. Loader
   * configuration is read when the plugin mounts.
   */
  requestLog?: PiAiRequestLogProfile
  /**
   * Prompt-cache TTL this route declares for a request's `cache_control`
   * markers: `5m` keeps the API's default five-minute lifetime, `1h` asks for
   * the extended one, and `none` sends no marker. The default `5m` is the
   * lifetime the route already served, stated explicitly so the choice cannot
   * come from an ambient provider default; the value reaches the wire only
   * through this route's profile, so no other provider's request changes.
   */
  cacheTtl: CcPoolCacheTtl
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
  cacheTtl: z.union(CACHE_TTLS).default('5m'),
  models: z.array(modelSetting).default(builtInModels).volatile(),
})
