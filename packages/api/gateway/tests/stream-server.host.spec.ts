import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf, type PeerId, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  RemoteStreamMuxServer,
  type RemoteStreamFailureMapper,
  type RemoteStreamOpener,
} from '../src/stream-server.ts'

interface RunningMux {
  readonly http: Server
  readonly mux: RemoteStreamMuxServer
  readonly url: string
}

const running = new Set<RunningMux>()

afterEach(async () => {
  try {
    await Promise.all([...running].map(async (entry) => {
      running.delete(entry)
      await entry.mux.close().catch(() => undefined)
      await closeHttp(entry.http)
    }))
  } finally {
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

describe('Remote stream mux server carrier lifecycle', () => {
  it('keeps one pending Ping while the transport makes write progress', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'] })
    let transport: GatedDuplex | undefined
    const entry = await startMux(
      async (_endpoint, _payload, _uplink, _peer, control) => waitForAbort(control.signal),
      100,
      262_144,
      undefined,
      (socket) => {
        transport = new GatedDuplex(socket)
        return transport
      },
    )
    const client = await connect(entry.url, false)
    if (transport === undefined) throw new Error('fixture transport has not upgraded')
    const serverSocket = acceptedSocket(entry.mux)
    const ping = vi.spyOn(serverSocket, 'ping')
    const receivedPing = vi.fn()
    client.on('ping', receivedPing)
    transport.hold = true
    serverSocket.send('synthetic payload', () => {})

    await vi.advanceTimersByTimeAsync(100)
    await transport.flushOne()
    await vi.advanceTimersByTimeAsync(100)
    await transport.flushOne()
    await vi.advanceTimersByTimeAsync(101)

    expect(receivedPing).not.toHaveBeenCalled()
    expect(serverSocket.readyState).toBe(WebSocket.OPEN)
    expect(ping).toHaveBeenCalledOnce()
    const received = once(client, 'ping')
    await transport.release()
    await received
    const pong = once(serverSocket, 'pong')
    client.pong()
    await pong
    await vi.advanceTimersByTimeAsync(100)
    expect(ping).toHaveBeenCalledTimes(2)
  })

  it('sends WebSocket Ping control frames without application messages', async () => {
    const entry = await startMux(async (_endpoint, _payload, _uplink, _peer, control) => waitForAbort(control.signal), 20)
    const client = await connect(entry.url)
    const serverSocket = acceptedSocket(entry.mux)
    const messages = vi.fn()
    client.on('message', messages)

    const ping = once(client, 'ping')
    const pong = once(serverSocket, 'pong')
    expect((await ping)[0]).toEqual(Buffer.alloc(0))
    expect((await pong)[0]).toEqual(Buffer.alloc(0))
    expect(messages).not.toHaveBeenCalled()

    const closingPing = vi.spyOn(serverSocket, 'ping')
    client.pause()
    serverSocket.close()
    expect(serverSocket.readyState).toBe(WebSocket.CLOSING)
    await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
    expect(closingPing).not.toHaveBeenCalled()

    const closed = once(client, 'close')
    client.resume()
    await closed
  })

  it('requires two missed intervals after a completed Ping before terminating an unresponsive socket', async () => {
    const fixture = await heartbeatFixture()
    await fixture.tick()
    fixture.complete(0)
    await fixture.tick()
    fixture.check()
    expect(fixture.socket.readyState).toBe(WebSocket.OPEN)
    await fixture.tick()
    const closed = once(fixture.client, 'close')
    fixture.check()
    await closed
    expect(fixture.ping).toHaveBeenCalledOnce()
    expect(fixture.terminated).toHaveBeenCalledOnce()
    expect(fixture.warning).toHaveBeenCalledExactlyOnceWith('[api-gateway] WebSocket heartbeat failed', {
      reason: 'timeout', phase: 'awaitingPong', bufferedBytes: 100,
    })
  })

  it('terminates a Ping write that makes no progress for two intervals', async () => {
    const fixture = await heartbeatFixture()
    await fixture.tick()
    await fixture.tick()
    fixture.check()
    expect(fixture.socket.readyState).toBe(WebSocket.OPEN)
    await fixture.tick()
    const closed = once(fixture.client, 'close')
    fixture.check()
    await closed
    expect(fixture.ping).toHaveBeenCalledOnce()
    expect(fixture.terminated).toHaveBeenCalledOnce()
    expect(fixture.warning).toHaveBeenCalledExactlyOnceWith('[api-gateway] WebSocket heartbeat failed', {
      reason: 'timeout', phase: 'writing', bufferedBytes: 100,
    })
  })

  it('requires two newly stalled intervals after observed write progress', async () => {
    const fixture = await heartbeatFixture()
    await fixture.tick()
    await fixture.tick()
    fixture.buffered.mockReturnValue(80)
    await fixture.tick()
    fixture.check()
    expect(fixture.socket.readyState).toBe(WebSocket.OPEN)
    fixture.buffered.mockReturnValue(100)
    await fixture.tick()
    fixture.check()
    expect(fixture.socket.readyState).toBe(WebSocket.OPEN)
    await fixture.tick()
    const closed = once(fixture.client, 'close')
    fixture.check()
    await closed
    expect(fixture.terminated).toHaveBeenCalledOnce()
  })

  it.each(['progress', 'flush', 'pong'] as const)('keeps the socket when %s arrives before the final check', async (event) => {
    const fixture = await heartbeatFixture()
    await fixture.tick()
    await fixture.tick()
    await fixture.tick()
    expect(fixture.checks).toHaveLength(1)
    if (event === 'progress') fixture.buffered.mockReturnValue(80)
    else if (event === 'flush') fixture.complete(0)
    else fixture.socket.emit('pong', Buffer.alloc(0))
    fixture.check()
    expect(fixture.terminated).not.toHaveBeenCalled()
    expect(fixture.warning).not.toHaveBeenCalled()
    await fixture.tick()
    fixture.check()
    expect(fixture.socket.readyState).toBe(WebSocket.OPEN)
  })

  it.each([undefined, new Error('old Ping write failed')])('ignores an old write callback after Pong and a new probe: %s', async (error) => {
    const fixture = await heartbeatFixture()
    await fixture.tick()
    fixture.socket.emit('pong', Buffer.alloc(0))
    await fixture.tick()
    expect(fixture.ping).toHaveBeenCalledTimes(2)
    await fixture.tick()
    fixture.complete(0, error)
    expect(fixture.terminated).not.toHaveBeenCalled()
    await fixture.tick()
    const closed = once(fixture.client, 'close')
    fixture.check()
    await closed
    expect(fixture.terminated).toHaveBeenCalledOnce()
    expect(fixture.warning).toHaveBeenCalledExactlyOnceWith('[api-gateway] WebSocket heartbeat failed', {
      reason: 'timeout', phase: 'writing', bufferedBytes: 100,
    })
  })

  it('terminates the current Ping write error without throwing', async () => {
    const fixture = await heartbeatFixture()
    await fixture.tick()
    const closed = once(fixture.client, 'close')
    expect(() => { fixture.complete(0, new Error('fixture Ping write failed')) }).not.toThrow()
    await closed
    expect(fixture.terminated).toHaveBeenCalledOnce()
    expect(fixture.warning).toHaveBeenCalledExactlyOnceWith('[api-gateway] WebSocket heartbeat failed', {
      reason: 'write-error', phase: 'writing', bufferedBytes: 100,
    })
  })

  it('ignores a pending check and write callback after socket disposal', async () => {
    const fixture = await heartbeatFixture()
    await fixture.tick()
    await fixture.tick()
    await fixture.tick()
    expect(fixture.checks).toHaveLength(1)
    const closed = once(fixture.client, 'close')
    await fixture.entry.mux.close()
    running.delete(fixture.entry)
    await closed
    fixture.complete(0, new Error('late write error'))
    fixture.check()
    await fixture.tick()
    expect(fixture.terminated).toHaveBeenCalledOnce()
    expect(fixture.ping).toHaveBeenCalledOnce()
    await closeHttp(fixture.entry.http)
  })

  it('rejects binary, malformed, and duplicate logical-stream messages', async () => {
    const entry = await startMux(async (_endpoint, _payload, _uplink, _peer, control) => waitForAbort(control.signal))

    const binary = await connect(entry.url)
    const binaryClosed = once(binary, 'close')
    binary.send(Buffer.from('{}'))
    const binaryEvent = await binaryClosed
    expect(binaryEvent[0]).toBe(1003)

    const malformed = await connect(entry.url)
    const malformedClosed = once(malformed, 'close')
    malformed.send('not json')
    const malformedEvent = await malformedClosed
    expect(malformedEvent[0]).toBe(1008)
    expect(String(malformedEvent[1])).toBe('invalid Remote stream request')

    const duplicate = await connect(entry.url)
    const longId = 'same'.repeat(100)
    duplicate.send(openFrame(longId))
    duplicate.send(openFrame(longId))
    const duplicateEvent = await once(duplicate, 'close')
    expect(duplicateEvent[0]).toBe(1008)
    expect(String(duplicateEvent[1])).toBe('invalid Remote stream request')

    const unknownType = await connect(entry.url)
    unknownType.send(openFrame('unknown-type'))
    unknownType.send(JSON.stringify({ type: 'input', streamId: 'unknown-type', value: 'unexpected' }))
    const unknownTypeEvent = await once(unknownType, 'close')
    expect(unknownTypeEvent[0]).toBe(1008)
    expect(String(unknownTypeEvent[1])).toBe('invalid Remote stream request')
  })

  it('accepts all ws text representations and terminates a carrier error', async () => {
    const entry = await startMux(async (_endpoint, _payload, _uplink, _peer, control) => waitForAbort(control.signal))
    const client = await connect(entry.url)
    const serverSocket = acceptedSocket(entry.mux)
    const cancel = JSON.stringify({ type: 'cancel', streamId: 'absent' })

    serverSocket.emit('message', [Buffer.from(cancel)], false)
    serverSocket.emit('message', Uint8Array.from(Buffer.from(cancel)).buffer, false)

    const closed = once(client, 'close')
    serverSocket.emit('error', new Error('fixture carrier failure'))
    await closed
  })

  it('does not send an end frame after clean source cancellation', async () => {
    let opened!: () => void
    const didOpen = new Promise<void>((resolve) => { opened = resolve })
    let returned!: () => void
    const didReturn = new Promise<void>((resolve) => { returned = resolve })
    const entry = await startMux(async (_endpoint, _payload, _uplink, _peer, control) => {
      opened()
      return cleanlyCancelled(control.signal, returned)
    })
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    client.send(openFrame('cancelled'))
    await didOpen
    client.send(JSON.stringify({ type: 'cancel', streamId: 'cancelled' }))
    await didReturn
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(frames).toEqual([])
    client.close()
    await once(client, 'close')
  })

  it('closes the carrier when ws reports an item write failure', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    let opened!: () => void
    const didOpen = new Promise<void>((resolve) => { opened = resolve })
    const entry = await startMux(async () => delayedItem(released, opened))
    const client = await connect(entry.url)
    client.send(openFrame('write-failure'))
    await didOpen
    failWrites(acceptedSocket(entry.mux))

    const closed = once(client, 'close')
    release()
    const closeEvent = await closed
    expect(closeEvent[0]).toBe(1011)
    expect(String(closeEvent[1])).toBe('Remote stream failure could not be delivered')
  })

  it('closes the carrier when the end frame cannot be written', async () => {
    const entry = await startMux(async () => (async function *(): AsyncIterable<never> {})())
    const client = await connect(entry.url)
    failWrites(acceptedSocket(entry.mux))

    const closed = once(client, 'close')
    client.send(openFrame('empty'))
    const closeEvent = await closed
    expect(closeEvent[0]).toBe(1011)
    expect(String(closeEvent[1])).toBe('Remote stream failure could not be delivered')
  })

  it('leaves a failed stream silent once its socket is no longer open', async () => {
    const opened = Promise.withResolvers<undefined>()
    const entry = await startMux(async () => {
      opened.resolve(undefined)
      throw new Error('fixture opener failure')
    })
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    const serverSocket = acceptedSocket(entry.mux)
    Object.defineProperty(serverSocket, 'readyState', { configurable: true, value: WebSocket.CLOSING })
    try {
      client.send(openFrame('silent'))
      await opened.promise
      // The failure path awaits nothing before it inspects the socket, so one
      // macrotask hop drains every microtask it can schedule.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(frames).toEqual([])
    } finally {
      Reflect.deleteProperty(serverSocket, 'readyState')
    }
    expect(serverSocket.readyState).toBe(WebSocket.OPEN)
    client.close()
    await once(client, 'close')
  })

  it('contains an item produced after its socket closes', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    let opened!: () => void
    const didOpen = new Promise<void>((resolve) => { opened = resolve })
    let returned!: () => void
    const didReturn = new Promise<void>((resolve) => { returned = resolve })
    const entry = await startMux(async () => delayedItem(released, opened, returned))
    const client = await connect(entry.url)
    client.send(openFrame('late-item'))
    await didOpen
    const serverSocket = acceptedSocket(entry.mux)
    client.close()
    await once(client, 'close')
    await vi.waitFor(() => { expect(serverSocket.readyState).toBe(WebSocket.CLOSED) })
    release()
    await didReturn
  })

  it('terminates active sockets on close and reports a repeated close', async () => {
    let opened!: () => void
    const didOpen = new Promise<void>((resolve) => { opened = resolve })
    let returned!: () => void
    const didReturn = new Promise<void>((resolve) => { returned = resolve })
    const entry = await startMux(async (_endpoint, _payload, _uplink, _peer, control) => {
      opened()
      return cleanlyCancelled(control.signal, returned)
    })
    const client = await connect(entry.url)
    client.send(openFrame('active'))
    await didOpen

    const closed = once(client, 'close')
    await entry.mux.close()
    running.delete(entry)
    await closed
    await didReturn
    await expect(entry.mux.close()).rejects.toThrow()
    await closeHttp(entry.http)
  })
})

