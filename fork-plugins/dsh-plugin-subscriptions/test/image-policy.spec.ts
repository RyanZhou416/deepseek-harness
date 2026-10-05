/** Subscription image policies against real attachment variants and the Claude wire adapter. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import sharp from 'sharp'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { createAssistantMessage, createToolResultMessage, IMAGE_OFFLOAD_REQUIRED_CODE, projectImagesForTextModel, ToolCallId } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ImageBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import { assertClaudeRequestBytes, claudeImagePolicy } from '../src/providers/claude-images.js'
import { ClaudeAdapter } from '../src/providers/claude.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { ClaudeSession } from '../src/auth/store.js'
import { resolveImages } from '../src/translate/resolved.js'
import type { ResolvedImagePart, TranslatableBlock, TranslatableMessage } from '../src/translate/resolved.js'
import { toAnthropicMessages } from '../src/translate/anthropic.js'


async function withImageStore(run: (store: LocalAttachmentStore, ref: ImageAttachmentRef) => Promise<void>): Promise<void> {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-image-policy-'))
  const ctx = new Context()
  try {
    const store = new LocalAttachmentStore(ctx, { dshHome })
    const data = new Uint8Array(await sharp({ create: { width: 2800, height: 1400, channels: 3, background: '#3684ad' } }).png().toBuffer())
    const ref = await store.saveImage({ data, mediaType: 'image/png', name: 'diagram.png' })
    await run(store, ref)
  } finally {
    await ctx.fiber.dispose()
    await rm(dshHome, { recursive: true, force: true })
  }
}

function history(ref: ImageAttachmentRef, count: number): RequestMessage[] {
  const image: ImageBlock = { type: 'image', attachment: ref }
  return [
    // The wire validator pairs every tool_result with a tool_use, so the
    // synthetic history carries the call the result answers.
    createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('screenshot'), name: 'read_image', arguments: '{}' }],
      source: { provider: 'claude', model: 'claude-test' },
    }),
    { role: 'user', content: Array<ImageBlock>(count - 1).fill(image) },
    createToolResultMessage({ callId: ToolCallId('screenshot'), isError: false, content: [image] }),
  ]
}

function firstImage(messages: readonly TranslatableMessage[]): ResolvedImagePart {
  for (const message of messages) {
    const block = message.content.find(part => part.type === 'image' && 'dataBase64' in part)
    if (block?.type === 'image' && 'dataBase64' in block) return block
  }
  throw new Error('request has no image')
}

async function dimensions(messages: readonly TranslatableMessage[]) {
  const metadata = await sharp(Buffer.from(firstImage(messages).dataBase64, 'base64')).metadata()
  return { width: metadata.width, height: metadata.height }
}

describe('subscription request images', () => {
  it('resizes every occurrence at 21 images and restores saved resolution after switching routes', async () => {
    await withImageStore(async (store, ref) => {
      const messages = history(ref, 21)
      const before = structuredClone(messages)
      const original = await store.readImage(ref)
      const policy = claudeImagePolicy(200_000)
      const twenty = await resolveImages(history(ref, 20), store, undefined, policy)
      const many = await resolveImages(messages, store, undefined, policy)
      assert.deepEqual(await dimensions(twenty), { width: 2800, height: 1400 })
      assert.deepEqual(await dimensions(many), { width: 2000, height: 1000 })
      const wire = toAnthropicMessages(many)
      assert.ok((JSON.stringify(wire)).includes('request preview 2000x1000px'))
      assert.equal((JSON.stringify(wire).match(/"type":"image"/g))?.length, 21)
      const otherRoute = await resolveImages(messages, store)
      assert.deepEqual(await dimensions(otherRoute), { width: 2800, height: 1400 })
      const returned = await resolveImages(messages, store, undefined, policy)
      assert.equal(firstImage(returned).dataBase64, firstImage(many).dataBase64)
      const textRoute = projectImagesForTextModel(messages)
      assert.ok((JSON.stringify(await resolveImages(textRoute, undefined))).includes('model accepts text only'))
      assert.deepEqual(messages, before)
      assert.deepEqual(await store.readImage(ref), original)
    })
  })

  it('excludes offloaded occurrences from the threshold and preserves per-occurrence names', async () => {
    await withImageStore(async (store, ref) => {
      const images: ImageBlock[] = Array.from({ length: 21 }, (_, index) => ({
        type: 'image', attachment: { ...ref, name: `shot-${index}.png` }, ...index === 0 ? { offloaded: true } : {},
      }))
      const resolved = await resolveImages([{ role: 'user', content: images }], store, undefined, claudeImagePolicy(200_000))
      assert.deepEqual(await dimensions(resolved), { width: 2800, height: 1400 })
      assert.ok((JSON.stringify(resolved)).includes('shot-0.png'))
      assert.ok((JSON.stringify(resolved)).includes('shot-20.png'))
      assert.equal((JSON.stringify(resolved).match(/"type":"image"/g))?.length, 20)
      const omitted = await resolveImages([{ role: 'user', content: [images[0]!] }], undefined)
      assert.ok((JSON.stringify(omitted)).includes('image omitted to fit request image limits'))
    })
  })

  it('requests durable offload for model count limits without deleting attachments', async () => {
    await withImageStore(async (store, ref) => {
      const messages = history(ref, 101)
      await assert.rejects(resolveImages(messages, store, undefined, claudeImagePolicy(200_000)),
        { code: IMAGE_OFFLOAD_REQUIRED_CODE, failure: { code: IMAGE_OFFLOAD_REQUIRED_CODE, message: 'Subscription request images exceed the route image budget.', offloadImages: 1 } })
      assert.equal((JSON.stringify(await resolveImages(messages, store, undefined, claudeImagePolicy(1_000_000))).match(/"type":"image"/g))?.length, 101)
      assert.deepEqual((await store.readImage(ref)).ref, ref)
    })
  })

  it('caps both orientations and preserves small images', () => {
    const ref: ImageAttachmentRef = { attachmentId: AttachmentId('geometry'), mediaType: 'image/png', bytes: 9_000_000, width: 100, height: 8192 }
    const policy = claudeImagePolicy(200_000)
    assert.deepEqual(policy.target(ref, 20), { width: 98, height: 8000, maxBytes: 7_500_000 })
    assert.deepEqual(policy.target(ref, 21), { width: 24, height: 2000, maxBytes: 7_500_000 })
    assert.deepEqual(policy.target({ ...ref, width: 64, height: 32 }, 21), { width: 64, height: 32, maxBytes: 7_500_000 })
  })

  it('counts exact UTF-8 body bytes and only asks to offload images when that can help', () => {
    const image: ResolvedImagePart = { type: 'image', mediaType: 'image/png', dataBase64: 'a'.repeat(1000) }
    const blocks: TranslatableBlock[] = [{ ...image, fileId: 'file_1' }, {
      type: 'tool-result', toolCallId: ToolCallId('shot'), content: [image],
    }]
    const messages: TranslatableMessage[] = [{ role: 'user', content: blocks }]
    assert.doesNotThrow(() => assertClaudeRequestBytes('a'.repeat(32_000_000), messages))
    assert.throws(() => assertClaudeRequestBytes('a'.repeat(31_999_999) + '图', messages),
      { code: IMAGE_OFFLOAD_REQUIRED_CODE, failure: { code: IMAGE_OFFLOAD_REQUIRED_CODE, message: 'Claude request exceeds its 32 MB body limit.', offloadImages: 2 } })
    assert.throws(() => assertClaudeRequestBytes('a'.repeat(32_001_000), messages), { code: 'INVALID_REQUEST' })
  })

  it('sends the resized bytes through the real Claude adapter before any provider fetch', async () => {
    await withImageStore(async (store, ref) => {
      const session: ClaudeSession = {
        accessToken: 'test-only',
        refreshToken: 'test-only',
        expiresAt: Number.MAX_SAFE_INTEGER,
        scopes: '',
        accountUuid: 'uuid-test',
        deviceId: 'dev-test',
      }
      const tokens = new AccountTokenManager<ClaudeSession>({
        provider: 'claude', displayName: 'Test',
        makeOptions: () => ({ preemptMs: 0, refresh: async () => session, isPermanent: () => false }),
        io: { list: async () => [{ key: 'test', session }], get: async () => session, save: async () => {}, remove: async () => {} },
      })
      let calls = 0
      const adapter = new ClaudeAdapter({
        models: [{ id: 'claude-test', contextWindow: 200_000 }], tokens, discovery: false,
        streamIdleTimeoutMs: 60_000, resolveAttachments: () => store,
        fetchFn: async (_url, init) => {
          calls += 1
          const body = String(init?.body)
          const matches = [...body.matchAll(/"data":"([A-Za-z0-9+/=]+)"/g)]
          assert.equal((matches)?.length, 21)
          for (const match of matches) {
            const metadata = await sharp(Buffer.from(match[1]!, 'base64')).metadata()
            assert.equal(metadata.width, 2000)
            assert.equal(metadata.height, 1000)
          }
          return new Response('data: {"type":"message_stop"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
        },
      })
      for await (const chunk of adapter.stream({ provider: 'claude', model: 'claude-test', messages: history(ref, 21) })) void chunk
      assert.equal(calls, 1)
    })
  })

})
