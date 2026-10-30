/**
 * The context and output capacity this route reports for a Claude model.
 *
 * Two different quantities describe the same model. The pinned client's catalogue carries the
 * window it compacts against — a policy window that may sit below what the API accepts — while
 * the API documentation states the model's own limit. The harness picker wants the capacity the
 * model really has, so a documented limit answers before the catalogue entry does.
 *
 * A caller applies a provider-reported limit first; this module answers when discovery disclosed
 * none, in this order: the documented per-model limit, the pinned profile's catalogue entry, and
 * a conservative pair for a model no source names.
 *
 * One documented figure is withheld from a plain model id. A model whose catalogue entry reaches
 * its 1M window only through the long-context beta — the 200000-window entries carrying the
 * 1M-beta flag rather than native 1M — is reported at the catalogue window instead, because a
 * plain id composes no beta: the documentation states what the model accepts with it, and
 * reporting a window a request cannot use is a capacity the harness would then plan against and
 * the API would refuse. An id carrying the request-time `[1m]` marker composes that beta, so it
 * reports the million the client believes; an id whose entry declares no such flag is clamped
 * back to the plain window. The output ceiling is not beta-gated and is reported as documented.
 *
 * The catalogue key a wire model id resolves to therefore belongs to this module: the marker is a
 * capacity choice, and every entry lookup here reads through it. The key itself is the wire
 * library's `normalizeModelId`, not a local string edit: it strips the request-time marker, a
 * dotted version and a dated suffix, so `claude-opus-4.8`, `claude-sonnet-4-5-20250929[1m]` and
 * the plain catalogue spelling read one entry. A local strip would leave the dated and dotted
 * spellings keyless, which reports their capacity, thinking shape, effort set and fast tier as
 * unnamed.
 */

import {
  CLAUDE_CODE_2_1_288_PROFILE,
  normalizeModelId,
} from '@tormentalabs/claude-code-wire-compat'
import type { ClaudeCodeCatalogueEntry } from '@tormentalabs/claude-code-wire-compat'

/** The context and output capacity one Claude model is reported with. */
export interface ClaudeModelLimits {
  /** Combined request/response capacity in tokens. */
  readonly contextWindow: number
  /** Per-request output ceiling in tokens. */
  readonly maxOutputTokens: number
}

/**
 * The capacity the API documentation states for each model it names.
 *
 * The current-model table gives every entry 1M context and 128K output except
 * `claude-haiku-4-5`, documented at 200K and 64K; the raw `/v1/models` example beside it
 * carries the flagship pair as `max_input_tokens: 1000000` and `max_tokens: 128000`, and the
 * cost-optimization guide gives 64,000 as the documented agentic starting point for
 * `max_tokens`, up to the model's own maximum. The table names its newest models through
 * placeholders, and the identifiers below are those placeholders resolved through the same
 * file's alias table — `opus 5.5` to the newest Opus and `opus 5` to the previous one, and
 * likewise for Sonnet, Fable and Mythos — against the ids the pinned catalogue carries.
 *
 * A model the documentation does not name is deliberately absent: the profile entry answers
 * for it instead, and an id neither source carries falls to {@link CLAUDE_UNNAMED_LIMITS}.
 *
 * Two entries list the window the documentation states for the model rather than the window
 * this route reports for the plain id: `claude-sonnet-4-6` and `claude-opus-4-6` reach a million
 * tokens only inside the long-context beta, and {@link claudeModelLimits} reports their catalogue
 * window there. A `[1m]` id is what composes that beta.
 */
const CLAUDE_DOCUMENTED_LIMITS: Readonly<Partial<Record<string, ClaudeModelLimits>>> = Object.freeze({
  'claude-fable-5': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  'claude-fable-5-1': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  'claude-mythos-5': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  'claude-mythos-5-1': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  'claude-opus-4-6': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  'claude-opus-4-7': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  'claude-opus-4-8': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  'claude-opus-5': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  'claude-opus-5-5': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  'claude-sonnet-4-6': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  'claude-sonnet-5': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  'claude-sonnet-5-5': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  'claude-haiku-4-5': { contextWindow: 200_000, maxOutputTokens: 64_000 },
})

