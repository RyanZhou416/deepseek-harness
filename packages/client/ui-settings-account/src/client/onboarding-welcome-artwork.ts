/** Welcome-step screenshots: a lazy chunk fetched on first display. */
import type { OnboardingArtwork } from './onboarding-artwork.ts'
import art from './assets/onboarding-welcome.webp'
import artDark from './assets/onboarding-welcome-dark.webp'
import artZh from './assets/onboarding-welcome-zh.webp'
import artZhDark from './assets/onboarding-welcome-zh-dark.webp'

/**
 * Select the welcome screenshot pair for an interface language.
 * @param locale - active interface language; `zh` selects the Chinese artwork.
 * @returns the light and dark screenshot URLs.
 */
export function welcomeArtwork(locale: string): OnboardingArtwork {
  return locale === 'zh' ? { src: artZh, darkSrc: artZhDark } : { src: art, darkSrc: artDark }
}
