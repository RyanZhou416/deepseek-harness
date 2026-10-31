/** Credit-step screenshots: a lazy chunk fetched on first display. */
import type { OnboardingArtwork } from './onboarding-artwork.ts'
import art from './assets/onboarding-recharge.webp'
import artDark from './assets/onboarding-recharge-dark.webp'
import artZh from './assets/onboarding-recharge-zh.webp'
import artZhDark from './assets/onboarding-recharge-zh-dark.webp'

/**
 * Select the credit screenshot pair for an interface language.
 * @param locale - active interface language; `zh` selects the Chinese artwork.
 * @returns the light and dark screenshot URLs.
 */
export function creditArtwork(locale: string): OnboardingArtwork {
  return locale === 'zh' ? { src: artZh, darkSrc: artZhDark } : { src: art, darkSrc: artDark }
}
