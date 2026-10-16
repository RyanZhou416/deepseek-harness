/**
 * Model-facing text for one canonical outcome.
 *
 * The renderer is deliberately compact: values print as single-line canonical
 * JSON (a string is its own text), because every byte here is a model token and
 * the complete-result budget already bounds the total. It adds only reading
 * aids — the interpreter's failure text, a sandbox denial marker, a deadline or
 * teardown marker, a nonzero exit marker, an unclean-cleanup marker, the
 * retained-result notice, and the bounded diagnostic stream. Native metadata and
 * the `result_type` tag stay in the canonical value for programmatic consumers.
 *
 * This module also owns the exact text of one retained page. The result bound
 * measures a page in the text this function produces, so the renderer is the
 * single home of that text rather than a second copy beside the bound.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/render
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { AetherDiscoverOutcome, AetherDiscovery } from './discovery.ts'
import type {
  AetherDiagnostics,
  AetherFailure,
  AetherOutcome,
  AetherProcessFacts,
  AetherRetainedOutcome,
  AetherSandboxFacts,
} from './outcome.ts'
import { isJsonObject } from './outcome.ts'
import type { AetherResultPage, AetherResultPageOutcome } from './results.ts'

/** Static exhaustiveness guard for a closed outcome union. */
function assertNever(value: never): never {
  throw new Error(`aether-shell: unhandled outcome ${JSON.stringify(value)}`)
}

/** Join the rendered sections, so an outcome with nothing to say still reads as a result. */
function text(parts: readonly string[]): string {
  const body = parts.filter(part => part.length > 0).join('\n')
  return body.length === 0 ? '(no output)' : body
}

