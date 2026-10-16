/**
 * The `policy_limits` document: its pinned envelope schema, the canonical validator hashed
 * over the raw body, and the bounded in-memory cache the reader adopts into.
 *
 * Everything here is a pure function over inputs the caller supplies. Nothing in this
 * module performs I/O, reads a credential, chooses an account or keeps a raw document on
 * disk: the caller injects the raw body, and the only thing retained is the derived
 * document plus its validator.
 */

import { coreFailure } from './failures.js'
import type { CoreFailure } from './failures.js'

/** One key's server verdict. */
export interface PolicyRestriction {
  readonly allowed: boolean
}

/** The document the pinned envelope describes. */
export interface PolicyLimitsDocument {
  /** Per-key verdicts; the envelope requires this member. */
  readonly restrictions: Readonly<Record<string, PolicyRestriction>>
  /** Compliance taints, normalized and deduplicated. */
  readonly complianceTaints: readonly string[]
  /** Monitoring notice, or `null` when the server stated none. */
  readonly monitoringNotice: { readonly text: string; readonly url: string | null } | null
  /** Default values; a non-empty map makes every verdict unsettled. */
  readonly defaults: Readonly<Record<string, unknown>>
  /** Bundled core skill names. */
  readonly coreSkills: readonly string[]
  /** Whether normalization dropped at least one taint the server sent. */
  readonly lossyComplianceTaints: boolean
}

/** What one parse produced. */
export type PolicyDocumentParse =
  | { readonly ok: true; readonly document: PolicyLimitsDocument }
  | { readonly ok: false; readonly failure: CoreFailure }

/** The pinned taint limit. */
const TAINT_LIMIT = 16

/** The pinned taint shape. */
const TAINT_PATTERN = /^[a-z0-9_-]{1,64}$/

/** The pinned monitoring-notice bounds. */
const NOTICE_TEXT_LIMIT = 500
const NOTICE_URL_LIMIT = 2048

/** The escape introducer and the C1 Control Sequence Introducer, in either of which a sequence starts. */
const ESCAPE = 0x1b
const CSI = 0x9b
/** The two string terminators: BEL and the C1 String Terminator. */
const BEL = 0x07
const STRING_TERMINATOR = 0x9c
/** The single-character introducers whose argument runs to a string terminator. */
const STRING_INTRODUCERS: ReadonlySet<number> = new Set([0x50, 0x58, 0x5d, 0x5e, 0x5f])

/**
 * Advance past one control sequence that ends at its final byte in `0x40`–`0x7E`.
 * @param text - the text being scanned.
 * @param from - the index after the introducer.
 * @returns the index after the sequence, or the end of the text when it is unterminated.
 */
function afterControlSequence(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) return index + 1
  }
  return text.length
}

/**
 * Advance past one string sequence (OSC, DCS, SOS, PM, APC), which ends at BEL or an ST.
 * @param text - the text being scanned.
 * @param from - the index after the introducer.
 * @returns the index after the sequence, or the end of the text when it is unterminated.
 */
function afterStringSequence(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === BEL || code === STRING_TERMINATOR) return index + 1
    if (code === ESCAPE && text.charCodeAt(index + 1) === 0x5c) return index + 2
  }
  return text.length
}

/**
 * Remove the terminal escape sequences from one string.
 *
 * The pinned text sanitizer runs the runtime's `stripANSI` before it drops the Unicode
 * classes below. That builtin is a runtime property, not part of the fixed raw, so this is
 * the one step whose source the extraction could not pin; it removes the same CSI/SGR, OSC
 * and other escape sequences a terminal would act on instead of leaving their printable
 * tails behind.
 * @param text - the raw text.
 * @returns the text without escape sequences.
 */
function stripEscapeSequences(text: string): string {
  let kept = ''
  let index = 0
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (code === CSI) {
      index = afterControlSequence(text, index + 1)
      continue
    }
    if (code !== ESCAPE) {
      kept += text[index]
      index += 1
      continue
    }
    const next = text.charCodeAt(index + 1)
    if (next === 0x5b) {
      index = afterControlSequence(text, index + 2)
      continue
    }
    if (STRING_INTRODUCERS.has(next)) {
      index = afterStringSequence(text, index + 2)
      continue
    }
    // A bare escape introducer is dropped here; the class strip below would drop it anyway.
    index += 1
  }
  return kept
}

