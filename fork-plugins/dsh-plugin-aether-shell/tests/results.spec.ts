/**
 * Retained results: ownership, bounds, paging, expiry, and the bound that
 * decides when a value is retained at all.
 *
 * Every case here owns a real cordis context with the real tool registry and the
 * real live-agent registry, and the real page renderer, so a bound is proven
 * against the text the model would actually receive. The clock is injected, so
 * idle expiry is decided by the test rather than by wall time.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { resolveConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { applyResultLimit, RESULT_LIMIT_CODE } from '../src/limit.ts'
import type { AetherRetention } from '../src/limit.ts'
import type { AetherProcessFacts, AetherSandboxFacts, AetherValueOutcome } from '../src/outcome.ts'
import { renderOutcome, renderPage, renderResultPage } from '../src/render.ts'
import { createAetherResultTools } from '../src/result-tools.ts'
import {
  aetherResultId,
  AetherResults,
  RESULT_FOREIGN_CODE,
  RESULT_ITEM_TOO_LARGE_CODE,
  RESULT_NOT_FOUND_CODE,
  RESULT_OWNER_CODE,
  RESULT_PAGE_ARG_CODE,
} from '../src/results.ts'
import type { AetherResultId, AetherResultPage, AetherResultsSettings } from '../src/results.ts'

/** The retrieval id no store ever mints. */
const UNKNOWN_ID = aetherResultId('00000000-0000-4000-8000-000000000000')

/** Default bounds for a suite that is not exercising a cap. */
const OPEN_BOUNDS: AetherResultsSettings = {
  maxResultsPerOwner: 64,
  maxStoredResultBytesPerOwner: 8 * 1024 * 1024,
  maxStoredResultBytes: 32 * 1024 * 1024,
  resultIdleTimeoutMs: 0,
}

/** Process facts of a call that succeeded, which is what retention requires. */
const SUCCEEDED: AetherProcessFacts = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  timeoutMs: 1_000,
  cleanupFailed: false,
}

/** Confinement facts of a call that ran unconfined. */
const UNCONFINED: AetherSandboxFacts = { mode: 'danger-full-access', denied: false }

/** A mounted context plus the store under test. */
interface Fixture {
  readonly ctx: Context
  readonly store: AetherResults
  readonly config: ReturnType<typeof resolveConfig>
  /** Register one live stub agent, which is the exact object ownership is keyed on. */
  agent(id: string): Promise<Agent>
  /** Execute one tool through the real registry. */
  call(name: string, args: unknown, agent: Agent): Promise<ToolExecutionResult>
  dispose(): Promise<void>
}

/**
 * Build one live stub agent over a real session and its own scope context.
 *
 * This mirrors the session suite's stub: the agent is registered in the live
 * registry, so `agents.get(id)` returns that exact object, and its scope is a
 * real fiber that can be disposed to prove a retained result is released with
 * its owner.
 * @param ctx - the mounted context that owns the registration.
 * @param rawId - session identity for the stub.
 * @returns the registered agent.
 */
async function liveAgent(ctx: Context, rawId: string): Promise<Agent> {
  const id = SessionId(rawId)
  const scope = ctx.plugin(() => {})
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    cwd: process.cwd(),
    isSeeded: false,
  })
  const agent = {
    id,
    options: {},
    session,
    status: 'idle' as const,
    ctx: scope.ctx,
  } as Agent
  await ctx.agents.register(agent)
  return agent
}

let fixture: Fixture | undefined

afterEach(async () => {
  const owned = fixture
  fixture = undefined
  await owned?.dispose()
})

/**
 * Mount the real registries, the real renderer, and one store.
 * @param options - retention bounds, plugin configuration overrides, and an injected clock.
 * @returns the mounted fixture.
 */
async function mount(options: {
  settings?: Partial<AetherResultsSettings>
  config?: Config
  now?: () => number
} = {}): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const config = resolveConfig(options.config ?? {})
  const store = new AetherResults({
    config,
    registry: () => ctx.get('agents'),
    renderPage,
    report: () => {},
    ...options.now === undefined ? {} : { now: options.now },
  }, { ...OPEN_BOUNDS, ...options.settings })
  for (const tool of createAetherResultTools({ ctx, config, results: store })) ctx.tools.register(tool)
  const mounted: Fixture = {
    ctx,
    store,
    config,
    agent: id => liveAgent(ctx, id),
    call: (name, args, agent) => ctx.tools.execute({
      callId: ToolCallId(`results-${name}`),
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent,
    }),
    dispose: async () => { await ctx.fiber.dispose() },
  }
  fixture = mounted
  return mounted
}

