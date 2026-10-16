/**
 * One reading of a subscription account's quota, from a single raw source.
 *
 * The raw sources are kept apart because their units are established per source and per
 * field: the `anthropic-ratelimit-unified-*` response headers carry a utilization fraction
 * and an epoch-seconds reset, while the OAuth usage document's windows carry a percent
 * utilization and an ISO reset. A value is normalized once, after its unit is known, and the
 * source, the window kind and the reset encoding ride along so a consumer never infers
 * either.
 *
 * Every entry point here is a pure function of its arguments: no clock is read (callers
 * pass `now`), no state survives a call, and the module imports nothing from the harness,
 * Cordis, the adapters or Node. Reading the header family one member at a time belongs to
 * {@link parseRawFacts}, which is its only reader; the projectors below consume the facts it
 * produced and never touch the response again.
 *
 * @module dsh-plugin-subscriptions/claude-core/quota-observation
 */

/**
 * The read-only header source the raw header parse reads: the one operation a response
 * header object has to offer. `Headers` satisfies it directly, and a caller can hand in any
 * object with the same method. A missing member reads `undefined`.
 */
export interface QuotaHeaderSource {
  /** One response header's value, or `undefined` when the response carried none. */
  get(name: string): string | undefined
}

/** Prefix every member of the unified rate-limit family shares. */
export const CLAUDE_UNIFIED_HEADER_PREFIX = 'anthropic-ratelimit-unified-'

/** Standalone members of the unified family, outside the per-window readings. */
export const CLAUDE_UNIFIED_MEMBER_SUFFIXES = Object.freeze([
  'status',
  'reset',
  'representative-claim',
  'fallback',
  'overage-status',
  'overage-reset',
  'overage-disabled-reason',
  'overage-in-use',
  'overage-scope',
] as const)

/**
 * A window's identity. The provider's own window token is preserved rather than folded into
 * a coarser bucket, so a per-model or overage window is never reported as a whole-account
 * weekly one.
 */
export type ClaudeQuotaWindowKind = '5h' | '7d' | '7d_oi' | 'overage' | 'unknown'

/** Window prefixes the provider meters separately, each with its own readings. */
export const CLAUDE_UNIFIED_WINDOW_PREFIXES: readonly ClaudeQuotaWindowKind[] =
  Object.freeze(['5h', '7d', '7d_oi', 'overage'] as const)

/** The three readings every window prefix carries. */
export const CLAUDE_UNIFIED_WINDOW_SUFFIXES = Object.freeze([
  'utilization',
  'reset',
  'surpassed-threshold',
] as const)

/**
 * The status member's accepted values. An unrecognized token and a missing status member
 * both read `other`, so a standing the response did not state is never presented as
 * `allowed`.
 */
export type ClaudeQuotaStatus = 'allowed' | 'allowed_warning' | 'rejected' | 'other'

/** Which raw source an observation was read from. */
export type ClaudeQuotaSource = 'ratelimit-headers' | 'usage-json'

/**
 * The reset encodings this application validates. `epoch-seconds` is the header family's
 * documented encoding; `iso` is the encoding the usage document's `resets_at` declares.
 * `unknown` means the raw value matched neither, so no instant is reported for it.
 */
export type ClaudeQuotaResetFormat = 'epoch-seconds' | 'iso' | 'unknown'

/**
 * What one strict reading covers, kept apart from the window token because the two answer
 * different questions: two model-scoped weekly windows and the whole-account weekly window
 * can share the token `7d`, and a consumer that decides on `kind` alone would treat a model
 * window as the account's own.
 *
 * `model-family` is the one model dimension this application has evidence for, and only for the
 * flat Sonnet/Opus windows: the source client classifies those by model family, not by a stable
 * model id. `unknown-scope` covers every reading whose applicability is not established — a
 * model window this application cannot name, the overage-included week, and the overage route.
 * It is never equivalent to an account window, so an absent `family` never means `account`.
 */
export type ClaudeQuotaScopeKind = 'account' | 'model-family' | 'unknown-scope'

/**
 * The model family a reading is scoped to, when the source states one.
 *
 * Only the flat `seven_day_opus` / `seven_day_sonnet` windows produce it, and it is a family,
 * never a model id: it says which family window this reading is, not which model a request uses.
 */
export type ClaudeQuotaFamily = 'opus' | 'sonnet'

/**
 * The one shape a strict reading takes. It carries the validated value, the unit the
 * normalization used, what the window covers, and the observation time the caller injected; a
 * field the source did not state, or stated unusably, stays absent rather than defaulting to
 * zero.
 */
export interface ClaudeQuotaObservation {
  /** Raw source this reading came from. */
  source: ClaudeQuotaSource
  /** Window token the source stated. */
  kind: ClaudeQuotaWindowKind
  /** What this reading covers, always stated so a model window is never read as the account's. */
  scopeKind: ClaudeQuotaScopeKind
  /**
   * Model family, and only from a window the source itself classifies by family. No stable model
   * id is reported here, and a display name never becomes one.
   */
  family?: ClaudeQuotaFamily
  /** Percent of the window consumed, normalized exactly once from {@link unit}. */
  normalizedPct: number
  /** Unit {@link normalizedPct} was normalized from, as the source declared it. */
  unit: 'ratio' | 'percent'
  /** Raw encoding of the reset this observation was built from. */
  resetFormat: ClaudeQuotaResetFormat
  /** Epoch milliseconds the window reopens, when the raw value validated. */
  resetsAtMs?: number
  /** Epoch milliseconds this reading was observed, injected by the caller. */
  observedAtMs: number
}

