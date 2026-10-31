// @vitest-environment jsdom
/**
 * Lazy onboarding artwork: each step selects its screenshots for the active
 * language, publishes them once the chunk arrives, ignores a result after
 * unmount, and keeps the page usable when the chunk cannot load.
 */
import { render, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OnboardingIllustration } from '../src/client/OnboardingIllustration.tsx'
import { useOnboardingArtwork, type OnboardingArtwork } from '../src/client/onboarding-artwork.ts'
import { welcomeArtwork } from '../src/client/onboarding-welcome-artwork.ts'
import { creditArtwork } from '../src/client/onboarding-credit-artwork.ts'

describe('OnboardingIllustration', () => {
  it('renders the screenshot pair only once the artwork arrives', () => {
    const view = render(<OnboardingIllustration artwork={undefined} />)
    expect(view.container.querySelectorAll('img')).toHaveLength(0)
    view.rerender(<OnboardingIllustration artwork={{ src: 'light.webp', darkSrc: 'dark.webp' }} />)
    expect([...view.container.querySelectorAll('img')].map(image => image.getAttribute('src')))
      .toEqual(['light.webp', 'dark.webp'])
  })
})

describe('onboarding artwork selection', () => {
  it('pairs each step with the screenshots of the active language', () => {
    expect(welcomeArtwork('en').src).toContain('onboarding-welcome.webp')
    expect(welcomeArtwork('en').darkSrc).toContain('onboarding-welcome-dark.webp')
    expect(welcomeArtwork('zh').src).toContain('onboarding-welcome-zh.webp')
    expect(welcomeArtwork('zh').darkSrc).toContain('onboarding-welcome-zh-dark.webp')
    expect(creditArtwork('en').src).toContain('onboarding-recharge.webp')
    expect(creditArtwork('en').darkSrc).toContain('onboarding-recharge-dark.webp')
    expect(creditArtwork('zh').src).toContain('onboarding-recharge-zh.webp')
    expect(creditArtwork('zh').darkSrc).toContain('onboarding-recharge-zh-dark.webp')
  })
})

describe('useOnboardingArtwork', () => {
  it('publishes the loaded pair and reloads after a language change', async () => {
    const load = vi.fn(async (locale: string): Promise<OnboardingArtwork> =>
      locale === 'zh' ? { src: 'zh-light', darkSrc: 'zh-dark' } : { src: 'en-light', darkSrc: 'en-dark' })
    const { result, rerender } = renderHook(({ locale }) => useOnboardingArtwork(load, locale), {
      initialProps: { locale: 'en' },
    })
    await waitFor(() => { expect(result.current).toEqual({ src: 'en-light', darkSrc: 'en-dark' }) })
    rerender({ locale: 'zh' })
    await waitFor(() => { expect(result.current).toEqual({ src: 'zh-light', darkSrc: 'zh-dark' }) })
    expect(load.mock.calls).toEqual([['en'], ['zh']])
  })

  it('ignores a screenshot loaded after the step unmounted', async () => {
    let resolve: (value: OnboardingArtwork) => void = () => {}
    const load = vi.fn(() => new Promise<OnboardingArtwork>((done) => { resolve = done }))
    const { result, unmount } = renderHook(() => useOnboardingArtwork(load, 'en'))
    expect(result.current).toBeUndefined()
    unmount()
    resolve({ src: 'late', darkSrc: 'late-dark' })
    await Promise.resolve()
    expect(result.current).toBeUndefined()
  })

  it('leaves the step without screenshots when the artwork chunk fails', async () => {
    const load = vi.fn(() => Promise.reject(new Error('artwork chunk unavailable')))
    const { result } = renderHook(() => useOnboardingArtwork(load, 'zh'))
    await waitFor(() => { expect(load).toHaveBeenCalledWith('zh') })
    await Promise.resolve()
    expect(result.current).toBeUndefined()
  })
})
