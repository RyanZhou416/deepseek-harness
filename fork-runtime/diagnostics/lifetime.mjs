/** Weak lifecycle observations for the fork's opt-in memory diagnostics. */

/**
 * Observe newly announced Agents and Sessions without owning their lifetime.
 * Samples dereference targets synchronously. Callers must leave a new event-loop
 * turn between a sample and a forced GC; WeakRef keeps a dereferenced target alive
 * until the current JavaScript job ends. Event counts describe the dispose event,
 * not retained bytes, and Agent counts can overlap their Session counts.
 * @param {object} ctx - Cordis context whose on method returns listener disposers.
 * @param {object} options - Bounded tracking, age threshold, GC counter, and sink.
 * @param {number} options.maxTracked - Maximum combined Agent and Session records.
 * @param {number} options.maxDetails - Maximum oldest disposed records per sample.
 * @param {number} options.minDisposedAgeMs - Age threshold for retained totals.
 * @param {() => number} options.getGcEpoch - Monotonic observed major-GC count.
 * @param {(record: object) => void} options.emit - Synchronous metadata-only sink.
 * @returns {{sample: () => object, dispose: () => void}} Synchronous sampler and idempotent teardown.
 */
export function attachLifetimeProbe(ctx, options) {
  const { maxTracked, maxDetails, minDisposedAgeMs, getGcEpoch, emit } = options
  for (const [name, value, minimum] of [
    ['maxTracked', maxTracked, 1],
    ['maxDetails', maxDetails, 0],
    ['minDisposedAgeMs', minDisposedAgeMs, 0],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`memory lifetime ${name} must be a safe integer >= ${minimum}`)
    }
  }
  if (typeof getGcEpoch !== 'function' || typeof emit !== 'function') {
    throw new Error('memory lifetime getGcEpoch and emit must be functions')
  }

  let index = new WeakMap()
  const records = new Map()
  const detachers = []
  let closed = false
  let nextId = 0
  let droppedTracking = 0
  let callbackErrors = 0
  let emitErrors = 0
  const totals = {
    sessionsCreated: 0,
    sessionsDisposed: 0,
    sessionsCollected: 0,
    agentsCreated: 0,
    agentsDisposed: 0,
    agentsCollected: 0,
  }

  const publish = record => {
    try { emit(record) } catch (error) {
      // The diagnostic sink must not interrupt an application lifecycle event.
      emitErrors += 1
    }
  }
  const observe = (kind, target, disposed, eventCount) => {
    if (closed) return
    const prefix = kind === 'session' ? 'sessions' : 'agents'
    totals[`${prefix}${disposed ? 'Disposed' : 'Created'}`] += 1
    let record = index.get(target)
    if (record === null) return
    const at = Date.now()
    const gcEpoch = getGcEpoch()
    if (record === undefined) {
      if (records.size >= maxTracked) {
        index.set(target, null)
        droppedTracking += 1
        return
      }
      record = {
        trackingId: ++nextId,
        kind,
        ref: new WeakRef(target),
        createdAt: disposed ? null : at,
        createdGcEpoch: disposed ? null : gcEpoch,
        disposedAt: null,
        disposedGcEpoch: null,
        eventsAtDispose: null,
      }
      index.set(target, record)
      records.set(record.trackingId, record)
    }
    if (disposed) {
      if (record.disposedAt !== null) return
      record.disposedAt = at
      record.disposedGcEpoch = gcEpoch
      record.eventsAtDispose = eventCount
    }
    publish({
      type: 'lifetime',
      action: disposed ? 'disposed' : 'created',
      trackingId: record.trackingId,
      kind,
      at,
      gcEpoch,
      ...(disposed ? { eventsAtDispose: eventCount } : {}),
    })
  }
  const listen = (event, observer) => {
    detachers.push(ctx.on(event, payload => {
      try { observer(payload) } catch (error) {
        // Instrumentation failures must not veto creation or disposal.
        callbackErrors += 1
      }
    }, { global: true }))
  }
  const dispose = () => {
    if (closed) return
    closed = true
    for (const detach of detachers.splice(0).reverse()) {
      try { detach() } catch (error) {
        // Continue releasing remaining listeners if one owner is already gone.
        callbackErrors += 1
      }
    }
    records.clear()
    index = new WeakMap()
  }
  try {
    listen('session/created', session => { observe('session', session, false, null) })
    listen('session/disposed', session => { observe('session', session, true, session.seq) })
    listen('agent/created', ({ agent }) => { observe('agent', agent, false, null) })
    listen('agent/disposed', ({ agent }) => { observe('agent', agent, true, agent.session.seq) })
  } catch (error) {
    dispose()
    throw error
  }

  const sample = () => {
    const at = Date.now()
    const gcEpoch = getGcEpoch()
    const summary = {
      at,
      gcEpoch,
      sessionsTracked: 0,
      sessionsActive: 0,
      activeSessionEvents: 0,
      maxActiveSessionEvents: 0,
      sessionsDisposedRetained: 0,
      sessionsDisposedRetainedOverMinAge: 0,
      oldestDisposedSessionMs: 0,
      disposedSessionEventsRetained: 0,
      agentsTracked: 0,
      agentsActive: 0,
      agentsDisposedRetained: 0,
      agentsDisposedRetainedOverMinAge: 0,
      oldestDisposedAgentMs: 0,
      disposedAgentEventsRetained: 0,
    }
    const details = []
    for (const record of records.values()) {
      const prefix = record.kind === 'session' ? 'sessions' : 'agents'
      const singular = record.kind === 'session' ? 'Session' : 'Agent'
      const target = record.ref.deref()
      if (target === undefined) {
        records.delete(record.trackingId)
        totals[`${prefix}Collected`] += 1
        continue
      }
      summary[`${prefix}Tracked`] += 1
      if (record.disposedAt === null) {
        summary[`${prefix}Active`] += 1
        if (record.kind === 'session') {
          const events = target.seq
          summary.activeSessionEvents += events
          summary.maxActiveSessionEvents = Math.max(summary.maxActiveSessionEvents, events)
        }
        continue
      }
      const ageMs = Math.max(0, at - record.disposedAt)
      summary[`${prefix}DisposedRetained`] += 1
      if (ageMs >= minDisposedAgeMs) summary[`${prefix}DisposedRetainedOverMinAge`] += 1
      summary[`oldestDisposed${singular}Ms`] = Math.max(summary[`oldestDisposed${singular}Ms`], ageMs)
      summary[`disposed${singular}EventsRetained`] += record.eventsAtDispose
      if (maxDetails === 0) continue
      const detail = {
        trackingId: record.trackingId,
        kind: record.kind,
        createdAt: record.createdAt,
        createdGcEpoch: record.createdGcEpoch,
        disposedAt: record.disposedAt,
        disposedGcEpoch: record.disposedGcEpoch,
        ageMs,
        majorGcSinceDispose: Math.max(0, gcEpoch - record.disposedGcEpoch),
        eventsAtDispose: record.eventsAtDispose,
      }
      const position = details.findIndex(item => item.disposedAt > detail.disposedAt)
      if (position === -1) {
        if (details.length < maxDetails) details.push(detail)
      } else {
        details.splice(position, 0, detail)
        if (details.length > maxDetails) details.pop()
      }
    }
    return { ...summary, ...totals, minDisposedAgeMs, details, droppedTracking, callbackErrors, emitErrors }
  }
  return { sample, dispose }
}
