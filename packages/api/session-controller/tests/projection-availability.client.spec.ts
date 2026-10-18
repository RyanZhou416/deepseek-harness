/** Window-first projection availability and opening-observation vocabulary. */

import { describe, expect, expectTypeOf, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  OpeningProjectionBlock,
  ProjectionAvailability,
  ProjectionCut,
  ProjectionUnavailableReason,
  ProjectionWatermark,
  SessionOpenMeasurement,
  SessionOpenObservation,
  SessionOpenPath,
} from '../src/client/contract/projection-availability.ts'
import type { ProjectionsBaseline } from '../src/client/sessions/projection-store.ts'
import type { SessionProjectionBaseline } from '../src/types.ts'

type AbsentBlock = Extract<OpeningProjectionBlock, { readonly kind: 'absent' }>
type ExactBlock = Extract<OpeningProjectionBlock, { readonly kind: 'exact' }>
type Unavailable = Extract<ProjectionAvailability, { readonly state: 'unavailable' }>
type Loading = Extract<ProjectionAvailability, { readonly state: 'loading' }>
type Exact = Extract<ProjectionAvailability, { readonly state: 'exact' }>

/** Exhaustive walk over the availability discriminant. */
function availabilityLabel(availability: ProjectionAvailability): string {
  switch (availability.state) {
    case 'unavailable': return `unavailable:${availability.reason}`
    case 'loading': return `loading:${availability.reason}`
    case 'exact': return `exact:${String(availability.asOfSeq)}`
    default: return assertNever(availability, 'projection availability')
  }
}

/** Exhaustive walk over the opening-block discriminant. */
function blockLabel(block: OpeningProjectionBlock): string {
  switch (block.kind) {
    case 'absent': return 'absent'
    case 'exact': return `exact:${String(block.cut.asOfSeq)}:${String(Object.keys(block.cut.values).length)}`
    default: return assertNever(block, 'opening projection block')
  }
}

describe('projection availability contract', () => {
  it('keeps an absent opening block distinct from an empty exact cut', () => {
    const absent: OpeningProjectionBlock = { kind: 'absent' }
    const emptyCut: OpeningProjectionBlock = { kind: 'exact', cut: { asOfSeq: 7, values: {} } }

    expect(blockLabel(absent)).toBe('absent')
    expect(blockLabel(emptyCut)).toBe('exact:7:0')
    expect('cut' in absent).toBe(false)
    expect(emptyCut.kind === 'exact' ? emptyCut.cut.values : null).toEqual({})

    expectTypeOf<AbsentBlock>().toEqualTypeOf<{ readonly kind: 'absent' }>()
    expectTypeOf<ExactBlock['cut']>().toEqualTypeOf<ProjectionCut>()
    expectTypeOf<'cut' extends keyof AbsentBlock ? true : false>().toEqualTypeOf<false>()
  })

  it('reports unavailable and loading states without holding an exact cut', () => {
    const unavailable: ProjectionAvailability = { state: 'unavailable', reason: 'opening-absent' }
    const loading: ProjectionAvailability = { state: 'loading', reason: 'read-failed' }
    const exact: ProjectionAvailability = { state: 'exact', asOfSeq: 41 }

    expect(availabilityLabel(unavailable)).toBe('unavailable:opening-absent')
    expect(availabilityLabel(loading)).toBe('loading:read-failed')
    expect(availabilityLabel(exact)).toBe('exact:41')

    expectTypeOf<ProjectionUnavailableReason>()
      .toEqualTypeOf<'opening-absent' | 'read-failed' | 'refused'>()
    expectTypeOf<Unavailable['reason']>().toEqualTypeOf<ProjectionUnavailableReason>()
    expectTypeOf<Loading['reason']>().toEqualTypeOf<ProjectionUnavailableReason>()
    expectTypeOf<Exact['asOfSeq']>().toEqualTypeOf<ProjectionWatermark>()
    expectTypeOf<'asOfSeq' extends keyof Unavailable ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<'asOfSeq' extends keyof Loading ? true : false>().toEqualTypeOf<false>()
  })

  it('accepts the exact baselines that carry the same watermark field', () => {
    expectTypeOf<ProjectionWatermark>().toEqualTypeOf<number>()
    expectTypeOf<ProjectionCut['values']>().toEqualTypeOf<Readonly<Record<string, unknown>>>()
    // A client store baseline and its wire block are both exact cuts.
    expectTypeOf<ProjectionsBaseline>().toExtend<ProjectionCut>()
    expectTypeOf<SessionProjectionBaseline>().toExtend<ProjectionCut>()

    const stored: ProjectionsBaseline = { asOfSeq: SessionSeq(5), values: { title: 'stored' } }
    const cut: ProjectionCut = stored
    expect(cut.asOfSeq).toBe(5)
    expect(cut.values).toEqual({ title: 'stored' })
  })

  it('records the fast-path negative control and separates both timing boundaries', () => {
    const fast: SessionOpenObservation = {
      path: 'window',
      projections: { kind: 'absent' },
      completeObservations: 0,
      windowReads: 1,
    }
    const fallback: SessionOpenObservation = {
      path: 'complete-observation',
      projections: { kind: 'exact', cut: { asOfSeq: 9, values: {} } },
      completeObservations: 1,
      windowReads: 1,
    }
    const sample: SessionOpenMeasurement = {
      ...fast,
      firstFrameMs: 612.4,
      exactProjectionsMs: 341.7,
    }

    expect(fast.path).toBe('window')
    expect(fast.projections).toEqual({ kind: 'absent' })
    expect(fast.completeObservations).toBe(0)
    expect(fast.windowReads).toBe(1)
    expect(fallback.path).toBe('complete-observation')
    expect(fallback.completeObservations).toBe(1)
    expect(sample.firstFrameMs).toBe(612.4)
    expect(sample.exactProjectionsMs).toBe(341.7)

    expectTypeOf<SessionOpenPath>().toEqualTypeOf<'window' | 'complete-observation'>()
    expectTypeOf<SessionOpenMeasurement>().toExtend<SessionOpenObservation>()
    expectTypeOf<'firstFrameMs' extends keyof SessionOpenObservation ? true : false>()
      .toEqualTypeOf<false>()
    expectTypeOf<SessionOpenMeasurement['exactProjectionsMs']>()
      .toEqualTypeOf<number | undefined>()
  })
})
