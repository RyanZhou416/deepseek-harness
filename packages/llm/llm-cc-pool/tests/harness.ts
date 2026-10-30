/**
 * Test helpers for the mac-pool plugin: one assembled request through the real
 * LLM seam, and a fetch stand-in that records what the Anthropic transport
 * would have sent without opening a socket.
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  FinishReason,
  GenerateOptions,
  Message,
  RequestMessage,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AttachmentId, AttachmentStore, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { PROVIDER } from '../src/pool.ts'

export interface AssembledRequest {
  chunks: StreamChunk[]
  message: Message
  finish: FinishReason
}

/**
 * Drive one request through `ctx.llm.stream` and assemble its chunks the way
 * the agent loop does.
 * @param ctx - context carrying the LLM service.
 * @param options - request options.
 * @param provider - route to send on; defaults to the pool route so a case that
 *   exercises another provider in the same context must name it.
 * @returns the assembled assistant message, usage-bearing chunks, and finish.
 */
export async function assemble(
  ctx: Context,
  options: Omit<GenerateOptions, 'provider'>,
  provider: string = PROVIDER,
): Promise<AssembledRequest> {
  const assembler = new BlockAssembler()
  const chunks: StreamChunk[] = []
  const request: GenerateOptions = { provider, ...options }
  for await (const chunk of ctx.llm.stream(request)) {
    chunks.push(chunk)
    assembler.push(chunk)
  }
  return {
    chunks,
    message: assembler.message({
      provider: request.provider,
      model: request.model,
      ...assembler.replayState === undefined ? {} : { replayState: assembler.replayState },
    }),
    finish: assembler.finish,
  }
}

/**
 * One user message, the smallest legal request body.
 * @param text - user text.
 * @returns the assembled request message.
 */
export function user(text: string): RequestMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** One captured provider request: everything the test asserts on, no socket. */
export interface CapturedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly body: Record<string, unknown>
}

/** The fetch replacement plus the requests it observed. */
export interface PoolFetchCapture {
  readonly calls: CapturedRequest[]
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

/**
 * Replace the transport's fetch with a recorder that answers per request.
 * `ProviderErrorCapture` delegates to `globalThis.fetch` per call, so a stub
 * installed before the request is the one the transport uses.
 * @param respond - produces the response for one recorded request; defaults to
 *   a minimal success SSE. A case that mounts the plugin with wire parity
 *   enabled must route by URL, because the capability probe reaches the same
 *   fetch before the first model request. A promise holds the answer open so a
 *   case can settle a probe after its generation was superseded or disposed.
 * @returns the captured request list and the fetch implementation to stub.
 */
export function capturePoolFetch(
  respond: (request: CapturedRequest) => Response | Promise<Response> = () => anthropicSuccessResponse(),
): PoolFetchCapture {
  const calls: CapturedRequest[] = []
  return {
    calls,
    async fetch(input, init) {
      const request = input instanceof Request ? input : undefined
      const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.href : input.url
      const headers = new Headers(request?.headers ?? init?.headers)
      const raw = init?.body === undefined
        ? request === undefined ? undefined : await request.clone().text()
        : typeof init.body === 'string' ? init.body : undefined
      const captured: CapturedRequest = {
        url,
        method: init?.method ?? request?.method ?? 'GET',
        headers,
        body: raw === undefined || raw.length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>,
      }
      calls.push(captured)
      return respond(captured)
    },
  }
}

/**
 * A minimal complete Anthropic Messages text generation.
 * @param text - the streamed text block.
 * @returns the SSE response the transport parses.
 */
export function anthropicSuccessResponse(text = 'hello'): Response {
  const frames: [string, Record<string, unknown>][] = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'm',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 1 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ]
  const body = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** One durable image reference for request-shape cases. */
export const TEST_IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
}

/** Host-side object location the test attachment provider claims. */
export const TEST_HOST_IMAGE_PATH = '/host/.dsh/attachments/objects/aa/object'

/** Execution-world path the test filesystem maps that object to. */
export const TEST_MODEL_IMAGE_PATH = '/model/.dsh/attachments/objects/aa/object'

/** Attachment provider that serves one tiny PNG-shaped request image. */
export class TestAttachmentStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 1,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 1,
    maxImagePixels: 1,
    maxImageDimension: 2000,
    mediaTypes: ['image/png'],
  }

  validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.reject(new Error('not used'))
  }

  saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.reject(new Error('not used'))
  }

  readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return Promise.resolve({ ref, data: Uint8Array.of(1) })
  }

  override imageHostPath(_ref: ImageAttachmentRef): string {
    return TEST_HOST_IMAGE_PATH
  }

  override readImageRequest(
    ref: ImageAttachmentRef,
    _target: ImageRequestTarget,
    _signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    return Promise.resolve({
      attachment: ref,
      variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
      data: Uint8Array.of(1),
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: true,
    })
  }
}

/** Filesystem provider that maps the host object into one execution world. */
export class MappedTestFileSystem extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  processPathFromHostPath(hostPath: string): string | undefined {
    return hostPath === TEST_HOST_IMAGE_PATH ? TEST_MODEL_IMAGE_PATH : undefined
  }
}
