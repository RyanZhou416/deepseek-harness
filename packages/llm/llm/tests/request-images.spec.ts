/** Retained occurrence counting and route-specific preparation without changing history. */
import { describe, expect, it, vi } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageRequestTarget, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createToolResultMessage, prepareRequestImages, ToolCallId } from '../src/index.ts'
import type { ImageBlock, RequestMessage } from '../src/index.ts'

const ref: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', bytes: 2, width: 2800, height: 1400,
}
const image: ImageBlock = { type: 'image', attachment: ref }

function version(attachment: ImageAttachmentRef, target: ImageRequestTarget): RequestImageAttachment {
  return {
    attachment, variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`), data: Uint8Array.of(1, 2),
    mediaType: attachment.mediaType, bytes: 2, width: target.width, height: target.height,
    depth: 'uchar', space: 'srgb', hasAlpha: false,
  }
}

describe('prepareRequestImages', () => {
  it('counts repeated images across history and tools but prepares each retained source once', async () => {
    const messages: RequestMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'compare' }, ...Array<ImageBlock>(20).fill(image)] },
      createToolResultMessage({ callId: ToolCallId('shot'), isError: false, content: [image, { ...image, offloaded: true }] }),
    ]
    const before = structuredClone(messages)
    const target = vi.fn((attachment: ImageAttachmentRef, count: number) => ({
      width: count > 20 ? 2000 : attachment.width, height: count > 20 ? 1000 : attachment.height, maxBytes: 2,
    }))
    const readImageRequest = vi.fn(async (attachment: ImageAttachmentRef, selected: ImageRequestTarget) => version(attachment, selected))
    const result = await prepareRequestImages(messages, { readImageRequest }, target)
    expect(target).toHaveBeenCalledExactlyOnceWith(ref, 21)
    expect(readImageRequest).toHaveBeenCalledTimes(1)
    expect(result.get(ref.attachmentId)).toMatchObject({ width: 2000, height: 1000 })
    expect(messages).toEqual(before)
    const next = await prepareRequestImages(messages, { readImageRequest }, source => ({ ...source, maxBytes: source.bytes }))
    expect(next.get(ref.attachmentId)).toMatchObject({ width: 2800, height: 1400 })
  })

  it('does not read offloaded-only history or empty input', async () => {
    const readImageRequest = vi.fn()
    const target = vi.fn()
    expect(await prepareRequestImages([{ role: 'user', content: [{ ...image, offloaded: true }] }], { readImageRequest }, target)).toEqual(new Map())
    expect(await prepareRequestImages([], { readImageRequest }, target)).toEqual(new Map())
    expect(readImageRequest).not.toHaveBeenCalled()
    expect(target).not.toHaveBeenCalled()
  })

  it('propagates read failures and cancellation without preparing later attachments', async () => {
    const messages: RequestMessage[] = [{ role: 'user', content: [image, {
      ...image, attachment: { ...ref, attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`) },
    }] }]
    const target = (source: ImageAttachmentRef) => ({ ...source, maxBytes: source.bytes })
    const readImageRequest = vi.fn(async () => { throw new Error('read failed') })
    await expect(prepareRequestImages(messages, { readImageRequest }, target)).rejects.toThrow('read failed')
    expect(readImageRequest).toHaveBeenCalledTimes(1)
    const abort = new AbortController()
    const cancelledRead = vi.fn(async (source: ImageAttachmentRef, selected: ImageRequestTarget, signal?: AbortSignal) => {
      expect(signal).toBe(abort.signal)
      abort.abort(new Error('cancelled'))
      return version(source, selected)
    })
    await expect(prepareRequestImages(messages, { readImageRequest: cancelledRead }, target, abort.signal)).rejects.toThrow('cancelled')
    expect(cancelledRead).toHaveBeenCalledTimes(1)
    await expect(prepareRequestImages(messages, { readImageRequest }, target, abort.signal)).rejects.toThrow('cancelled')
    expect(readImageRequest).toHaveBeenCalledTimes(1)
  })
})
