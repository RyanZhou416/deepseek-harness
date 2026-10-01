/**
 * Resolved-image plumbing for the wire translators. ImageBlocks carry only an
 * attachment reference; the bytes live in the attachment service, which is
 * async I/O. Adapters resolve images BEFORE calling the (pure, synchronous)
 * translators, so the translators see {@link ResolvedImagePart}s with inline
 * base64 data.
 */

import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, offloadedImageText, prepareRequestImages, projectOffloadedImages, requiredImageOffload } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmImageRequestBudget, Message, RequestImageTargetResolver, RequestMessage, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'

/** Request-local policy supplied by the resolved provider/model route. */
export interface SubscriptionImagePolicy {
  /** Dimensions and byte target for each immutable source at this request's image count. */
  target: RequestImageTargetResolver
  /** Aggregate represented bytes and occurrence limit, enforced through logged offload. */
  budget?: LlmImageRequestBudget
}

/** Preserve normalized resolution when the route has no tighter protocol policy. */
const normalizedTarget: RequestImageTargetResolver = ref => ({ width: ref.width, height: ref.height, maxBytes: ref.bytes })

/** An image block with its bytes resolved to inline base64 for the wire. */
export interface ResolvedImagePart {
  type: 'image'
  /** MIME type verified by the attachment service (e.g. `image/png`). */
  mediaType: string
  /** Base64-encoded image bytes. */
  dataBase64: string
  /** Files API `id`, sent as `source.file_id` when the base64 image exceeds the vision limit. */
  fileId?: string
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
 * @param policy - exact route's request limits; omission preserves normalized image dimensions.
 * @returns ordered translator messages with tool results and images resolved.
 */
export async function resolveImages(
  messages: readonly RequestMessage[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
  policy?: SubscriptionImagePolicy,
): Promise<readonly TranslatableMessage[]> {
  const projected = projectOffloadedImages(messages, ref => offloadedImageText(ref))
  const hasImage = projected.some(message => message.content.some(block => block.type === 'image'))
  if (!hasImage) return projected.map(message => translatable(message, message.content))
  if (attachments === undefined) {
    throw new LlmError(
      'dsh-plugin-subscriptions: the request carries an image but no attachments service is mounted; '
      + 'image input requires the harness attachment store',
      'UNSUPPORTED',
    )
  }
  const versions = await prepareRequestImages(projected, attachments, policy?.target ?? normalizedTarget, signal)
  if (policy?.budget !== undefined) {
    const offloadImages = requiredImageOffload(projected, policy.budget,
      block => (versions.get(block.attachment.attachmentId) as RequestImageAttachment).bytes)
    if (offloadImages > 0) {
      throw new LlmError('Subscription request images exceed the route image budget.', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages })
    }
  }
  const resolveBlock = (block: ContentBlock): TranslatableBlock[] => {
    if (block.type !== 'image') return [block]
    const version = versions.get(block.attachment.attachmentId) as RequestImageAttachment
    const { attachmentId, mediaType, bytes, width, height, name } = block.attachment
    return [{
      type: 'image',
      mediaType: version.mediaType,
      dataBase64: Buffer.from(version.data).toString('base64'),
    }, {
      type: 'text',
      text: `Image reference (for image_generate.referenceImages): ${JSON.stringify({
        attachmentId, mediaType, bytes, width, height, ...name === undefined ? {} : { name },
      })}; request preview ${version.width}x${version.height}px.`,
    }]
  }
  return projected.map(message => translatable(
    message,
    message.content.flatMap(resolveBlock),
  ))
}