/**
 * The window the pinned catalogue gives a model whose entry declares 200000 and no other
 * context flag.
 *
 * The profile models only the flags a request reads, so an entry carrying the 200000 window
 * with nothing but the 1M-suffix marker reaches this module without a `context` object. The
 * omitted value is the catalogue's own default, not this route's choice.
 */
const CLAUDE_CATALOGUE_DEFAULT_WINDOW = 200_000

/**
 * The capacity reported for a model no source names.
 *
 * A model that appears in neither the documentation nor the pinned catalogue is one whose real
 * limits are unknown, and both figures here are deliberately below the documented flagship
 * pair: an under-claimed window compacts earlier rather than letting a request overrun the
 * model, and an under-claimed output ceiling asks for less rather than sending a `max_tokens`
 * the API rejects.
 */
const CLAUDE_UNNAMED_LIMITS: ClaudeModelLimits = Object.freeze({
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
})

/**
 * The window the client believes once `context-1m-2025-08-07` is on the request.
 *
 * The client's own constant rather than a documented per-model figure, which is why this module
 * cannot read it from either of its two sources.
 */
const CLAUDE_ONE_MILLION_WINDOW = 1_000_000

/**
 * The request-time marker that selects the long-context beta.
 *
 * The pinned builder composes `context-1m-2025-08-07` from `/\[1m\]/iu.test(rawModel)` and strips
 * the marker out of the id the body names, so it changes the window a request may use without
 * changing the model.
 */
const ONE_MILLION_MARKER = '[1m]'

/** Whether a wire model id carries {@link ONE_MILLION_MARKER}. */
function carriesOneMillionMarker(model: string): boolean {
  return /\[1m\]/iu.test(model)
}

/**
 * The pinned catalogue's key for a wire model id.
 *
 * Delegates to the wire library so this route and the builder agree on which
 * model an id names: the request-time marker, a dotted version, a dated suffix
 * and the letter case all resolve to the catalogue spelling. Exported because
 * a per-model wire rule beside a catalogue lookup must key on the same id; a
 * literal comparison against the raw wire id misses those spellings.
 * @param model - the wire model id.
 * @returns the id the profile keys its catalogue entry by.
 */
export function claudeCatalogueId(model: string): string {
  return normalizeModelId(model)
}

/**
 * One model's entry in the pinned catalogue, when it carries one.
 *
 * A request-time marker is not part of the catalogue key, so a marked id reads the same entry as
 * the plain one; neither is a dotted version or a dated suffix, which the same normalization
 * removes.
 * @param model - the wire model id.
 * @returns the catalogue entry, or undefined for an id the profile does not carry.
 */
export function claudeCatalogueEntry(model: string): ClaudeCodeCatalogueEntry | undefined {
  const catalogue = CLAUDE_CODE_2_1_288_PROFILE.supportedModels
  // A model id is arbitrary text, so the catalogue is asked for an own key: an id spelled like
  // an inherited object member must not resolve to that member.
  const id = claudeCatalogueId(model)
  return Object.hasOwn(catalogue, id) ? catalogue[id] : undefined
}

/**
 * The documented capacity for one model, when the documentation names it.
 * @param model - the wire model id; a request-time marker resolves to the id the documentation
 *   names.
 * @returns the documented limits, or undefined for a model the documentation does not name.
 */
export function claudeDocumentedLimits(model: string): ClaudeModelLimits | undefined {
  const id = claudeCatalogueId(model)
  return Object.hasOwn(CLAUDE_DOCUMENTED_LIMITS, id) ? CLAUDE_DOCUMENTED_LIMITS[id] : undefined
}

