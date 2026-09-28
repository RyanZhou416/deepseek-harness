/** Activity-state query parsing for scoped and legacy browser clients. */

import type { TeamActivityCollectionOptions, TeamActivityTarget } from './snapshot.ts'

/** A malformed activity-state selection that must not fall back to an all-team scan. */
export class ActivityQueryError extends Error {}

/** Parsed route switches and snapshot collection options. */
export interface ActivityQuery {
  readonly archived: boolean
  readonly options: TeamActivityCollectionOptions
}

/**
 * Parse one activity-state URL without allowing malformed scope to become unscoped work.
 * @param url - request URL resolved by the Host route.
 * @returns archive selection and collection options.
 * @throws {ActivityQueryError} when scoped/detail parameters are incomplete or empty.
 */
export function parseActivityQuery(url: URL): ActivityQuery {
  const captainValues = url.searchParams.getAll('captainSessionId')
  const targetCaptains = url.searchParams.getAll('teamCaptainSessionId')
  const teamIds = url.searchParams.getAll('teamId')
  const detailValues = url.searchParams.getAll('detail')
  const hasScopeParameter = captainValues.length > 0 || targetCaptains.length > 0 || teamIds.length > 0

  if (captainValues.length > 1) throw new ActivityQueryError('captainSessionId must appear at most once')
  const captainSessionId = captainValues[0]?.trim() ?? ''
  if (captainValues.length === 1 && captainSessionId === '') {
    throw new ActivityQueryError('captainSessionId must not be empty')
  }
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
  const hasScope = captainSessionId !== '' || targets.length > 0
  if (includeDetails && !hasScope) {
    throw new ActivityQueryError('detail requires a captain or explicit team target')
  }

  const legacy = !hasScopeParameter && detailValues.length === 0
  return {
    archived: url.searchParams.get('archived') === '1',
    options: {
      ...captainSessionId === '' ? {} : { captainSessionId },
      ...targets.length === 0 ? {} : { targets },
      includeDetails: legacy || includeDetails,
      includeCaptainInbox: legacy,
    },
  }
}