/** One member's read: what the response carried, and the number it parsed to when it was one. */
export interface RawFactMember {
  /**
   * Present when the response answered with a non-blank value. A missing member and a blank
   * one are both `absent`, which is what keeps them distinguishable from a stated zero: a
   * stated zero is present with `parsedNumber: 0`. A stated value that is not a finite number
   * is `invalid`: it exists, and no consumer may read it as a value.
   */
  presence: 'absent' | 'present' | 'present-zero' | 'invalid'
  /** The trimmed value the response answered with, present exactly when the member is present. */
  rawText?: string
  /**
   * The finite number `rawText` parsed to. It is present exactly for `present` and
   * `present-zero`, and its presence is the only validity judgement a consumer needs: an
   * `invalid` member may still carry text, and carries no number.
   */
  parsedNumber?: number
}

/** One window's three raw member readings from the unified header family. */
export interface RawFactWindow {
  /** Window token the readings belong to. */
  window: ClaudeQuotaWindowKind
  /** The `-utilization` member. */
  utilization: RawFactMember
  /** The `-reset` member; its encoding is left to the injected legacy resolver. */
  reset: RawFactMember
  /** The `-surpassed-threshold` member. */
  surpassedThreshold: RawFactMember
}

/** The unified header family read once, with every member this module consumes classified. */
export interface RawFacts {
  /**
   * Standalone members by suffix, keyed exactly as the family names them. `fallback` is the
   * one member whose raw text a projector reads beyond its presence.
   */
  members: Readonly<Record<string, RawFactMember>>
  /** Per-window readings, in `5h`, `7d`, `7d_oi`, `overage` order. */
  windows: readonly RawFactWindow[]
}

/**
 * The reset resolver the legacy projector delegates to. It is a caller-supplied port on
 * purpose: it interprets every encoding the subscription routes' shared reader accepts (a
 * delay, epoch seconds, epoch milliseconds, a Go duration such as `6m0s`, and an
 * HTTP-date), and it lives with the providers' retry readers rather than here.
 * @param rawText - the member's raw text, or `undefined` when the response carried none.
 * @param now - the current epoch milliseconds, for a value that states a delay.
 * @returns epoch milliseconds of the reset, or `undefined` when the value disclosed none.
 */
export type LegacyResetResolver = (rawText: string | undefined, now: number) => number | undefined

/** One window's reading in a legacy report. */
export interface QuotaLegacyWindowReading {
  /** Window token, as the header family names it. */
  window: string
  /** Fraction of the window consumed (0–1), as the provider reported it. */
  utilization?: number
  /** Epoch milliseconds at which the window reopens. */
  resetsAt?: number
  /** Threshold the utilization passed, when the provider sent it. */
  surpassedThreshold?: number
}

/**
 * One account's unified rate-limit report, under the field names the plugin's settings
 * surfaces and account pool already read.
 */
export interface QuotaLegacyState {
  /** The account's standing: `rejected` is the provider refusing its requests. */
  status: ClaudeQuotaStatus
  /** Epoch milliseconds the claiming window reopens. */
  resetsAt?: number
  /** The window claiming the limit, when named. */
  claim?: string
  /** Whether the provider advertised a fallback route past the limit. */
  fallbackAvailable?: boolean
  /** The overage route's own status. */
  overageStatus?: ClaudeQuotaStatus
  /** Epoch milliseconds the overage cap reopens. */
  overageResetsAt?: number
  /** Why overage is unavailable, when the provider said so. */
  overageDisabledReason?: string
  /** Whether this account's requests are currently drawing on paid overage. */
  overageInUse?: boolean
  /** Which budget the overage draws on. */
  overageScope?: string
  /** Per-window readings, in window-prefix order. */
  windows: QuotaLegacyWindowReading[]
  /** Epoch milliseconds this report was read off the response. */
  observedAt: number
}

/**
 * One legacy usage window, under the field names the plugin's usage surfaces and pool
 * consume: a percent (0–100) from the provider's own percent unit, and the window kind its
 * `kind` token maps to.
 */
export interface QuotaWindowSpec {
  /** Window kind: `session` for the short rolling window, `weekly` for the 7-day ones. */
  kind: 'session' | 'weekly' | 'other'
  /** Model display label for a model-specific window, when the response names one. */
  scope?: string
  /** Percent of the window already consumed (0–100). */
  usedPercent: number
  /** Epoch milliseconds at which the window resets, when the provider discloses it. */
  resetsAt?: number
}

/**
 * The top-level window keys the usage document is known to carry. A key outside this set is
 * counted and never named, echoed or copied anywhere: an unrecognized key is the provider's
 * data, not this plugin's to expose.
 */
export const CLAUDE_USAGE_WINDOW_KEYS = Object.freeze([
  'five_hour',
  'seven_day',
  'seven_day_oauth_apps',
  'seven_day_opus',
  'seven_day_sonnet',
  'cinder_cove',
] as const)

/**
 * The usage document's top-level keys this module recognizes. Recognizing a key is not
 * claiming its values are window readings: `limits` is a nested array, and `extra_usage`'s
 * period unit (monthly or per channel) is not established, so no window is produced from it.
 */
