import { Context } from '@deepseek-ai/cordis'
import { SessionId, TOOL_OUTCOME_UNKNOWN_TEXT, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { generationLogPath } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe.each(['none', 'zstd'] as const)('V3 error-turn tool migration (%s)', (compression) => {
  it('reads without publication, then publishes and reopens a verified V4 successor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-v3-error-tool-'))
    roots.push(root)
    const id = SessionId('failed-tool')
    const path = generationLogPath(root, undefined, id, 3, compression)
    const header = { type: 'session', version: 3, id, createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const rows = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message', surfaceOp: 'append', data: {
          turn: 1, step: 1,
          message: {
            id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
            content: [{ type: 'tool-call', id: 'call-1', name: 'pwsh', arguments: '{}' }],
          },
          stream: [],
        },
      },
      { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'pwsh', arguments: '{}' } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'failed', code: 'UNKNOWN' } } } },
    ].map((event, seq) => ({ ...event, seq, time: seq + 2 }))
    const first = JSON.stringify(header) + '\n'
    const body = rows.map(row => JSON.stringify(row) + '\n').join('')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, compression === 'none' ? first + body
      : Buffer.concat([await compressZstdFrame(first), await compressZstdFrame(body)]))
    const original = await readFile(path)

    async function mount(): Promise<Context> {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root, compression })
      return ctx
    }

    const ctx = await mount()
    const reader = await ctx.sessionPersistence.open(id, 'read')
    let prepared: readonly SessionEvent[]
    try {
      prepared = (await reader.read()).events
      expect(reader.header.version).toBe(4)
    } finally {
      await reader.close()
    }
    expect(prepared).toHaveLength(rows.length + 1)
    expect(prepared[4]).toMatchObject({
      type: 'tool/result', seq: 4, sourceEventSeqs: [3],
      data: {
        error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
        message: { role: 'tool', content: [{ type: 'text', text: TOOL_OUTCOME_UNKNOWN_TEXT }] },
      },
    })
    expect(await readFile(path)).toEqual(original)
    expect(await readdir(dirname(path))).toEqual([compression === 'none' ? 'session.v3.jsonl' : 'session.v3.jsonl.zstd'])

    const writer = await ctx.sessionPersistence.open(id, 'write')
    try { expect((await writer.read()).events).toEqual(prepared) } finally { await writer.close() }
    expect(await readFile(path)).toEqual(original)
    expect((await readdir(dirname(path))).filter(name => name !== 'session.lock').sort()).toEqual([
      compression === 'none' ? 'session.v3.jsonl' : 'session.v3.jsonl.zstd',
      compression === 'none' ? 'session.v4.jsonl' : 'session.v4.jsonl.zstd',
    ])

    const reopened = await mount()
    const current = await reopened.sessionPersistence.open(id, 'read')
    try { expect((await current.read()).events).toEqual(prepared) } finally { await current.close() }
    expect(await readFile(path)).toEqual(original)
  })
})
