/**
 * Prove four Claude boundary contracts at once, each through shipped code.
 *
 * `claude_stream_boundaries_probe` first drives a `BunBridge` over an injected duplex
 * and the real frame codec. One bridge carries three multiplexed requests: a body whose
 * reader claims every frame before it arrives, a body nobody reads, and a sibling that
 * keeps streaming after its neighbour fails. The cap is configured small through the
 * constructor, so the observation stays a few kilobytes instead of the shipped 32 MiB
 * default, while the claimed body still totals many times its own cap.
 *
 * It then feeds synthetic responses through the real translator and the harness
 * `BlockAssembler`, and replays the stored assistant message with `toAnthropicMessages`:
 * that pins where a captured server-tool pair is re-emitted after a generation-limit
 * prune, and which wire stop states end the turn as an unsupported response rather than
 * as the retryable empty completion.
 *
 * Last it carries the identity-refresh observation, which drives the shipped
 * `ClaudeAdapter` over synthetic credentials and reports whether the credential the
 * adapter's own profile replay rotated survived the identity backfill.
 *
 * Every body and stream here is in memory, so no child process, socket, timer,
 * credential, or provider call is involved, and the tool returns one deterministic JSON
 * observation for the session log.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, subscriptionRetryPolicy } from '../../src/providers/rate-limit.ts'
import { AnthropicStreamTranslator, toAnthropicMessages, UNSUPPORTED_RESPONSE_CODE } from '../../src/translate/anthropic.ts'
import { BridgeError, BunBridge } from '../../src/transport/bridge.ts'
import { FrameDecoder, encodeBody, encodeControl } from '../../src/transport/frames.ts'
import { probeClaudeIdentityRefresh } from './claude-identity-refresh-probe.mjs'

export const name = 'claude-stream-boundaries-probe'
export const inject = ['tools']

/** The request the bridge exists to carry. */
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages?beta=true'

/** Bytes in one frame the bodies below send. */
const CHUNK_BYTES = 16

/** Unread backlog, in bytes, one response body may hold before the bridge fails it. */
const CAP_BYTES = 64

/** Frames the claimed body sends: 4096 bytes, sixty-four times its own cap. */
const DRAIN_FRAMES = 256

/** Frames the sibling body sends on each side of its neighbour's failure. */
const SIBLING_FRAMES = 4

/** One frame of body bytes, in the position pattern the delivered chunks are checked against. */
const CHUNK = (() => {
  const bytes = new Uint8Array(CHUNK_BYTES)
  for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = index & 0xff
  return bytes
})()

/**
 * A duplex that answers every request with a body-bearing head and lets the proof send
 * everything after it, so backlog is observed at exact frame boundaries.
 * @returns The duplex plus the child-side moves the proof needs.
 */
function bridgeHarness() {
  const decoder = new FrameDecoder()
  const requests = []
  const cancels = []
  let dataHandler
  let killed = false

  const send = (bytes) => {
    dataHandler?.(bytes)
  }

  const duplex = {
    write(bytes) {
      for (const frame of decoder.push(bytes)) {
        if (frame.tag !== 1) continue
        const type = frame.message['type']
        if (type === 'cancel') {
          cancels.push(String(frame.message['streamId']))
          continue
        }
        if (type !== 'request') continue
        const streamId = String(frame.message['streamId'])
        const index = typeof frame.message['index'] === 'number' ? frame.message['index'] : requests.length
        requests.push({ streamId, index })
        send(encodeControl({
          streamId,
          type: 'response',
          status: 200,
          headers: [['content-type', 'text/event-stream']],
        }))
      }
    },
    onData(handler) {
      dataHandler = handler
    },
    onExit() {},
    kill() {
      killed = true
    },
  }

  return {
    duplex,
    requests,
    killed: () => killed,
    /** Delivers one body frame for a stream. */
    chunk: index => send(encodeBody(index, CHUNK)),
    /** Delivers the end frame that closes a stream. */
    end: streamId => send(encodeControl({ streamId, type: 'end' })),
    /** How many cancel frames the bridge wrote for one stream. */
    cancelsFor: streamId => cancels.filter(candidate => candidate === streamId).length,
  }
}

/**
 * Unwraps one read that must carry a frame.
 * @param pending - The read's promise.
 * @returns The delivered byte count.
 */
async function delivered(pending) {
  const next = await pending
  if (next.done === true || next.value === undefined) {
    throw new Error('the bridged body ended before its frames did')
  }
  return next.value.byteLength
}

/**
 * Opens one request and takes a reader over the body the duplex already answered.
 * @param bridge - The bridge under proof.
 * @param harness - The duplex driving it.
 * @param readers - Every reader the proof must release.
 * @returns The opened stream's identity and reader.
 */
async function open(bridge, harness, readers) {
  const response = await bridge.request(MESSAGES_URL, { method: 'POST' })
  const body = response.body
  if (body === null) throw new Error('the bridged response carried no body')
  const reader = body.getReader()
  readers.push(reader)
  const opened = harness.requests.at(-1)
  if (opened === undefined) throw new Error('the bridge wrote no request frame')
  return { streamId: opened.streamId, index: opened.index, reader }
}

