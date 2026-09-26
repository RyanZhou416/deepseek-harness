// DeepSeek Harness fork modification: verified subscription-route API prices.
/** Standard-speed API reference prices; sources and assumptions live in docs/model-pricing.md. */
import { modelsDevProviderOf } from './providers'

/** USD per million disjoint input, cache-read, cache-write, and output tokens. */
export interface TokenPrices {
  readonly hit: number
  readonly miss: number
  readonly write: number
  readonly out: number
}

/** One verified model and its optional whole-request long-context price. */
export interface ReferenceModelPrice {
  readonly provider: string
  readonly model: string
  readonly standard: TokenPrices
  readonly longContext?: { readonly above: number; readonly price: TokenPrices }
}

/** Date on which the bundled prices were checked against the model vendors. */
export const REFERENCE_PRICE_DATE = '2026-09-27'

/** Cost buckets retain per-request context tiers before Session aggregation. */
export const COST_PERIODS = ['peak', 'off', 'long'] as const

const REFERENCES: readonly ReferenceModelPrice[] = [
  {
    provider: 'openai', model: 'gpt-6-astra',
    standard: { miss: 10, hit: 1, write: 12.5, out: 50 },
    longContext: { above: 272_000, price: { miss: 20, hit: 2, write: 25, out: 75 } },
  },
  {
    provider: 'openai', model: 'gpt-6-sol',
    standard: { miss: 2, hit: 0.2, write: 2.5, out: 10 },
    longContext: { above: 272_000, price: { miss: 4, hit: 0.4, write: 5, out: 15 } },
  },
  { provider: 'anthropic', model: 'claude-opus-5-5', standard: { miss: 4, hit: 0.2, write: 5, out: 20 } },
  { provider: 'anthropic', model: 'claude-fable-5-1', standard: { miss: 10, hit: 0.25, write: 12.5, out: 50 } },
  {
    provider: 'xai', model: 'grok-4.7',
    standard: { miss: 2, hit: 0.5, write: 2, out: 6 },
    longContext: { above: 200_000, price: { miss: 4, hit: 1, write: 4, out: 12 } },
  },
]

/**
 * Resolve a supported route to its vendor's reference price, independently of models.dev availability.
 * @param provider - Recorded DSH provider id.
 * @param model - Recorded model id; matching is case-insensitive and exact.
 * @returns The verified model, or undefined for an unlisted provider/model pair.
 */
export function referenceModelPriceOf(provider: string, model: string): ReferenceModelPrice | undefined {
  const route = provider.toLowerCase()
  const owner = modelsDevProviderOf(route)
  const id = model.toLowerCase()
  return REFERENCES.find(entry => entry.model === id
    && (entry.provider === owner || (route === 'cursor' && entry.model === 'grok-4.7')))
}

/**
 * Check the complete prompt, including cache reads and writes, against its pricing threshold.
 * @param provider - Recorded provider route.
 * @param model - Recorded model id.
 * @param promptTokens - Aggregate prompt tokens for one request, excluding output.
 * @returns Whether the whole request uses the long-context rate.
 */
export function usesLongContextPrice(provider: string, model: string, promptTokens: number): boolean {
  const tier = referenceModelPriceOf(provider, model)?.longContext
  return tier !== undefined && promptTokens > tier.above
}
