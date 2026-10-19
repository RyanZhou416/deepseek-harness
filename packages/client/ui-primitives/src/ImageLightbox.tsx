import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutlineRegular } from './icons/index.tsx'
import css from './ImageLightbox.module.css'

/** Lightbox strings the owner resolves from its own locale namespace. */
export interface ImageLightboxLabels {
  /** Accessible name of the preview dialog. */
  dialog: string
  /** Accessible label of the close control. */
  close: string
}

/** Scale bounds for the original-image preview. */
const MIN_SCALE = 1
const MAX_SCALE = 6
const ZOOM_STEP = 1.25

/** Pointer capture is unavailable in older DOM implementations. */
type PointerCaptureTarget = {
  setPointerCapture?: (pointerId: number) => void
  releasePointerCapture?: (pointerId: number) => void
}

/** Clamp the preview scale to the supported zoom range. */
function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

/**
 * Document-level original-image preview opened by clicking a thumbnail.
 * Closes on Escape, backdrop press, or the close control, and restores focus
 * to the opener on unmount. The image zooms with the wheel or a double-click
 * and pans by dragging while zoomed. Rendered through a body portal: an
 * opener inside a transformed or filtered ancestor would otherwise trap the
 * fixed backdrop in that ancestor's box instead of covering the viewport.
 *
 * @param props.src - the original image URL.
 * @param props.alt - the image's alt text.
 * @param props.labels - dialog and close-control strings.
 * @param props.onClose - dismiss callback owned by the opener.
 * @returns the modal preview dialog.
 */
export function ImageLightbox({ src, alt, labels, onClose }: {
  src: string
  alt: string
  labels: ImageLightboxLabels
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null)
  const [view, setView] = useState({ scale: MIN_SCALE, x: 0, y: 0 })

  const clampOffset = (scale: number, x: number, y: number): { x: number; y: number } => {
    const viewport = viewportRef.current
    /* v8 ignore next -- wheel and pointer handlers cannot run before the viewport mounts */
    if (viewport === null) return { x: 0, y: 0 }
    const size = viewport.getBoundingClientRect()
    const limitX = (size.width * (scale - MIN_SCALE)) / 2
    const limitY = (size.height * (scale - MIN_SCALE)) / 2
    return {
      x: Math.min(limitX, Math.max(-limitX, x)),
      y: Math.min(limitY, Math.max(-limitY, y)),
    }
  }

  const applyZoom = (factor: number): void => {
    setView((current) => {
      const scale = clampScale(current.scale * factor)
      if (scale === MIN_SCALE) return { scale, x: 0, y: 0 }
      return { scale, ...clampOffset(scale, current.x, current.y) }
    })
  }

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      if (event.key === 'Tab') { event.preventDefault(); closeRef.current?.focus() }
    }
    const viewport = viewportRef.current
    const onWheel = (event: globalThis.WheelEvent): void => {
      event.preventDefault()
      applyZoom(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
    }
    window.addEventListener('keydown', onKeyDown, true)
    viewport?.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      viewport?.removeEventListener('wheel', onWheel)
      restoreRef.current?.focus()
    }
  }, [onClose])

  return createPortal(
    <div
      className={css.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={labels.dialog}
    >
      <div className={css.stage} onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}>
        <div className={css.mask} aria-hidden="true" onMouseDown={onClose} />
        <div
          ref={viewportRef}
          className={css.viewport}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose()
          }}
          onPointerDown={(event) => {
            if (view.scale <= MIN_SCALE) return
            const target = event.currentTarget as PointerCaptureTarget
            target.setPointerCapture?.(event.pointerId)
            dragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              originX: view.x,
              originY: view.y,
            }
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current
            if (drag === null || drag.pointerId !== event.pointerId) return
            setView(current => ({
              ...current,
              ...clampOffset(current.scale, drag.originX + event.clientX - drag.startX, drag.originY + event.clientY - drag.startY),
            }))
          }}
          onPointerUp={(event) => {
            if (dragRef.current?.pointerId !== event.pointerId) return
            dragRef.current = null
            const target = event.currentTarget as PointerCaptureTarget
            target.releasePointerCapture?.(event.pointerId)
          }}
          onPointerCancel={() => { dragRef.current = null }}
          onDoubleClick={() => {
            setView(current => current.scale === MIN_SCALE
              ? { scale: 2, x: 0, y: 0 }
              : { scale: MIN_SCALE, x: 0, y: 0 })
          }}
        >
          <img
            className={css.image}
            src={src}
            alt={alt}
            draggable={false}
            style={{
              cursor: view.scale > MIN_SCALE ? 'grab' : 'default',
              transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
            }}
          />
        </div>
        <button ref={closeRef} type="button" className={css.close} aria-label={labels.close} onClick={onClose}>
          <IconCloseOutlineRegular size={16} />
        </button>
      </div>
    </div>,
    document.body,
  )
}
