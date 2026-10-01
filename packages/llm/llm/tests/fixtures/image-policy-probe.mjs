/** Recorded-session probe of request image dimensions across model routes. */
import { readFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { claudeImagePolicy } from '../../../../../fork-plugins/dsh-plugin-subscriptions/src/providers/claude-images.ts'
import { resolveImages } from '../../../../../fork-plugins/dsh-plugin-subscriptions/src/translate/resolved.ts'

export const name = 'image-policy-probe'
export const inject = ['tools', 'attachments']

/** Register a probe whose persisted result reports actual request-preview metadata. */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'image_route_probe',
    description: 'Report request image dimensions for a saved attachment and route.',
    parameters: {
      route: { type: 'string', enum: ['claude', 'other'], required: true },
      count: { type: 'integer', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      if (args.count !== 20 && args.count !== 21) throw new Error('image probe expects 20 or 21 images')
      const data = new Uint8Array(await readFile(new URL('./image-policy.png', import.meta.url)))
      const attachment = await ctx.attachments.saveImage({ data, mediaType: 'image/png' })
      const image = { type: 'image', attachment }
      const messages = [
        { role: 'user', content: Array(args.count - 1).fill(image) },
        createToolResultMessage({ callId: ToolCallId('image-probe'), isError: false, content: [image] }),
      ]
      const resolved = await resolveImages(messages, ctx.attachments, exec.signal,
        args.route === 'claude' ? claudeImagePolicy(200_000) : undefined)
      const preview = resolved[0].content.find(block => block.type === 'text').text.match(/request preview (\d+x\d+)px/)[1]
      return JSON.stringify({ route: args.route, count: args.count, source: `${attachment.width}x${attachment.height}`, preview })
    },
    presentCall: args => ({ card: 'generic', title: 'Inspect request image dimensions', kind: 'other', rawInput: args }),
  })))
}
