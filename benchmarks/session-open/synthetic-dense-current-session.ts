/**
 * Deterministic dense current-format JSONL Session for history-window benchmarks.
 *
 * The generation is written with the production header and event encoders and
 * the production Zstandard frame encoder: one event occupies one physical row,
 * every row is its own checksummed frame, and the header is the first frame.
 * That is the append-framed layout a runtime generation reaches when its write
 * path persists event-sized batches, and it keeps the index walk and window
 * reads dominated by per-frame work rather than by a few large frames.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { eventLine, toHeaderLine } from '../../packages/session/session-persistence-jsonl/src/format.ts'
import { compressZstdFrame } from '../../packages/session/session-persistence-jsonl/src/zstd.ts'
import {
  SYNTHETIC_SESSION_CWD,
  SYNTHETIC_SESSION_DIRECTORY,
  SYNTHETIC_SESSION_ID,
} from './session-open.constants.ts'
import { SYNTHETIC_CURRENT_FILENAME } from './synthetic-released-v0-session.ts'

const TIME_ZERO = 1_700_000_000_000
/** Compression concurrency bounds prep without reordering the written frames. */
const COMPRESS_CONCURRENCY = 32

/** Physical and logical facts of one written dense current generation. */
export interface SyntheticDenseCurrentSessionWrite {
  readonly path: string
  readonly compressedBytes: number
  readonly logicalBytes: number
  /** Logical events; equals `rows` because every row holds one event. */
  readonly events: number
  readonly rows: number
  /** Header frame plus one body frame per event. */
  readonly frames: number
}

/** Alternating turn boundaries: relationship-valid, one event per physical row. */
function turnEvents(turn: number): readonly SessionEvent[] {
  const start = (turn - 1) * 2
  return [
    { type: 'turn/start', seq: SessionSeq(start), time: start, data: { turn } },
    {
      type: 'turn/end',
      seq: SessionSeq(start + 1),
      time: start + 1,
      data: { turn, reason: { kind: 'completed' } },
    },
  ]
}

async function compressRows(rows: readonly string[]): Promise<Buffer[]> {
  const frames: Buffer[] = []
  for (let index = 0; index < rows.length; index += COMPRESS_CONCURRENCY) {
    const batch = rows.slice(index, index + COMPRESS_CONCURRENCY)
    frames.push(...await Promise.all(batch.map(async row => compressZstdFrame(`${row}\n`))))
  }
  return frames
}

/**
 * Write one dense current-format generation: 2 events per turn, one frame per event.
 * @param root - JSONL persistence root that receives the standard session directory.
 * @param turns - completed turns to encode.
 * @returns physical and logical workload facts.
 */
export async function writeSyntheticDenseCurrentSession(
  root: string,
  turns: number,
): Promise<SyntheticDenseCurrentSessionWrite> {
  const directory = join(root, SYNTHETIC_SESSION_DIRECTORY)
  await mkdir(directory, { recursive: true })
  const path = join(directory, SYNTHETIC_CURRENT_FILENAME)
  const headerLine = `${JSON.stringify(toHeaderLine({
    version: SESSION_FORMAT_VERSION,
    id: SessionId(SYNTHETIC_SESSION_ID),
    createdAt: TIME_ZERO,
    cwd: SYNTHETIC_SESSION_CWD,
    isSeeded: false,
  }))}\n`
  const rows = Array.from({ length: turns }, (_, index) => turnEvents(index + 1))
    .flat()
    .map(event => eventLine(event))
  const bodyFrames = await compressRows(rows)
  const headerFrame = await compressZstdFrame(headerLine)
  const physical = Buffer.concat([headerFrame, ...bodyFrames])
  await writeFile(path, physical)
  return {
    path,
    compressedBytes: physical.byteLength,
    logicalBytes: Buffer.byteLength(headerLine)
      + rows.reduce((total, row) => total + Buffer.byteLength(row) + 1, 0),
    events: rows.length,
    rows: rows.length,
    frames: rows.length + 1,
  }
}

/**
 * Read the handwritten generation back through the complete-read path, proving
 * the fixture is a valid current generation with exactly the reported events.
 * @param root - JSONL persistence root holding the fixture.
 * @param expectedEvents - event count the fixture reports.
 */
export async function verifySyntheticDenseCurrentSession(root: string, expectedEvents: number): Promise<void> {
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    const handle = await ctx.sessionPersistence.open(SessionId(SYNTHETIC_SESSION_ID), 'read')
    try {
      const read = await handle.read()
      if (read.events.length !== expectedEvents) {
        throw new Error(`dense current fixture holds ${String(read.events.length)} events, expected ${String(expectedEvents)}`)
      }
      for (const [index, event] of read.events.entries()) {
        if (Number(event.seq) !== index) {
          throw new Error(`dense current fixture event ${String(index)} has seq ${String(event.seq)}`)
        }
      }
    } finally {
      await handle.close()
    }
  } finally {
    await ctx.fiber.dispose()
  }
}