export const CLAUDE_USAGE_TOP_LEVEL_KEYS = Object.freeze([
  ...CLAUDE_USAGE_WINDOW_KEYS,
  'extra_usage',
  'limits',
  'seven_day_overage_included',
] as const)

/**
 * A fixed code for a wire member this module could not use. These codes are the complete
 * vocabulary reported to callers; a raw key name, a display name or a raw value never appears
 * in one. Each rejected value increments exactly one code, so the counts are a partition of
 * the rejections and never a double count of the same fact.
 */
export type QuotaParseIssueCode =
  | 'window-shape-invalid'
  | 'percent-missing'
  | 'percent-out-of-range'
  | 'reset-shape-invalid'
  | 'limit-kind-unknown'
  | 'window-key-unsupported'

/** Counts for the wire members an application check rejected, keyed by fixed code. */
export type QuotaParseIssues = Readonly<Partial<Record<QuotaParseIssueCode, number>>>

/** The usage document parsed into legacy windows, plus the strict reading of the same body. */
export interface ClaudeQuotaDocument {
  /** The legacy-compatible window list the usage surfaces render. */
  windows: QuotaWindowSpec[]
  /**
   * Strict per-window observations, present exactly when the caller asked for them. The
   * nested `limits` array wins whenever it carries any entry — the precedence the legacy
   * mapping already used — so one body never yields both a flat and a nested reading.
   */
  strictObservations?: ClaudeQuotaObservation[]
  /**
   * Count of recognized top-level window keys this application could not read: the key held
   * something other than a window object, or held a window object whose `utilization` was
   * missing or not a finite number. A key that is absent or explicitly `null` is not counted,
   * because no window was observed there rather than a window that could not be read.
   */
  rejectedWindowKeys?: number
  /**
   * Count of top-level keys outside {@link CLAUDE_USAGE_TOP_LEVEL_KEYS}. This counter is the
   * only representation of that fact — no `issues` code duplicates it — so `unknownTopLevelKeys`
   * and the counts in {@link issues} are separate totals over different facts.
   */
  unknownTopLevelKeys?: number
  /** Fixed-code counts for values an application check rejected, each counted once. */
  issues?: QuotaParseIssues
}

/** Counters behind {@link ClaudeQuotaDocument.issues}. */
type MutableIssues = Partial<Record<QuotaParseIssueCode, number>>

/** One reading's window token and the scope it covers, with why it could not be classified. */
interface QuotaWindowKind {
  /** The window token. */
  kind: ClaudeQuotaWindowKind
  /** What the token covers for this reading. */
  scopeKind: ClaudeQuotaScopeKind
  /** Explanation for a reading this module could not classify. */
  reason?: string
}

/** One projection of a usage document's windows. */
interface UsageWindowsProjection {
  /** The legacy window list. */
  windows: QuotaWindowSpec[]
  /** Strict observations, present only when the caller asked for them. */
  strictObservations?: ClaudeQuotaObservation[]
  /** Count of window keys that held a value this module could not read. */
  rejectedWindowKeys?: number
}

/** Count one rejected wire value under its fixed code. */
function addIssue(issues: MutableIssues, code: QuotaParseIssueCode): void {
  issues[code] = (issues[code] ?? 0) + 1
}

/**
 * How one member of the header family is read.
 *
 * The family mixes token fields, numeric readings and reset instants, and the same text means
 * different things in each: `allowed` is a valid status token, `1.7861472e9` is a valid epoch
 * seconds reset, and neither is a utilization reading. Classifying by member type is what keeps
 * a stated text member `present` instead of calling it invalid for not being a number.
 */
type RawMemberKind = 'text' | 'numeric' | 'reset'

/** Each standalone member's kind: tokens, reset instants, and the rest are numbers. */
const MEMBER_KINDS: Readonly<Record<string, RawMemberKind>> = Object.freeze({
  status: 'text',
  reset: 'reset',
  'representative-claim': 'text',
  fallback: 'text',
  'overage-status': 'text',
  'overage-reset': 'reset',
  'overage-disabled-reason': 'text',
  'overage-in-use': 'text',
  'overage-scope': 'text',
})

/**
 * Read one member of the header family: the response's value, trimmed, classified once.
 *
 * A missing member (`undefined`) and a blank one are both absent. What a present value then
 * means depends on the member: a numeric reading whose text is not a finite number is `invalid`,
 * while a token or a reset instant is `present` with its text — the projectors decide what such
 * a value is worth, and a token this application does not know is still a token it received.
 * `Number('')` is zero, so blankness is decided before any numeric parse, and a blank member is
 * never a stated zero.
 * @param get - the read-only header source.
 * @param name - the full header name to read.
 * @param kind - how this member's text is read.
 * @returns the member's classification.
 */
function readMember(get: QuotaHeaderSource, name: string, kind: RawMemberKind): RawFactMember {
  const value = get.get(name)
  if (value === undefined) return { presence: 'absent' }
  const rawText = value.trim()
  if (rawText.length === 0) return { presence: 'absent' }
  if (kind === 'text' || kind === 'reset') return { presence: 'present', rawText }
  const parsed = Number(rawText)
  if (!Number.isFinite(parsed)) return { presence: 'invalid', rawText }
  return { presence: parsed === 0 ? 'present-zero' : 'present', rawText, parsedNumber: parsed }
}