/** A lone surrogate code unit, which the sanitizer first replaces with U+200B. */
const LONE_SURROGATE_PATTERN = /\p{Cs}/gu

/** The emoji joiners the pinned sanitizer is told to keep: ZWJ, VS15 and VS16. */
const EMOJI_JOINER_CLASS = '\\u200D\\uFE0E\\uFE0F'

/**
 * The classes the pinned sanitizer removes, as one run: control, format, surrogate,
 * private-use and unassigned code points, the two line separators, the braille blank and
 * every `Default_Ignorable_Code_Point`.
 */
const STRIPPED_CLASS = '\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}\\u2028\\u2029\\p{Default_Ignorable_Code_Point}\\u2800'

/**
 * A run of stripped characters that are not themselves emoji joiners.
 *
 * The lookahead is on the character the run consumes, so the three joiners are excluded from
 * every run and survive it: that is what `keepEmojiJoiners` buys, and it is why a ZWJ inside an
 * emoji sequence is not cut out of it.
 */
const STRIPPED_RUN_PATTERN = new RegExp(`(?:(?![${EMOJI_JOINER_CLASS}])[${STRIPPED_CLASS}])+`, 'gu')

/** A joiner run at the start of the text or after whitespace, which the sanitizer drops. */
const LEADING_JOINER_PATTERN = new RegExp(`(?<!\\S)[${EMOJI_JOINER_CLASS}]+`, 'gu')

/**
 * Normalize one monitoring-notice text, as the pinned `LD(text, '', {keepEmojiJoiners:true})`
 * transform does.
 *
 * A lone surrogate becomes U+200B first, then escape sequences are removed, then each run of
 * stripped characters is dropped, and finally a joiner run that only leads the text or a word
 * is dropped. The three emoji joiners survive the second step. The bound is checked by the
 * caller, on the raw member.
 * @param text - the raw notice text.
 * @returns the normalized text.
 */
function normalizeNoticeText(text: string): string {
  return stripEscapeSequences(text.replace(LONE_SURROGATE_PATTERN, '\u200B'))
    .replace(STRIPPED_RUN_PATTERN, '')
    .replace(LEADING_JOINER_PATTERN, '')
}

/** The pinned core-skill bounds. */
const CORE_SKILL_LIMIT = 256
const CORE_SKILL_NAME_LIMIT = 128

/** Whether a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Define one data key as an own enumerable property.
 *
 * Assignment is not usable here: `target['__proto__'] = value` walks the prototype setter
 * and the key disappears from the projection, while the canonical hash and the verdicts must
 * both keep every key the server sent, `__proto__` included.
 * @param target - the object to write into.
 * @param key - the property name, exactly as it arrived.
 * @param value - the value to store.
 */
function defineDataKey<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
}

/**
 * The pinned guard for a monitoring-notice URL: the https scheme, at most 2048 characters, a
 * parseable URL and no unusable code point.
 *
 * The contract states `{text≤500, url≤2048 https}` and nothing stricter, so a userinfo
 * component is not refused here. The pinned `Aje` refine is applied after the scheme and URL
 * checks: a url carrying a control, format or otherwise invisible code point is refused even
 * though `URL` would have parsed it. A private-use code point is not refused by that refine,
 * and is not refused here either.
 */
const NOTICE_URL_PATTERN = /^https:\/\/[^\s\u0000-\u001f\u007f]+$/

/** The C0 and C1 control ranges `Aje` refuses outright. */
const NOTICE_URL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/

/** The two Unicode properties `Aje` refuses: format and default-ignorable code points. */
const FORMAT_CODE_POINT_PATTERN = /\p{Cf}/u
const DEFAULT_IGNORABLE_PATTERN = /\p{Default_Ignorable_Code_Point}/u

/**
 * The one code point `Aje` refuses by value, U+10EEEE.
 *
 * It is a private-use code point, so neither property test above refuses it and the pinned
 * predicate names this one literally.
 */
const REFUSED_CODE_POINT = 0x10_eeee

/**
 * `Aje`: whether one character makes a URL unusable.
 * @param character - one code point of the URL.
 * @returns true when the pinned refine refuses a url carrying it.
 */
function isUnusableUrlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return DEFAULT_IGNORABLE_PATTERN.test(character)
    || FORMAT_CODE_POINT_PATTERN.test(character)
    || character === '\u2028'
    || character === '\u2029'
    || character === '\u2800'
    || (code >= 0xd800 && code <= 0xdfff)
    || code === REFUSED_CODE_POINT
}

