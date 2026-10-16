/**
 * A recording port for the suites that drive a Claude send without testing
 * recording itself.
 *
 * The adapter refuses to POST without a recorder, so every existing send-path
 * case must state what its recorder answers. Cases that assert the refusal paths
 * live in `claude-wire-record.spec.ts`; the suites here only need the route to
 * reach the wire, and they keep their own assertions unchanged.
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { LlmRequestRecordOutcome } from '@deepseek-ai/dsh-llm-request-record'
import { ClaudeRequestRecordPort } from '../src/providers/claude-wire-record.js'

/** The recorded position this stub reports; the brand is asserted the way the sibling specs brand a session id. */
const PREPARED_ID = 1 as SessionSeq

/** A port that records successfully and reports the same position every time. */
export class PermittingRecordPort extends ClaudeRequestRecordPort {
  /**
   * Accept every attempt.
   * @returns one successful outcome carrying this stub's fixed position.
   */
  override record(): Promise<LlmRequestRecordOutcome> {
    return Promise.resolve({ ok: true, preparedId: PREPARED_ID })
  }
}