/** Retain one value, failing loudly when retention was refused. */
function retained(store: AetherResults, owner: Agent, value: JsonValue): AetherResultId {
  const outcome = store.retain(owner, value, 'Fixture')
  if (outcome.kind !== 'stored') throw new Error(`expected retention, got ${outcome.reason}`)
  return aetherResultId(outcome.value.summary.id)
}

/** Narrow one page, failing loudly on anything else. */
function pageOf(value: unknown): AetherResultPage {
  const page = value as AetherResultPage
  if (page.kind !== 'page') throw new Error(`expected a page, got ${JSON.stringify(value)}`)
  return page
}

/** The coded refusal of one outcome, failing loudly when the call succeeded. */
function codeOf(value: unknown): string {
  const outcome = value as { kind?: string; error?: { code?: string } }
  if (outcome.kind !== 'error') throw new Error(`expected a coded refusal, got ${JSON.stringify(value)}`)
  return outcome.error?.code ?? 'missing'
}

/** The rendered text of a coded refusal, empty when the call succeeded. */
function messageOf(value: unknown): string {
  const outcome = value as { kind?: string; error?: { message?: string; hint?: string } }
  if (outcome.kind !== 'error') throw new Error(`expected a coded refusal, got ${JSON.stringify(value)}`)
  return `${outcome.error?.message ?? ''} ${outcome.error?.hint ?? ''}`
}

