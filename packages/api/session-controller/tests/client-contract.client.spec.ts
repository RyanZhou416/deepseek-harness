import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { PromptContentPart as AttachmentPromptContentPart } from '@deepseek-ai/dsh-attachment/types'
import { SessionSeq, type SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import {
  MutableSessionEventSource, type SessionAssistantSettlementEntry,
  type SessionLiveEventEntry, type SessionTransientEventEntry,
} from '../src/client/contract/events.ts'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type { ISession } from '../src/client/contract/session.ts'
import type { ProjectionsBaseline } from '../src/client/sessions/projection-store.ts'
import { ProjectionValueStore } from '../src/client/sessions/projection-store.ts'
import type { PromptContentPart as SessionPromptContentPart, SessionPageRequest } from '../src/types.ts'
import { ev, plainTurn } from './event-script.client.ts'

type RenameSuccess = Extract<Awaited<ReturnType<ISession['rename']>>, { readonly ok: true }>

function entry(seq: SessionSeq): SessionLiveEventEntry {
  return {
    type: 'event',
    event: {
      type: 'turn/start',
      seq,
      time: seq,
      data: { turn: seq },
    },
  }
}

function transient(attemptId: string, seq = 1.5): SessionTransientEventEntry {
  return {
    type: 'transient',
    event: {
      type: 'assistant/live-chunk',
      seq,
      time: 1,
      data: {
        attemptId: LlmAttemptId(attemptId),
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'live' },
      },
    },
  }
}

function assistantSettlement(seq: SessionSeq): SessionAssistantSettlementEntry {
  return {
    type: 'event',
    event: {
      type: 'assistant/attempt',
      seq,
      time: seq,
      data: { turn: 1, step: 1, stream: [] },
    },
  }
}