describe('Remote stream mux server Peer binding', () => {
  it('closes an upgrade at once when the admitted Peer scope is already disposed', async () => {
    const peer = await fixturePeer()
    await peer.dispose()
    const opened = vi.fn()
    const entry = await startMux(async (_endpoint, _payload, _uplink, _peer, control) => {
      opened()
      return waitForAbort(control.signal)
    }, 2_000, 262_144, peer)
    const client = new WebSocket(entry.url)
    const closeEvent = await once(client, 'close')
    expect(closeEvent[0]).toBe(1001)
    expect(String(closeEvent[1])).toBe('peer left')
    expect(opened).not.toHaveBeenCalled()
  })

  it('hands the admitted Peer to every opener and closes the socket when its scope is disposed', async () => {
    const peer = await fixturePeer()
    const seen: PeerScope[] = []
    const entry = await startMux(async (_endpoint, _payload, _uplink, opened, control) => {
      seen.push(opened)
      return waitForAbort(control.signal)
    }, 2_000, 262_144, peer)
    const client = await connect(entry.url)
    client.send(openFrame('bound'))
    await vi.waitFor(() => { expect(seen).toHaveLength(1) })
    expect(seen[0]).toBe(peer)

    const closed = once(client, 'close')
    await peer.dispose()
    const closeEvent = await closed
    expect(closeEvent[0]).toBe(1001)
    expect(String(closeEvent[1])).toBe('peer left')
  })
})

