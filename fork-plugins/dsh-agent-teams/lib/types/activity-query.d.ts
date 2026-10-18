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
 * @param url - request URL resolved by the Host route.
 * @returns archive selection and collection options.
 * @throws {ActivityQueryError} when scoped/detail parameters are incomplete or empty.
 */
export declare function parseActivityQuery(url: URL): ActivityQuery;