/**
 * Read one answered response's unified rate-limit headers, once.
 *
 * Every member this module consumes is read here exactly once, and the read-only source is
 * never consulted again by the projectors below: a caller that projects one set of facts
 * into both the legacy report and the strict observations reads the response a single time.
 * The family's member and window names are closed, so a fact set this function did not
 * produce is a programming error rather than wire input.
 * @param get - the read-only header source; `Headers` satisfies it directly.
 * @returns the classified members and windows.
 * @throws Error when the source does not offer the one read this parse depends on.
 */
export function parseRawFacts(get: QuotaHeaderSource): RawFacts {
  if (typeof get?.get !== 'function') {
    throw new Error('parseRawFacts requires a read-only header source with a get(name) method')
  }
  const members: Record<string, RawFactMember> = {}
  for (const suffix of CLAUDE_UNIFIED_MEMBER_SUFFIXES) {
    // The kind table covers exactly the family's standalone members; a missing entry would mean
    // the member list and the kind table drifted apart, which is a programming error.
    const kind = MEMBER_KINDS[suffix] ?? 'text'
    members[suffix] = readMember(get, `${CLAUDE_UNIFIED_HEADER_PREFIX}${suffix}`, kind)
  }
  const windows: RawFactWindow[] = []
  for (const window of CLAUDE_UNIFIED_WINDOW_PREFIXES) {
    windows.push({
      window,
      utilization: readMember(get, `${CLAUDE_UNIFIED_HEADER_PREFIX}${window}-utilization`, 'numeric'),
      reset: readMember(get, `${CLAUDE_UNIFIED_HEADER_PREFIX}${window}-reset`, 'reset'),
      surpassedThreshold: readMember(get, `${CLAUDE_UNIFIED_HEADER_PREFIX}${window}-surpassed-threshold`, 'numeric'),
    })
  }
  return { members, windows }
}

/**
 * The one standalone member of a fact set, by the name the family uses.
 *
 * The member table is closed and constructed by {@link parseRawFacts}, so a name it does not
 * carry is a programming error in a caller, not a wire condition to tolerate.
 * @param facts - the fact set a header parse produced.
 * @param suffix - the member suffix to read.
 * @returns that member's reading.
 * @throws Error when the fact set does not carry the member.
 */
function memberOf(facts: RawFacts, suffix: (typeof CLAUDE_UNIFIED_MEMBER_SUFFIXES)[number]): RawFactMember {
  const member = facts.members[suffix]
  if (member === undefined) {
    throw new Error(`raw quota facts carry no '${suffix}' member; only parseRawFacts may construct them`)
  }
  return member
}

/**
 * The window readings for one window token.
 * @param facts - the fact set a header parse produced.
 * @param window - the window token to read.
 * @returns that window's readings.
 * @throws Error when the fact set does not carry the window.
 */
function windowOf(facts: RawFacts, window: ClaudeQuotaWindowKind): RawFactWindow {
  const found = facts.windows.find(candidate => candidate.window === window)
  if (found === undefined) {
    throw new Error(`raw quota facts carry no '${window}' window; only parseRawFacts may construct them`)
  }
  return found
}

/**
 * Map a status token to the reported standing. An unrecognized token reads `other`, and so
 * does a missing member: the response stated no standing this application knows, and reading
 * that absence as `allowed` would present a refusal as a healthy account.
 * @param facts - the fact set.
 * @param suffix - the status member to read.
 * @returns the standing to report.
 */
function statusOf(facts: RawFacts, suffix: 'status' | 'overage-status'): ClaudeQuotaStatus {
  const text = memberOf(facts, suffix).rawText
  return text === 'allowed' || text === 'allowed_warning' || text === 'rejected' ? text : 'other'
}

/**
 * Project one read of the unified headers into the plugin's existing report.
 *
 * The reset instant is the injected resolver's answer, not this module's: the legacy
 * surfaces keep every encoding the providers' shared reader accepts (a delay, epoch
 * seconds, epoch milliseconds, a duration, an HTTP-date), and that reader is the one the
 * other subscription routes already use.
 * @param facts - the fact set {@link parseRawFacts} produced.
 * @param deps - the reset resolver, and the observation time for this report.
 * @returns the report, with the fields and values the headers previously produced.
 * @throws Error when the resolver or the observation time is missing or unusable.
 */