describe('Remote stream mux server uplink', () => {
  it('buffers uplink items sent before the opener resolves and half-closes on end', async () => {
    const release = Promise.withResolvers<undefined>()
    const entry = await startMux(async (_endpoint, _payload, uplink) => {
      await release.promise
      return echoUplink(uplink)
    })
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    const received = countMessages(acceptedSocket(entry.mux))
    client.send(openFrame('echo'))
    client.send(itemFrame('echo', 'one'))
    client.send(itemFrame('echo'))
    await vi.waitFor(() => { expect(received.count).toBe(3) })
    expect(frames).toEqual([])

    release.resolve(undefined)
    await vi.waitFor(() => {
      expect(frames).toEqual([
        { type: 'item', streamId: 'echo', value: 'one' },
        { type: 'item', streamId: 'echo' },
      ])
    })
    client.send(endFrame('echo'))
    await vi.waitFor(() => { expect(frames.at(-1)).toEqual({ type: 'end', streamId: 'echo' }) })
    expect(frames).toHaveLength(3)
    client.close()
    await once(client, 'close')
  })

  it('fails a stream on an item after end and keeps the socket open', async () => {
    const entry = await startMux(async (endpoint, _payload, uplink, _peer, control) =>
      endpoint === 'fixture/echo' ? echoUplink(uplink) : waitForAbort(control.signal))
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    client.send(openFrame('held'))
    client.send(endFrame('held'))
    client.send(endFrame('held'))
    client.send(itemFrame('held', 'late'))
    await vi.waitFor(() => {
      expect(frames).toEqual([{
        type: 'error',
        streamId: 'held',
        error: {
          code: 'gateway/protocol',
          message: 'api gateway: Remote stream uplink item after end',
          details: { endpoint: 'fixture/follow' },
        },
      }])
    })

    expect(client.readyState).toBe(WebSocket.OPEN)
    client.send(openFrame('again', 'fixture/echo'))
    client.send(itemFrame('again', 'still served'))
    await vi.waitFor(() => {
      expect(frames.at(-1)).toEqual({ type: 'item', streamId: 'again', value: 'still served' })
    })
    client.close()
    await once(client, 'close')
  })

  it('fails a stream whose buffered uplink exceeds the configured bytes and drops later items', async () => {
    const release = Promise.withResolvers<undefined>()
    const entry = await startMux(async () => (async function *(): AsyncIterable<never> {
      await release.promise
    })(), 2_000, 48)
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    const received = countMessages(acceptedSocket(entry.mux))
    client.send(openFrame('big'))
    client.send(itemFrame('big', 'x'.repeat(64)))
    client.send(itemFrame('big', 'dropped'))
    client.send(endFrame('big'))
    await vi.waitFor(() => { expect(received.count).toBe(4) })
    expect(frames).toEqual([])

    release.resolve(undefined)
    await vi.waitFor(() => {
      expect(frames).toEqual([{
        type: 'error',
        streamId: 'big',
        error: {
          code: 'gateway/uplink-overflow',
          message: 'api gateway: Remote stream uplink exceeded 48 buffered bytes',
          details: { endpoint: 'fixture/follow' },
        },
      }])
    })
    client.close()
    await once(client, 'close')
  })

  it('drops uplink frames for a stream it no longer owns and keeps the socket open', async () => {
    const entry = await startMux(async (endpoint, _payload, uplink, _peer, control) =>
      endpoint === 'fixture/echo' ? echoUplink(uplink) : waitForAbort(control.signal))
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    const received = countMessages(acceptedSocket(entry.mux))
    client.send(itemFrame('absent', 1))
    client.send(endFrame('absent'))
    client.send(openFrame('live', 'fixture/echo'))
    client.send(itemFrame('live', 'served'))
    await vi.waitFor(() => { expect(received.count).toBe(4) })
    await vi.waitFor(() => { expect(frames).toEqual([{ type: 'item', streamId: 'live', value: 'served' }]) })
    expect(client.readyState).toBe(WebSocket.OPEN)
    client.close()
    await once(client, 'close')
  })

  it('ends a pending uplink read when the socket closes', async () => {
    const read = Promise.withResolvers<unknown>()
    const opened = Promise.withResolvers<undefined>()
    const entry = await startMux(async (_endpoint, _payload, uplink, _peer, control) => {
      uplink[Symbol.asyncIterator]().next().then(read.resolve, read.resolve)
      opened.resolve(undefined)
      return waitForAbort(control.signal)
    })
    const client = await connect(entry.url)
    client.send(openFrame('pending'))
    await opened.promise
    client.close()
    await once(client, 'close')
    await expect(read.promise).resolves.toMatchObject({ message: 'Remote stream socket closed' })
  })

  it('drops uplink items after the Host stops reading', async () => {
    const release = Promise.withResolvers<undefined>()
    const returned = Promise.withResolvers<undefined>()
    const entry = await startMux(async (_endpoint, _payload, uplink) => {
      const iterator = uplink[Symbol.asyncIterator]()
      const first: IteratorResult<unknown, undefined> = await iterator.next()
      await iterator.return?.()
      returned.resolve(undefined)
      return (async function *(): AsyncIterable<unknown> {
        await release.promise
        yield { first: first.value, afterReturn: (await iterator.next()).done }
      })()
    })
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    const received = countMessages(acceptedSocket(entry.mux))
    client.send(openFrame('closed'))
    client.send(itemFrame('closed', 'one'))
    await returned.promise
    client.send(itemFrame('closed', 'two'))
    client.send(endFrame('closed'))
    client.send(itemFrame('closed', 'three'))
    await vi.waitFor(() => { expect(received.count).toBe(5) })

    release.resolve(undefined)
    await vi.waitFor(() => {
      expect(frames).toEqual([
        { type: 'item', streamId: 'closed', value: { first: 'one', afterReturn: true } },
        { type: 'end', streamId: 'closed' },
      ])
    })
    client.close()
    await once(client, 'close')
  })

  it('reports a second uplink consumer and a second pending read as stream failures', async () => {
    const entry = await startMux(async (endpoint, _payload, uplink) => {
      const iterator = uplink[Symbol.asyncIterator]()
      if (endpoint === 'fixture/twice') uplink[Symbol.asyncIterator]()
      void iterator.next().catch(() => undefined)
      await iterator.next()
      return echoUplink(uplink)
    })
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    client.send(openFrame('twice', 'fixture/twice'))
    client.send(openFrame('pending', 'fixture/pending'))
    await vi.waitFor(() => {
      expect(frames).toEqual(expect.arrayContaining([
        {
          type: 'error',
          streamId: 'twice',
          error: { code: 'internal', message: 'api gateway: Remote stream uplink inbox already has a consumer', details: {} },
        },
        {
          type: 'error',
          streamId: 'pending',
          error: { code: 'internal', message: 'api gateway: Remote stream uplink inbox has one pending read', details: {} },
        },
      ]))
    })
    expect(frames).toHaveLength(2)
    client.close()
    await once(client, 'close')
  })
})

