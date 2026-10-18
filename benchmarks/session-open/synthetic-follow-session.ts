/**
 * Deterministic message-bearing current-format Session for follow-level opening
 * benchmarks.
 *
 * The generation is written through the production create/append path in fixed
 * multi-turn batches: every row is a validated current-format row, every batch
 * is one Zstandard frame, and the newest bounded window therefore holds enough
 * append-surface messages for a message-aligned opening page. Deterministic
 * incompressible prompt and reply text keeps the stored artifact above the
 * production small-source cutoff without inflating the event count. The
 * workload uses reviewed constants, one Session id, and one working directory;
 * it contains no recorded Session material.
 */

import { stat } from 'node:fs/promises'
import { scheduler } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import * as SessionStatsPlugin from '@deepseek-ai/dsh-session-stats'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as SessionTurnOutlinePlugin from '@deepseek-ai/dsh-session-turn-outline'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { generationLogPath } from '../../packages/session/session-persistence-jsonl/src/format.ts'
import { installModelSelectionProjection } from '../../packages/api/session-controller/src/model-selection-projection.ts'
import { SYNTHETIC_SESSION_CWD, SYNTHETIC_SESSION_ID } from './session-open.constants.ts'

/** Completed turns persisted together as one physical frame. */
export const FOLLOW_TURNS_PER_FRAME = 8
/** Events one completed turn contributes: boundaries, two messages, and one step. */
export const FOLLOW_EVENTS_PER_TURN = 6

const TIME_ZERO = 1_700_000_000_000
/** Default production history page: the tail window must resolve this many messages. */
const FOLLOW_PAGE_MESSAGES = 50
/** Production default history-window event bound. */
const FOLLOW_WINDOW_EVENTS = 2_000
/** Prompt characters added per turn so the artifact exceeds the small-source cutoff. */
const PROMPT_NOISE_CHARS = 96
/** Reply characters added per turn; enough incompressible text keeps the stored artifact above 2 MiB. */
const REPLY_NOISE_CHARS = 192

/**
 * Deterministic incompressible hex text.
 * @param seed - per-turn seed that keeps every turn's bytes distinct.
 * @param chars - even character count to return.
 * @returns hex characters derived from a fixed xorshift sequence.
 */
function noise(seed: number, chars: number): string {
  let state = Math.imul(seed, 2_654_435_761) >>> 0 || 1
  let text = ''
  while (text.length < chars) {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    text += state.toString(16).padStart(8, '0')
  }
  return text.slice(0, chars)
}

/** Physical and logical facts of one written follow fixture. */
export interface SyntheticFollowSessionWrite {
  readonly path: string
  readonly compressedBytes: number
  readonly events: number
  readonly turns: number
  /** Header frame plus one body frame per persisted turn batch. */
  readonly frames: number
}