export function projectLegacy(
  facts: RawFacts,
  deps: { resolveReset: LegacyResetResolver; now: number },
): QuotaLegacyState {
  if (typeof deps?.resolveReset !== 'function' || !Number.isFinite(deps?.now)) {
    throw new Error('projectLegacy requires a reset resolver and a finite observation time')
  }
  const { resolveReset, now } = deps
  const resetOf = (suffix: (typeof CLAUDE_UNIFIED_MEMBER_SUFFIXES)[number]): number | undefined =>
    resolveReset(memberOf(facts, suffix).rawText, now)
  const windows: QuotaLegacyWindowReading[] = []
  for (const prefix of CLAUDE_UNIFIED_WINDOW_PREFIXES) {
    const read = windowOf(facts, prefix)
    const utilization = read.utilization.parsedNumber
    const resetsAt = resolveReset(read.reset.rawText, now)
    const surpassedThreshold = read.surpassedThreshold.parsedNumber
    if (utilization === undefined && resetsAt === undefined && surpassedThreshold === undefined) continue
    windows.push({
      window: prefix,
      ...utilization === undefined ? {} : { utilization },
      ...resetsAt === undefined ? {} : { resetsAt },
      ...surpassedThreshold === undefined ? {} : { surpassedThreshold },
    })
  }
  const resetsAt = resetOf('reset')
  const claim = memberOf(facts, 'representative-claim').rawText
  const fallback = memberOf(facts, 'fallback').rawText
  const overageResetsAt = resetOf('overage-reset')
  const overageDisabledReason = memberOf(facts, 'overage-disabled-reason').rawText
  const overageInUse = memberOf(facts, 'overage-in-use').rawText
  const overageScope = memberOf(facts, 'overage-scope').rawText
  const overageStatus = memberOf(facts, 'overage-status').rawText
  return {
    status: statusOf(facts, 'status'),
    ...resetsAt === undefined ? {} : { resetsAt },
    ...claim === undefined ? {} : { claim },
    ...fallback === undefined ? {} : { fallbackAvailable: fallback === 'available' },
    ...overageStatus === undefined ? {} : { overageStatus: statusOf(facts, 'overage-status') },
    ...overageResetsAt === undefined ? {} : { overageResetsAt },
    ...overageDisabledReason === undefined ? {} : { overageDisabledReason },
    ...overageInUse === undefined ? {} : { overageInUse: overageInUse === 'true' },
    ...overageScope === undefined ? {} : { overageScope },
    windows,
    observedAt: now,
  }
}

/**
 * The largest epoch-seconds value this application reads as a header reset.
 *
 * `253402300799` is `9999-12-31T23:59:59Z`, the last second of the last four-digit UTC year
 * RFC 3339 spells without extra digits. The bound exists so the strict path never guesses a
 * unit: a value beyond it is not a four-digit-year instant, and a thirteen-digit value is epoch
 * milliseconds rather than seconds, which this path refuses instead of re-interpreting. It is
 * this build's own reading rule — not a deployment setting and not a limit the service states.
 */
export const CLAUDE_QUOTA_MAX_EPOCH_SECONDS = 253_402_300_799

/**
 * Classify a header reset's encoding and convert it, or nothing.
 *
 * The header family writes epoch seconds. A bare non-negative integer inside
 * {@link CLAUDE_QUOTA_MAX_EPOCH_SECONDS} is that encoding and nothing else is: an explicit `0`
 * is `1970-01-01T00:00:00Z` — a stated instant, not an absent one, and its usefulness is the
 * caller's freshness question rather than this parser's — while a decimal, an exponent, a
 * duration, a date and any out-of-range magnitude are left to the legacy resolver, which accepts
 * the encodings this strict path deliberately does not.
 * @param member - the reset member's reading.
 * @returns the epoch milliseconds for the one encoding this path supports, or undefined.
 */
function strictHeaderResetMs(member: RawFactMember): number | undefined {
  const text = member.rawText
  if (text === undefined || !/^\d+$/.test(text)) return undefined
  const seconds = Number(text)
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > CLAUDE_QUOTA_MAX_EPOCH_SECONDS) return undefined
  return seconds * 1_000
}

/**
 * Read the unified headers as strict per-window observations.
 *
 * Only the encoding the header family documents is converted: an `epoch-seconds` reset in the
 * range {@link CLAUDE_QUOTA_MAX_EPOCH_SECONDS} describes becomes epoch milliseconds, once, and
 * nothing else is guessed. A window whose utilization is absent, blank or not a finite number is
 * left out entirely rather than reported as a zero-percent window, and the utilization is
 * normalized exactly once from the fraction the header states.
 *
 * The windows keep their own tokens and observation times: the overage-included week is stored
 * under its own key and gated on a model display list, so it is not the account week and is not
 * merged with it; the overage route states no scope this application established either.
 * @param facts - the fact set {@link parseRawFacts} produced.
 * @param deps - the observation time for this read.
 * @returns one observation per window the response stated usable readings for.
 * @throws Error when the observation time is missing or not finite.
 */
export function projectStrict(facts: RawFacts, deps: { now: number }): ClaudeQuotaObservation[] {
  if (!Number.isFinite(deps?.now)) throw new Error('projectStrict requires a finite observation time')
  const observations: ClaudeQuotaObservation[] = []
  for (const read of facts.windows) {
    const utilization = read.utilization.parsedNumber
    if (utilization === undefined) continue
    const resetsAtMs = strictHeaderResetMs(read.reset)
    observations.push({
      source: 'ratelimit-headers',
      kind: read.window,
      // The session and all-model weekly windows are the authenticated context's own. The other
      // two tokens are not: `7d_oi` is the overage-included week, and `overage` is the paid
      // route, so neither is read as an account window.
      scopeKind: read.window === '5h' || read.window === '7d' ? 'account' : 'unknown-scope',
      normalizedPct: utilization * 100,
      unit: 'ratio',
      resetFormat: resetsAtMs === undefined ? 'unknown' : 'epoch-seconds',
      ...resetsAtMs === undefined ? {} : { resetsAtMs },
      observedAtMs: deps.now,
    })
  }
  return observations
}

