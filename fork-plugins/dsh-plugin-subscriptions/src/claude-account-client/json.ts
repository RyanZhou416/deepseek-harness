/**
 * The small untyped-document helpers every reader in this client shares.
 *
 * A response document crosses a wire boundary, so it is validated before it is read and no field
 * is guessed: each helper answers only what the document itself states, and an absent field stays
 * absent rather than being collapsed into a candidate.
 *
 * @module dsh-plugin-subscriptions/claude-account-client/json
 */

/**
 * Read one value as a plain JSON record.
 * @param value - the value crossing the wire boundary.
 * @returns the record when the value is a JSON object, otherwise undefined.
 */
export function claudeRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * The first non-empty string among the candidates, in priority order.
 * @param values - the candidate values, best first.
 * @returns the first non-empty string, or undefined.
 */
export function claudeFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** One field's presence and value, so an explicit null stays distinguishable from absence. */
export interface ClaudeOwnField {
  /** Whether the record owns the key at all. */
  readonly present: boolean
  /** The value the record owns; null is a stated value. */
  readonly value: unknown
}

/**
 * Read one field's own value from a record.
 * @param record - the record, when one exists.
 * @param key - the field name.
 * @returns whether the record owns the field and what it holds.
 */
export function claudeOwnField(record: Record<string, unknown> | undefined, key: string): ClaudeOwnField {
  if (record === undefined || !Object.hasOwn(record, key)) return { present: false, value: undefined }
  return { present: true, value: record[key] }
}