/** Join the text blocks of one tool result, which is the model-visible output. */
function resultText(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/**
 * Read every item of one retained container by following `nextOffset`.
 * @param store - the store holding the result.
 * @param owner - the owning agent.
 * @param id - the retained result to drain.
 * @returns the concatenated items.
 */
function drainItems(store: AetherResults, owner: Agent, id: AetherResultId): JsonValue[] {
  const items: JsonValue[] = []
  let offset: number | undefined
  for (let step = 0; step < 200; step += 1) {
    const page = pageOf(store.page(owner, { id, ...offset === undefined ? {} : { offset } }))
    if (!Array.isArray(page.data)) throw new Error('expected array page data')
    items.push(...page.data)
    if (page.complete) return items
    if (page.nextOffset === null) throw new Error('an incomplete page must carry a next offset')
    offset = page.nextOffset
  }
  throw new Error('the retained array did not drain within 200 pages')
}

/**
 * Read every byte chunk of one retained value by following `nextOffset`.
 * @param store - the store holding the result.
 * @param owner - the owning agent.
 * @param id - the retained result to drain.
 * @returns the concatenated encoded text.
 */
function drainBytes(store: AetherResults, owner: Agent, id: AetherResultId): string {
  let text = ''
  let offset: number | undefined
  for (let step = 0; step < 200; step += 1) {
    const page = pageOf(store.page(owner, { id, format: 'json', ...offset === undefined ? {} : { offset } }))
    if (typeof page.data !== 'string') throw new Error('expected a byte chunk')
    text += page.data
    if (page.complete) return text
    if (page.nextOffset === null) throw new Error('an incomplete page must carry a next offset')
    offset = page.nextOffset
  }
  throw new Error('the retained value did not drain within 200 pages')
}

/** One array of `count` integers. */
function numbers(count: number): JsonValue[] {
  return Array.from({ length: count }, (_, index) => index)
}

/** One successful value arm, as the retention callback receives it. */
function produced(value: JsonValue, process: AetherProcessFacts = SUCCEEDED): AetherValueOutcome {
  return { kind: 'value', value, resultType: 'Fixture', sandbox: UNCONFINED, process, stderr: { text: '', truncated: false } }
}

describe('aether retained results', () => {
  it('retains an oversized value whole and reports its shape instead of its content', async () => {
    const { store, agent } = await mount()
    const owner = await agent('retain-summary')
    const value = numbers(200)
    const outcome = store.retain(owner, value, 'Array')
    expect(outcome.kind).toBe('stored')
    if (outcome.kind !== 'stored') return
    expect(outcome.value.summary).toMatchObject({
      originalResultType: 'Array',
      bytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
      total: 200,
      unit: 'items',
      complete: true,
      inline: false,
    })
    // Only the shape travels: no element of the value is in the summary.
    expect(Object.keys(outcome.value.summary).sort()).toEqual(['bytes', 'complete', 'id', 'inline', 'originalResultType', 'total', 'unit'])
  })

  it.each(['中', '😀', 'é'])('includes a complete %s at a small byte limit and reaches the final quote', async (scalar) => {
    const mounted = await mount()
    const owner = await mounted.agent('small-byte-limit')
    const id = retained(mounted.store, owner, scalar)
    const bytes = Buffer.byteLength(scalar, 'utf8')
    const part = pageOf(mounted.store.page(owner, { id, format: 'json', offset: 1, limit: bytes }))
    expect(part.data).toBe(scalar)
    expect(part.shown).toBe(bytes)
    expect(part.nextOffset).toBe(1 + bytes)
    const tail = pageOf(mounted.store.page(owner, { id, format: 'json', offset: 1 }))
    expect(tail.data).toBe(`${scalar}"`)
    expect(tail.complete).toBe(true)
    const tooSmall = mounted.store.page(owner, { id, format: 'json', offset: 1, limit: bytes - 1 })
    expect(tooSmall).toMatchObject({ kind: 'error', error: { code: 'E_BAD_ARG' } })
  })

  it('reports JSON format for scalar byte pages even when no format was requested', async () => {
    const mounted = await mount()
    const owner = await mounted.agent('scalar-format')
    const id = retained(mounted.store, owner, '中文')
    expect(pageOf(mounted.store.page(owner, { id }))).toMatchObject({ format: 'json', unit: 'utf8_bytes', data: '"中文"', complete: true })
  })

  it('pages an array by whole elements and reconstructs it exactly', async () => {
    const mounted = await mount({ config: { maxResultBytes: 1_024 } })
    const owner = await mounted.agent('retain-array')
    const value = numbers(400)
    const id = retained(mounted.store, owner, value)
    const first = pageOf(mounted.store.page(owner, { id }))
    expect(first.format).toBe('items')
    expect(first.unit).toBe('items')
    expect(first.offset).toBe(0)
    expect(first.total).toBe(400)
    // A bounded page never returns the whole array, and never splits an element.
    expect(first.shown).toBeGreaterThan(0)
    expect(first.shown).toBeLessThan(400)
    expect(first.complete).toBe(false)
    expect(first.nextOffset).toBe(first.shown)
    expect(first.data).toEqual(value.slice(0, first.shown))
    expect(drainItems(mounted.store, owner, id)).toEqual(value)
  })

  it('pages a record by whole fields and keeps every key', async () => {
    const mounted = await mount({ config: { maxResultBytes: 1_024 } })
    const owner = await mounted.agent('retain-record')
    const value = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`field${index}`, index]))
    const id = retained(mounted.store, owner, value)
    const merged: Record<string, JsonValue> = {}
    let offset: number | undefined
    for (let step = 0; step < 200; step += 1) {
      const page = pageOf(mounted.store.page(owner, { id, ...offset === undefined ? {} : { offset } }))
      if (Array.isArray(page.data) || page.data === null || typeof page.data !== 'object') {
        throw new Error('expected record page data')
      }
      expect(Object.keys(page.data)).toHaveLength(page.shown)
      Object.assign(merged, page.data)
      if (page.complete) break
      if (page.nextOffset === null) throw new Error('an incomplete page must carry a next offset')
      offset = page.nextOffset
    }
    expect(merged).toEqual(value)
  })

  it('refuses one element larger than a page and names the byte format', async () => {
    const mounted = await mount({ config: { maxResultBytes: 1_024 } })
    const owner = await mounted.agent('retain-oversized-item')
    const id = retained(mounted.store, owner, ['z'.repeat(4_000)])
    const outcome = mounted.store.page(owner, { id })
    expect(codeOf(outcome)).toBe(RESULT_ITEM_TOO_LARGE_CODE)
    expect(messageOf(outcome)).toContain('format "json"')
  })

  it('reconstructs a value from json byte pages alone, splitting no character', async () => {
    const mounted = await mount({ config: { maxResultBytes: 1_024 } })
    const owner = await mounted.agent('retain-bytes')
    // Multi-byte characters prove every byte page lands on a character boundary.
    const value = [`h\u00e9llo \u{1f30d} `.repeat(200)]
    const id = retained(mounted.store, owner, value)
    const first = pageOf(mounted.store.page(owner, { id, format: 'json' }))
    expect(first.unit).toBe('utf8_bytes')
    expect(first.total).toBe(Buffer.byteLength(JSON.stringify(value), 'utf8'))
    const text = drainBytes(mounted.store, owner, id)
    expect(text).toBe(JSON.stringify(value))
    expect(JSON.parse(text)).toEqual(value)
  })

  it('refuses a byte offset that lands inside a UTF-8 character', async () => {
    const mounted = await mount()
    const owner = await mounted.agent('retain-mid-character')
    const id = retained(mounted.store, owner, ['h\u00e9llo'])
    // The encoding opens `["h`, so byte 4 continues the two-byte `\u00e9`.
    const outcome = mounted.store.page(owner, { id, format: 'json', offset: 4 })
    expect(codeOf(outcome)).toBe(RESULT_PAGE_ARG_CODE)
    expect(Buffer.from(JSON.stringify(['h\u00e9llo']), 'utf8')[4]).toBeGreaterThanOrEqual(0x80)
  })

  it('pages an empty container as a complete empty page', async () => {
    const mounted = await mount()
    const owner = await mounted.agent('retain-empty')
    const id = retained(mounted.store, owner, [])
    expect(mounted.store.page(owner, { id })).toEqual({
      kind: 'page',
      id,
      format: 'items',
      unit: 'items',
      offset: 0,
      shown: 0,
      total: 0,
      nextOffset: null,
      complete: true,
      data: [],
    })
  })

  it('refuses an offset past the end and accepts one exactly at it', async () => {
    const mounted = await mount()
    const owner = await mounted.agent('retain-offset')
    const id = retained(mounted.store, owner, numbers(3))
    expect(codeOf(mounted.store.page(owner, { id, offset: 4 }))).toBe(RESULT_PAGE_ARG_CODE)
    const atEnd = pageOf(mounted.store.page(owner, { id, offset: 3 }))
    expect(atEnd).toMatchObject({ offset: 3, shown: 0, complete: true, nextOffset: null })
  })

  it('honours a caller limit without exceeding the page budget', async () => {
    const mounted = await mount()
    const owner = await mounted.agent('retain-limit')
    const id = retained(mounted.store, owner, numbers(50))
    const page = pageOf(mounted.store.page(owner, { id, limit: 5 }))
    expect(page.shown).toBe(5)
    expect(page.nextOffset).toBe(5)
    expect(page.complete).toBe(false)
  })

  it('refuses a new result at the per-owner count limit and keeps the results already held', async () => {
    const mounted = await mount({ settings: { maxResultsPerOwner: 2 } })
    const owner = await mounted.agent('retain-count')
    const first = retained(mounted.store, owner, numbers(4))
    retained(mounted.store, owner, numbers(5))
    const refused = mounted.store.retain(owner, numbers(6), 'Array')
    expect(refused.kind).toBe('refused')
    expect(refused.kind === 'refused' ? refused.reason : '').toContain('maxResultsPerOwner')
    // Nothing was evicted to make room.
    expect(pageOf(mounted.store.page(owner, { id: first })).total).toBe(4)
  })

  it('refuses a value over the per-owner byte limit, and one owner past its total', async () => {
    const mounted = await mount({ settings: { maxResultsPerOwner: 64, maxStoredResultBytesPerOwner: 4_096, maxStoredResultBytes: 65_536 } })
    const owner = await mounted.agent('retain-owner-bytes')
    const single = mounted.store.retain(owner, 'y'.repeat(5_000), 'String')
    expect(single.kind).toBe('refused')
    expect(single.kind === 'refused' ? single.reason : '').toContain('maxStoredResultBytesPerOwner limit')
    retained(mounted.store, owner, 'y'.repeat(3_000))
    const over = mounted.store.retain(owner, 'y'.repeat(3_000), 'String')
    expect(over.kind).toBe('refused')
    expect(over.kind === 'refused' ? over.reason : '').toContain('maxStoredResultBytesPerOwner')
  })

  it('refuses a value that would exceed the limit every agent shares', async () => {
    const mounted = await mount({ settings: { maxResultsPerOwner: 64, maxStoredResultBytesPerOwner: 4_096, maxStoredResultBytes: 5_000 } })
    const first = await mounted.agent('retain-global-a')
    const second = await mounted.agent('retain-global-b')
    retained(mounted.store, first, 'y'.repeat(3_000))
    const over = mounted.store.retain(second, 'y'.repeat(3_000), 'String')
    expect(over.kind).toBe('refused')
    expect(over.kind === 'refused' ? over.reason : '').toContain('maxStoredResultBytes')
  })

  it('refuses another agent\'s id and reports an unknown one', async () => {
    const mounted = await mount()
    const owner = await mounted.agent('retain-owner')
    const stranger = await mounted.agent('retain-stranger')
    const id = retained(mounted.store, owner, numbers(8))
    expect(codeOf(mounted.store.page(stranger, { id }))).toBe(RESULT_FOREIGN_CODE)
    expect(codeOf(mounted.store.drop(stranger, id))).toBe(RESULT_FOREIGN_CODE)
    expect(codeOf(mounted.store.page(owner, { id: UNKNOWN_ID }))).toBe(RESULT_NOT_FOUND_CODE)
  })

  it('releases every result an owner held when that owner\'s scope is disposed', async () => {
    const mounted = await mount()
    const owner = await mounted.agent('retain-disposed')
    const id = retained(mounted.store, owner, numbers(8))
    await owner.ctx.fiber.dispose()
    expect(codeOf(mounted.store.page(owner, { id }))).toBe(RESULT_OWNER_CODE)
    expect(mounted.store.retain(owner, numbers(8), 'Array').kind).toBe('refused')
  })

  it('expires an idle result and keeps one that is still being read', async () => {
    let clock = 1_000
    const mounted = await mount({ settings: { resultIdleTimeoutMs: 60_000 }, now: () => clock })
    const owner = await mounted.agent('retain-idle')
    const id = retained(mounted.store, owner, numbers(8))
    clock += 59_000
    expect(pageOf(mounted.store.page(owner, { id })).total).toBe(8)
    // That read refreshed the entry, so a second full interval still resolves.
    clock += 59_000
    expect(pageOf(mounted.store.page(owner, { id })).total).toBe(8)
    clock += 60_001
    expect(codeOf(mounted.store.page(owner, { id }))).toBe(RESULT_NOT_FOUND_CODE)
  })

  it('drops a result on request and reports a second drop as unknown', async () => {
    const mounted = await mount()
    const owner = await mounted.agent('retain-drop')
    const id = retained(mounted.store, owner, numbers(8))
    expect(mounted.store.drop(owner, id)).toEqual({ kind: 'dropped', id, dropped: true })
    expect(codeOf(mounted.store.drop(owner, id))).toBe(RESULT_NOT_FOUND_CODE)
  })

  it('releases every held result when the store is disposed', async () => {
    const mounted = await mount()
    const owner = await mounted.agent('retain-dispose-store')
    const id = retained(mounted.store, owner, numbers(8))
    await mounted.store.dispose()
    expect(codeOf(mounted.store.page(owner, { id }))).toBe(RESULT_OWNER_CODE)
    expect(codeOf(mounted.store.drop(owner, id))).toBe(RESULT_OWNER_CODE)
    // A disposed store accepts nothing, so it can hold no value whose id
    // nothing could resolve.
    const late = mounted.store.retain(owner, numbers(8), 'Array')
    expect(late.kind).toBe('refused')
    expect(late.kind === 'refused' ? late.reason : '').toContain('plugin unloaded')
  })
})

