/**
 * The one retrieval tool: page or drop a result this deployment retained.
 *
 * A value too large for the complete-result budget is retained whole by
 * `aether_call`, `aether_pipeline`, or `aether_eval`, which return its id and
 * shape instead of the value. This tool reads that value one bounded page at a
 * time. Paging never runs the interpreter: it reads the stored JSON, so a page
 * costs one map lookup and one serialization, and no side effect of the original
 * program is repeated.
 *
 * Two formats exist because two kinds of value need different addressing. `items`
 * (the default) pages a container by whole elements or whole fields, so every
 * page is itself valid JSON of the same shape. `json` pages the value's canonical
 * JSON encoding by UTF-8 byte offset, which is the only way to read one element
 * that is larger than a whole page; concatenating those chunks and parsing the
 * result reconstructs the value exactly. `offset`, `shown`, `total`, and
 * `nextOffset` are always counted in the unit the page reports.
 *
 * Dropping is explicit and takes nothing else: a caller that asks for `drop` with
 * any other argument is refused rather than silently interpreted, because "drop
 * and page" has no single meaning.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/result-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { MIN_RESULT_BYTES } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { renderResultPage } from './render.ts'
import { aetherResultId, RESULT_OWNER_CODE, RESULT_PAGE_ARG_CODE } from './results.ts'
import type { AetherResultFormat, AetherResultPageOutcome, AetherResults } from './results.ts'

/** A failure in the vocabulary every AetherShell tool already carries. */
const FAILURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    message: { type: 'string', required: true },
    code: { type: 'string' },
    builtin: { type: 'string' },
    hint: { type: 'string' },
    didYouMean: { type: 'array', items: { type: 'string' } },
    retryable: { type: 'boolean' },
    details: { type: 'json' },
  },
} as const

/** One page of a retained result. */
const PAGE_ARM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'page' },
    id: { type: 'string', required: true, description: 'The retained result this page came from.' },
    format: { type: 'string', required: true, enum: ['items', 'json'], description: 'The format this page was produced in.' },
    unit: { type: 'string', required: true, enum: ['items', 'utf8_bytes'], description: 'The unit offset, shown, total, and nextOffset are counted in.' },
    offset: { type: 'number', required: true, description: 'Index or byte offset of this page\'s first unit.' },
    shown: { type: 'number', required: true, description: 'Units included in this page.' },
    total: { type: 'number', required: true, description: 'Units the complete value holds, in `unit`.' },
    nextOffset: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }], description: 'Offset to pass as the next page\'s offset; null once the value is exhausted.' },
    complete: { type: 'boolean', required: true, description: 'True when this page includes the value\'s last unit.' },
    data: { type: 'json', required: true, description: 'This page\'s content: elements, whole fields, one whole scalar, or an unbroken byte chunk.' },
  },
} as const

/** The receipt for one dropped retained result. */
const DROPPED_ARM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'dropped' },
    id: { type: 'string', required: true },
    dropped: { type: 'boolean', required: true, const: true },
  },
} as const

/** One refused page or drop. */
const ERROR_ARM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'error' },
    error: FAILURE_SCHEMA,
  },
} as const

/** Canonical result of one retrieval. */
const RESULT_OUTCOME_SCHEMA = { oneOf: [PAGE_ARM, DROPPED_ARM, ERROR_ARM] } as const

/** The retrieval tool's own arguments, as the model supplied them. */
interface AetherResultPageArgs {
  readonly id: string
  readonly offset?: number
  readonly limit?: number
  readonly maxBytes?: number
  readonly format?: AetherResultFormat
  readonly drop?: boolean
}

/** The capability services and plugin-owned state the retrieval tool reads. */
export interface AetherResultToolDependencies {
  /** Context supplying the tool registry. */
  readonly ctx: Context
  /** Resolved deployment configuration, supplying the page budget ceiling. */
  readonly config: ResolvedConfig
  /** The store that holds this deployment's retained results. */
  readonly results: AetherResults
}

/**
 * Reject a retrieval id that is not one non-empty opaque token.
 * @param value - the model-supplied id.
 * @returns the id to resolve.
 * @throws Error when the id is blank.
 */
function readId(value: string): string {
  if (value.trim().length === 0) {
    throw new Error(`aether-shell [${RESULT_PAGE_ARG_CODE}]: id must be a non-empty retrieval id, as returned by a retained result`)
  }
  return value
}

