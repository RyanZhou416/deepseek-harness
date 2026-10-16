/**
 * Durable record of a compatibility profile the service refused.
 *
 * A client-version refusal is evidence about the protocol, not about the account: the same
 * target origin refuses the same profile whoever is signed in. So the record is keyed by
 * provider, normalized origin and profile fingerprint alone, and it deliberately has no
 * clear path — re-login, an account rename, a quota reset and a restart must not release a
 * profile the service already refused. Only a profile whose fingerprint no longer matches
 * (a trusted replacement of the pinned combination) stops matching.
 *
 * The store is fail-closed on its own state. Only a missing file means "never refused"; a
 * record that cannot be read, cannot be parsed, or does not carry the identity it is filed
 * under is reported as unreadable and treated as a block, because releasing a refused
 * profile on a damaged record would send exactly the request the service refused. Writes go
 * to an exclusively created temporary file and are renamed into place, so two processes
 * cannot truncate each other's record and a crash leaves either the old record or the new
 * one.
 *
 * The store keeps the minimum such a record needs and nothing derived from a credential: no
 * token, no header, no response body, no account key. Files are written under the plugin's
 * own home directory with owner-only permissions.
 *
 * @module dsh-plugin-subscriptions/providers/claude-protocol-state
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** The provider/origin/profile identity one block is keyed by. */
export interface ClaudeProtocolKey {
  /** Provider route the refusal was reported on. */
  readonly provider: string
  /** Normalized origin the request targeted. */
  readonly origin: string
  /** Compatibility-profile fingerprint the request was built from. */
  readonly fingerprint: string
}

/** One persisted protocol block, as stored on disk. */
export interface ClaudeProtocolBlock extends ClaudeProtocolKey {
  /** Record version, so a future schema can migrate rather than guess. */
  readonly version: 1
  /** Stable reason code the refusal produced. */
  readonly reason: string
  /** The provider's own code, when it sent one. */
  readonly serverCode?: string
  /** ISO instant this identity was first refused. */
  readonly firstSeenAt: string
  /** ISO instant this identity was most recently refused. */
  readonly lastSeenAt: string
}

/** Constructor options for {@link ClaudeProtocolBlockStore}. */
export interface ClaudeProtocolBlockStoreOptions {
  /** Directory holding the records; absent uses the plugin's own home directory. */
  readonly directory?: string
  /** Sink for a diagnostic about the store itself; never used for a credential. */
  readonly onWarn?: (message: string) => void
}

/** The record one refusal contributes, before its instants are filled in. */
export type ClaudeProtocolBlockRecord = ClaudeProtocolKey & {
  /** Stable reason code the refusal produced. */
  readonly reason: string
  /** The provider's own code, when it sent one. */
  readonly serverCode?: string
}

/**
 * What the store found for one requested identity.
 *
 * `unreadable` is a safe error rather than an absence: the route must treat it as a block,
 * because a record it cannot verify is a record it cannot rule out.
 */
export type ClaudeProtocolBlockState =
  /** No record exists for this identity. */
  | 'absent'
  /** A readable record for exactly this identity exists. */
  | 'blocked'
  /** The store holds something for this identity that it cannot verify. */
  | 'unreadable'

/** Whether a block reached durable storage. */
export interface ClaudeProtocolBlockWrite {
  /** Whether the record was persisted; false means the block is only in memory. */
  readonly persisted: boolean
  /** Why persistence failed, when it did. */
  readonly error?: unknown
}

/** Every record the store can read, and the ones it cannot. */
export interface ClaudeProtocolBlockListing {
  /** The records that parsed and carried their own identity. */
  readonly blocks: readonly ClaudeProtocolBlock[]
  /** File names whose contents could not be trusted, for diagnostics. */
  readonly unreadable: readonly string[]
}

/** The directory records live in when the caller names none. */
function defaultDirectory(): string {
  return dshHomePath('plugins', 'subscriptions', 'claude-protocol-blocks')
}

/**
 * Validate a value read back from disk.
 *
 * Records cross a filesystem boundary, so every field the store routes on is checked rather
 * than trusted. A record whose identity does not match the key it is filed under is not a
 * match for that key, and is reported as unverifiable instead of adopted.
 * @param value - the parsed file contents.
 * @returns true when every required field is present and well typed.
 */
function isProtocolBlock(value: unknown): value is ClaudeProtocolBlock {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record['version'] === 1
    && typeof record['provider'] === 'string' && record['provider'].length > 0
    && typeof record['origin'] === 'string' && record['origin'].length > 0
    && typeof record['fingerprint'] === 'string' && record['fingerprint'].length > 0
    && typeof record['reason'] === 'string' && record['reason'].length > 0
    && typeof record['firstSeenAt'] === 'string'
    && typeof record['lastSeenAt'] === 'string'
}

/**
 * Whether a filesystem failure means the record simply does not exist.
 * @param error - the caught failure.
 * @returns true only for ENOENT.
 */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * The bounded, credential-free record store for refused compatibility profiles.
 *
 * The hot path reads one deterministic file for the requested identity and never walks the
 * directory, so an unrelated damaged record cannot stall or fail an unaffected profile. A
 * store failure is reported once and still yields a safe answer: an unverifiable record
 * blocks, and a write that did not reach disk keeps its in-memory block and reports itself
 * as unpersisted.
 */
export class ClaudeProtocolBlockStore {
  private readonly directory: string
  private readonly blocks = new Map<string, ClaudeProtocolBlock>()
  private readonly unreadable = new Set<string>()
  private warned = new Set<string>()