/**
 * The pinned profile's catalogue capacity for one model.
 *
 * @param model - the wire model id.
 * @returns the catalogue entry's window and default output ceiling, or undefined for an id the
 *   profile does not carry.
 */
export function claudeProfileLimits(model: string): ClaudeModelLimits | undefined {
  const entry = claudeCatalogueEntry(model)
  if (entry === undefined) return undefined
  return {
    contextWindow: entry.context?.window ?? CLAUDE_CATALOGUE_DEFAULT_WINDOW,
    // The catalogue limits are optional on the library's entry type because profiles predating
    // them cannot supply the field; the pinned profile supplies it on every entry.
    maxOutputTokens: entry.maxOutputTokens?.default ?? CLAUDE_UNNAMED_LIMITS.maxOutputTokens,
  }
}

/**
 * Whether this request composes the long-context beta for a model whose entry declares it.
 *
 * The client raises the window it believes to a million when the marker is on the id, and clamps
 * that belief back to the entry's own 200000 window when the model does not declare the beta. The
 * million is the client's constant rather than a documented per-model figure, so it answers for a
 * model the current-model table does not name as well.
 *
 * @param model - the wire model id.
 * @returns true when the id carries the marker and the entry declares the beta.
 */
function composesOneMillionBeta(model: string): boolean {
  return carriesOneMillionMarker(model)
    && claudeCatalogueEntry(model)?.context?.supports1mBeta === true
}

/**
 * Whether this request can reach a model's documented window without composing the beta.
 *
 * A catalogue entry whose 200000 window carries the 1M-beta flag rather than native 1M reaches a
 * million tokens only inside `context-1m-2025-08-07`; {@link composesOneMillionBeta} answers for
 * the ids that compose it, so a plain id reports the catalogue window instead. An entry that
 * declares no long-context flag needs no beta, and one whose window is native does not compose it.
 *
 * @param model - the wire model id.
 * @returns true when the documented window is reachable without the beta.
 */
function documentedWindowReachable(model: string): boolean {
  const context = claudeCatalogueEntry(model)?.context
  return context?.supports1mBeta !== true || context.native1m === true
}

/**
 * The marked id whose request composes the long-context beta, when the marker buys a window.
 *
 * The marked id is the only channel this route has for a context size, so a model whose marked
 * window equals its plain one — every native-1M entry, and every entry the beta flag does not
 * cover, whose claim the client clamps back — gets no variant rather than a second id that
 * reports the same capacity.
 *
 * @param model - the unmarked wire model id.
 * @returns the marked id, or undefined when it reports no larger window than the plain one.
 */
export function claudeOneMillionModelId(model: string): string | undefined {
  if (carriesOneMillionMarker(model)) return undefined
  const marked = `${model}${ONE_MILLION_MARKER}`
  return claudeModelLimits(marked).contextWindow > claudeModelLimits(model).contextWindow ? marked : undefined
}

/**
 * The capacity to report for one model when discovery disclosed none.
 *
 * @param model - the wire model id.
 * @returns the documented limit, the pinned catalogue's entry, or the conservative pair. A
 *   documented window that needs the long-context beta is replaced by the catalogue window
 *   under a plain id, and an id that composes the beta reports the million the client believes.
 */
export function claudeModelLimits(model: string): ClaudeModelLimits {
  const documented = claudeDocumentedLimits(model)
  const catalogue = claudeProfileLimits(model)
  if (composesOneMillionBeta(model)) {
    return {
      contextWindow: CLAUDE_ONE_MILLION_WINDOW,
      maxOutputTokens: (documented ?? catalogue)?.maxOutputTokens ?? CLAUDE_UNNAMED_LIMITS.maxOutputTokens,
    }
  }
  if (documented === undefined) return catalogue ?? CLAUDE_UNNAMED_LIMITS
  if (catalogue === undefined) return documented
  return {
    contextWindow: documentedWindowReachable(model) ? documented.contextWindow : catalogue.contextWindow,
    maxOutputTokens: documented.maxOutputTokens,
  }
}
