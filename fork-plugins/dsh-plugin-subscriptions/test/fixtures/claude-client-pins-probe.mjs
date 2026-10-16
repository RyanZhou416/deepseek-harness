/**
 * Observe the Claude ATIS client-pin contracts as sanitized booleans and counts.
 *
 * `probeClaudeClientPins` drives the shipped `fetchClaudeCatalogue` bootstrap read and the shipped
 * `buildClaudeWireRequest` assembly over the real durable continuation owner: the read claims and
 * commits its disclosure through the owner's own capture ticket, a wire observation prepares the
 * span and freezes its pin through the owner's own `prepare`/`freeze`, and the account clear runs
 * through the owner's own `clearAccountCatalog` — the one clear that drops this installation's
 * spans and candidate. The builder is handed exactly the facts the owner produced
 * (`wireSessionId`, `atisPin`, `previousRequestId: undefined`); nothing here mints, looks up or
 * defaults any of them.
 *
 * Everything runs under one private root this probe owns, over a synthetic session and injected
 * fetches that open no socket: `spans.json`, `salt.json` and `identity-generation.json` are this
 * probe's own files, and the observation carries booleans and counts only — never a token, an
 * account key, a wire session id or a credential, not even a synthetic one.
 *
 * A snapshot driver applies this module as a plugin, which registers `claude_client_pins_probe`
 * and records the one JSON observation it returns; the probe stays importable on its own.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ClaudeContinuationState } from '../../src/providers/claude-continuation-state.ts'
import { continuationBudget } from '../../src/providers/claude-continuation-io.ts'
import { fetchClaudeCatalogue } from '../../src/providers/claude.ts'
import { buildClaudeWireRequest } from '../../src/providers/claude-wire.ts'

export const name = 'claude-client-pins-probe'
export const inject = ['tools']

/** Two opaque tokens a read may disclose; module-local so no caller can observe them. */
const PIN_A = 'v1.pin.aaaaaaaa.bbbbbbbb.cccccccc'
const PIN_B = 'v1.pin.dddddddd.eeeeeeee.ffffffff'
/** Disclosures the client rejects: the empty value and the space both leave it no token. */
const PIN_REJECTED = ['', 'not a token']

/** One account key per observed contract, so no observation reaches another's state. */
const ACCOUNT_SPAN = 'pins-account-span'
const ACCOUNT_EMPTY = 'pins-account-empty'
const ACCOUNT_CLEARED = 'pins-account-cleared'
const ACCOUNT_REVOKED = 'pins-account-revoked'

/** The accounts whose identity owner this probe establishes before it observes anything. */
const ACCOUNTS = [ACCOUNT_SPAN, ACCOUNT_EMPTY, ACCOUNT_CLEARED, ACCOUNT_REVOKED]

/** Harness session identities; each names one account span of the observations below. */
const SPAN_1 = '11111111-1111-4111-8111-111111111111'
const SPAN_2 = '22222222-2222-4222-8222-222222222222'
const SPAN_3 = '33333333-3333-4333-8333-333333333333'
const SPAN_4 = '44444444-4444-4444-8444-444444444444'

/** The one endpoint a bootstrap read reaches; anything else is a request this probe never makes. */
const BOOTSTRAP_PATH = '/api/claude_cli/bootstrap'

/** The owner's own budgets; the defaults this plugin resolves. */
const DEADLINE_MS = 1_000
const LOCK_TIMEOUT_MS = 2_000

/** The synthetic account identity every assembled request is built from. */
const SESSION = {
  accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
  expiresAt: Date.now() + 3_600_000, scopes: 'user:inference', subscriptionType: 'max',
  accountUuid: '99999999-9999-4999-8999-999999999999', deviceId: 'a1'.repeat(32),
}

/** The request these observations assemble; text only, so no attachment service is needed. */
const REQUEST = {
  provider: 'claude', model: 'claude-opus-4-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
}

/**
 * Run every client-pin observation over the shipped read, durable owner and wire assembly.
 * @returns the compact sanitized observation the session log records.
 * @throws Error when the owner refuses a preparation or a freeze the observation depends on.
 */