describe('the complete-result bound with retention', () => {
  it('returns a retained arm whose own complete size fits the budget', async () => {
    const mounted = await mount({ config: { maxResultBytes: 1_024 } })
    const owner = await mounted.agent('limit-accepts')
    const outcome = produced('z'.repeat(4_000))
    const limited = applyResultLimit(outcome, renderOutcome(outcome), mounted.config.maxResultBytes, {
      retain: (value) => {
        const stored = mounted.store.retain(owner, value.value, value.resultType)
        if (stored.kind === 'refused') return undefined
        return {
          outcome: {
            kind: 'retained',
            result: stored.value.summary,
            sandbox: value.sandbox,
            process: value.process,
            stderr: value.stderr,
          },
          discard: () => { stored.value.discard() },
        }
      },
    })
    expect(limited.kind).toBe('retained')
    if (limited.kind !== 'retained') return
    const measured = Math.max(Buffer.byteLength(JSON.stringify(limited), 'utf8'), Buffer.byteLength(renderOutcome(limited), 'utf8'))
    expect(measured).toBeLessThanOrEqual(mounted.config.maxResultBytes)
    // The value it points at resolves, and the notice names the check tool.
    const page = pageOf(mounted.store.page(owner, { id: aetherResultId(limited.result.id) }))
    expect(page.total).toBe(Buffer.byteLength(JSON.stringify('z'.repeat(4_000)), 'utf8'))
    expect(renderOutcome(limited)).toContain('aether_result_page')
  })

  it('keeps the coded limit failure when the store refuses the value', async () => {
    const mounted = await mount({ config: { maxResultBytes: 1_024 }, settings: { maxResultsPerOwner: 1 } })
    const owner = await mounted.agent('limit-refused')
    retained(mounted.store, owner, numbers(4))
    const outcome = produced('z'.repeat(4_000))
    const limited = applyResultLimit(outcome, renderOutcome(outcome), mounted.config.maxResultBytes, {
      retain: (value) => {
        const stored = mounted.store.retain(owner, value.value, value.resultType)
        return stored.kind === 'refused' ? undefined : { outcome: { kind: 'retained', result: stored.value.summary, sandbox: value.sandbox, process: value.process, stderr: value.stderr }, discard: () => { stored.value.discard() } }
      },
    })
    expect(limited.kind).toBe('error')
    expect(limited.kind === 'error' ? limited.error.code : '').toBe(RESULT_LIMIT_CODE)
  })

  it('gives back a retained value whose arm still exceeds the budget', async () => {
    const outcome = produced('z'.repeat(4_000))
    let discarded = false
    const retention: AetherRetention = {
      retain: () => ({
        // The interpreter's diagnostic stream survives into the retained arm, so
        // a value whose bulk was that stream cannot be published as a success.
        outcome: {
          kind: 'retained',
          result: { id: 'stub', bytes: 1, total: 1, unit: 'utf8_bytes', complete: true, inline: false },
          sandbox: UNCONFINED,
          process: SUCCEEDED,
          stderr: { text: 'e'.repeat(4_000), truncated: false },
        },
        discard: () => { discarded = true },
      }),
    }
    const limited = applyResultLimit(outcome, renderOutcome(outcome), 1_024, retention)
    // The value was already held, so the unpublished identity is given back
    // rather than left behind for a model that never received it.
    expect(discarded).toBe(true)
    expect(limited.kind).toBe('error')
    expect(limited.kind === 'error' ? limited.error.code : '').toBe(RESULT_LIMIT_CODE)
    expect(limited.kind === 'error' ? limited.error.message : '').toContain('the retained result is')
  })

  it('never retains a failed process, a failure arm, or a call with no retention', async () => {
    let asked = 0
    const retention: AetherRetention = {
      retain: () => { asked += 1; return undefined },
    }
    const failedProcess = produced('z'.repeat(4_000), { ...SUCCEEDED, exitCode: null })
    const error = { kind: 'error', error: { message: 'no', retryable: false }, sandbox: UNCONFINED, process: SUCCEEDED, stderr: { text: '', truncated: false } } as const
    const denied = { kind: 'denied', sandbox: { ...UNCONFINED, denied: true }, process: SUCCEEDED, stderr: { text: '', truncated: false } } as const
    const interrupted = { kind: 'interrupted', timedOut: true, aborted: false, sandbox: UNCONFINED, process: { ...SUCCEEDED, timedOut: true }, stderr: { text: '', truncated: false } } as const
    expect(applyResultLimit(failedProcess, renderOutcome(failedProcess), 1_024, retention).kind).toBe('error')
    for (const outcome of [error, denied, interrupted]) {
      expect(applyResultLimit(outcome, renderOutcome(outcome), 1_024, retention)).toBe(outcome)
    }
    const noRetention = applyResultLimit(produced('z'.repeat(4_000)), renderOutcome(produced('z'.repeat(4_000))), 1_024)
    expect(noRetention.kind).toBe('error')
    expect(asked).toBe(0)
  })

  it('keeps the storage refusal reason and warns against replaying effects', () => {
    const outcome = produced('z'.repeat(4_000))
    const limited = applyResultLimit(outcome, renderOutcome(outcome), 1_024, {
      retain: () => ({ reason: 'maxResultsPerOwner limit reached' }),
    })
    expect(limited.kind).toBe('error')
    if (limited.kind !== 'error') throw new Error('Expected a result-limit failure')
    expect(limited.error.message).toContain('maxResultsPerOwner limit reached')
    expect(limited.error.hint).toContain('do not rerun it automatically')
  })

  it('leaves a result inside the budget untouched', async () => {
    const mounted = await mount()
    const outcome = produced(numbers(4))
    expect(applyResultLimit(outcome, renderOutcome(outcome), mounted.config.maxResultBytes, { retain: () => { throw new Error('retention must not run') } })).toBe(outcome)
  })
})

