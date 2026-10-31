/**
 * The seam-provided header listing: backends whose revisions are cheap inherit
 * `SessionPersistence.listHeaders`, which must select what `list` selects and
 * return no revision.
 */

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  SessionPersistence,
  SessionPersistenceRevision,
  type SessionAccess,
  type SessionHandle,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot,
  type SessionPersistenceStatOptions,
} from '../src/index.ts'
import { meta } from './contract.ts'

type ListSnapshots = (options?: SessionPersistenceListOptions) => Promise<readonly SessionPersistenceSnapshot[]>

/** A backend that only lists snapshots; every handle operation is unavailable. */
class ListingOnlyPersistence extends SessionPersistence {
  /** The inherited `list` calls, so a test can prove the delegation. */
  readonly listed = vi.fn<ListSnapshots>()

  constructor(ctx: Context, snapshots: readonly SessionPersistenceSnapshot[]) {
    super(ctx)
    this.listed.mockResolvedValue(snapshots)
  }

  create(_header: SessionHeader, _options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    return this.unavailable()
  }

  open(_id: SessionId, _access: SessionAccess, _options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    return this.unavailable()
  }

  flush(): Promise<void> {
    return this.unavailable()
  }

  stat(_id: SessionId, _options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    return this.unavailable()
  }

  list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    return this.listed(options)
  }

  private unavailable<Value>(): Promise<Value> {
    return Promise.reject(new Error('the listing-only backend serves no handles'))
  }
}

describe('default listHeaders', () => {
  it('delegates to list and returns headers with format status but no revision', async () => {
    const snapshots: SessionPersistenceSnapshot[] = [
      { header: meta('current'), revision: SessionPersistenceRevision('rev-current'), formatStatus: 'current' },
      { header: meta('historical'), revision: SessionPersistenceRevision('rev-historical'), formatStatus: 'migration-required' },
      { header: meta('unversioned'), revision: SessionPersistenceRevision('rev-unversioned') },
    ]
    const persistence = new ListingOnlyPersistence(new Context(), snapshots)
    const options = {
      excludeSessionIds: new Set([SessionId('hidden')]),
      excludeSubagentSessions: true,
    }

    const headers = await persistence.listHeaders(options)

    // Selection is the backend's own `list`: same options, same rows.
    expect(persistence.listed).toHaveBeenCalledExactlyOnceWith(options)
    expect(headers).toEqual([
      { header: snapshots[0]!.header, formatStatus: 'current' },
      { header: snapshots[1]!.header, formatStatus: 'migration-required' },
      { header: snapshots[2]!.header },
    ])
    expect(headers.every(row => Object.hasOwn(row, 'revision'))).toBe(false)
  })
})
