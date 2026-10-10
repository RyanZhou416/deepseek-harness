/**
 * Keyed toolview for the `image_generate` tool: renders generated images
 * inline in the conversation. The row shows the call's prompt while running
 * and after settling; a settled result with image blocks renders them through
 * this plugin's own ImageGallery (harness rc.8 stopped exporting the platform
 * one as a package value), whose bytes load through the node half's
 * `/subscriptions-auth` RPC channel (the durable ImageAttachmentRef is never
 * a fetchable URL on its own). A text-only settled result (degraded route)
 * renders its text; an error result renders the first error line.
 *
 * The 'tool.call.toolview' slot contract is owned by ui-tool
 * (packages/client/ui-tool/src/client/contract/slots.ts), which this package
 * does not resolve; the SlotMap merge here and the shared ToolCallOwnerProps
 * in format.ts mirror it structurally (same discipline as
 * platform-modules.d.ts).
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { ImageGallery } from './ImageGallery.js'
import type { ImageAttachmentRef, ImageLoader, MessageImageLabels } from './ImageGallery.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { derivePrompt, fallbackTranslate, resultText, toolviewStyles } from './format.js'
import type { SubscriptionsTranslate, ToolCallOwnerProps } from './format.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Mirror of ui-tool's keyed atomic Tool view declaration (see the module header). */
    'tool.call.toolview': { kind: 'keyed'; scope: 'session'; owner: ToolCallOwnerProps }
  }
}

/** Injected dependencies of {@link ImageGenerateToolview} (slot `inject`). */
export interface ImageGenerateToolviewInjected {
  /** Session-authorized image URL loader riding the `/subscriptions-auth` channel. */
  load: ImageLoader
}

/**
 * Props delivered by the toolview outlet: the owner share plus the inject
 * face and the framework locale seat, spread flat.
 */
export type ImageGenerateToolviewProps =
  Partial<ToolCallOwnerProps>
  & Partial<ImageGenerateToolviewInjected>
  & { t?: SubscriptionsTranslate | undefined }

/** `image` endpoint result: the node half owns this shape. */
interface ImageEndpointResult {
  mediaType: string
  dataBase64: string
}

/**
 * Build the ImageGallery loader over the `image` endpoint.
 * @param rpc - Connection RPC caller.
 * @returns loader resolving an attachment ref to a data URL.
 */
export function createImageLoader(rpc: ConnectionHandle['rpc']): ImageLoader {
  // The host validates a full ImageAttachmentRef payload (readImage takes the
  // whole ref), so forward the attachment verbatim.
  return attachment =>
    callSubscriptionsAuth<ImageEndpointResult>(rpc, 'image', { ...attachment })
      .then(result => `data:${result.mediaType};base64,${result.dataBase64}`)
}

/** Image attachments of a settled result; empty while running or on the text-only route. */
function resultImages(block: ToolCallBlock): { attachment: ImageAttachmentRef }[] {
  if (!('kind' in block)) return []
  const images: { attachment: ImageAttachmentRef }[] = []
  for (const part of block.content) {
    if (part.type === 'image') images.push({ attachment: part.attachment as ImageAttachmentRef })
  }
  return images
}

/**
 * The `image_generate` keyed toolview component.
 * @param props - owner share, inject face, and locale seat (spread flat).
 * @returns the call row plus, once settled, the gallery / text / error body.
 */
export function ImageGenerateToolview(props: ImageGenerateToolviewProps) {
  const { block, load } = props
  const t = props.t ?? fallbackTranslate
  if (block === undefined) return null
  const settled = 'kind' in block
  const argsRaw = settled ? block.call?.argsRaw ?? '' : block.phase === 'start' ? block.argsRaw : ''
  let references = 0
  try {
    const args = JSON.parse(argsRaw)
    if (Array.isArray(args?.referenceImages)) references = args.referenceImages.length
  } catch { /* Arguments may still be streaming. */ }
  const prompt = derivePrompt(argsRaw)
  const title = references > 0
    ? t('imageGenerateTitleReferences', { count: references, prompt })
    : t('imageGenerateTitle', { prompt })
  const images = resultImages(block)
  const text = settled ? resultText(block) : ''
  const labels: MessageImageLabels = {
    image: t('image'),
    open: t('viewImage'),
    openNamed: name => t('viewImageNamed', { name }),
    loading: t('imageLoading'),
    loadFailed: t('imageLoadFailed'),
    lightbox: { dialog: t('imagePreview'), close: t('imageClose') },
  }
  return (
    <div style={toolviewStyles.container}>
      <div style={toolviewStyles.row}>
        <span style={toolviewStyles.icon}><IconSparkleRegular size={14} /></span>
        <span style={toolviewStyles.title}>{title}</span>
      </div>
      {!settled && <p style={toolviewStyles.subtle}>{t('generating')}</p>}
      {settled && block.isError && text !== '' && (
        <p style={toolviewStyles.error}>{text.split('\n', 1)[0]}</p>
      )}
      {settled && !block.isError && images.length > 0 && load !== undefined && (
        <ImageGallery images={images} load={load} labels={labels} />
      )}
      {settled && !block.isError && images.length === 0 && text !== '' && (
        <p style={toolviewStyles.output}>{text}</p>
      )}
    </div>
  )
}
