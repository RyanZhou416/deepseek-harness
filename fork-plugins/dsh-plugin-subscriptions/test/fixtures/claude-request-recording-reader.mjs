/**
 * Read the prepared-request records an earlier process persisted, in a second OS process.
 *
 * This fixture is a reader and nothing else. It builds no service, opens no writer, starts no
 * turn and reaches no provider: it opens the named Session through the composition's own
 * `sessionPersistence`, lets that reader derive each event's `seq` the way the persistence layer
 * does, projects every `llm/request-record` with `reconstructRequestSystem`, and checks the
 * projected text, the record's own digest and the digest of its text against the records the
 * caller states. It then prints one JSON line per record on stdout and requests a bounded exit.
 *
 * The read begins only after the launcher commits successful startup (`appReady`), and the exit
 * is requested only after the read settled, so no disposal ever waits on I/O this plugin still
 * owns. Every failure is reported on stderr as one line and exits 1; the process never reports a
 * bare boolean in place of the records it actually read.
 */

import z from '@deepseek-ai/schemastery'
import { reconstructRequestSystem, requestRecordDigest } from '@deepseek-ai/dsh-llm-request-record'

export const name = 'claude-request-recording-reader'

/** The persisted log it reads, plus the launcher's start and exit seams. */
export const inject = ['sessionPersistence', 'appReady', 'appExit']

/** What the caller states: which session to read, and the records it must find. */
export const Config = z.object({
  sessionId: z.string().required(),
  expectRecords: z.array(z.object({
    systemBlocks: z.array(z.string()).required().min(1),
    systemDigest: z.string().required(),
  })).required().min(1),
})

/**
 * Read every prepared record of the named Session and check it against the expectation.
 *
 * The read handle is closed on every path, so a refused comparison leaves no open log.
 * @param ctx - composition context carrying the persistence service.
 * @param config - the session id and the records the caller expects, in log order.
 * @returns the real records, as the values a caller may assert on.
 * @throws Error naming the first record whose text, digest or identity disagrees.
 */
async function readRecords(ctx, config) {
  const handle = await ctx.sessionPersistence.open(config.sessionId, 'read')
  try {
    const { events } = await handle.read()
    const records = events.filter(event => event.type === 'llm/request-record')
    if (records.length !== config.expectRecords.length) {
      throw new Error(`${records.length} prepared records are persisted, the caller expects ${config.expectRecords.length}`)
    }
    const preparedIds = new Set()
    const read = []
    for (const [index, record] of records.entries()) {
      const expected = config.expectRecords[index]
      const selected = reconstructRequestSystem(events, record.seq)
      if (selected === undefined) throw new Error(`the log holds no record at preparedId ${record.seq}`)
      if (JSON.stringify(selected) !== JSON.stringify(expected.systemBlocks)) {
        throw new Error(`record ${record.seq} does not carry the expected ordered system text`)
      }
      if (record.data.systemDigest !== expected.systemDigest) {
        throw new Error(`record ${record.seq} carries a digest the caller did not state`)
      }
      if (requestRecordDigest(record.data.systemBlocks) !== record.data.systemDigest) {
        throw new Error(`record ${record.seq} carries a digest its own system text does not satisfy`)
      }
      if (preparedIds.has(record.seq)) throw new Error(`two records share preparedId ${record.seq}`)
      preparedIds.add(record.seq)
      read.push({
        preparedId: record.seq,
        systemBlocks: [...record.data.systemBlocks],
        systemDigest: record.data.systemDigest,
      })
    }
    return read
  } finally {
    await handle.close()
  }
}

/**
 * Run one read and report it on stdout, answering the exit code this process must request.
 * @param ctx - composition context carrying the persistence service.
 * @param config - the session id and the records the caller expects.
 * @returns 0 after the records were printed, 1 after one failure line was written to stderr.
 */
async function run(ctx, config) {
  try {
    const records = await readRecords(ctx, config)
    process.stdout.write(`${JSON.stringify({ pid: process.pid, sessionId: config.sessionId, records: records.length })}\n`)
    for (const record of records) process.stdout.write(`${JSON.stringify(record)}\n`)
    return 0
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`claude-request-recording-reader: ${detail}\n`)
    return 1
  }
}

/**
 * Read once, after successful startup, and request the exit the read earned.
 *
 * `appExit` disposes the tree, so it is requested from a settled read rather than from inside
 * it; the effect's disposal still awaits that read so no late I/O outlives the request.
 * @param ctx - composition context carrying the persistence, ready and exit seams.
 * @param config - the session id and the records the caller expects.
 */
export function apply(ctx, config) {
  let pending
  ctx.effect(() => {
    const cancelReady = ctx.appReady.onReady(() => {
      pending = run(ctx, config)
      void pending.then(code => { ctx.appExit(code) })
    })
    return async () => {
      cancelReady()
      await pending
    }
  }, 'claude-request-recording-reader')
}
