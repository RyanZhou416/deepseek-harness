/**
 * Resolved-image plumbing for the wire translators. ImageBlocks carry only an
 * attachment reference; the bytes live in the attachment service, which is
 * async I/O. Adapters resolve images BEFORE calling the (pure, synchronous)
 * translators, so the translators see {@link ResolvedImagePart}s with inline
 * base64 data.
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, RequestMessage, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'

/** An image block with its bytes resolved to inline base64 for the wire. */
export interface ResolvedImagePart {
  type: 'image'
  /** MIME type verified by the attachment service (e.g. `image/png`). */
  mediaType: string
  /** Base64-encoded image bytes. */
  dataBase64: string
}

/** Translator input: a harness block, resolved image, or internal tool-result wrapper. */
export type TranslatableBlock = ContentBlock | ResolvedImagePart | ResolvedToolResultBlock

/** Tool results may themselves carry attachment-backed images. */
export interface ResolvedToolResultBlock {
  type: 'tool-result'
  toolCallId: ToolResultMessage['toolCallId']
  isError?: boolean
  content: readonly TranslatableBlock[]
}

/**
 * Wires with text-only tool outputs receive images in a following user turn.
 * Defer that turn until all consecutive user messages have been processed:
 * parallel tool results can arrive in separate harness messages, and a user
 * image message must not interrupt their tool-call/output pairing.
 */
export function withToolResultImages(messages: readonly TranslatableMessage[]): TranslatableMessage[] {
  const out: TranslatableMessage[] = []
  let images: TranslatableBlock[] = []
  const flush = (): void => {
    if (images.length > 0) out.push({ role: 'user', content: images })
    images = []
  }
  for (const message of messages) {
    if (message.role === 'assistant') flush()
    out.push(message)
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      const parts = block.content.filter((part): part is ResolvedImagePart => part.type === 'image' && 'dataBase64' in part)
      if (parts.length > 0) {
        images.push({ type: 'text', text: `Images from tool result ${String(block.toolCallId)}:` }, ...parts)
      }
    }
  }
  flush()
  return out
}

/** Translator input message: role plus resolved blocks. */
export interface TranslatableMessage {
  role: 'system' | 'user' | 'assistant'
  content: readonly TranslatableBlock[]
  /** Preserved for adapters whose provider-private replay metadata is required. */
  source?: Message['source']
}

/** Adapt V4 tool-role messages to the translators' internal result block. */
function translatable(message: RequestMessage, content: readonly TranslatableBlock[]): TranslatableMessage {
  if (message.role === 'developer') {
    throw new LlmError('dsh-plugin-subscriptions: developer messages are not supported by this provider', 'UNSUPPORTED_CONTENT')
  }
  if (message.role === 'tool') return {
    role: 'user',
    source: message.source,
    content: [{ type: 'tool-result', toolCallId: message.toolCallId,
      ...message.isError === undefined ? {} : { isError: message.isError }, content }],
  }
  if (content === message.content) return message
  return { role: message.role, content, ...message.source === undefined ? {} : { source: message.source } }
}

/**
 * Resolve every ImageBlock's attachment reference to inline base64 bytes.
 * Ordinary image-free messages keep their identity; V4 tool-role messages
 * become internal result blocks. A request carrying an image without an
 * attachment service fails; unsupported developer messages also fail rather
 * than being silently omitted.
 * @param messages - durable conversation messages and request-only user input.
 * @param attachments - the deployment's attachment service, when mounted.
 * @param signal - cancellation for the storage reads.
 * @returns ordered translator messages with tool results and images resolved.
 */
export async function resolveImages(
  messages: readonly RequestMessage[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<readonly TranslatableMessage[]> {
  const hasImage = messages.some(message => message.content.some(block => block.type === 'image'))
  if (!hasImage) return messages.map(message => translatable(message, message.content))
  if (attachments === undefined) {
    throw new LlmError(
      'dsh-plugin-subscriptions: the request carries an image but no attachments service is mounted; '
      + 'image input requires the harness attachment store',
      'UNSUPPORTED',
    )
  }
  const resolveBlock = async (block: ContentBlock): Promise<TranslatableBlock[]> => {
    if (block.type !== 'image') return [block]
    const stored = await attachments.readImage(block.attachment, signal)
    const { attachmentId, mediaType, bytes, width, height, name } = stored.ref
    return [{
      type: 'image',
      mediaType: stored.ref.mediaType,
      dataBase64: Buffer.from(stored.data).toString('base64'),
    }, {
      type: 'text',
      text: `Image reference (for image_generate.referenceImages): ${JSON.stringify({
        attachmentId, mediaType, bytes, width, height, ...name === undefined ? {} : { name },
      })}`,
    }]
  }
  return Promise.all(messages.map(async message => translatable(
    message,
    (await Promise.all(message.content.map(resolveBlock))).flat(),
  )))
}
