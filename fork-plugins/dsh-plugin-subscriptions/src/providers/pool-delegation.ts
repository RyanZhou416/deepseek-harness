/**
 * The account-pool delegation every subscription adapter shares. An adapter
 * contributes its own catalogue data and its own model-field assembly; this base
 * owns the four seams the pool plugs into: picker rows add the configured
 * pool's tiers, resolution hands a pool-owned id to the pool, streaming runs the
 * pool prelude before the provider's own wire path, and the account seam streams
 * one named account through that same path.
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ProviderId } from '../auth/store.js'
import type { PoolAdapter } from './pool.js'
import { withPoolTiers } from './provider-catalog.js'
import type { ProviderCatalog } from './provider-catalog.js'

/** The pool binding every delegating adapter carries in its constructor options. */
interface PoolBinding {
  /** Late-bound pool facade (wired after adapter construction); absent means no pool. */
  pool?: () => PoolAdapter | undefined
}

/**
 * Base for a subscription adapter that a configured account pool may route:
 * one instance serves one provider route, and its constructor options carry the
 * pool facade. A subclass supplies its {@link ProviderCatalog} plus the
 * provider-specific pieces: {@link resolveOwnModel}, {@link streamOwn}, the
 * static and discovered row mapping, and its own account-catalog invalidation.
 */
export abstract class PoolBackedAdapter extends LlmAdapter {
  /** The provider's account-indexed catalog, assigned by the subclass constructor. */
  protected abstract readonly catalogs: ProviderCatalog

  protected constructor(private readonly poolHost: PoolBinding) {
    super()
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return withPoolTiers(await this.listOwnModels(provider), this.poolHost.pool?.(), provider)
  }

  /** The provider's own catalog: union of every account, or one account when named. */
  async listOwnModels(provider: string, account?: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    return this.catalogs.list(provider, account, signal)
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const pool = this.poolHost.pool?.()
    if (pool !== undefined && await pool.owns(provider as ProviderId, model)) {
      return pool.resolveModel(provider, model)
    }
    return this.resolveOwnModel(provider, model)
  }

  /** Capability resolution of the provider's own models (the pool resolves members here). */
  abstract resolveOwnModel(provider: string, model: string, account?: string): Promise<LlmResolvedModelInfo>

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const pool = this.poolHost.pool?.()
    if (pool !== undefined && await pool.owns(options.provider as ProviderId, options.model)) {
      yield* pool.stream(options)
      return
    }
    yield* this.streamOwn(options)
  }

  /** Stream through the provider's own wire path, one account (default when omitted) at a time. */
  protected abstract streamOwn(options: GenerateOptions, account?: string): AsyncIterable<StreamChunk>

  /** Pool seam: stream through one specific account instead of the default. */
  streamAccount(options: GenerateOptions, account?: string): AsyncIterable<StreamChunk> {
    return this.streamOwn(options, account)
  }
}