const mapFailure: RemoteStreamFailureMapper = (error) => {
  const remote = remoteErrorOf(error)
  if (remote !== undefined) return { code: remote.code, message: remote.message, details: remote.details }
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  }
}

/** Control public ws callbacks and timer phases without altering mux-owned heartbeat state. */
async function heartbeatFixture() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const entry = await startMux(async (_endpoint, _payload, _uplink, _peer, control) => waitForAbort(control.signal), 100)
  const client = await connect(entry.url, false)
  const socket = acceptedSocket(entry.mux)
  const completions: ((error?: Error) => void)[] = []
  const ping = vi.spyOn(socket, 'ping').mockImplementation((_data, _mask, callback) => {
    if (callback === undefined) throw new Error('fixture expected a Ping completion callback')
    // ws types require an Error, but successful writes call back without one.
    completions.push((error) => { Reflect.apply(callback, undefined, error === undefined ? [] : [error]) })
  })
  const buffered = vi.spyOn(socket, 'bufferedAmount', 'get').mockReturnValue(100)
  const terminated = vi.spyOn(socket, 'terminate')
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const checks: (() => void)[] = []
  const immediate = globalThis.setImmediate
  vi.spyOn(globalThis, 'setImmediate').mockImplementation((callback) => {
    checks.push(callback)
    return immediate(() => {})
  })
  return {
    entry, client, socket, ping, buffered, terminated, warning, checks,
    tick: () => vi.advanceTimersByTimeAsync(100),
    complete: (index: number, error?: Error): void => {
      const callback = completions[index]
      if (callback === undefined) throw new Error('fixture has no Ping completion at that index')
      callback(error)
    },
    check: (): void => {
      for (const callback of checks.splice(0)) callback()
    },
  }
}