/**
 * Map one nested `limits` entry's `kind` token, and what its scope covers.
 *
 * `weekly_all` is the whole account's window; `weekly_scoped` is a model's, and no stable model
 * identity is established for such a row, so it stays `unknown-scope` while keeping the token
 * `7d`. An unrecognized token is `kind: 'unknown'` and is equally unscoped.
 * @param kind - the entry's raw `kind` token, when it stated one.
 * @returns the window token and the scope kind, with a reason for an unclassified token.
 */
function limitKind(kind: string | undefined): QuotaWindowKind {
  if (kind === 'session') return { kind: '5h', scopeKind: 'account' }
  if (kind === 'weekly_all') return { kind: '7d', scopeKind: 'account' }
  if (kind === 'weekly_scoped') return { kind: '7d', scopeKind: 'unknown-scope' }
  return {
    kind: 'unknown',
    scopeKind: 'unknown-scope',
    reason: kind === undefined
      ? 'the limits entry stated no kind'
      : 'the limits entry stated a kind outside session, weekly_all and weekly_scoped',
  }
}

/**
 * Each top-level window key this module turns into a window, what it covers, and the label the
 * adapter already showed for it.
 *
 * A model dimension the key states cannot be read as the account's: only the keys marked
 * `account` are the authenticated context's own windows, and the model-family keys carry the
 * family the source classifies them under rather than any model id. A recognized key absent from
 * this table is not mapped at all: its values are counted under a fixed code and otherwise
 * ignored, because what the key covers is not established.
 */
const TOP_LEVEL_KIND: Readonly<Record<
  string,
  {
    kind: ClaudeQuotaWindowKind
    scopeKind: ClaudeQuotaScopeKind
    family?: ClaudeQuotaFamily
    label?: string
  }
>> = Object.freeze({
  five_hour: { kind: '5h', scopeKind: 'account' },
  seven_day: { kind: '7d', scopeKind: 'account' },
  // These two keys name the model family their window covers, and the usage surfaces show that
  // label. The family is the one the source's own classifier resolves; it is not a model id and
  // not a statement about which model a request uses.
  seven_day_opus: { kind: '7d', scopeKind: 'model-family', family: 'opus', label: 'Opus' },
  seven_day_sonnet: { kind: '7d', scopeKind: 'model-family', family: 'sonnet', label: 'Sonnet' },
})

/** One nested `limits` entry, as far as this module reads it. */
interface RawLimitEntry {
  kind?: unknown
  percent?: unknown
  resets_at?: unknown
  scope?: { model?: { display_name?: unknown } | null } | null
}

/**
 * One reset value read once into the two judgements its consumers need.
 *
 * The document declares ISO 8601 for `resets_at`, and the legacy surfaces have always accepted
 * whatever `Date.parse` reads — an HTTP-date, a slash-separated date, a calendar-invalid ISO
 * string that the runtime normalizes. Both judgements come from this one read, so neither the
 * strict path nor the legacy path re-reads the member or keeps a second rule for it.
 */
interface UsageResetFact {
  /** The value an ISO 8601 reading may use, present only for the subset this application validates. */
  isoInstantMs?: number
  /** The value the legacy surfaces have always read with `Date.parse`. */
  legacyInstantMs?: number
}

/** One window's raw members, before the source's declared units are applied. */
interface RawUsageWindow {
  /** The `utilization` member, as a number when the document stated a finite one. */
  utilization?: number
  /** The raw `resets_at` member, exactly as the document carried it; read once by the caller. */
  resetsAt?: unknown
}

/**
 * The exact ISO 8601 shape an `iso` reading accepts: a calendar date, a wall time, an optional
 * fraction, and a mandatory `Z` or `±HH:MM` offset, so the instant is the same on every host.
 *
 * This is the subset this application validates, not a claim that the service emits only this
 * shape: a value outside it stays `unknown` rather than being guessed at.
 */
const ISO_8601_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** Days in each calendar month, by 1-based month, ignoring leap years. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * Whether a `YYYY-MM-DD` triple is a real calendar date.
 *
 * The runtime normalizes an impossible day (`2026-02-30`) into the next month instead of
 * refusing it, so an ISO reading checks the calendar itself: a date the source could not have
 * meant is not an instant.
 * @param year - the four-digit year.
 * @param month - the 1-based month.
 * @param day - the day of the month.
 * @returns true when the month holds that day.
 */
function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const limit = month === 2 && (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : MONTH_DAYS[month - 1]
  return day <= limit
}

/**
 * Read one top-level window object's members without applying a unit or an encoding.
 *
 * A window that is present but is not an object contributes nothing: the provider stated a
 * window this application cannot read, and zero is not what it stated. The utilization is
 * narrowed on the local itself, so the number a branch builds with is the number that was
 * checked rather than a value re-read behind a boolean.
 * @param value - the raw member.
 * @returns the window's raw members, or undefined when the value is not a window object.
 */
function readUsageWindow(value: unknown): RawUsageWindow | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as { utilization?: unknown; resets_at?: unknown }
  const utilization = record.utilization
  return {
    ...typeof utilization === 'number' && Number.isFinite(utilization) ? { utilization } : {},
    ...record.resets_at === undefined ? {} : { resetsAt: record.resets_at },
  }
}

