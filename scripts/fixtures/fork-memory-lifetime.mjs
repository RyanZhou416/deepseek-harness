/** Isolated lifecycle/GC fixture: no profile, user data, network, or credentials. */
import assert from 'node:assert/strict'
import { constants, PerformanceObserver } from 'node:perf_hooks'
import { attachLifetimeProbe } from '../../fork-runtime/diagnostics/lifetime.mjs'

class ContextFixture {
  listeners = new Map()
  on(event, callback, options) {
    assert.equal(options.global, true)
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(callback)
    this.listeners.set(event, listeners)
    return () => { listeners.delete(callback) }
  }
  send(event, payload) {
    for (const callback of this.listeners.get(event) ?? []) callback(payload)
  }
  count() {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0)
  }
}

const scenario = process.argv[2]
const ctx = new ContextFixture()
const output = []
let epoch = 0
const options = {
  maxTracked: 20,
  maxDetails: 10,
  minDisposedAgeMs: 60_000,
  getGcEpoch: () => epoch,
  emit: record => { output.push(record) },
}
const realNow = Date.now
let probe
try {
  if (scenario === 'metadata') {
    let now = 1000
    Date.now = () => now
    probe = attachLifetimeProbe(ctx, { ...options, maxDetails: 2 })
    const first = Object.freeze({ seq: 123, id: 'private-session', content: 'private-content' })
    const agent = Object.freeze({ session: first, id: 'private-agent' })
    const second = Object.freeze({ seq: 77 })
    ctx.send('session/created', first)
    ctx.send('agent/created', { agent })
    ctx.send('session/created', second)
    epoch = 2
    now = 2000
    ctx.send('session/disposed', second)
    now = 3000
    ctx.send('agent/disposed', { agent })
    now = 4000
    ctx.send('session/disposed', first)
    now = 63_000
    epoch = 5
    const sample = probe.sample()
    assert.equal(sample.sessionsTracked, 2)
    assert.equal(sample.agentsTracked, 1)
    assert.equal(sample.sessionsDisposedRetained, 2)
    assert.equal(sample.agentsDisposedRetained, 1)
    assert.equal(sample.sessionsDisposedRetainedOverMinAge, 1)
    assert.equal(sample.agentsDisposedRetainedOverMinAge, 1)
    assert.equal(sample.oldestDisposedSessionMs, 61_000)
    assert.equal(sample.disposedSessionEventsRetained, 200)
    assert.equal(sample.disposedAgentEventsRetained, 123)
    assert.deepEqual(sample.details.map(item => item.trackingId), [3, 2])
    assert.deepEqual(sample.details.map(item => item.majorGcSinceDispose), [3, 3])
    assert.deepEqual(sample.details.map(item => item.createdAt), [1000, 1000])
    assert.deepEqual(sample.details.map(item => item.createdGcEpoch), [0, 0])
    assert.equal(sample.sessionsCreated, 2)
    assert.equal(sample.agentsDisposed, 1)
    assert.equal(output.length, 6)
    assert.doesNotMatch(JSON.stringify({ output, sample }), /private-|content|"ref"/u)
    assert.equal(Object.keys(first).length, 3)
    probe.dispose()
    probe.dispose()
    assert.equal(ctx.count(), 0)
    assert.equal(probe.sample().sessionsTracked, 0)
    ctx.send('session/created', first)
    assert.equal(output.length, 6)
  } else if (scenario === 'active-history') {
    probe = attachLifetimeProbe(ctx, options)
    const first = { seq: 10 }
    const second = { seq: 20 }
    const disposed = { seq: 500 }
    const agent = { session: first }
    const disposedAgent = { session: disposed }
    for (const session of [first, second, disposed]) ctx.send('session/created', session)
    ctx.send('agent/created', { agent })
    ctx.send('agent/created', { agent: disposedAgent })
    ctx.send('agent/disposed', { agent: disposedAgent })
    ctx.send('session/disposed', disposed)
    let sample = probe.sample()
    assert.equal(sample.sessionsTracked, 3)
    assert.equal(sample.sessionsActive, 2)
    assert.equal(sample.agentsTracked, 2)
    assert.equal(sample.agentsActive, 1)
    assert.equal(sample.activeSessionEvents, 30)
    assert.equal(sample.maxActiveSessionEvents, 20)
    assert.equal(sample.disposedSessionEventsRetained, 500)
    first.seq = 100
    disposed.seq = 900
    sample = probe.sample()
    assert.equal(sample.activeSessionEvents, 120)
    assert.equal(sample.maxActiveSessionEvents, 100)
    assert.equal(sample.disposedSessionEventsRetained, 500)
  } else if (scenario === 'capacity') {
    probe = attachLifetimeProbe(ctx, { ...options, maxTracked: 1, maxDetails: 0 })
    const first = { seq: 1 }
    const dropped = { seq: 2 }
    ctx.send('session/created', first)
    ctx.send('session/created', dropped)
    ctx.send('session/disposed', first)
    ctx.send('session/disposed', dropped)
    const sample = probe.sample()
    assert.equal(sample.sessionsTracked, 1)
    assert.equal(sample.sessionsCreated, 2)
    assert.equal(sample.sessionsDisposed, 2)
    assert.equal(sample.droppedTracking, 1)
    assert.equal(sample.details.length, 0)
    assert.equal(output.length, 2)
  } else if (scenario === 'failure-containment') {
    probe = attachLifetimeProbe(ctx, { ...options, emit: () => { throw Error('sink unavailable') } })
    const first = { seq: 3 }
    ctx.send('session/created', first)
    ctx.send('session/disposed', first)
    assert.equal(probe.sample().emitErrors, 2)
    assert.equal(probe.sample().sessionsDisposedRetained, 1)
    probe.dispose()
    assert.equal(ctx.count(), 0)
    const brokenContext = new ContextFixture()
    const originalOn = brokenContext.on
    brokenContext.on = function (event, callback, listenerOptions) {
      if (event === 'agent/created') throw Error('registration failed')
      return originalOn.call(this, event, callback, listenerOptions)
    }
    assert.throws(() => attachLifetimeProbe(brokenContext, options), /registration failed/u)
    assert.equal(brokenContext.count(), 0)
    assert.throws(() => attachLifetimeProbe(ctx, { ...options, maxTracked: 0 }), /maxTracked/u)
    assert.throws(() => attachLifetimeProbe(ctx, { ...options, maxDetails: -1 }), /maxDetails/u)
    assert.throws(() => attachLifetimeProbe(ctx, { ...options, minDisposedAgeMs: NaN }), /minDisposedAgeMs/u)
    assert.throws(() => attachLifetimeProbe(ctx, { ...options, emit: null }), /emit/u)
  } else if (scenario === 'real-gc') {
    assert.equal(typeof global.gc, 'function')
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR) epoch += 1
      }
    })
    observer.observe({ entryTypes: ['gc'] })
    try {
      probe = attachLifetimeProbe(ctx, { ...options, maxTracked: 3 })
      const intentionallyRetained = [{ seq: 999 }]
      ctx.send('session/created', intentionallyRetained[0])
      ctx.send('session/disposed', intentionallyRetained[0])
      const weak = (() => {
        const session = Object.freeze({ seq: 20 })
        const agent = Object.freeze({ session })
        ctx.send('session/created', session)
        ctx.send('agent/created', { agent })
        ctx.send('agent/disposed', { agent })
        ctx.send('session/disposed', session)
        return [new WeakRef(session), new WeakRef(agent)]
      })()
      assert.equal(probe.sample().sessionsTracked, 2)
      let sample
      const deadline = realNow() + 10_000
      do {
        // Every GC runs in a new job after the previous sample's dereferences.
        await new Promise(setImmediate)
        global.gc()
        await new Promise(setImmediate)
        sample = probe.sample()
        if (sample.sessionsCollected === 1 && sample.agentsCollected === 1 && epoch > 0) break
      } while (realNow() < deadline)
      assert.equal(sample.sessionsCollected, 1)
      assert.equal(sample.agentsCollected, 1)
      assert.equal(weak[0].deref(), undefined)
      assert.equal(weak[1].deref(), undefined)
      assert.equal(sample.sessionsTracked, 1)
      assert.equal(sample.details[0].majorGcSinceDispose, epoch)
      assert.ok(epoch > 0)
      assert.equal(intentionallyRetained[0].seq, 999)
      const replacement = { seq: 1 }
      ctx.send('session/created', replacement)
      assert.equal(probe.sample().sessionsTracked, 2)
      assert.equal(probe.sample().droppedTracking, 0)
    } finally {
      observer.disconnect()
    }
  } else {
    throw Error(`unknown fixture scenario: ${scenario}`)
  }
} finally {
  probe?.dispose()
  Date.now = realNow
}
assert.equal(ctx.count(), 0)
console.log(JSON.stringify({ scenario, passed: true }))