/**
 * Claims one frame with a read that is already waiting, so the frame is handed to that
 * read instead of entering the backlog queue.
 * @param stream - The opened stream to read.
 * @param harness - The duplex delivering frames.
 * @returns The claimed byte count.
 */
async function claimFrame(stream, harness) {
  const pending = stream.reader.read()
  harness.chunk(stream.index)
  return await delivered(pending)
}

/**
 * Releases one reader, tolerating a body that already ended or failed.
 * @param reader - The reader to release.
 */
async function release(reader) {
  try {
    await reader.cancel()
  } catch (_settledBody) {
    // A closed or errored body has nothing left to release.
  }
}

/** The model every replayed message below was produced by. */
const MODEL = 'claude-opus-4-5'

/** The server-tool pair one response streams and the next request carries back. */
const SERVER_PAIR = [
  { type: 'server_tool_use', id: 'server1', name: 'tool_search_tool_regex', input: { query: 'find' } },
  {
    type: 'tool_search_tool_result',
    tool_use_id: 'server1',
    content: { type: 'tool_search_tool_search_result', tool_references: [] },
  },
]

/** Every wire stop reason the generation-limit prune is proven for. */
const LIMIT_REASONS = ['max_tokens', 'model_context_window_exceeded']

/**
 * Feed every event through one real translator and flatten the chunks it emitted.
 * @param events - The response's events, in arrival order.
 * @returns Every emitted chunk, in stream order.
 */
function drain(events) {
  const translator = new AnthropicStreamTranslator()
  return events.flatMap(event => translator.push(event))
}

/**
 * A truncated local call, the captured server pair, then text: the response shape the
 * generation-limit prune has to keep in order.
 * @param stopReason - The wire stop reason that ends the response.
 * @returns The response's events.
 */
function localThenServerThenText(stopReason) {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'local1', name: 'local_tool' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: SERVER_PAIR[0] },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: SERVER_PAIR[1] },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 3, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'after server result' } },
    { type: 'content_block_stop', index: 3 },
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
}

/**
 * One text block ending with the given `message_delta`.
 * @param delta - The terminal delta the provider sent.
 * @returns The response's events.
 */
function textThenDelta(delta) {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]
}

/** A response that streamed only the server-tool pair and then ended normally. */
function serverOnlyStream() {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: SERVER_PAIR[0] },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: SERVER_PAIR[1] },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]
}

/** The provider's degenerate completion: an ordinary stop that streamed nothing. */
function noContentStream() {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
    { type: 'message_stop' },
  ]
}

/**
 * One wire message's content types, in order.
 * @param message - A message `toAnthropicMessages` produced.
 * @returns The block types it carries.
 */
function wireTypes(message) {
  return Array.isArray(message?.content) ? message.content.map(block => block.type) : []
}

/**
 * Run one response through the shipped path — the real translator, then the loop's
 * assembler — and replay the stored assistant message into the next request.
 * @param events - The response's events, in stream order.
 * @returns The kept blocks, the stored envelope, and the built request.
 */
function replay(events) {
  const assembler = new BlockAssembler()
  for (const chunk of drain(events)) assembler.push(chunk)
  const envelope = assembler.replayState
  const kept = assembler.blocks()
  const wire = toAnthropicMessages([{
    role: 'assistant',
    content: kept,
    source: {
      kind: 'model',
      provider: 'claude',
      model: MODEL,
      ...envelope === undefined ? {} : { replayState: envelope },
    },
  }], MODEL)
  return { kept, envelope, wire }
}

/**
 * Prove a generation-limit prune keeps the captured server pair ahead of the text it
 * preceded, without re-emitting the local call the prune dropped.
 * @returns The kept blocks, the wire order, the captured pair's positions, and whether
 *   every limit stop reason agrees.
 */
function proveReplayOrder() {
  const runs = LIMIT_REASONS.map((reason) => {
    const { kept, envelope, wire } = replay(localThenServerThenText(reason))
    const captures = envelope?.response?.serverBlocks ?? []
    const blocks = Array.isArray(wire[0]?.content) ? wire[0].content : []
    return {
      kept: kept.map(block => block.type),
      wire: wireTypes(wire[0]),
      captured: captures.map(capture => capture.block.type),
      positions: captures.map(capture => capture.index),
      pairIntact: blocks[0]?.id !== undefined && blocks[0].id === blocks[1]?.tool_use_id,
      localToolReplayed: blocks.some(block => block.type === 'tool_use'),
    }
  })
  const [first] = runs
  if (first === undefined) throw new Error('the replay proof ran no limit stop reason')
  return {
    reasons: [...LIMIT_REASONS],
    agree: runs.every(run => JSON.stringify(run) === JSON.stringify(first)),
    kept: first.kept,
    wire: first.wire,
    captured: first.captured,
    positions: first.positions,
    pairIntact: first.pairIntact,
    localToolReplayed: first.localToolReplayed,
  }
}

