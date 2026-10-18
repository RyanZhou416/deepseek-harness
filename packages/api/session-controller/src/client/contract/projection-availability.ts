/**
 * Shared vocabulary for window-first Session opening: whether whole-log
 * projections are exact, the watermark an exact cut merges under, and the
 * opening facts a follow-level benchmark records.
 *
 * Type-only by construction: no runtime exports and no imports, so the Host
 * opening path, the Client projection lifecycle, and the benchmark can share
 * these names without loading code or crossing a compiler face.
 */

/**
 * Watermark of one exact projection cut: the newest Session event seq whose
 * complete fold produced the values. `-1` is the cursor before the first event.
 *
 * A watermark is comparable only with watermarks of the same Host connection
 * generation. A deferred read that outlives its generation carries no
 * comparable watermark and must be discarded, not merged.
 */
export type ProjectionWatermark = number

/**
 * One exact whole-log projection cut.
 *
 * Merge rule for an exact cut offered to the client projection store:
 * - accept the cut only for the Host generation that requested it;
 * - a carried key replaces its stored row only when {@link ProjectionCut.asOfSeq}
 *   is strictly newer than that row's watermark, so a replayed, stale, or
 *   out-of-order read cannot regress a value;
 * - a key the cut omits is capability-absent at this cut and clears its row
 *   unless a strictly newer sequenced row already superseded the cut.
 *
 * An opening block that was absent supplies no cut and follows none of these
 * rules: it neither writes nor clears values.
 */
export interface ProjectionCut {
  /** Event cut these values are exact at; see {@link ProjectionWatermark}. */
  readonly asOfSeq: ProjectionWatermark
  /** Complete values at the cut; a key absent from this record is capability-absent there. */
  readonly values: Readonly<Record<string, unknown>>
}

/**
 * Projection block carried by an opening follow snapshot.
 *
 * `absent` is a window-first opening: the Host served the bounded tail window
 * and holds no exact whole-log cut. Consumers keep cached hints and mark
 * whole-log projections unavailable. They must never replace the absent block
 * with an empty exact cut, which claims whole-log emptiness and clears every
 * cached projection row.
 *
 * `exact` is a complete cut, including one whose `values` record is empty:
 * empty values at a cut are the claim that no projection exists there.
 *
 * The follow snapshot's wire field is optional: an omitted `projections`
 * field is `absent`; a present field, even with empty values, is `exact`.
 */
export type OpeningProjectionBlock =
  | {
    /** No exact whole-log cut was served; cached hints stay non-exact. */
    readonly kind: 'absent'
  }
  | {
    /** An exact whole-log cut was served; its values may legitimately be empty. */
    readonly kind: 'exact'
    /** The exact cut. */
    readonly cut: ProjectionCut
  }

/**
 * Why a Session generation does not hold exact whole-log projections.
 * - `opening-absent`: the opening frame carried no block (window-first open).
 * - `read-failed`: the deferred exact read failed with a retryable error.
 * - `refused`: the exact read cannot succeed in this generation (permission,
 *   migration-required, or a superseded generation); consumers must not spin.
 */
export type ProjectionUnavailableReason = 'opening-absent' | 'read-failed' | 'refused'

/**
 * Client availability of one Session generation's whole-log projections.
 *
 * `unavailable` and `loading` never make the projection store exact: cached or
 * window-scoped hints may still exist, but presentation must not state them as
 * whole-session values. `exact` is the only state that may drive exact
 * statistics and Context presentation, and its `asOfSeq` is the cut the
 * whole-log values are exact at.
 */
export type ProjectionAvailability =
  | {
    /** No exact whole-log values are held and no read is in flight. */
    readonly state: 'unavailable'
    /** Why the generation is unavailable. */
    readonly reason: ProjectionUnavailableReason
  }
  | {
    /** An exact whole-log read is in flight for this generation. */
    readonly state: 'loading'
    /** Why the read started. */
    readonly reason: ProjectionUnavailableReason
  }
  | {
    /** Exact whole-log values are held at {@link ProjectionAvailability.asOfSeq}. */
    readonly state: 'exact'
    /** Cut the held values are exact at; see {@link ProjectionWatermark}. */
    readonly asOfSeq: ProjectionWatermark
  }

/**
 * History source that answered one follow opening.
 * `window` is the bounded stored window; `complete-observation` materializes
 * the complete log through `sessionQuery.observeSession`.
 */
export type SessionOpenPath = 'window' | 'complete-observation'

/**
 * Facts one opening exposes to a follow-level benchmark.
 *
 * A negative control asserts that the fast path reports `path: 'window'` with
 * `projections.kind: 'absent'`, at least one window read, and zero complete
 * observations: each complete observation starts a full persistence open, so a
 * zero count proves that work did not run. A window read that falls back keeps
 * its count while the complete observation adds its own, which distinguishes a
 * fallback from a fast opening.
 */
export interface SessionOpenObservation {
  /** Source that produced the opening snapshot. */
  readonly path: SessionOpenPath
  /** Projection block the opening snapshot carried, or absent when none was served. */
  readonly projections: OpeningProjectionBlock
  /** Complete observations (`sessionQuery.observeSession`, hence a full persistence open) attempted. */
  readonly completeObservations: number
  /** Bounded stored-window reads (`sessionQuery.readWindow`) attempted. */
  readonly windowReads: number
}

/**
 * One follow-level cold-opening measurement. The opening frame and the deferred
 * exact projection read are timed separately because the whole-log fold is not
 * part of the window-first first frame.
 */
export interface SessionOpenMeasurement extends SessionOpenObservation {
  /** Milliseconds from the opening request to the first snapshot yielded to the consumer. */
  readonly firstFrameMs: number
  /**
   * Milliseconds of the separately measured exact `session/projections` read.
   * Omitted when that follow-up was not measured.
   */
  readonly exactProjectionsMs?: number
}