describe('aether_result_page through the tool registry', () => {
  it('returns a page for the owning agent and refuses every other agent', async () => {
    const mounted = await mount()
    const owner = await mounted.agent('tool-owner')
    const stranger = await mounted.agent('tool-stranger')
    const id = retained(mounted.store, owner, numbers(20))
    const result = await mounted.call('aether_result_page', { id }, owner)
    expect(result.isError).toBe(false)
    const page = pageOf(result.value)
    expect(page.id).toBe(id)
    expect(page.total).toBe(20)
    expect(renderResultPage(page)).toContain(`aether result ${id}`)

    const foreign = await mounted.call('aether_result_page', { id }, stranger)
    expect(foreign.isError).toBe(false)
    expect(codeOf(foreign.value)).toBe(RESULT_FOREIGN_CODE)

    const unknown = await mounted.call('aether_result_page', { id: 'nope' }, owner)
    expect(unknown.isError).toBe(false)
    expect(codeOf(unknown.value)).toBe(RESULT_NOT_FOUND_CODE)
  })

  it('drops a result through the tool and refuses a drop that carries a page argument', async () => {
    const mounted = await mount()
    const owner = await mounted.agent('tool-drop')
    const id = retained(mounted.store, owner, numbers(20))
    const malformed = await mounted.call('aether_result_page', { id, drop: true, offset: 1 }, owner)
    expect(malformed.isError).toBe(true)
    expect(resultText(malformed)).toContain(RESULT_PAGE_ARG_CODE)

    const dropped = await mounted.call('aether_result_page', { id, drop: true }, owner)
    expect(dropped.isError).toBe(false)
    expect(dropped.value).toEqual({ kind: 'dropped', id, dropped: true })
  })

  it('refuses a page budget over the deployment limit and a blank id', async () => {
    const mounted = await mount({ config: { maxResultBytes: 2_048 } })
    const owner = await mounted.agent('tool-args')
    const id = retained(mounted.store, owner, numbers(20))
    const budgeted = await mounted.call('aether_result_page', { id, maxBytes: 4_096 }, owner)
    expect(budgeted.isError).toBe(true)
    expect(resultText(budgeted)).toContain('maxResultBytes')
    const blank = await mounted.call('aether_result_page', { id: '   ' }, owner)
    expect(blank.isError).toBe(true)
    expect(resultText(blank)).toContain(RESULT_PAGE_ARG_CODE)
  })
})

