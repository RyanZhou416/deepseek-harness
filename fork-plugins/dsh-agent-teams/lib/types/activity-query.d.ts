import type { TeamActivityCollectionOptions } from './snapshot.ts';
/** Activity-state query parsing for scoped and legacy browser clients. */
/** A malformed activity-state selection that must not fall back to an all-team scan. */
export declare class ActivityQueryError extends Error {
}
/** Parsed route switches and snapshot collection options. */
export interface ActivityQuery {
    readonly archived: boolean;
    readonly options: TeamActivityCollectionOptions;
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
export declare function parseActivityQuery(url: URL): ActivityQuery;
