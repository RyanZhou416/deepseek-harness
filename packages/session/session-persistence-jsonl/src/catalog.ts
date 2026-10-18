/**
 * Header catalog for the JSONL session store.
 *
 * Listing the store used to decode the first log frame of every physical
 * Session directory just to learn that Session's immutable header. The
 * catalog persists those headers beside the store, keyed by directory
 * segment, so a listing can trust an entry while its log's byte size and
 * modification time are unchanged and fall back to a header read otherwise.
 * Deleted directories are pruned on a full scan; a missing, unreadable, or
 * outdated catalog is rebuilt by that same fallback.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/catalog
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'

/** Catalog filename inside the configured session root. */
export const SESSION_CATALOG_FILE = '.session-catalog.json'

/** On-disk format version; a mismatch discards the catalog and rebuilds it. */
const SESSION_CATALOG_VERSION = 1

/** One Session's cached immutable header and the log identity it described. */
export interface SessionCatalogEntry {
  readonly header: SessionHeader
  readonly formatStatus: NonNullable<SessionPersistenceSnapshot['formatStatus']>
  readonly sizeBytes: number
  readonly mtimeMs: number
}

interface CatalogFile {
  readonly version: number
  readonly sessions: Record<string, SessionCatalogEntry>
}

/** A log's current identity as returned by `stat(path, { bigint: true })`. */
export interface SessionLogIdentity {
  readonly size: bigint
  readonly mtimeMs: bigint
}

function sameEntry(left: SessionCatalogEntry | undefined, right: SessionCatalogEntry): boolean {
  return left !== undefined
    && left.sizeBytes === right.sizeBytes
    && left.mtimeMs === right.mtimeMs
    && left.formatStatus === right.formatStatus
    && JSON.stringify(left.header) === JSON.stringify(right.header)
}

/**
 * Durable header cache owned by one persistence backend instance.
 *
 * Writes are serialized and published with a same-directory rename, so a
 * concurrent reader sees either the previous complete file or the new one.
 * A failed write keeps the in-memory entries and retries on the next flush.
 */
export class SessionCatalog {
  private entries = new Map<string, SessionCatalogEntry>()
  private loaded = false
  private dirty = false
  private flushChain: Promise<void> = Promise.resolve()

  /**
   * @param root - the session root directory holding the catalog file.
   * @param warn - receives a catalog read/write failure description; catalog failures never fail a listing.
   */
  constructor(
    private readonly root: string,
    private readonly warn: (message: string) => void,
  ) {}

  /** Load the catalog once; a missing or invalid file leaves an empty cache that the next scan rebuilds. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(join(this.root, SESSION_CATALOG_FILE), 'utf8')) as Partial<CatalogFile>
      if (parsed.version !== SESSION_CATALOG_VERSION || typeof parsed.sessions !== 'object' || parsed.sessions === null) {
        this.dirty = true
        return
      }
      for (const [segment, entry] of Object.entries(parsed.sessions)) {
        if (typeof entry?.header?.id !== 'string'
          || typeof entry.sizeBytes !== 'number'
          || typeof entry.mtimeMs !== 'number'
          || (entry.formatStatus !== 'current' && entry.formatStatus !== 'migration-required')) continue
        this.entries.set(segment, entry)
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warn(`session catalog unreadable at ${join(this.root, SESSION_CATALOG_FILE)}: ${String(error)}`)
        this.dirty = true
      }
    }
  }

  /**
   * Read a cached entry only while the log identity it recorded still matches.
   * @param segment - encoded Session directory name.
   * @param identity - the log file's current size and modification time.
   * @returns the cached entry, or undefined when a header read is required.
   */
  lookup(segment: string, identity: SessionLogIdentity): SessionCatalogEntry | undefined {
    const entry = this.entries.get(segment)
    if (entry === undefined) return undefined
    if (entry.sizeBytes !== Number(identity.size) || entry.mtimeMs !== Number(identity.mtimeMs)) return undefined
    return entry
  }

  /**
   * Record or refresh one entry.
   * @param segment - encoded Session directory name.
   * @param entry - the header and log identity just observed.
   */
  remember(segment: string, entry: SessionCatalogEntry): void {
    if (sameEntry(this.entries.get(segment), entry)) return
    this.entries.set(segment, entry)
    this.dirty = true
  }

  /**
   * Refresh the log identity of one already-known entry without scheduling a
   * durable rewrite.
   *
   * A live Session's log grows continuously, so every listing observes a new
   * size and modification time for it. That identity is worth remembering in
   * process — the next scan then trusts the cached header again — but it is not
   * worth rewriting the complete catalog file on the read path: the durable
   * entry keeps describing the older log, and the next process re-reads at most
   * one header per Session whose log grew after the last write.
   * @param segment - encoded Session directory name.
   * @param entry - the header and log identity just observed.
   * @returns whether an entry with this exact header was refreshed; `false`
   *   means the caller must record it through {@link remember}.
   */
  refreshIdentity(segment: string, entry: SessionCatalogEntry): boolean {
    const current = this.entries.get(segment)
    if (current === undefined) return false
    if (current.formatStatus !== entry.formatStatus
      || JSON.stringify(current.header) !== JSON.stringify(entry.header)) return false
    if (current.sizeBytes !== entry.sizeBytes || current.mtimeMs !== entry.mtimeMs) {
      this.entries.set(segment, entry)
    }
    return true
  }

  /**
   * Whether this catalog holds changes that have not reached the medium yet.
   * @returns true when a later {@link flush} would write the catalog file.
   */
  get needsFlush(): boolean {
    return this.dirty
  }

  /**
   * Drop entries whose directory no longer exists.
   * @param segments - every Session directory segment the scan observed.
   */
  prune(segments: ReadonlySet<string>): void {
    let removed = false
    for (const segment of this.entries.keys()) {
      if (segments.has(segment)) continue
      this.entries.delete(segment)
      removed = true
    }
    if (removed) this.dirty = true
  }

  /**
   * Encoded directory segments whose cached Session header has subagent origin.
   * @returns the segments a listing may skip before any file read.
   */
  subagentSegments(): Iterable<string> {
    return [...this.entries]
      .filter(([, entry]) => entry.header.origin === 'subagent')
      .map(([segment]) => segment)
  }

  /** Publish pending changes, coalescing concurrent flushes onto one write. */
  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    this.flushChain = this.flushChain.then(async () => {
      const sessions: Record<string, SessionCatalogEntry> = {}
      for (const [segment, entry] of this.entries) sessions[segment] = entry
      const content: CatalogFile = { version: SESSION_CATALOG_VERSION, sessions }
      const target = join(this.root, SESSION_CATALOG_FILE)
      const temp = `${target}.tmp-${process.pid}`
      try {
        await writeFile(temp, `${JSON.stringify(content)}\n`, 'utf8')
        await rename(temp, target)
      } catch (error: unknown) {
        this.dirty = true
        await rm(temp, { force: true }).catch(() => undefined)
        this.warn(`session catalog write failed at ${target}: ${String(error)}`)
      }
    })
    await this.flushChain
  }
}
