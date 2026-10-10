/**
 * Keyed toolview for the `video_generate` tool: renders the generated video
 * inline in the conversation. The row shows the call's prompt while running
 * and after settling; a settled success loads the MP4 bytes through the node
 * half's `/subscriptions-auth` `video` endpoint (by bare file name), builds a
 * Blob URL, and plays it in a native `<video controls>` element. The file
 * name comes from the result's presentation meta when the dispatch was
 * top-level, and is recovered from the "Saved video to …" text line for
 * nested (Code Mode) dispatches, where the harness computes no meta. A result
 * with neither renders its text; an error result renders the first error line.
 *
 * The 'tool.call.toolview' SlotMap entry is declared by
 * ImageGenerateToolview.tsx in this same package (one declaration per
 * augmentation), so this file only uses the shared owner-props mirror.
 */
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { derivePrompt, fallbackTranslate, resultText, toolviewStyles } from './format.js'
import type { SubscriptionsTranslate, ToolCallOwnerProps } from './format.js'

/** Decoded video bytes as the node half's `video` endpoint answers them. */
interface VideoBytes {
  mediaType: string
  dataBase64: string
}

/** Injected dependencies of {@link VideoGenerateToolview} (slot `inject`). */
export interface VideoGenerateToolviewInjected {
  /** Loads one generated video's bytes by bare file name. */
  loadVideo: (name: string) => Promise<VideoBytes>
}

/**
 * Props delivered by the toolview outlet: the owner share plus the inject
 * face and the framework locale seat, spread flat.
 */
export type VideoGenerateToolviewProps =
  Partial<ToolCallOwnerProps>
  & Partial<VideoGenerateToolviewInjected>
  & { t?: SubscriptionsTranslate | undefined }

/**
 * Build the video loader over the `/subscriptions-auth` `video` endpoint.
 * @param rpc - Connection RPC caller.
 * @returns loader resolving a bare file name to the decoded bytes.
 */
export function createVideoLoader(rpc: ConnectionHandle['rpc']): (name: string) => Promise<VideoBytes> {
  return name => callSubscriptionsAuth<VideoBytes>(rpc, 'video', { name })
}

/**
 * The generated video's bare file name: presentation meta first (top-level
 * dispatches), then the render text's "Saved video to …" line (nested
 * dispatches compute no meta).
 */
function resolveFileName(block: ToolCallBlock): string | undefined {
  if (!('kind' in block)) return undefined
  const meta = block.meta
  if (typeof meta === 'object' && meta !== null) {
    const fileName = (meta as Record<string, unknown>).fileName
    if (typeof fileName === 'string' && fileName.length > 0) return fileName
  }
  const match = /^Saved video to (.+\.mp4)/m.exec(resultText(block))
  if (match === null) return undefined
  const path = match[1]
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Decode a base64 payload into bytes (browser-side; no Buffer). */
function base64Bytes(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Loading lifecycle of the Blob URL. */
type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; url: string }
  | { phase: 'failed'; message: string }

const styles: Record<string, CSSProperties> = {
  ...toolviewStyles,
  video: {
    display: 'block', maxWidth: 480, width: '100%', borderRadius: 8,
    backgroundColor: 'var(--dsw-alias-fill-tertiary)',
  },
}

/**
 * The `video_generate` keyed toolview component.
 * @param props - owner share, inject face, and locale seat (spread flat).
 * @returns the call row plus, once settled, the player / text / error body.
 */
export function VideoGenerateToolview(props: VideoGenerateToolviewProps) {
  const { block, loadVideo } = props
  const t = props.t ?? fallbackTranslate
  const settled = block !== undefined && 'kind' in block
  const isError = settled && block.isError
  const fileName = block !== undefined && settled && !isError ? resolveFileName(block) : undefined
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' })

  useEffect(() => {
    if (fileName === undefined || loadVideo === undefined) return
    let cancelled = false
    let objectUrl: string | undefined
    setLoad({ phase: 'loading' })
    loadVideo(fileName).then(
      (video) => {
        if (cancelled) return
        // Uint8Array#slice detaches a plain ArrayBuffer view for BlobPart.
        objectUrl = URL.createObjectURL(new Blob([base64Bytes(video.dataBase64).slice()], { type: video.mediaType }))
        setLoad({ phase: 'ready', url: objectUrl })
      },
      (error: unknown) => {
        if (cancelled) return
        setLoad({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      cancelled = true
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl)
    }
  }, [fileName, loadVideo])

  if (block === undefined) return null
  const argsRaw = settled ? block.call?.argsRaw ?? '' : block.phase === 'start' ? block.argsRaw : ''
  const title = t('videoGenerateTitle', { prompt: derivePrompt(argsRaw) })
  const text = settled ? resultText(block) : ''
  return (
    <div style={styles.container}>
      <div style={styles.row}>
        <span style={styles.icon}><IconSparkleRegular size={14} /></span>
        <span style={styles.title}>{title}</span>
      </div>
      {!settled && <p style={styles.subtle}>{t('generatingVideo')}</p>}
      {settled && isError && text !== '' && (
        <p style={styles.error}>{text.split('\n', 1)[0]}</p>
      )}
      {settled && !isError && fileName !== undefined && load.phase === 'loading' && (
        <p style={styles.subtle}>{t('videoLoading')}</p>
      )}
      {settled && !isError && fileName !== undefined && load.phase === 'failed' && (
        <p style={styles.error}>{t('videoLoadFailed', { message: load.message })}</p>
      )}
      {settled && !isError && fileName !== undefined && load.phase === 'ready' && (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- generated clip; no caption track exists.
        <video style={styles.video} src={load.url} controls preload="metadata" />
      )}
      {settled && !isError && fileName === undefined && text !== '' && (
        <p style={styles.output}>{text}</p>
      )}
    </div>
  )
}
