import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'

/**
 * Stand-in projection registry for cases that own the client-visible key set.
 * The service must exist for the engine to load (its `sessionListMetadata`
 * registration runs in `[Service.init]`), and `wireKeys` then decides which
 * stored checkpoint counts as a complete baseline.
 * @param wireKeys - keys the registry reports as client-visible.
 * @returns the registry value to provide as `sessionProjections`.
 */
export function projectionRegistryStandIn(wireKeys: readonly string[] = []) {
  return {
    register: () => Promise.resolve({ stateOf: () => ({}) }),
    wireKeys: () => wireKeys,
  }
}

/** Test-only concrete query service for backend-independent behavior. */
export class TestSessionQueryEngine extends SessionQueryEngine {
  override searchSessions(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    return Promise.resolve({ items: [] })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    return {
      session: (await this.readSurface(request.sessionId)).session,
      items: [],
    }
  }
}