async function startMux(
  open: RemoteStreamOpener,
  heartbeatIntervalMs = 2_000,
  streamInboxBytes = 262_144,
  peer?: PeerScope,
  wrapSocket: (socket: Duplex) => Duplex = socket => socket,
): Promise<RunningMux> {
  const admitted = peer ?? await fixturePeer()
  const mux = new RemoteStreamMuxServer(open, mapFailure, heartbeatIntervalMs, streamInboxBytes)
  const http = createServer()
  http.on('upgrade', (request, socket, head) => { mux.handleUpgrade(request, wrapSocket(socket), head, admitted) })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject)
      resolve()
    })
  })
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('fixture HTTP server has no TCP port')
  const entry = { http, mux, url: `ws://127.0.0.1:${String(address.port)}` }
  running.add(entry)
  return entry
}

/** A real ws transport whose write completions advance only through the fixture's gate. */
class GatedDuplex extends Duplex {
  hold = false
  private pending: { readonly chunk: Buffer; readonly callback: (error?: Error | null) => void } | undefined

  constructor(private readonly socket: Duplex) {
    super({ highWaterMark: 1 })
    socket.on('data', (data: Buffer) => { if (!this.push(data)) socket.pause() })
    socket.on('end', () => { this.push(null) })
    socket.on('error', (error: Error) => { this.destroy(error) })
    socket.on('close', () => { this.destroy() })
  }

