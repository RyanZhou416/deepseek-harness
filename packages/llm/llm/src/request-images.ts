/** Request-local image variants shared by provider adapters. */

import type { AttachmentId, AttachmentStore, ImageAttachmentRef, ImageRequestTarget, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { RequestMessage } from './types.ts'

/**
 * Resolve one route's image dimensions after counting all retained occurrences.
 * @param attachment - immutable normalized source, never a previous request variant.
 * @param imageCount - retained occurrences across user messages and tool results, including repeats.
 * @returns the route's complete dimensions and encoded-byte target.
 */
export type RequestImageTargetResolver = (attachment: ImageAttachmentRef, imageCount: number) => ImageRequestTarget

/**
 * Prepare each retained attachment once under the current request's route.
 * Offloaded occurrences neither count nor read storage. The returned map is
 * request-local; the attachment provider caches variants by source and target.
 * @param messages - complete derived history, including logged offload marks.
 * @param attachments - provider of immutable sources and cached request variants.
 * @param target - route policy resolved for this request's model and endpoint.
 * @param signal - cancellation for reads and transformations.
 * @returns prepared versions keyed by durable attachment id.
 */
export async function prepareRequestImages(
  messages: readonly RequestMessage[],
  attachments: Pick<AttachmentStore, 'readImageRequest'>,
  target: RequestImageTargetResolver,
  signal?: AbortSignal,
): Promise<Map<AttachmentId, RequestImageAttachment>> {
  signal?.throwIfAborted()
  const refs = new Map<AttachmentId, ImageAttachmentRef>()
  let imageCount = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'image' || block.offloaded === true) continue
      imageCount += 1
      refs.set(block.attachment.attachmentId, block.attachment)
    }
  }
  const versions = new Map<AttachmentId, RequestImageAttachment>()
  for (const ref of refs.values()) {
    signal?.throwIfAborted()
    const version = await attachments.readImageRequest(ref, target(ref, imageCount), signal)
    signal?.throwIfAborted()
    versions.set(ref.attachmentId, version)
  }
  return versions
}
