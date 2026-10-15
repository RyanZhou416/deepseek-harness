/**
 * Bounded, pageable projection of the interpreter's ontology payloads into the
 * values `aether_discover` returns.
 *
 * The native payloads are large: the manifest lists 53 categories, and a
 * category such as `Core` describes hundreds of builtins, so a caller pages
 * through them with `offset` and `limit` instead of raising a deployment
 * budget. `ontology_describe` also answers an unknown name with a *successful*
 * record carrying `error` and `hint` rather than a failure. That reply shape is
 * read here and nowhere else: no other returned field is inspected for failure,
 * because a native value may legitimately contain an `error` key of its own.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/discovery
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { AetherDeniedOutcome, AetherErrorOutcome, AetherInterruptedOutcome, AetherValueOutcome } from './outcome.ts'
import { isJsonObject } from './outcome.ts'

/** Which native ontology payload one discovery call returned. */
export type AetherDiscoveryShape = 'manifest' | 'category' | 'builtin' | 'unknown'

/** One page of a native ontology list. */
export interface AetherOntologyPage {
  /** Zero-based index of the first entry to include. */
  readonly offset?: number
  /** Maximum entries to include; the deployment's entry budget caps it. */
  readonly limit?: number
}

/** How one discovery payload was bounded, and which shape its value has. */
export interface AetherDiscovery {
  /** The native payload shape the value carries. */
  shape: AetherDiscoveryShape
  /** The category or builtin name this call asked for, when it named one. */
  query?: string
  /** Zero-based index of the first entry included; present for the list shapes. */
  offset?: number
  /** Entries included in this page; present for the list shapes. */
  shown?: number
  /** Entries the native payload listed; present for the list shapes. */
  total?: number
  /**
   * Offset to pass as the next page's `offset`; present exactly when entries
   * remain beyond this page.
   */
  nextOffset?: number
  /** True when entries remain beyond this page, or the example cap dropped content. */
  truncated: boolean
}

/** One bounded discovery value and the shape facts its consumer needs. */
export interface AetherProjection {
  /** The bounded payload; field names stay as the interpreter wrote them. */
  value: JsonValue
  discovery: AetherDiscovery
}

/** A discovery call that produced a value. */
export type AetherDiscoverOutcome =
  | (AetherValueOutcome & { discovery: AetherDiscovery })
  | AetherErrorOutcome
  | AetherDeniedOutcome
  | AetherInterruptedOutcome

/** Copy the named fields the source record carries, keeping native field names. */
function pick(source: Record<string, JsonValue>, keys: readonly string[]): Record<string, JsonValue> {
  const kept: Record<string, JsonValue> = {}
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined) kept[key] = value
  }
  return kept
}

/**
 * Cap the illustrative examples of a builtin detail.
 *
 * Parameters are deliberately left intact: they are the call contract, and a
 * partial parameter list would produce wrong calls.
 * @param record - the native builtin detail.
 * @param limit - the page size in entries.
 * @returns the record and whether the cap dropped examples.
 */
function capExamples(record: Record<string, JsonValue>, limit: number): { value: Record<string, JsonValue>; truncated: boolean } {
  const examples = record.examples
  if (!Array.isArray(examples) || examples.length <= limit) return { value: record, truncated: false }
  return { value: { ...record, examples: examples.slice(0, limit) }, truncated: true }
}

/**
 * Slice one native list into the requested page and describe how to continue.
 * @param total - entries the native payload listed.
 * @param offset - the requested zero-based start index, when the caller gave one.
 * @param limit - the page size in entries.
 * @returns the page bounds and the continuation offset.
 */
function pageBounds(total: number, offset: number | undefined, limit: number): { start: number; end: number; nextOffset?: number } {
  const start = Math.min(offset ?? 0, total)
  const end = Math.min(start + limit, total)
  return { start, end, ...end < total ? { nextOffset: end } : {} }
}
/**
 * Project one ontology payload under the requested page.
 * @param query - the category or builtin name the call named, when it named one.
 * @param result - the native `result` of the discovery request.
 * @param page - the requested offset and page size, already validated and capped.
 * @returns the bounded value and its shape facts.
 */
export function projectOntology(query: string | undefined, result: JsonValue, page: AetherOntologyPage = {}): AetherProjection {
  const named = query === undefined ? {} : { query }
  const limit = page.limit ?? Number.MAX_SAFE_INTEGER
  if (!isJsonObject(result)) {
    return { value: result, discovery: { shape: 'unknown', ...named, truncated: false } }
  }
  const categories = result.categories
  if (Array.isArray(categories)) {
    const bounds = pageBounds(categories.length, page.offset, limit)
    const shown = categories.slice(bounds.start, bounds.end)
    return {
      value: { ...pick(result, ['ontology', 'total_builtins', 'effect_legend', 'hint']), categories: shown },
      discovery: {
        shape: 'manifest',
        ...named,
        offset: bounds.start,
        shown: shown.length,
        total: categories.length,
        ...bounds.nextOffset === undefined ? {} : { nextOffset: bounds.nextOffset },
        truncated: bounds.nextOffset !== undefined,
      },
    }
  }
  const builtins = result.builtins
  if (Array.isArray(builtins)) {
    const bounds = pageBounds(builtins.length, page.offset, limit)
    const shown = builtins.slice(bounds.start, bounds.end)
    return {
      value: { ...pick(result, ['category', 'hint']), builtins: shown },
      discovery: {
        shape: 'category',
        ...named,
        offset: bounds.start,
        shown: shown.length,
        total: builtins.length,
        ...bounds.nextOffset === undefined ? {} : { nextOffset: bounds.nextOffset },
        truncated: bounds.nextOffset !== undefined,
      },
    }
  }
  if (typeof result.error === 'string') {
    return { value: pick(result, ['error', 'hint']), discovery: { shape: 'unknown', ...named, truncated: false } }
  }
  const capped = capExamples(result, limit)
  return { value: capped.value, discovery: { shape: 'builtin', ...named, truncated: capped.truncated } }
}