describe('Client Session contracts', () => {
  it('requires branded Session positions at internal event fixture boundaries', () => {
    expectTypeOf(entry).parameter(0).toEqualTypeOf<SessionSeq>()
    expectTypeOf(ev.user).parameter(0).toEqualTypeOf<SessionSeq>()
    expectTypeOf(ev.commandDone).parameter(4).toEqualTypeOf<SessionSeq | undefined>()
    expectTypeOf(ev.compactSummary).parameter(2).toEqualTypeOf<SessionSeq>()
    expectTypeOf(ev.compactCheckpoint).parameter(1).toEqualTypeOf<SessionSeq>()
    expectTypeOf(plainTurn).parameter(0).toEqualTypeOf<SessionSeq>()
  })

  it('brands same-process Session event positions while keeping the API wire numeric', () => {
    expectTypeOf<ISession['loadThrough']>().parameter(0).toEqualTypeOf<SessionSeq>()
    expectTypeOf<RenameSuccess['value']['seq']>().toEqualTypeOf<SessionSeq>()
    expectTypeOf<ProjectionValueStore['apply']>().parameter(2).toEqualTypeOf<SessionSeqCursor>()
    expectTypeOf<ProjectionsBaseline['asOfSeq']>().toEqualTypeOf<SessionSeqCursor>()
    expectTypeOf<SessionPageRequest['throughSeq']>().toEqualTypeOf<number>()
  })

  it('keeps its text and image prompt parts identical to attachment intake', () => {
    expectTypeOf<Exclude<SessionPromptContentPart, { type: 'file' }>>()
      .toEqualTypeOf<AttachmentPromptContentPart>()
  })

  it('publishes exact replace, prepend, and append event-window changes', () => {
    const feed = new MutableSessionEventSource()
    const listener = vi.fn()
    const dispose = feed.subscribe(listener)
    const first = entry(SessionSeq(1))
    const older = entry(SessionSeq(0))
    const live = entry(SessionSeq(2))

    feed.replace([first], true)
    expect(feed.getSnapshot()).toEqual({
      entries: [first],
      hasMore: true,
      revision: 1,
      change: { kind: 'replace', entries: [first] },
    })

    feed.prepend([older], false)
    expect(feed.getSnapshot()).toEqual({
      entries: [older, first],
      hasMore: false,
      revision: 2,
      change: { kind: 'prepend', entries: [older] },
    })

    feed.append(live)
    expect(feed.getSnapshot()).toEqual({
      entries: [older, first, live],
      hasMore: false,
      revision: 3,
      change: { kind: 'append', entries: [live] },
    })
    expect(listener).toHaveBeenCalledTimes(3)

    dispose()
    feed.append(entry(SessionSeq(3)))
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('does not traverse the complete event window while appending', () => {
    const feed = new MutableSessionEventSource()
    const first = entry(SessionSeq(1))
    const base = [first]
    const iterate = vi.fn(Array.prototype[Symbol.iterator].bind(base))
    Object.defineProperty(base, Symbol.iterator, { value: iterate })
    feed.replace(base, false)
    iterate.mockClear()

    const before = feed.getSnapshot()
    const live = entry(SessionSeq(2))
    feed.append(live)
    const after = feed.getSnapshot()

    expect(iterate).not.toHaveBeenCalled()
    expect(before.entries).toEqual([first])
    expect(after.entries).toEqual([first, live])
    expect(after.entries).toBe(after.entries)
    expect(iterate).toHaveBeenCalledOnce()
  })

  it('publishes one exact Assistant settlement delta after retiring its transient rows', () => {
    const feed = new MutableSessionEventSource()
    const opening = entry(SessionSeq(1))
    const live = transient('attempt-one')
    const settlement = assistantSettlement(SessionSeq(2))
    const later = entry(SessionSeq(3))
    feed.replace([opening, live, later], false)

    feed.settleAssistant(LlmAttemptId('attempt-one'), settlement)

    expect(feed.getSnapshot()).toEqual({
      entries: [opening, settlement, later],
      hasMore: false,
      revision: 2,
      change: {
        kind: 'settle-assistant',
        attemptId: 'attempt-one',
        entry: settlement,
      },
    })

    feed.append(transient('attempt-two', 3.5))
    feed.settleAssistant(LlmAttemptId('attempt-two'))
    expect(feed.getSnapshot().entries).toEqual([opening, settlement, later])
    expect(feed.getSnapshot().change).toEqual({
      kind: 'settle-assistant',
      attemptId: 'attempt-two',
    })
  })

  it('appends an Assistant commitment above every published transient', () => {
    const feed = new MutableSessionEventSource()
    const opening = entry(SessionSeq(1))
    const live = transient('attempt-one')
    feed.replace([opening, live], false)
    const settlement = assistantSettlement(SessionSeq(2))

    feed.commitAssistant(settlement)

    expect(feed.getSnapshot()).toEqual({
      entries: [opening, live, settlement],
      hasMore: false,
      revision: 2,
      change: { kind: 'append', entries: [settlement] },
    })
  })

  it('inserts a delayed Assistant commitment at its published sequence position', () => {
    const feed = new MutableSessionEventSource()
    const listener = vi.fn()
    feed.subscribe(listener)
    const opening = entry(SessionSeq(1))
    const live = transient('attempt-one')
    const later = entry(SessionSeq(3))
    feed.replace([opening, live], false)
    feed.append(later)
    listener.mockClear()

    const settlement = assistantSettlement(SessionSeq(2))
    feed.commitAssistant(settlement)

    expect(feed.getSnapshot()).toEqual({
      entries: [opening, live, settlement, later],
      hasMore: false,
      revision: 3,
      change: { kind: 'insert-assistant', entry: settlement },
    })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('tracks a prepended page when the previously published window is empty', () => {
    const feed = new MutableSessionEventSource()
    feed.replace([], true)
    const later = entry(SessionSeq(3))
    feed.prepend([later], false)
    const settlement = assistantSettlement(SessionSeq(2))

    feed.commitAssistant(settlement)

    expect(feed.getSnapshot().entries).toEqual([settlement, later])
    expect(feed.getSnapshot().change).toEqual({ kind: 'insert-assistant', entry: settlement })
  })

  it('does not mutate the entries an earlier snapshot still exposes', () => {
    const feed = new MutableSessionEventSource()
    const opening = entry(SessionSeq(1))
    const live = transient('attempt-one')
    const later = entry(SessionSeq(3))
    const installed = [opening, live, later]
    feed.replace(installed, false)
    const before = feed.getSnapshot()
    expect(before.entries).toBe(installed)

    const settlement = assistantSettlement(SessionSeq(2))
    feed.commitAssistant(settlement)

    expect(before.entries).toBe(installed)
    expect(before.entries).toEqual([opening, live, later])
    expect(feed.getSnapshot().entries).toEqual([opening, live, settlement, later])
  })

  it('leaves the window and its listeners untouched when a settlement retires nothing', () => {
    const feed = new MutableSessionEventSource()
    const listener = vi.fn()
    feed.subscribe(listener)
    const opening = entry(SessionSeq(1))
    const settlement = assistantSettlement(SessionSeq(2))
    feed.replace([opening, settlement], false)
    const published = feed.getSnapshot()
    listener.mockClear()

    feed.settleAssistant(LlmAttemptId('absent-attempt'))
    feed.settleAssistant(LlmAttemptId('absent-attempt'), settlement)

    expect(feed.getSnapshot()).toBe(published)
    expect(listener).not.toHaveBeenCalled()
  })

  it('ignores a duplicate commitment and rejects a conflicting occupant before mutating', () => {
    const feed = new MutableSessionEventSource()
    const opening = entry(SessionSeq(1))
    const live = transient('attempt-one')
    const later = entry(SessionSeq(3))
    feed.replace([opening, live, later], false)
    const settlement = assistantSettlement(SessionSeq(2))
    feed.commitAssistant(settlement)
    const published = feed.getSnapshot()

    feed.commitAssistant(settlement)
    expect(feed.getSnapshot()).toBe(published)

    const conflict = assistantSettlement(SessionSeq(2))
    expect(() => { feed.commitAssistant(conflict) }).toThrow('event window already holds a different entry at seq 2')
    expect(feed.getSnapshot()).toBe(published)
    expect(feed.getSnapshot().entries).toHaveLength(4)
  })

})