  /**
   * @param options - directory override and diagnostic sink.
   */
  constructor(private readonly options: ClaudeProtocolBlockStoreOptions = {}) {
    this.directory = options.directory ?? defaultDirectory()
  }

  /**
   * Whether this provider, origin and profile fingerprint may not be asked again.
   * @param key - the identity to test.
   * @returns the state the store can prove: blocked, absent, or unverifiable.
   */
  async state(key: ClaudeProtocolKey): Promise<ClaudeProtocolBlockState> {
    const name = fileKey(key)
    if (this.blocks.has(name)) return 'blocked'
    if (this.unreadable.has(name)) return 'unreadable'
    let contents: string
    try {
      contents = await readFile(join(this.directory, `${name}.json`), 'utf8')
    } catch (error: unknown) {
      if (isMissing(error)) return 'absent'
      // A record that exists but cannot be read is not an absence: treating it as one would
      // release the profile it may still be blocking.
      this.unreadable.add(name)
      this.warnOnce(name, `claude protocol block ${name} could not be read; treating the profile as blocked`)
      return 'unreadable'
    }
    const record = parseBlock(contents)
    if (record === undefined || !sameKey(record, key)) {
      this.unreadable.add(name)
      this.warnOnce(name, `claude protocol block ${name} is damaged or names another identity; treating the profile as blocked`)
      return 'unreadable'
    }
    this.blocks.set(name, record)
    return 'blocked'
  }

  /**
   * Whether this identity is blocked, counting an unverifiable record as blocked.
   * @param key - the identity to test.
   * @returns true when the route must not send a request for this identity.
   */
  async isBlocked(key: ClaudeProtocolKey): Promise<boolean> {
    return await this.state(key) !== 'absent'
  }

  /**
   * Record one refusal, keeping the first instant it was seen.
   *
   * The block is published in memory before the write is attempted, so a failed write still
   * stops this process from asking again; the returned result says whether it would survive
   * a restart, and the caller reports that rather than claiming success.
   * @param record - the identity and the reason it was refused.
   * @returns whether the record reached durable storage.
   */
  async block(record: ClaudeProtocolBlockRecord): Promise<ClaudeProtocolBlockWrite> {
    const name = fileKey(record)
    const now = new Date().toISOString()
    const existing = this.blocks.get(name)
    const next: ClaudeProtocolBlock = {
      version: 1,
      provider: record.provider,
      origin: record.origin,
      fingerprint: record.fingerprint,
      reason: record.reason,
      ...record.serverCode === undefined ? {} : { serverCode: record.serverCode },
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
    }
    this.blocks.set(name, next)
    this.unreadable.delete(name)
    try {
      await mkdir(this.directory, { recursive: true })
      // An exclusively created temporary file renamed into place: a crash leaves either the
      // previous record or this one, and two processes cannot truncate each other's file.
      const temporary = join(this.directory, `${name}.${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 })
        await rename(temporary, join(this.directory, `${name}.json`))
      } catch (error: unknown) {
        await rm(temporary, { force: true })
        throw error
      }
      return { persisted: true }
    } catch (error: unknown) {
      this.warnOnce(name, `claude protocol block ${name} could not be persisted; it holds for this process only`)
      return { persisted: false, error }
    }
  }

  /**
   * Every record the store can read, with the ones it cannot. Diagnostics only: the hot path
   * never walks the directory, and an unreadable file is reported rather than thrown.
   * @returns the readable records and the file names that could not be trusted.
   */
  async list(): Promise<ClaudeProtocolBlockListing> {
    const blocks: ClaudeProtocolBlock[] = [...this.blocks.values()]
    const unreadable: string[] = [...this.unreadable]
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error: unknown) {
      if (isMissing(error)) return { blocks, unreadable }
      return { blocks, unreadable: [...unreadable, this.directory] }
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const stem = name.slice(0, -'.json'.length)
      if (this.blocks.has(stem) || this.unreadable.has(stem)) continue
      let record: ClaudeProtocolBlock | undefined
      try {
        record = parseBlock(await readFile(join(this.directory, name), 'utf8'))
      } catch (error: unknown) {
        if (!isMissing(error)) unreadable.push(name)
        continue
      }
      if (record === undefined || fileKey(record) !== stem) {
        unreadable.push(name)
        continue
      }
      blocks.push(record)
    }
    return { blocks, unreadable }
  }

  private warnOnce(name: string, message: string): void {
    if (this.warned.has(name)) return
    this.warned.add(name)
    this.options.onWarn?.(message)
  }
}

/**
 * Parse one record's contents.
 * @param contents - the file's text.
 * @returns the record, or undefined when it is not one.
 */
function parseBlock(contents: string): ClaudeProtocolBlock | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    // Only swallow the parse: an unparseable record is reported as unverifiable.
    return undefined
  }
  return isProtocolBlock(parsed) ? parsed : undefined
}

/**
 * Whether a stored record carries exactly the identity it is filed under.
 * @param record - the stored record.
 * @param key - the requested identity.
 * @returns true when every keyed field matches.
 */
function sameKey(record: ClaudeProtocolBlock, key: ClaudeProtocolKey): boolean {
  return record.provider === key.provider
    && record.origin === key.origin
    && record.fingerprint === key.fingerprint
}

/**
 * The file name one identity is stored under.
 * @param key - the provider, origin and fingerprint to name.
 * @returns a 64-character lowercase hex file stem.
 */
function fileKey(key: ClaudeProtocolKey): string {
  return createHash('sha256')
    .update(`${key.provider}\n${key.origin}\n${key.fingerprint}\n`)
    .digest('hex')
}