/** Whether a stated notice URL is usable. */
function isUsableNoticeUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > NOTICE_URL_LIMIT) return false
  if (!NOTICE_URL_PATTERN.test(value)) return false
  if (NOTICE_URL_CONTROL_PATTERN.test(value)) return false
  for (const character of value) {
    if (isUnusableUrlCharacter(character)) return false
  }
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.hostname.length > 0
  } catch {
    return false
  }
}

/**
 * Normalize one compliance taint.
 * @param value - the raw taint.
 * @returns the normalized taint, or `undefined` when it is not a legal one.
 */
function normalizeTaint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return TAINT_PATTERN.test(normalized) ? normalized : undefined
}

/**
 * Parse and normalize one `policy_limits` response body.
 *
 * The envelope follows the pinned schema: `restrictions` and every `restrictions[k].allowed`
 * are required, while taints, the monitoring notice, defaults and core skills each have a
 * declared default. An unknown top-level key is stripped, not rejected. A taint list that
 * carried something but normalized to nothing is a parse failure; a list that lost some
 * entries keeps the legal ones and marks the document lossy.
 * @param raw - the parsed JSON body, exactly as the transport delivered it.
 * @returns the normalized document, or why the body was refused.
 */
export function parsePolicyLimitsDocument(raw: unknown): PolicyDocumentParse {
  if (!isRecord(raw)) return { ok: false, failure: coreFailure('parse_failed') }
  const rawRestrictions = raw['restrictions']
  if (!isRecord(rawRestrictions)) return { ok: false, failure: coreFailure('parse_failed') }
  const restrictions: Record<string, PolicyRestriction> = {}
  for (const [key, value] of Object.entries(rawRestrictions)) {
    if (!isRecord(value) || typeof value['allowed'] !== 'boolean') {
      return { ok: false, failure: coreFailure('parse_failed') }
    }
    // `__proto__` is a data key here like any other: it stays an own property.
    defineDataKey(restrictions, key, { allowed: value['allowed'] })
  }

  let lossyComplianceTaints = false
  const complianceTaints: string[] = []
  const rawTaints = raw['compliance_taints']
  if (rawTaints === null) {
    // The pinned member is `z.array(...).default([])`: only an absent member defaults.
    // An explicit null is a malformed body, not an empty taint list.
    return { ok: false, failure: coreFailure('parse_failed') }
  }
  if (rawTaints !== undefined) {
    if (!Array.isArray(rawTaints)) return { ok: false, failure: coreFailure('parse_failed') }
    for (const entry of rawTaints) {
      if (complianceTaints.length >= TAINT_LIMIT) {
        lossyComplianceTaints = true
        break
      }
      const taint = normalizeTaint(entry)
      if (taint === undefined) {
        lossyComplianceTaints = true
        continue
      }
      if (!complianceTaints.includes(taint)) complianceTaints.push(taint)
    }
    if (rawTaints.length > 0 && complianceTaints.length === 0) {
      return { ok: false, failure: coreFailure('parse_failed') }
    }
  }

  let monitoringNotice: PolicyLimitsDocument['monitoringNotice'] = null
  const rawNotice = raw['monitoring_notice']
  if (isRecord(rawNotice)) {
    const text = rawNotice['text']
    const url = rawNotice['url']
    // The pinned bound is checked on the raw member, before the text is normalized.
    const usableText = typeof text === 'string' && text.length <= NOTICE_TEXT_LIMIT
    if (usableText) {
      // The url FIELD is `.catch(null)`: an unusable url keeps the notice (and its text) and
      // drops only the url, so the document stays unsettled instead of losing the gate.
      const usableUrl = url === null || url === undefined || isUsableNoticeUrl(url)
      monitoringNotice = {
        text: normalizeNoticeText(text),
        url: usableUrl && typeof url === 'string' ? url : null,
      }
    }
  }

  const rawDefaults = raw['defaults']
  const defaults = isRecord(rawDefaults) ? { ...rawDefaults } : {}

  // The pinned member is `z.array(...).catch([])`: ANY failure — a non-array, an oversized
  // list or one unusable name — takes the whole member's default, never a filtered or
  // truncated subset.
  let coreSkills: readonly string[] = []
  const rawSkills = raw['core_skills']
  if (rawSkills !== undefined) {
    const usable = Array.isArray(rawSkills)
      && rawSkills.length <= CORE_SKILL_LIMIT
      && rawSkills.every(entry => typeof entry === 'string' && entry.length <= CORE_SKILL_NAME_LIMIT)
    coreSkills = usable ? [...rawSkills as string[]] : []
  }

  return {
    ok: true,
    document: {
      restrictions,
      complianceTaints,
      monitoringNotice,
      defaults,
      coreSkills,
      lossyComplianceTaints,
    },
  }
}

