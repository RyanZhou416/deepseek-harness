/**
 * The private route facts a Claude probe request declares.
 *
 * The shipped `ClaudeAdapter` refuses a request that names no session — every prepared Messages
 * request is recorded in that session's log — and refuses an account whose identity generation was
 * never established, so a probe that drives the adapter directly must state both. This module
 * opens that composition once per probe, out of the Host's own pieces and out of nothing the
 * application is using:
 *
 *  - the Host's real `SessionStore` and `SessionRequestRecordProvider`, so the recording gate is
 *    answered by a real append and a real durability checkpoint rather than by a stub;
 *  - one session created in that store, whose id is the `sessionId` the probe's requests declare;
 *  - the real `ClaudeContinuationState` over a temporary root this module removes.
 *
 * The store is private, so no record of a probe's request enters the application's own session
 * log, and the flush listener participates in memory: `SessionStore.flush` reports a durability
 * checkpoint only when a listener participates, and the recorded bytes are not what a probe
 * observes. A failed mount releases everything it opened before reporting the failure.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionRequestRecordProvider from '@deepseek-ai/dsh-llm-request-record'
import { ClaudeContinuationState } from '../../src/providers/claude-continuation-state.ts'
import { ClaudeRequestRecordPort } from '../../src/providers/claude-wire-record.ts'

/**
 * Open the private composition one probe's Claude requests declare their durable facts through.
 * @param prefix - the temporary-directory prefix naming the probe that owns this composition.
 * @param accounts - the canonical account keys the probe serves; each is established before any
 *   request is driven.
 * @returns the session id the probe's requests declare, the continuation owner and the bound
 *   record port the adapter is built with, and a repeat-safe `close` releasing all three.
 */
export async function ownedClaudeRequest(prefix, accounts) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const state = new ClaudeContinuationState({ root, deadlineMs: 1_000, lockTimeoutMs: 2_000 })
  const ctx = new Context()
  // Every caller awaits the one disposal this composition started, so a second close is safe and
  // the root is removed even when only the mount failed.
  let closing
  const close = () => {
    closing ??= (async () => {
      await ctx.fiber.dispose()
      await state.close()
      await rm(root, { recursive: true, force: true })
    })()
    return closing
  }
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionRequestRecordProvider, { flushTimeoutMs: 2_000 })
    ctx.on('session/flush', () => {})
    const session = ctx.sessions.create()
    for (const account of accounts) {
      const advanced = await state.initialize(account)
      if (advanced.kind !== 'advanced') {
        throw new Error(`the identity generation of ${account} was not established`)
      }
    }
    // `ctx.get` is the optional-service accessor: the port needs the recorder this composition
    // mounts, so a missing one is refused here rather than as an unrecordable send.
    const recorder = ctx.get('llmRequestRecord')
    if (recorder === undefined) {
      throw new Error('the private composition mounted no recording service')
    }
    const requestRecord = new ClaudeRequestRecordPort()
    requestRecord.bind(recorder)
    return { sessionId: session.id, continuation: state, requestRecord, close }
  } catch (error) {
    // A mount that failed after its context exists still releases what it opened; a close that
    // also fails is reported beside that failure instead of replacing it.
    const cleanup = await close().then(() => undefined, (failed) => failed)
    if (cleanup !== undefined) {
      throw new AggregateError([error, cleanup], 'the private composition did not open and its close also failed')
    }
    throw error
  }
}