/** Six current-format events for one completed Turn with a user and assistant message. */
function turnEvents(turn: number): SessionEvent[] {
  const base = (turn - 1) * FOLLOW_EVENTS_PER_TURN
  const prompt = `prompt ${String(turn)} ${noise(turn, PROMPT_NOISE_CHARS)}`
  const answer = `answer ${String(turn)} ${noise(turn + 1, REPLY_NOISE_CHARS)}`
  return [
    { type: 'turn/start', seq: SessionSeq(base), time: base, data: { turn } },
    { type: 'user/message', seq: SessionSeq(base + 1), time: base + 1, surfaceOp: 'append', data: freezeMessage({
      id: MessageId(`follow-user-${String(turn)}`),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }) },
    { type: 'step/start', seq: SessionSeq(base + 2), time: base + 2, data: { turn, step: 1 } },
    { type: 'assistant/message', seq: SessionSeq(base + 3), time: base + 3, surfaceOp: 'append', data: {
      turn,
      step: 1,
      message: freezeMessage({
        id: MessageId(`follow-assistant-${String(turn)}`),
        role: 'assistant',
        content: [{ type: 'text', text: answer }],
        source: { kind: 'model', provider: 'bench', model: 'bench' },
      }),
      stream: [
        { type: 'chunk', time: base + 2, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { type: 'text-chunks', time0: base + 2, index: 0, dt: [], texts: [answer] },
        { type: 'chunk', time: base + 3, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: answer } } },
        { type: 'chunk', time: base + 3, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ],
    } },
    { type: 'step/end', seq: SessionSeq(base + 4), time: base + 4, data: { turn, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(base + 5), time: base + 5, data: { turn, reason: { kind: 'completed' } } },
  ]
}

/**
 * Write one deterministic message-bearing current generation.
 * @param root - JSONL persistence root that receives the standard Session directory.
 * @param turns - completed turns to encode; each turn contributes six events.
 * @returns physical and logical workload facts.
 */
export async function writeSyntheticFollowSession(
  root: string,
  turns: number,
): Promise<SyntheticFollowSessionWrite> {
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: SessionId(SYNTHETIC_SESSION_ID),
      createdAt: TIME_ZERO,
      cwd: SYNTHETIC_SESSION_CWD,
      isSeeded: false,
    }
    const handle = await ctx.sessionPersistence.create(header)
    try {
      for (let first = 1; first <= turns; first += FOLLOW_TURNS_PER_FRAME) {
        const batch: SessionEvent[] = []
        for (let offset = 0; offset < FOLLOW_TURNS_PER_FRAME && first + offset <= turns; offset += 1) {
          batch.push(...turnEvents(first + offset))
        }
        await handle.append(batch)
      }
    } finally {
      await handle.close()
    }
    const path = generationLogPath(
      root,
      SYNTHETIC_SESSION_CWD,
      SessionId(SYNTHETIC_SESSION_ID),
      SESSION_FORMAT_VERSION,
      'zstd',
    )
    const info = await stat(path)
    return {
      path,
      compressedBytes: info.size,
      events: turns * FOLLOW_EVENTS_PER_TURN,
      turns,
      frames: Math.ceil(turns / FOLLOW_TURNS_PER_FRAME) + 1,
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

/**
 * Read the handwritten generation through the complete-read path, proving it is
 * a valid current generation with the reported events and a message-bearing tail.
 * @param root - JSONL persistence root holding the fixture.
 * @param expected - facts the writer reported.
 */
export async function verifySyntheticFollowSession(
  root: string,
  expected: SyntheticFollowSessionWrite,
): Promise<void> {
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    const handle = await ctx.sessionPersistence.open(SessionId(SYNTHETIC_SESSION_ID), 'read')
    try {
      const read = await handle.read()
      if (read.events.length !== expected.events) {
        throw new Error(
          `follow fixture holds ${String(read.events.length)} events, expected ${String(expected.events)}`,
        )
      }
      for (const [index, event] of read.events.entries()) {
        if (Number(event.seq) !== index) {
          throw new Error(`follow fixture event ${String(index)} has seq ${String(event.seq)}`)
        }
      }
      const tail = read.events.slice(-FOLLOW_WINDOW_EVENTS)
      const messages = tail.filter(event => event.type === 'user/message' || event.type === 'assistant/message')
      if (messages.length < FOLLOW_PAGE_MESSAGES) {
        throw new Error(
          `follow fixture tail holds ${String(messages.length)} messages, `
          + `expected at least ${String(FOLLOW_PAGE_MESSAGES)} for a message-aligned opening page`,
        )
      }
    } finally {
      await handle.close()
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

/** Register the client-visible projection units the real bundles mount. */
async function installFollowProjectionSet(ctx: Context): Promise<void> {
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  ctx.sessionProjections.register(agentPresetProjectionDefinition)
  installModelSelectionProjection(ctx)
  await ctx.plugin(SessionTitleService, {
    fallbackMaxWords: 5,
    fallbackMaxBytes: 40,
    maxTitleBytes: 80,
  })
  await ctx.plugin(SessionStatsPlugin)
  await ctx.plugin(SessionTurnOutlinePlugin)
  await ctx.plugin(TokenMeter)
}

/**
 * Persist one durable complete projection checkpoint for the fixture at `root`
 * through the production projection-cache path, so a fresh process reopens with
 * an exact opening block instead of a deferred read.
 * @param root - root holding the fixture Session that also receives the cache domain.
 * @returns wire projection keys the persisted checkpoint carries.
 */
export async function writeSyntheticFollowProjectionCheckpoint(root: string): Promise<number> {
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await installFollowProjectionSet(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 1_000, writeIntervalMs: 60_000 })
    const stored = await (async () => {
      const handle = await ctx.sessionPersistence.open(SessionId(SYNTHETIC_SESSION_ID), 'read')
      try {
        return {
          header: handle.header,
          inheritedEventCount: handle.inheritedEventCount,
          events: (await handle.read()).events,
        }
      } finally {
        await handle.close()
      }
    })()
    // One complete fold outside measurement; the cache's fail-soft write-back
    // publishes the checkpoint the cache-warm sample reopens.
    ctx.sessionProjectionCache.coldSnapshot(stored.header, stored.inheritedEventCount, stored.events)
    const wireKeys = ctx.sessionProjections.wireKeys()
    const deadline = Date.now() + 10_000
    for (;;) {
      const cached = ctx.sessionProjectionCache.cachedSnapshot(stored.header)
      if (cached !== undefined && wireKeys.every(key => Object.hasOwn(cached.values, key))) {
        return wireKeys.length
      }
      if (Date.now() > deadline) {
        throw new Error('cache-warm fixture did not persist a complete projection checkpoint')
      }
      await scheduler.yield()
    }
  } finally {
    await ctx.fiber.dispose()
  }
}