  override _read(): void { this.socket.resume() }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.hold) this.pending = { chunk, callback }
    else this.socket.write(chunk, callback)
  }

  async flushOne(): Promise<void> {
    const pending = this.pending
    if (pending === undefined) throw new Error('fixture has no held write')
    this.pending = undefined
    await new Promise<void>((resolve, reject) => {
      this.socket.write(pending.chunk, (error) => {
        pending.callback(error)
        if (error) reject(error)
        else resolve()
      })
    })
  }

  async release(): Promise<void> {
    this.hold = false
    await this.flushOne()
  }

  override _final(callback: () => void): void { this.socket.end(callback) }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    const pending = this.pending
    this.pending = undefined
    pending?.callback(error ?? new Error('fixture gated transport destroyed'))
    this.socket.destroy()
    callback(error)
  }
}

/** A Peer whose scope is a plain Cordis fiber, so `peer.ctx.effect` and `dispose()` behave as the registry's do. */
async function fixturePeer(): Promise<PeerScope> {
  const root = new Context()
  const fiber = root.plugin(() => {})
  await fiber
  return {
    id: 'fixture-peer' as PeerId,
    ctx: fiber.ctx,
    dispose: async () => { await fiber.dispose() },
  }
}

async function connect(url: string, autoPong = true): Promise<WebSocket> {
  const socket = new WebSocket(url, { autoPong })
  await once(socket, 'open')
  return socket
}

