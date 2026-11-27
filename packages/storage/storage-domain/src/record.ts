/**
 * Record-boundary validation shared by the eager open and the lazy read path:
 * exactly one zod parse per stored value, translated to `invalid-record` with
 * its table and key.
 * @module @deepseek-ai/dsh-storage-domain/src/record
 */

import { DomainError } from './error.ts'

/**
 * Run one stored-value parse, translating failure to `invalid-record` with its
 * location. The zod failure stays the cause.
 * @param domain - Domain name for the diagnostic.
 * @param table - Table name; `''` for the global singleton.
 * @param key - Record key; `''` for the global singleton.
 * @param parse - The schema parse to run.
 * @returns the parsed value.
 */
export function parseRecord<T>(domain: string, table: string, key: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    const slot = table === '' ? 'global' : `record '${key}' in table '${table}'`
    throw new DomainError(
      'invalid-record',
      `domain '${domain}': stored ${slot} does not match its schema`,
      { detail: { table, key }, cause: error },
    )
  }
}
