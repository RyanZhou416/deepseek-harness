/**
 * Framing for the Bun stdio transport.
 *
 * One child process serves concurrent requests, so every frame is addressable.
 * A control frame carries UTF-8 JSON, whose `streamId` names the request it
 * belongs to. A body frame carries raw bytes — neither base64-inflated nor split
 * on newlines — preceded by the numeric index the control frames assigned to that
 * stream, because a UUID repeated on every chunk of a streamed response would cost
 * more than the payload it labels.
 *
 * Wire shape:
 *
 *   frame := uint32be length | uint8 tag | payload
 *   tag 0x01: payload is UTF-8 JSON, including `streamId`
 *   tag 0x02: payload is uint32be streamIndex followed by raw body bytes
 *
 * `length` counts the tag and the payload, never itself.
 */

/** Byte width of a frame's length prefix. */
export const FRAME_LENGTH_BYTES = 4;

/** Tag byte introducing a JSON control frame. */
export const TAG_CONTROL = 0x01;

/** Tag byte introducing a raw body frame. */
export const TAG_BODY = 0x02;

/**
 * Largest frame this codec will accept, in bytes.
 *
 * The child never sends a frame larger than one buffer of response bytes, and the
 * client never sends a frame larger than one request body chunk. The ceiling exists
 * so a corrupt or hostile length prefix fails loudly instead of allocating.
 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** A decoded control frame. */
interface ControlFrame {
  readonly tag: typeof TAG_CONTROL;
  /** Parsed JSON payload. The `streamId` member is required by the protocol. */
  readonly message: Record<string, unknown>;
}

/** A decoded body frame. */
interface BodyFrame {
  readonly tag: typeof TAG_BODY;
  /** Stream index assigned by the control frame that opened the stream. */
  readonly streamIndex: number;
  /** Raw bytes, exactly as the peer sent them. */
  readonly bytes: Uint8Array;
}

/** Either frame shape. */
export type Frame = ControlFrame | BodyFrame;

/** Failure raised for a payload the protocol cannot represent. */
export class FrameError extends Error {
  /** Machine-readable reason, stable enough for tests to assert. */
  readonly reason:
    | 'length-limit'
    | 'unknown-tag'
    | 'invalid-json'
    | 'missing-stream-id'
    | 'invalid-stream-index'
    | 'truncated';

  /**
   * @param reason - Which invariant the payload violated.
   * @param detail - Extra context for logs; never contains payload bytes.
   */
  constructor(reason: FrameError['reason'], detail = '') {
    super(detail === '' ? reason : `${reason}: ${detail}`);
    this.name = 'FrameError';
    this.reason = reason;
  }
}

/**
 * Encodes a control frame.
 *
 * @param message - JSON payload; must carry a non-empty string `streamId`.
 * @returns The framed bytes.
 */
export function encodeControl(message: Record<string, unknown>): Uint8Array {
  const streamId = message['streamId'];
  if (typeof streamId !== 'string' || streamId.length === 0) {
    throw new FrameError('missing-stream-id');
  }
  const json = new TextEncoder().encode(JSON.stringify(message));
  return frame(TAG_CONTROL, json);
}

/**
 * Encodes a body frame.
 *
 * @param streamIndex - Numeric index the peer assigned to this stream.
 * @param bytes - Raw body bytes.
 * @returns The framed bytes.
 */
export function encodeBody(streamIndex: number, bytes: Uint8Array): Uint8Array {
  if (!Number.isInteger(streamIndex) || streamIndex < 0 || streamIndex > 0xffffffff) {
    throw new FrameError('invalid-stream-index', String(streamIndex));
  }
  const payload = new Uint8Array(4 + bytes.byteLength);
  new DataView(payload.buffer).setUint32(0, streamIndex, false);
  payload.set(bytes, 4);
  return frame(TAG_BODY, payload);
}

function frame(tag: number, payload: Uint8Array): Uint8Array {
  const total = 1 + payload.byteLength;
  if (total > MAX_FRAME_BYTES) {
    throw new FrameError('length-limit', String(total));
  }
  const out = new Uint8Array(FRAME_LENGTH_BYTES + total);
  new DataView(out.buffer).setUint32(0, total, false);
  out[FRAME_LENGTH_BYTES] = tag;
  out.set(payload, FRAME_LENGTH_BYTES + 1);
  return out;
}

/**
 * Incremental decoder.
 *
 * Bytes arrive in whatever chunks the pipe delivers, so a frame may be split
 * across reads and one read may hold several frames. `push` returns every frame
 * the buffer now completes and keeps the remainder.
 */
export class FrameDecoder {
  #buffer: Uint8Array = new Uint8Array(0);
  #error: FrameError | undefined;

  /**
   * Feeds bytes and returns the frames they complete.
   *
   * Decoding never throws. A malformed frame stops the stream — the peer is out of
   * step and every later boundary would be guesswork — but frames already completed
   * in the same read are still returned, and the failure is reported through
   * {@link FrameDecoder.error}. This method runs inside a pipe data handler, where a
   * throw becomes an uncaught exception in the host process.
   *
   * @param chunk - Bytes read from the pipe.
   * @returns Complete frames decoded before any failure, in arrival order.
   */
  push(chunk: Uint8Array): readonly Frame[] {
    if (this.#error !== undefined) return [];
    this.#buffer = concat(this.#buffer, chunk);
    const frames: Frame[] = [];
    for (;;) {
      if (this.#buffer.byteLength < FRAME_LENGTH_BYTES) break;
      const length = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset,
        FRAME_LENGTH_BYTES,
      ).getUint32(0, false);
      if (length > MAX_FRAME_BYTES) {
        this.#error = new FrameError('length-limit', String(length));
        break;
      }
      const total = FRAME_LENGTH_BYTES + length;
      if (this.#buffer.byteLength < total) break;
      let frame: Frame;
      try {
        frame = decodeFrame(this.#buffer.subarray(FRAME_LENGTH_BYTES, total));
      } catch (error) {
        this.#error =
          error instanceof FrameError ? error : new FrameError('unknown-tag');
        break;
      }
      frames.push(frame);
      this.#buffer = this.#buffer.subarray(total);
    }
    if (this.#error !== undefined) this.#buffer = new Uint8Array(0);
    return frames;
  }

  /** The first decoding failure, once the stream is out of step. */
  get error(): FrameError | undefined {
    return this.#error;
  }

  /** Bytes held for an incomplete frame. */
  get pending(): number {
    return this.#buffer.byteLength;
  }
}

function decodeFrame(payload: Uint8Array): Frame {
  if (payload.byteLength === 0) throw new FrameError('truncated');
  const tag = payload[0];
  const body = payload.subarray(1);
  if (tag === TAG_CONTROL) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new FrameError('invalid-json');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new FrameError('invalid-json', 'not an object');
    }
    const message = parsed as Record<string, unknown>;
    const streamId = message['streamId'];
    if (typeof streamId !== 'string' || streamId.length === 0) {
      throw new FrameError('missing-stream-id');
    }
    return { tag: TAG_CONTROL, message };
  }
  if (tag === TAG_BODY) {
    if (body.byteLength < 4) throw new FrameError('truncated', 'body header');
    const streamIndex = new DataView(
      body.buffer,
      body.byteOffset,
      4,
    ).getUint32(0, false);
    return { tag: TAG_BODY, streamIndex, bytes: body.slice(4) };
  }
  throw new FrameError('unknown-tag', String(tag));
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  if (right.byteLength === 0) return left;
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}
