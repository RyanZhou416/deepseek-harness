/** Stored log size lookup shared by the cold and live fold caps. */
import type { Context } from '@deepseek-ai/cordis'
import { asRecord } from './record'

/** Stored artifact size of one Session, or undefined when persistence cannot tell. */
export async function storedSizeOf(ctx: Context, sessionId: string): Promise<number | undefined> {
  const persistence = asRecord(ctx.get('sessionPersistence'))
  if (typeof persistence?.stat !== 'function') return undefined
  try {
    const size = asRecord(await (persistence.stat as (id: string) => Promise<unknown>).call(persistence, sessionId))?.sizeBytes
    return typeof size === 'number' && Number.isFinite(size) ? size : undefined
  } catch {
    // An unreadable size leaves the read to the fold path, which reports its own failure.
    return undefined
  }
}