export async function probeClaudeClientPins() {
  const root = await mkdtemp(join(tmpdir(), 'claude-client-pins-'))
  const state = new ClaudeContinuationState({ deadlineMs: DEADLINE_MS, lockTimeoutMs: LOCK_TIMEOUT_MS, root })
  /** How many bootstrap reads and wire assemblies the probe drove. */
  const counts = { bootstrapReads: 0, wireRequests: 0 }
  /** One fresh budget per observation, as one request chain resolves one. */
  const budget = () => continuationBudget(DEADLINE_MS)

  /**
   * One bootstrap read for one account, answering with the offered `client_data.atis`.
   * @param account - the account key the read belongs to.
   * @param atis - the value the document discloses, or undefined to disclose nothing.
   * @param before - work to finish while the read is still in flight.
   */
  const readBootstrap = async (account, atis, before) => {
    counts.bootstrapReads += 1
    const fetchFn = async (url) => {
      if (!String(url).includes(BOOTSTRAP_PATH)) throw new Error('the bootstrap read reached an unexpected endpoint')
      if (before !== undefined) await before()
      return Response.json(atis === undefined ? {} : { client_data: { atis } })
    }
    return await fetchClaudeCatalogue(SESSION, [], fetchFn, undefined, account, undefined, state)
  }

  /**
   * The pin one assembled request actually carries.
   *
   * The span is prepared and its pin frozen through the owner, and the builder is handed that
   * span's own wire identity and frozen pin: a span that already froze keeps its value, and one
   * that has not freezes this account's current candidate.
   * @param account - the account serving the request.
   * @param sessionId - the harness session identity of the request's account span.
   * @returns the `x-cc-atis` value, or the empty string when the request carried none.
   */
  const pinOf = async (account, sessionId) => {
    counts.wireRequests += 1
    const prepared = await state.prepareRequest({
      account, harnessSessionId: sessionId, origin: 'initial', deadline: budget(),
    })
    if (prepared.kind !== 'ready') {
      throw new Error(`the continuation owner refused this span (${prepared.reason})`)
    }
    const frozen = await state.freezeRequest(prepared.prepared, budget())
    if (frozen.kind !== 'frozen') {
      throw new Error(`the continuation owner refused this pin (${frozen.reason})`)
    }
    const built = await buildClaudeWireRequest(
      REQUEST, SESSION, REQUEST.messages, 1024, undefined, undefined,
      {
        sessionId: prepared.prepared.wireSessionId,
        atisPin: frozen.pin.kind === 'token' ? frozen.pin.token : undefined,
        previousRequestId: undefined,
      },
      account,
    )
    const pin = built.headers.find(([header]) => header.toLowerCase() === 'x-cc-atis')
    return pin === undefined ? '' : pin[1]
  }

  try {
    // Every observation is served under an identity the owner established, exactly as the auth
    // lifecycle establishes one before it may change anything.
    for (const account of ACCOUNTS) {
      const established = await state.initialize(account)
      if (established.kind !== 'advanced') {
        throw new Error(`the identity owner could not be established (${established.reason})`)
      }
    }

    // One account: the first read pins its span, and a later read cannot replace that pin.
    await readBootstrap(ACCOUNT_SPAN, PIN_A)
    const firstA = await pinOf(ACCOUNT_SPAN, SPAN_1) === PIN_A
    await readBootstrap(ACCOUNT_SPAN, PIN_B)
    const sameSpanAfterBStillA = await pinOf(ACCOUNT_SPAN, SPAN_1) === PIN_A
    const newSpanB = await pinOf(ACCOUNT_SPAN, SPAN_2) === PIN_B

    // A span frozen before any usable disclosure stays headerless, a rejected disclosure pins
    // nothing, and a later read reaches only a span that has not frozen yet.
    const frozenBeforeAnyRead = await pinOf(ACCOUNT_EMPTY, SPAN_1) === ''
    await readBootstrap(ACCOUNT_EMPTY, PIN_REJECTED[0])
    const emptyDisclosureOmitted = await pinOf(ACCOUNT_EMPTY, SPAN_3) === ''
    await readBootstrap(ACCOUNT_EMPTY, PIN_REJECTED[1])
    const unprintableDisclosureOmitted = await pinOf(ACCOUNT_EMPTY, SPAN_4) === ''
    await readBootstrap(ACCOUNT_EMPTY, PIN_A)
    const emptySpanRemainsOmitted = frozenBeforeAnyRead && await pinOf(ACCOUNT_EMPTY, SPAN_1) === ''
    const lateTokenReachesOnlyNewSpan = await pinOf(ACCOUNT_EMPTY, SPAN_2) === PIN_A

    // The one account clear drops the frozen span that carried a token and the candidate with it.
    await readBootstrap(ACCOUNT_CLEARED, PIN_A)
    const clearedSpanCarriedA = await pinOf(ACCOUNT_CLEARED, SPAN_1) === PIN_A
    await state.clearAccountCatalog(ACCOUNT_CLEARED)
    const clearedSpanOmitted = await pinOf(ACCOUNT_CLEARED, SPAN_1) === ''
    const clearedCandidateOmitted = await pinOf(ACCOUNT_CLEARED, SPAN_3) === ''

    // A clear landing while a read is in flight revokes the ticket that read holds.
    await readBootstrap(ACCOUNT_REVOKED, PIN_B, async () => { await state.clearAccountCatalog(ACCOUNT_REVOKED) })
    const lateBootstrapDiscarded = await pinOf(ACCOUNT_REVOKED, SPAN_1) === ''

    return {
      firstA,
      sameSpanAfterBStillA,
      newSpanB,
      emptySpanRemainsOmitted,
      rejectedDisclosuresOmitted: emptyDisclosureOmitted && unprintableDisclosureOmitted,
      lateTokenReachesOnlyNewSpan,
      clearedAccountOmitted: clearedSpanCarriedA && clearedSpanOmitted && clearedCandidateOmitted,
      lateBootstrapDiscarded,
      ...counts,
    }
  } finally {
    await state.close()
    await rm(root, { recursive: true, force: true })
  }
}

/** Register the deterministic client-pin probe with recorded output. */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'claude_client_pins_probe',
    description: 'Prove the Claude ATIS client pins through the shipped bootstrap read and wire assembly: the first request of an account span freezes the token its newest read disclosed, a later read cannot replace that span\'s pin while a span that has not frozen takes the newer token, a disclosure the client rejects pins nothing, and the public account clear drops frozen spans and revokes a read still in flight.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      return JSON.stringify(await probeClaudeClientPins())
    },
    presentCall: args => ({ card: 'generic', title: 'Inspect Claude client pins', kind: 'other', rawInput: args }),
  })))
}
