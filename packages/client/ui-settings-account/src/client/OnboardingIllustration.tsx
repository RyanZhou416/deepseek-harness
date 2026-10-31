/** Paired artwork follows the page's light and dark theme selectors. */
import type { OnboardingArtwork } from './onboarding-artwork.ts'
import css from './DesktopOnboarding.module.css'

/**
 * @param props - artwork URLs and feature-owned geometry; the artwork is absent until its lazy chunk arrives.
 * @returns decorative theme variants, or the empty frame while the screenshots load.
 */
export function OnboardingIllustration({ className = '', artwork }: {
  className?: string | undefined
  artwork: OnboardingArtwork | undefined
}) {
  return <div className={`${css.illustration} ${className}`} aria-hidden="true">
    {artwork === undefined ? null : <>
      <img className={css.lightIllustration} src={artwork.src} alt="" />
      <img className={css.darkIllustration} src={artwork.darkSrc} alt="" />
    </>}
  </div>
}