function acceptedSocket(mux: RemoteStreamMuxServer): WebSocket {
  const exposed = mux as unknown as { server: { clients: Set<WebSocket> } }
  const socket = [...exposed.server.clients][0]
  if (socket === undefined) throw new Error('fixture mux has no accepted socket')
  return socket
}

function collectFrames(client: WebSocket): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  client.on('message', (data) => {
    if (!Buffer.isBuffer(data)) throw new TypeError('fixture expected a Buffer frame')
    frames.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>)
  })
  return frames
}

/** Count the text frames the mux has already dispatched, so a test can wait for the Host to hold them. */
function countMessages(serverSocket: WebSocket): { count: number } {
  const received = { count: 0 }
  serverSocket.on('message', () => { received.count += 1 })
  return received
}

function failWrites(serverSocket: WebSocket): void {
  const mutable = serverSocket as {
    send(data: unknown, callback: (error?: Error) => void): void
  }
  mutable.send = (_data, callback): void => {
    callback(new Error('fixture ws write failure'))
  }
}

function openFrame(streamId: string, endpoint = 'fixture/follow'): string {
  return JSON.stringify({ type: 'open', streamId, endpoint, payload: {} })
}

function itemFrame(streamId: string, value?: unknown): string {
  return JSON.stringify(value === undefined ? { type: 'item', streamId } : { type: 'item', streamId, value })
}

function endFrame(streamId: string): string {
  return JSON.stringify({ type: 'end', streamId })
}

async function *echoUplink(uplink: AsyncIterable<unknown>): AsyncIterable<unknown> {
  for await (const value of uplink) yield value
}

async function *waitForAbort(signal: AbortSignal): AsyncIterable<never> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

async function *cleanlyCancelled(signal: AbortSignal, returned: () => void): AsyncIterable<never> {
  try {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  } finally {
    returned()
  }
}

async function *delayedItem(
  released: Promise<void>,
  opened: () => void,
  returned: () => void = () => {},
): AsyncIterable<string> {
  try {
    opened()
    await released
    yield 'item'
  } finally {
    returned()
  }
}

async function closeHttp(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}