/** Render the interpreted value; a string is its own text, everything else is single-line JSON. */
function renderValue(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Render the interpreter's failure text with the code, suggestions, hint, and retry advice it supplied. */
function renderFailure(error: AetherFailure): string {
  if (error.details !== undefined) return JSON.stringify({ error: error.details })
  const parts = [`aether error${error.code === undefined ? '' : ` (${error.code})`}: ${error.message}`]
  if (error.hint !== undefined) parts.push(`hint: ${error.hint}`)
  const suggestions = error.didYouMean
  // The interpreter usually folds its suggestions into the hint; render them
  // separately only when the hint does not already name them.
  if (suggestions !== undefined && suggestions.length > 0
    && !suggestions.every(name => error.hint !== undefined && error.hint.includes(name))) {
    parts.push(`did you mean: ${suggestions.join(', ')}`)
  }
  if (error.retryable === true) parts.push('retryable: true')
  return parts.join('\n')
}

/** Render the bounded diagnostic stream, naming the spill file when the budget truncated it. */
function renderDiagnostics(stderr: AetherDiagnostics): string[] {
  const parts: string[] = []
  if (stderr.text.length > 0) parts.push('[stderr]', stderr.text.replace(/\n+$/, ''))
  if (stderr.truncated) parts.push(`[stderr truncated; complete stream: ${stderr.spillPath ?? '(unavailable)'}]`)
  return parts
}

/** Render the process facts that are independent of what the interpreter reported. */
function renderProcess(process: AetherProcessFacts): string[] {
  const parts: string[] = []
  if (process.exitCode !== null && process.exitCode !== 0) parts.push(`[exit code: ${process.exitCode}]`)
  if (process.cleanupFailed) parts.push('[managed process range did not stop within the grace period]')
  return parts
}

/** Render the sandbox denial the way the shell tools report one, so the model reads one marker dialect. */
function renderDenial(sandbox: AetherSandboxFacts): string {
  return `[sandbox: file access denied under ${sandbox.mode} mode]`
}

/** Render why this plugin stopped the interpreter before it reported a result. */
function renderInterruption(timedOut: boolean): string {
  return timedOut ? '[timed out before the interpreter reported a result]' : '[stopped: the plugin unloaded]'
}

/**
 * Render the notice that replaces a value too large to return inline.
 *
 * The notice names the value's shape, the exact tool call that reads it, and the
 * fact that nothing was lost or re-run: it is the only place the model learns the
 * retrieval tool exists, so it must carry the call rather than a bare id.
 * @param outcome - the retained arm.
 * @returns the model-facing notice.
 */
function renderRetained(outcome: AetherRetainedOutcome): string {
  const { id, bytes, total, unit, originalResultType } = outcome.result
  const kind = originalResultType === undefined ? '' : ` of type ${originalResultType}`
  return `aether result ${id}: the complete value is ${bytes} bytes${kind} and is over this deployment's result budget, so it was retained whole instead of returned.`
    + ` It holds ${total} ${unit}. Read it with aether_result_page { id: "${id}" }; paging reads the stored value without running anything again.`
}

/** Render `ontology_describe`'s unknown-name reply, which arrives as a successful record. */
function renderUnknownOntology(value: JsonValue): string[] {
  if (!isJsonObject(value)) return [renderValue(value)]
  const parts = [typeof value.error === 'string' ? `aether ontology: ${value.error}` : renderValue(value)]
  if (typeof value.hint === 'string') parts.push(`hint: ${value.hint}`)
  return parts
}

/** Render how to read the rest of a paged or example-capped discovery payload. */
function renderDiscoveryNotice(discovery: AetherDiscovery): string | undefined {
  if (discovery.nextOffset !== undefined) {
    return `[showing ${discovery.shown ?? 0} of ${discovery.total ?? 0}; continue with offset ${discovery.nextOffset}]`
  }
  return discovery.truncated ? '[examples truncated to the page size]' : undefined
}

/**
 * Render one canonical outcome for the model.
 * @param outcome - the canonical value of a `call`, `pipeline`, or `eval` result.
 * @returns the model-facing text.
 */
export function renderOutcome(outcome: AetherOutcome): string {
  switch (outcome.kind) {
    case 'value':
      return text([renderValue(outcome.value), ...renderProcess(outcome.process), ...renderDiagnostics(outcome.stderr)])
    case 'retained':
      return text([renderRetained(outcome), ...renderProcess(outcome.process), ...renderDiagnostics(outcome.stderr)])
    case 'error':
      return text([renderFailure(outcome.error), ...renderProcess(outcome.process), ...renderDiagnostics(outcome.stderr)])
    case 'denied':
      return text([renderDenial(outcome.sandbox), ...renderProcess(outcome.process), ...renderDiagnostics(outcome.stderr)])
    case 'interrupted':
      return text([renderInterruption(outcome.timedOut), ...renderProcess(outcome.process), ...renderDiagnostics(outcome.stderr)])
    default:
      return assertNever(outcome)
  }
}

/**
 * Render one page of a retained result.
 *
 * The notice names the format, the unit, the range, and how to continue, because
 * `offset` means an element index in one format and a byte offset in the other,
 * and a caller that guesses between them would skip or repeat content.
 * @param page - the page about to be returned.
 * @returns the model-facing text, ending in the page's own content.
 */
export function renderPage(page: AetherResultPage): string {
  const end = page.offset + page.shown
  const notice = page.complete
    ? `aether result ${page.id}: ${page.format} page, ${page.unit} ${page.offset}..${end} of ${page.total} (complete)`
    : `aether result ${page.id}: ${page.format} page, ${page.unit} ${page.offset}..${end} of ${page.total}; continue with offset ${page.nextOffset}`
  return `${notice}\n${renderValue(page.data)}`
}

/**
 * Render one canonical `aether_result_page` result.
 * @param outcome - the page, drop receipt, or coded refusal.
 * @returns the model-facing text.
 */
export function renderResultPage(outcome: AetherResultPageOutcome): string {
  switch (outcome.kind) {
    case 'page':
      return renderPage(outcome)
    case 'dropped':
      return `aether result ${outcome.id}: dropped`
    case 'error':
      return renderFailure(outcome.error)
    default:
      return assertNever(outcome)
  }
}

/**
 * Render one discovery outcome for the model.
 * @param outcome - the canonical value of an `aether_discover` result.
 * @returns the model-facing text, with an explicit continuation notice when the page left entries behind.
 */
export function renderDiscovery(outcome: AetherDiscoverOutcome): string {
  switch (outcome.kind) {
    case 'value': {
      const parts = outcome.discovery.shape === 'unknown' ? renderUnknownOntology(outcome.value) : [renderValue(outcome.value)]
      const notice = renderDiscoveryNotice(outcome.discovery)
      if (notice !== undefined) parts.push(notice)
      return text([...parts, ...renderProcess(outcome.process), ...renderDiagnostics(outcome.stderr)])
    }
    case 'error':
      return text([renderFailure(outcome.error), ...renderProcess(outcome.process), ...renderDiagnostics(outcome.stderr)])
    case 'denied':
      return text([renderDenial(outcome.sandbox), ...renderProcess(outcome.process), ...renderDiagnostics(outcome.stderr)])
    case 'interrupted':
      return text([renderInterruption(outcome.timedOut), ...renderProcess(outcome.process), ...renderDiagnostics(outcome.stderr)])
    default:
      return assertNever(outcome)
  }
}