describe('aether retained-result configuration', () => {
  it('resolves explicit retention defaults', () => {
    expect(resolveConfig()).toMatchObject({
      maxResultsPerOwner: 8,
      maxStoredResultBytesPerOwner: 16 * 1024 * 1024,
      maxStoredResultBytes: 64 * 1024 * 1024,
      resultIdleTimeoutMs: 1_800_000,
    })
  })

  it('accepts a disabled expiry and rejects an unusable one', () => {
    expect(resolveConfig({ resultIdleTimeoutMs: 0 }).resultIdleTimeoutMs).toBe(0)
    expect(() => resolveConfig({ resultIdleTimeoutMs: -1 })).toThrow('resultIdleTimeoutMs')
    expect(() => resolveConfig({ resultIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1 })).toThrow('resultIdleTimeoutMs')
  })

  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects unusable maxResultsPerOwner ${value}`, () => {
      expect(() => resolveConfig({ maxResultsPerOwner: value })).toThrow('maxResultsPerOwner')
    })
  }

  for (const field of ['maxStoredResultBytesPerOwner', 'maxStoredResultBytes'] as const) {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      it(`rejects unusable ${field} ${value}`, () => {
        expect(() => resolveConfig({ [field]: value })).toThrow(field)
      })
    }
  }

  it('requires the shared limit to cover one owner\'s limit', () => {
    expect(() => resolveConfig({ maxStoredResultBytesPerOwner: 4_096, maxStoredResultBytes: 2_048 }))
      .toThrow(/must be at least maxStoredResultBytesPerOwner/)
    expect(resolveConfig({ maxStoredResultBytesPerOwner: 4_096, maxStoredResultBytes: 4_096 }).maxStoredResultBytes).toBe(4_096)
  })
})
