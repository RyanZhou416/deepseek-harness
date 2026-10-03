/** Declarations for the heap-snapshot retainer analysis in `retainers.mjs`. */

/** Parsed V8 heap snapshot arrays. */
export interface HeapSnapshot {
  readonly meta: object
  readonly nodes: Uint32Array
  readonly edges: Uint32Array
  readonly locations: number[]
  readonly strings: string[]
}

/** Target selection and report bounds for {@link findRetainers}. */
export interface RetainerSelection {
  readonly classNames?: readonly string[]
  readonly ids?: readonly number[]
  readonly maxGroups?: number
}

/** Reachability totals and retainer chains grouped by normalized hops. */
export type RetainerReport = object

/**
 * Read and parse one `.heapsnapshot` file.
 * @param file - path to a snapshot written by V8 or Chrome DevTools.
 * @returns the parsed snapshot.
 */
export function readHeapSnapshot(file: string): Promise<HeapSnapshot>

/**
 * Shortest strong retainer chains from the GC roots to the selected objects.
 * @param snapshot - parsed snapshot.
 * @param selection - target selection and report bounds.
 * @returns totals and grouped chains.
 */
export function findRetainers(snapshot: Omit<HeapSnapshot, 'locations'>, selection: RetainerSelection): RetainerReport

/**
 * Render a retainer report as text.
 * @param report - report from {@link findRetainers}.
 * @returns human-readable chains.
 */
export function formatRetainers(report: RetainerReport): string