/**
 * Read one usage document `resets_at` into both judgements.
 *
 * A member the document did not state — the key absent, or explicitly `null` — is absent
 * information, not a malformed value, so it counts nothing and reports no instant: a missing
 * reset is never turned into a fabricated date or zero. A value that is present and unusable (a
 * number, a blank string, any other type, or text nothing can parse) counts once under the fixed
 * code and reports no instant either.
 *
 * The value is never read as a number of seconds here: the nested `limits` array's model-scoped
 * branch converts a numeric reset from seconds in the source client, and that branch does not
 * generalize to these fields.
 * @param value - the raw `resets_at` member.
 * @param issues - the counter sink for a malformed reset.
 * @returns the strict ISO instant, the legacy parseable instant, or neither.
 */
function readUsageReset(value: unknown, issues: MutableIssues): UsageResetFact {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'string' || value.length === 0) {
    addIssue(issues, 'reset-shape-invalid')
    return {}
  }
  const parseable = Date.parse(value)
  const legacy = Number.isFinite(parseable) ? { legacyInstantMs: parseable } : {}
  if (legacy.legacyInstantMs === undefined) addIssue(issues, 'reset-shape-invalid')
  const match = ISO_8601_INSTANT.exec(value)
  if (match === null) return legacy
  const [, year, month, day] = match
  if (!isCalendarDate(Number(year), Number(month), Number(day))) return legacy
  const instant = Date.parse(value)
  return Number.isFinite(instant) ? { isoInstantMs: instant, legacyInstantMs: instant } : legacy
}

/** Map a nested entry's window kind to the legacy window vocabulary. */
function legacyKind(kind: ClaudeQuotaWindowKind): QuotaWindowSpec['kind'] {
  if (kind === '5h') return 'session'
  if (kind === '7d') return 'weekly'
  return 'other'
}

/**
 * Read the nested `limits` array.
 *
 * A percent outside 0–100 still becomes a legacy window, because the legacy list only ever
 * required a finite number and never enforced the range: the application's range check decides
 * whether a strict observation is `known`, not whether the window exists. The source declares
 * that range and enforces none, so this check is the application's own and is not a claim about
 * the service.
 *
 * A `weekly_scoped` row carries only a display name, which is not a stable model identity: the
 * strict reading keeps its token and stays `unknown-scope` rather than binding the row to a
 * model. Each row is projected on its own, so two rows that share a label, a reset or an
 * unknown scope remain two readings.
 * @param value - the raw `limits` member.
 * @param now - the observation time.
 * @param issues - the counter sink for rejected values.
 * @param wantsStrict - whether to also project strict observations.
 * @returns the projection, or undefined when the array carried no entry at all.
 */
function parseLimits(
  value: unknown,
  now: number,
  issues: MutableIssues,
  wantsStrict: boolean,
): UsageWindowsProjection | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const windows: QuotaWindowSpec[] = []
  const observations: ClaudeQuotaObservation[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) {
      addIssue(issues, 'window-shape-invalid')
      continue
    }
    const entry = raw as RawLimitEntry
    if (typeof entry.percent !== 'number' || !Number.isFinite(entry.percent)) {
      addIssue(issues, 'percent-missing')
      continue
    }
    const inRange = entry.percent >= 0 && entry.percent <= 100
    if (!inRange) addIssue(issues, 'percent-out-of-range')
    const { kind, scopeKind, reason } = limitKind(typeof entry.kind === 'string' ? entry.kind : undefined)
    if (wantsStrict && reason !== undefined && inRange) addIssue(issues, 'limit-kind-unknown')
    const named = entry.scope?.model?.display_name
    const display = typeof named === 'string' && named.length > 0 ? named : undefined
    const reset = readUsageReset(entry.resets_at, issues)
    windows.push({
      // The legacy label stays exactly as the response spelled it: it is the display name the
      // usage surfaces show, and it is not used to bind this row to a model. The legacy instant
      // is what `Date.parse` has always read, so this window is unaffected by the stricter ISO
      // validation the reading below applies.
      kind: legacyKind(kind),
      ...display === undefined ? {} : { scope: display },
      usedPercent: entry.percent,
      ...reset.legacyInstantMs === undefined ? {} : { resetsAt: reset.legacyInstantMs },
    })
    if (!wantsStrict || !inRange) continue
    observations.push({
      source: 'usage-json',
      kind,
      scopeKind,
      normalizedPct: entry.percent,
      unit: 'percent',
      resetFormat: reset.isoInstantMs === undefined ? 'unknown' : 'iso',
      ...reset.isoInstantMs === undefined ? {} : { resetsAtMs: reset.isoInstantMs },
      observedAtMs: now,
    })
  }
  return {
    windows,
    ...wantsStrict ? { strictObservations: observations } : {},
  }
}

