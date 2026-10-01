/** Anthropic Messages image limits for the current request, including historical tool images. */

import { longEdgeDimensions } from '@deepseek-ai/dsh-attachment'
import type { SubscriptionImagePolicy } from '../translate/resolved.js'
import type { TranslatableBlock, TranslatableMessage } from '../translate/resolved.js'
import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmError } from '@deepseek-ai/dsh-llm'

/** Anthropic's standard endpoint request-body cap, including text, tools and image encoding. */
const MAX_REQUEST_BYTES = 32_000_000

/**
 * Resolve Claude's protocol limits without changing normalized attachments.
 * @param contextWindow - resolved model context capacity.
 * @returns request-only dimensions and the model's image occurrence ceiling.
 */
export function claudeImagePolicy(contextWindow: number): SubscriptionImagePolicy {
  return {
    target: (ref, count) => ({
      ...longEdgeDimensions(ref.width, ref.height, count > 20 ? 2000 : 8000),
      // The direct Messages API allows 10 MB of base64 for one image.
      maxBytes: Math.min(ref.bytes, 7_500_000),
    }),
    budget: { representation: 'base64', maxImages: contextWindow <= 200_000 ? 100 : 600 },
  }
}

/** Return encoded image lengths in wire order; file references retain their occurrence position. */
function imageLengths(blocks: readonly TranslatableBlock[]): number[] {
  return blocks.flatMap(block => {
    if (block.type === 'tool-result') return imageLengths(block.content)
    if (block.type === 'image' && 'dataBase64' in block) return [block.fileId === undefined ? block.dataBase64.length : 0]
    return []
  })
}

/**
 * Require a logged offload before submitting an oversized JSON body.
 * @param body - exact serialized Messages payload.
 * @param messages - resolved images in the same order used by the wire translator.
 * @returns nothing when the request fits.
 * @throws LlmError with an offload count, or INVALID_REQUEST when images cannot free enough bytes.
 */
export function assertClaudeRequestBytes(body: string, messages: readonly TranslatableMessage[]): void {
  const excess = Buffer.byteLength(body, 'utf8') - MAX_REQUEST_BYTES
  if (excess <= 0) return
  const lengths = messages.flatMap(message => imageLengths(message.content))
  let removed = 0
  for (const [index, length] of lengths.entries()) {
    removed += length
    if (removed > excess) {
      throw new LlmError('Claude request exceeds its 32 MB body limit.', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages: index + 1 })
    }
  }
  throw new LlmError('Claude request text and tools exceed its 32 MB body limit; compact the conversation or reduce the tools.', 'INVALID_REQUEST')
}
