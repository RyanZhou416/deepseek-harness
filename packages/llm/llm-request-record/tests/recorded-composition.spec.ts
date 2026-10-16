/**
 * Durable round trip for the recording seam, with a persistence owner this file
 * states itself.
 *
 * The case mounts a real `SessionStore`, the real provider, and a private
 * persistence listener that writes each session's accepted events to a JSONL file
 * inside a directory the case owns. It then reads that file back and selects one
 * attempt's ordered system text by the `preparedId` the producer got — so the
 * registry answers for a durable read exactly as it does for live events, and two
 * attempts of one conversation are told apart from the bytes on disk rather than
 * from a listener that merely returned true.
 *
 * Nothing here reads a Session's in-memory history: `snapshotEvents`, `ownEvents`
 * and `eventAt` are deprecated for new callers, and this file uses no Session
 * accessor at all after the record is written.
 *
 * The shipped JSONL persistence, a process restart and the keyless recorded
 * snapshot are separate Layer B gates in an isolated copy; this file exercises the
 * same contract with a persistence owner the test states explicitly.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionRequestRecordProvider, { reconstructRequestSystem } from '@deepseek-ai/dsh-llm-request-record'
import type { LlmRequestRecordPayload } from '@deepseek-ai/dsh-llm-request-record'

/** The ordered system text one prepared request emitted. */
const SYSTEM_BLOCKS = ['billing header', 'identity header', 'be terse']

function payload(overrides: Partial<LlmRequestRecordPayload> = {}): LlmRequestRecordPayload {
  return {
    provider: 'claude',
    model: 'claude-opus-5',
    purpose: 'conversation',
    systemBlocks: [...SYSTEM_BLOCKS],
    wireLibrary: '@tormentalabs/claude-code-wire-compat@0.0.0-fixture',
    profile: 'claude-code-2.1.288',
    ...overrides,
  }
}

/**
 * A private durability owner: one JSONL file per case, written at the durability
 * checkpoint rather than at append.
 *
 * This is the shape a persistence plugin has — collect accepted events, publish
 * them on `session/flush` — stated in the test instead of mounting the shipped
 * backend. The write is real, so a read-back proves the record left the process's
 * memory.
 */
class FileRecordingPersistence {
  private readonly accepted = new Map<string, SessionEvent[]>()

  constructor(private readonly file: string) {}

  /**
   * Own the durability of every session in `ctx` for as long as the context lives.
   * @param ctx - the context whose sessions this persistence stores.
   */
  attach(ctx: Context): void {
    ctx.on('session/event', (session, event) => {
      const key = String(session.id)
      const events = this.accepted.get(key) ?? []
      events.push(event)
      this.accepted.set(key, events)
    })
    ctx.on('session/flush', async (session: Session) => {
      const events = this.accepted.get(String(session.id)) ?? []
      await writeFile(this.file, events.map(event => JSON.stringify(event)).join('\n') + (events.length === 0 ? '' : '\n'))
    })
  }
}

/** Whether one parsed JSON line is a logged record this projection selects. */
function isLoggedRecord(value: unknown): value is SessionEvent<'llm/request-record'> {
  if (typeof value !== 'object' || value === null) return false
  if (!('type' in value) || value.type !== 'llm/request-record') return false
  if (!('seq' in value) || typeof value.seq !== 'number') return false
  if (!('data' in value)) return false
  const data = value.data
  return typeof data === 'object' && data !== null
    && 'systemBlocks' in data && Array.isArray(data.systemBlocks)
}

/** Every record the JSONL text carries, in file order. */
function recordsIn(text: string): SessionEvent<'llm/request-record'>[] {
  return text
    .split('\n')
    .filter(line => line.length > 0)
    .map((line): unknown => JSON.parse(line))
    .filter(isLoggedRecord)
}

let context: Context | undefined
let directory: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

async function mount(): Promise<{ ctx: Context; file: string }> {
  directory = await mkdtemp(join(tmpdir(), 'llm-request-record-'))
  const file = join(directory, 'session.jsonl')
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionRequestRecordProvider, { flushTimeoutMs: 2_000 })
  new FileRecordingPersistence(file).attach(ctx)
  context = ctx
  return { ctx, file }
}

describe('recorded composition', () => {
  it('selects one attempt of several from the bytes that reached the file', async () => {
    const { ctx, file } = await mount()
    const session = ctx.sessions.create()

    const first = await ctx.llmRequestRecord.recordPreparedRequest(
      { sessionId: session.id },
      payload({ systemBlocks: ['first attempt'] }),
    )
    const second = await ctx.llmRequestRecord.recordPreparedRequest(
      { sessionId: session.id },
      payload({ systemBlocks: ['second attempt'] }),
    )
    if (!first.ok || !second.ok) throw new Error('both attempts must be recorded')

    const durable = recordsIn(await readFile(file, 'utf8'))
    expect(durable).toHaveLength(2)
    // The producer's own ids address the durable records, one attempt each.
    expect(durable.map(record => record.seq)).toEqual([first.preparedId, second.preparedId])
    expect(reconstructRequestSystem(durable, first.preparedId)).toEqual(['first attempt'])
    expect(reconstructRequestSystem(durable, second.preparedId)).toEqual(['second attempt'])
    // Without an id the projection reads the latest record, which is a default only.
    expect(reconstructRequestSystem(durable)).toEqual(['second attempt'])
    expect(reconstructRequestSystem(durable, second.preparedId)).not.toEqual(
      reconstructRequestSystem(durable, first.preparedId),
    )
  })

  it('writes the complete record the reader depends on', async () => {
    const { ctx, file } = await mount()
    const session = ctx.sessions.create()

    const outcome = await ctx.llmRequestRecord.recordPreparedRequest({ sessionId: session.id }, payload())
    if (!outcome.ok) throw new Error('the attempt must be recorded')

    const durable = recordsIn(await readFile(file, 'utf8'))
    expect(durable).toHaveLength(1)
    expect(durable[0]!.data).toMatchObject({
      v: 1,
      phase: 'prepared',
      provider: 'claude',
      model: 'claude-opus-5',
      purpose: 'conversation',
      systemBlocks: SYSTEM_BLOCKS,
      wireLibrary: '@tormentalabs/claude-code-wire-compat@0.0.0-fixture',
      profile: 'claude-code-2.1.288',
    })
    expect(reconstructRequestSystem(durable, outcome.preparedId)).toEqual(SYSTEM_BLOCKS)
  })

  it('answers a later reader with no live session at all', async () => {
    const { ctx, file } = await mount()
    const session = ctx.sessions.create()
    const outcome = await ctx.llmRequestRecord.recordPreparedRequest({ sessionId: session.id }, payload())
    if (!outcome.ok) throw new Error('the attempt must be recorded')
    await ctx.fiber.dispose()
    context = undefined

    // A reader holding only the persisted bytes still selects by the recorded id.
    const durable = recordsIn(await readFile(file, 'utf8'))
    expect(reconstructRequestSystem(durable, outcome.preparedId)).toEqual(SYSTEM_BLOCKS)
  })
})