/**
 * Reject a page bound that is not a whole number in range.
 * @param name - the argument name as the model wrote it.
 * @param value - the model-supplied number.
 * @param minimum - the smallest value this argument accepts.
 * @returns the validated number.
 * @throws Error when the value is not an integer of at least `minimum`.
 */
function readWhole(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`aether-shell [${RESULT_PAGE_ARG_CODE}]: ${name} must be an integer of at least ${minimum}, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Reject a `drop` request that also carries a page argument.
 * @param args - the model-supplied arguments.
 * @throws Error when any argument other than the id accompanies `drop: true`.
 */
function assertDropShape(args: AetherResultPageArgs): void {
  const extra = (['offset', 'limit', 'maxBytes', 'format'] as const).filter(name => args[name] !== undefined)
  if (extra.length === 0) return
  throw new Error(`aether-shell [${RESULT_PAGE_ARG_CODE}]: drop takes the retrieval id alone, but ${extra.join(', ')} ${extra.length === 1 ? 'was' : 'were'} also given; page the result first or drop it on its own`)
}

/**
 * Build the retrieval tool.
 *
 * Registration is the caller's effect, and the caller registers this tool only
 * where the live-agent registry is mounted, because a retained result is fenced
 * to the exact live Agent that produced it. Disposing the plugin fiber therefore
 * removes the tool together with the store that resolves its ids.
 * @param dependencies - context, resolved configuration, and the retained-result store.
 * @returns the tool definitions in registration order.
 */
export function createAetherResultTools(dependencies: AetherResultToolDependencies): ToolDefinition[] {
  const { config, results } = dependencies

  const page = defineTool({
    name: 'aether_result_page',
    description: 'Page a complete oversized query value by its retained id, without rerunning code/effects. '
      + 'Continue with returned nextOffset (in unit) until complete. Agent-private; idle expiry, drop, owner disposal or plugin/Host shutdown release it. '
      + 'For json pages, concatenate data strings then JSON-parse once; this also retrieves an oversized single item.',
    parameters: {
      id: { type: 'string', required: true, description: 'Retained result id from a query, not a job/session id.' },
      offset: {
        type: 'number',
        description: 'Start offset (default 0); pass back nextOffset, do not calculate it.',
      },
      limit: { type: 'number', description: 'Maximum items/fields or UTF-8 bytes; page budget still applies.' },
      maxBytes: {
        type: 'number',
        description: 'Response byte cap; defaults to maxResultBytes and cannot exceed it.',
      },
      format: { type: 'string', enum: ['items', 'json'], description: 'items (default): whole array elements/record fields. json: canonical JSON in UTF-8 byte chunks.' },
      drop: { type: 'boolean', description: 'Release instead of page; use with id only.' },
    },
    output: {
      schema: RESULT_OUTCOME_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderResultPage(value) }],
      presentationMeta: (_args, value) => value.kind === 'page' || value.kind === 'dropped' ? { resultId: value.id } : undefined,
    },
    async execute(args, exec): Promise<AetherResultPageOutcome> {
      const owner = exec.agent
      if (owner === undefined) {
        throw new Error(`aether-shell [${RESULT_OWNER_CODE}]: a retained result belongs to the agent that produced it, and this call has no calling agent`)
      }
      const id = aetherResultId(readId(args.id))
      if (args.drop === true) {
        assertDropShape(args)
        return results.drop(owner, id)
      }
      const offset = args.offset === undefined ? undefined : readWhole('offset', args.offset, 0)
      const limit = args.limit === undefined ? undefined : readWhole('limit', args.limit, 1)
      const maxBytes = args.maxBytes === undefined ? undefined : readWhole('maxBytes', args.maxBytes, MIN_RESULT_BYTES)
      if (maxBytes !== undefined && maxBytes > config.maxResultBytes) {
        throw new Error(`aether-shell [${RESULT_PAGE_ARG_CODE}]: maxBytes ${maxBytes} is over this deployment's maxResultBytes budget of ${config.maxResultBytes}; omit maxBytes to use that budget`)
      }
      return results.page(owner, {
        id,
        ...offset === undefined ? {} : { offset },
        ...limit === undefined ? {} : { limit },
        ...maxBytes === undefined ? {} : { maxBytes },
        ...args.format === undefined ? {} : { format: args.format },
      })
    },
  })

  return [page]
}
