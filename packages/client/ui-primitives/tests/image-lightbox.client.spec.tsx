// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ImageLightbox } from '../src/ImageLightbox.tsx'

afterEach(cleanup)

const labels = { dialog: '原图预览', close: '关闭原图预览' }

describe('ImageLightbox', () => {
  it('focuses its close control, closes by button and Escape, and restores focus', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    const close = view.getByRole('button', { name: '关闭原图预览' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    const outerKey = vi.fn()
    document.body.addEventListener('keydown', outerKey)
    try {
      fireEvent.keyDown(close, { key: 'Escape' })
      expect(outerKey).not.toHaveBeenCalled()
    } finally { document.body.removeEventListener('keydown', outerKey) }
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('tolerates a focus owner it cannot restore (no active element at mount)', () => {
    // jsdom always reports body as the fallback active element; stub the
    // element-less state a detached focus can leave.
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => null })
    try {
      const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} />)
      view.unmount()
    } finally {
      delete (document as { activeElement?: unknown }).activeElement
    }
  })

  it('closes on a mask press but not on a press over the image', () => {
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    fireEvent.mouseDown(view.getByRole('img'))
    expect(onClose).not.toHaveBeenCalled()
    const mask = document.querySelector('[aria-hidden="true"]') as HTMLElement
    fireEvent.mouseDown(mask)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('zooms with the wheel and pans by dragging while zoomed', () => {
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} />)
    const image = view.getByRole('img')
    const viewport = image.parentElement as HTMLElement
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0,
      toJSON: () => ({}),
    })

    fireEvent.doubleClick(image)
    expect(image.style.transform).toBe('translate3d(0px, 0px, 0) scale(2)')
    fireEvent.doubleClick(image)
    expect(image.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)')

    fireEvent.wheel(viewport, { deltaY: -100 })
    expect(image.style.transform).toContain('scale(1.25)')

    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 180, clientY: 160 })
    fireEvent.pointerUp(viewport, { pointerId: 1 })
    expect(image.style.transform).toBe('translate3d(0px, 0px, 0) scale(1.25)')

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 180, clientY: 160 })
    fireEvent.pointerUp(image, { pointerId: 1 })
    expect(image.style.transform).toBe('translate3d(80px, 60px, 0) scale(1.25)')

    fireEvent.doubleClick(image)
    expect(image.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)')

    fireEvent.wheel(viewport, { deltaY: -100 })
    fireEvent.wheel(viewport, { deltaY: 100 })
    expect(image.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)')
  })

  it('closes on a blank press and ignores a drag before zoom', () => {
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    const image = view.getByRole('img')
    const viewport = image.parentElement as HTMLElement

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 80, clientY: 60 })
    fireEvent.pointerCancel(viewport, { pointerId: 1 })
    expect(image.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)')

    fireEvent.mouseDown(viewport)
    expect(onClose).toHaveBeenCalledTimes(1)
    const stage = view.getByRole('dialog').firstElementChild as HTMLElement
    fireEvent.mouseDown(stage)
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