/**
 * The terminal finish one response produced.
 * @param events - The response's events, in stream order.
 * @returns The finish kind, its failure code, and whether it carried a replay envelope.
 */
function terminalStop(events) {
  const finish = drain(events).at(-1)
  if (finish?.type !== 'finish') throw new Error('the response produced no terminal finish')
  return {
    kind: finish.reason.kind,
    code: finish.reason.kind === 'error' ? finish.reason.failure.code : 'none',
    envelope: finish.replayState !== undefined,
  }
}

/**
 * Prove which wire stop states end the turn instead of passing as completed answers, and
 * which of them the subscription routes retry.
 * @returns One observation per stop state, plus the routes' retryable codes.
 */
function proveTerminalStops() {
  const policy = subscriptionRetryPolicy(
    DEFAULT_RETRY,
    DEFAULT_RATE_LIMIT_WAIT,
    'claude-stream-boundaries terminal-stop proof',
  )
  return {
    pauseTurn: terminalStop(textThenDelta({ stop_reason: 'pause_turn' })),
    compaction: terminalStop(textThenDelta({ stop_reason: 'compaction' })),
    serverOnly: terminalStop(serverOnlyStream()),
    empty: terminalStop(noContentStream()),
    retryable: [...policy.retryableCodes].sort(),
    retriesUnsupported: policy.retryableCodes.includes(UNSUPPORTED_RESPONSE_CODE),
  }
}

/**
 * Run every stream-boundary proof over one real bridge.
 * @returns The compact observation the session log records.
 */
async function proveStreamBoundaries() {
  const harness = bridgeHarness()
  const bridge = new BunBridge(harness.duplex, { maxQueuedBytes: CAP_BYTES })
  const readers = []
  try {
    const claimed = await open(bridge, harness, readers)
    const unread = await open(bridge, harness, readers)
    const sibling = await open(bridge, harness, readers)

    // Every frame is claimed by a read registered before it was sent, so the queue never
    // holds one: this body carries sixty-four caps' worth while its backlog stays at zero.
    let bytesConsumed = 0
    for (let sent = 0; sent < DRAIN_FRAMES; sent += 1) bytesConsumed += await claimFrame(claimed, harness)
    harness.end(claimed.streamId)
    const claimedEnd = await claimed.reader.read()

    // Four unread frames put the sibling exactly at its cap, which the bridge allows.
    for (let sent = 0; sent < SIBLING_FRAMES; sent += 1) harness.chunk(sibling.index)
    let siblingBytes = 0
    for (let read = 0; read < SIBLING_FRAMES; read += 1) siblingBytes += await delivered(sibling.reader.read())

    // Nothing reads this body, so the frame past its cap is the first unread byte over it.
    for (let sent = 0; sent < SIBLING_FRAMES + 1; sent += 1) harness.chunk(unread.index)
    let overflowReason = 'none'
    try {
      await unread.reader.read()
    } catch (error) {
      overflowReason = error instanceof BridgeError ? error.reason : 'other'
    }
    // The child may still be sending for the failed stream; neither frame may release it a
    // second time.
    harness.end(unread.streamId)
    harness.chunk(unread.index)

    // The sibling is untouched by its neighbour's failure and still reaches its own end.
    for (let sent = 0; sent < SIBLING_FRAMES; sent += 1) harness.chunk(sibling.index)
    siblingBytes += await delivered(sibling.reader.read())
    for (let read = 1; read < SIBLING_FRAMES; read += 1) siblingBytes += await delivered(sibling.reader.read())
    harness.end(sibling.streamId)
    const siblingEnd = await sibling.reader.read()

    return {
      scenario: 'claude-stream-boundaries',
      capBytes: CAP_BYTES,
      bytesConsumed,
      finish: claimedEnd.done === true ? 'closed' : 'open',
      sibling: { bytes: siblingBytes, finish: siblingEnd.done === true ? 'closed' : 'open' },
      overflowCancel: { reason: overflowReason, cancels: harness.cancelsFor(unread.streamId) },
      replayOrder: proveReplayOrder(),
      terminalStops: proveTerminalStops(),
      identityRefresh: await probeClaudeIdentityRefresh(),
    }
  } finally {
    for (const reader of readers) await release(reader)
    bridge.dispose()
  }
}

/** Register the deterministic stream-boundary probe with recorded output. */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'claude_stream_boundaries_probe',
    description: 'Prove the Claude stream boundaries: the Bun transport bounds one response body by the bytes it still holds unread, a generation-limit prune replays a captured server-tool pair ahead of the text it preceded, paused, compacting, or server-tool-only turns fail closed as an unsupported response while only a genuinely empty completion stays retryable, and the shipped Claude adapter keeps the credential its own profile replay rotated when the identity backfill runs.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      return JSON.stringify(await proveStreamBoundaries())
    },
    presentCall: args => ({ card: 'generic', title: 'Inspect Claude stream boundaries', kind: 'other', rawInput: args }),
  })))
}
