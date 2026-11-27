import type { TeamActivityCollectionOptions, TeamActivityTarget } from './snapshot.ts'
/** Activity-state query parsing for scoped and legacy browser clients. */

/** A malformed activity-state selection that must not fall back to an all-team scan. */
export class ActivityQueryError extends Error {}

/** Parsed route switches and snapshot collection options. */
export interface ActivityQuery {
  readonly archived: boolean
  readonly options: TeamActivityCollectionOptions
}

/**
 * Parse one activity-state URL without allowing malformed scope to become unscoped work.
 *
 * Two client generations poll this route. The current panel sends
 * `session=<captain>&summary=1`; a scoped card/legacy caller may send
 * `captainSessionId`, paired `teamCaptainSessionId`+`teamId` targets, and
 * `detail=1`. A request with neither scope nor switches keeps the original
 * full payload, including captain-inbox previews.
 * @param url - request URL resolved by the Host route.
 * @returns archive selection and collection options.
 * @throws {ActivityQueryError} when scoped/detail parameters are incomplete, empty or contradictory.
 */
export function parseActivityQuery(url: URL): ActivityQuery {
  const captainValues = url.searchParams.getAll('captainSessionId')
  const sessionValues = url.searchParams.getAll('session')
  const targetCaptains = url.searchParams.getAll('teamCaptainSessionId')
  const teamIds = url.searchParams.getAll('teamId')
  const detailValues = url.searchParams.getAll('detail')
  const summaryValues = url.searchParams.getAll('summary')

  if (captainValues.length > 1) throw new ActivityQueryError('captainSessionId must appear at most once')
  if (sessionValues.length > 1) throw new ActivityQueryError('session must appear at most once')
  const captainSessionId = captainValues[0]?.trim() ?? ''
  if (captainValues.length === 1 && captainSessionId === '') {
    throw new ActivityQueryError('captainSessionId must not be empty')
  }
  const session = sessionValues[0]?.trim() ?? ''
  if (captainSessionId !== '' && session !== '' && session !== captainSessionId) {
    throw new ActivityQueryError('session and captainSessionId name different captains')
  }
  const captain = captainSessionId !== '' ? captainSessionId : session
  if (targetCaptains.length !== teamIds.length) {
    throw new ActivityQueryError('each team target requires captainSessionId and teamId')
  }
  const targets: TeamActivityTarget[] = []
  for (let index = 0; index < teamIds.length; index += 1) {
    const targetCaptain = targetCaptains[index]?.trim() ?? ''
    const teamId = teamIds[index]?.trim() ?? ''
    if (targetCaptain === '' || teamId === '') {
      throw new ActivityQueryError('team target values must not be empty')
    }
    targets.push({ captainSessionId: targetCaptain, teamId })
  }
  if (detailValues.length > 1 || (detailValues.length === 1 && detailValues[0] !== '1')) {
    throw new ActivityQueryError('detail must be exactly 1')
  }
  const includeDetails = detailValues.length === 1
  const hasScope = captain !== '' || targets.length > 0
  if (includeDetails && !hasScope) {
    throw new ActivityQueryError('detail requires a captain or explicit team target')
  }

  const summary = summaryValues.includes('1')
  const legacy = !hasScope && detailValues.length === 0 && summaryValues.length === 0
  return {
    archived: url.searchParams.get('archived') === '1',
    options: {
      ...captain === '' ? {} : { captainSessionId: captain },
      ...targets.length === 0 ? {} : { targets },
      // The legacy and detail requests keep the staged-plan authoring text.
      includeDetails: legacy || includeDetails,
      ...summary && !legacy && !includeDetails ? { summary: true } : {},
      includeCaptainInbox: legacy,
    },
  }
}