/**
 * The canonical form of one JSON value, as the pinned validator computes it.
 *
 * Arrays keep their order; objects are rebuilt with their keys sorted, recursively, so two
 * bodies that differ only in member order hash the same. Anything else is serialized as
 * JSON leaves it.
 * @param value - the value to canonicalize.
 * @returns the canonical JSON text.
 */
export function canonicalPolicyJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/** Rebuild one value with object keys sorted, recursively. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {}
    // Own keys only, defined rather than assigned, so a `__proto__` member survives into
    // the canonical text and therefore into the hash.
    for (const key of Object.keys(value).sort()) defineDataKey(sorted, key, canonicalize(value[key]))
    return sorted
  }
  return value
}

/**
 * Hash one canonical text with sha256.
 *
 * WebCrypto is used when the runtime exposes it; otherwise the Node crypto module hashes
 * the same bytes. Both produce the same lowercase hex.
 * @param text - the canonical text.
 * @returns the lowercase hex digest.
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const subtle = globalThis.crypto?.subtle
  if (subtle !== undefined) {
    const digest = await subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  }
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The validator of one raw policy body: `sha256:<hex>` over its canonical form.
 *
 * The pinned client hashes the RAW body it received, never the parsed projection, so a body
 * whose unknown members were stripped still validates as the server sent it.
 * @param raw - the parsed JSON body.
 * @returns the validator string.
 */
export async function policyValidator(raw: unknown): Promise<string> {
  return `sha256:${await sha256Hex(canonicalPolicyJson(raw))}`
}

/** One adopted policy snapshot. */
export interface PolicySnapshot {
  /** The normalized document. */
  readonly document: PolicyLimitsDocument
  /** The validator of the raw body this document came from. */
  readonly validator: string
  /** When the caller received the body, in epoch milliseconds. */
  readonly receivedAt: number
  /**
   * The `signature` response header, when one was sent. It is kept for diagnostics only and
   * never participates in adoption.
   */
  readonly signature?: string
}

/**
 * The bounded in-memory adoption cache.
 *
 * It holds at most one snapshot, replaces it only through {@link adopt}, and never writes
 * anything to disk. The caller owns its lifetime; clearing it drops the live policy while
 * leaving the caller's own state untouched.
 */
export class PolicyLimitsCache {
  private snapshot: PolicySnapshot | undefined

  /**
   * Adopt one parsed response body.
   * @param raw - the parsed JSON body.
   * @param options - when it was received and the signature header, when one was sent.
   * @returns the adopted snapshot, or why the body was refused.
   */
  async adopt(
    raw: unknown,
    options: { receivedAt: number; signature?: string },
  ): Promise<{ ok: true; snapshot: PolicySnapshot } | { ok: false; failure: CoreFailure }> {
    const parsed = parsePolicyLimitsDocument(raw)
    if (!parsed.ok) return { ok: false, failure: parsed.failure }
    const snapshot: PolicySnapshot = {
      document: parsed.document,
      validator: await policyValidator(raw),
      receivedAt: options.receivedAt,
      ...options.signature === undefined ? {} : { signature: options.signature },
    }
    this.snapshot = snapshot
    return { ok: true, snapshot }
  }

  /**
   * The adopted snapshot, without any read or refresh.
   * @returns the snapshot, or `undefined` when nothing was adopted.
   */
  current(): PolicySnapshot | undefined {
    return this.snapshot
  }

  /**
   * The live policy document the verdict evaluator reads (`cb()`).
   * @returns the document, or `null` when no policy is live.
   */
  live(): PolicyLimitsDocument | null {
    return this.snapshot?.document ?? null
  }

  /**
   * The conditional-request validator for the session policy (`s`).
   * @returns the validator, or `undefined` when no policy is live.
   */
  validator(): string | undefined {
    return this.snapshot?.validator
  }

  /** Drop the adopted snapshot. */
  clear(): void {
    this.snapshot = undefined
  }
}