/**
 * Read the flat top-level window keys.
 *
 * Three states are held apart, because the source client treats them differently and a
 * consumer must not read one as another:
 *
 * - The key is absent, or the document stated `null` for it: no window was observed. Nothing is
 *   counted and no reading is produced — an unavailable window is not a malformed one, and a
 *   synthesized zero would misreport it as an untouched window.
 * - The key holds an object whose `utilization` is missing or not a finite number: the document
 *   stated a window this application cannot read. That is counted once under a fixed code and
 *   produces no reading; it is never read as zero percent.
 * - The key holds a number: the window exists, and the rules below apply. The legacy window
 *   appears whenever that number is finite — the range has never been its requirement, so an
 *   out-of-range value still renders as the source stated it — while a strict reading
 *   additionally needs a percent inside 0–100 and an ISO-qualified reset, because it is the
 *   reading a consumer may act on.
 *
 * A key that names no window this application produces at all (`seven_day_oauth_apps`,
 * `cinder_cove`) is counted under its own fixed code and otherwise ignored. A key that names a
 * model family reports that family and never an account scope, and the family says which family
 * window this is, not which model a request should use.
 * @param document - the parsed usage document.
 * @param now - the observation time.
 * @param issues - the counter sink for rejected values.
 * @param wantsStrict - whether to also project strict observations.
 * @returns the projection.
 */
function parseFlatWindows(
  document: Record<string, unknown>,
  now: number,
  issues: MutableIssues,
  wantsStrict: boolean,
): UsageWindowsProjection {
  const windows: QuotaWindowSpec[] = []
  const observations: ClaudeQuotaObservation[] = []
  let rejectedWindowKeys = 0
  for (const key of CLAUDE_USAGE_WINDOW_KEYS) {
    if (!Object.hasOwn(document, key)) continue
    const named = TOP_LEVEL_KIND[key]
    if (named === undefined) {
      // Recognized, and deliberately not turned into a window: a synthesized unit or period
      // would claim more than the source established.
      addIssue(issues, 'window-key-unsupported')
      rejectedWindowKeys += 1
      continue
    }
    const read = readUsageWindow(document[key])
    if (read === undefined) continue
    if (read.utilization === undefined) {
      rejectedWindowKeys += 1
      addIssue(issues, 'percent-missing')
      continue
    }
    const inRange = read.utilization >= 0 && read.utilization <= 100
    if (!inRange) addIssue(issues, 'percent-out-of-range')
    // The legacy label names the model family the key covers, and the surfaces keep showing it;
    // the strict reading reports the family itself and never treats the label as an identity.
    const reset = readUsageReset(read.resetsAt, issues)
    windows.push({
      kind: legacyKind(named.kind),
      ...named.label === undefined ? {} : { scope: named.label },
      usedPercent: read.utilization,
      ...reset.legacyInstantMs === undefined ? {} : { resetsAt: reset.legacyInstantMs },
    })
    if (!wantsStrict || !inRange) continue
    observations.push({
      source: 'usage-json',
      kind: named.kind,
      scopeKind: named.scopeKind,
      ...named.family === undefined ? {} : { family: named.family },
      normalizedPct: read.utilization,
      unit: 'percent',
      resetFormat: reset.isoInstantMs === undefined ? 'unknown' : 'iso',
      ...reset.isoInstantMs === undefined ? {} : { resetsAtMs: reset.isoInstantMs },
      observedAtMs: now,
    })
  }
  return {
    windows,
    ...wantsStrict ? { strictObservations: observations } : {},
    ...rejectedWindowKeys === 0 ? {} : { rejectedWindowKeys },
  }
}

/**
 * Parse an OAuth usage document into the plugin's legacy windows, and optionally into strict
 * observations of the same body.
 *
 * The nested `limits` array wins whenever it carries any entry; the flat
 * `five_hour`/`seven_day*` buckets are read only when it does not, so one body never
 * produces two sets of windows for the same quota. Every check here is the application's
 * own: the source client declares but does not enforce a 0–100 percent or an ISO reset, so a
 * value outside those is what the application rejects for a strict reading — the legacy list
 * keeps the window a finite number produced, exactly as it did before this check existed — and
 * a member the document did not state leaves its field absent rather than defaulting to zero.
 *
 * A key this module does not recognize is counted, never named: the returned record carries
 * only fixed codes and counts, so no provider key or display name reaches a log or an
 * observation through it. Every strict reading is projected from its own source element, so two
 * model windows that share a label, a reset or an unknown scope stay two readings.
 * @param body - the parsed usage document, or any other JSON value.
 * @param now - the current epoch milliseconds, for each observation's `observedAtMs`.
 * @param options - set `strictObservations` to also project the strict reading.
 * @returns the legacy windows, and the strict observations when they were requested.
 */
export function parseUsageJson(
  body: unknown,
  now: number,
  options?: { strictObservations?: boolean },
): ClaudeQuotaDocument {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { windows: [] }
  const document = body as Record<string, unknown>
  const issues: MutableIssues = {}
  let unknownTopLevelKeys = 0
  for (const key of Object.keys(document)) {
    if ((CLAUDE_USAGE_TOP_LEVEL_KEYS as readonly string[]).includes(key)) continue
    unknownTopLevelKeys += 1
  }
  const wantsStrict = options?.strictObservations === true
  const projection = parseLimits(document.limits, now, issues, wantsStrict)
    ?? parseFlatWindows(document, now, issues, wantsStrict)
  const counted = Object.keys(issues).length === 0 ? undefined : issues
  return {
    windows: projection.windows,
    ...projection.strictObservations === undefined ? {} : { strictObservations: projection.strictObservations },
    ...projection.rejectedWindowKeys === undefined ? {} : { rejectedWindowKeys: projection.rejectedWindowKeys },
    ...unknownTopLevelKeys === 0 ? {} : { unknownTopLevelKeys },
    ...counted === undefined ? {} : { issues: counted },
  }
}
