/**
 * Absolute-time formatting shared by the settings section and the reset-credit
 * row. The dictionary's `dateTime` template owns the field order and
 * separators: `Date#toLocaleString` follows the browser language instead of the
 * app locale, so a locale switch would leave mixed-language text behind.
 *
 * The tool rows' shared half lives here too: the prompt line, the settled
 * result text, the missing-locale fallback and the row styles both generated
 * tool views render with.
 */
import type { CSSProperties } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'

/** Translate one key of this plugin's dictionary. */
export type SubscriptionsTranslate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/**
 * Format one instant as a local date and time.
 * @param t - Subscriptions dictionary translator.
 * @param at - Epoch milliseconds.
 * @returns The instant rendered through the dictionary's `dateTime` template.
 */
export function formatDateTime(t: SubscriptionsTranslate, at: number): string {
  const d = new Date(at)
  const pad2 = (value: number): string => String(value).padStart(2, '0')
  return t('dateTime', {
    y: d.getFullYear(),
    m: d.getMonth() + 1,
    d: d.getDate(),
    hh: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
  })
}

/**
 * English-dictionary fallback for a missing locale seat (standalone renders);
 * the framework always supplies the namespace-bound one.
 * @param key - dictionary key.
 * @param params - `{name}` template params.
 * @returns the template with params substituted.
 */
export function fallbackTranslate(key: SubscriptionsKey, params?: Record<string, unknown>): string {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

/** Title prompt truncation budget (characters). */
const PROMPT_MAX_LENGTH = 60

/**
 * One model row's display text.
 *
 * A row the provider refuses, or one a saved selection names without the catalog
 * listing it any more, states that beside the name instead of reading like any other
 * row: the model list and the account allowlist both offer these rows, and choosing
 * one silently is what the markers exist to prevent. The provider's own reason is wire
 * data and travels verbatim inside the localized template.
 * @param t - Subscriptions dictionary translator.
 * @param model - the row's name plus whichever markers its source stated.
 * @returns the row text.
 */
export function modelRowLabel(
  t: SubscriptionsTranslate,
  model: { name: string; disabledReason?: string; unavailable?: boolean },
): string {
  const disabled = model.disabledReason === undefined
    ? ''
    : ` (${t('modelsDisabled', { reason: model.disabledReason })})`
  const unavailable = model.unavailable === true ? ` (${t('modelsUnavailable')})` : ''
  return `${model.name}${disabled}${unavailable}`
}

/** Extract the prompt from the call's raw args JSON; falls back to the first string value, then the raw line. */
export function derivePrompt(argsRaw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    // Non-JSON args (mid-stream truncation): fall back to the raw string below.
    parsed = undefined
  }
  let prompt: string | undefined
  if (typeof parsed === 'object' && parsed !== null) {
    const args = parsed as Record<string, unknown>
    if (typeof args.prompt === 'string' && args.prompt !== '') prompt = args.prompt
    else {
      for (const value of Object.values(args)) {
        if (typeof value === 'string' && value !== '') { prompt = value; break }
      }
    }
  }
  const line = (prompt ?? argsRaw).split('\n', 1)[0] ?? ''
  return line.length > PROMPT_MAX_LENGTH ? `${line.slice(0, PROMPT_MAX_LENGTH)}…` : line
}

/** Flatten a settled result's text blocks (the degraded text-only route and the error line). */
export function resultText(block: ToolCallBlock): string {
  if (!('kind' in block)) return ''
  const parts: string[] = []
  for (const part of block.content) {
    if (part.type === 'text') parts.push(part.text)
  }
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
  return parts.join('\n')
}

/** Mirror of ui-tool's ToolCallOwnerProps (the slot contract this package does not resolve). */
export interface ToolCallOwnerProps {
  callId: string
  toolName: string
  block: ToolCallBlock
  cwd?: string | undefined
  openFile: (path: string) => void
  inspect?: (() => void) | undefined
}

/** Row styles every keyed tool view of this package renders with. */
export const toolviewStyles: Record<string, CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' },
  row: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  icon: { display: 'inline-flex', flexShrink: 0, color: 'var(--dsw-alias-label-tertiary)' },
  title: {
    fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  subtle: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  output: {
    margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)',
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
  },
  error: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
}
