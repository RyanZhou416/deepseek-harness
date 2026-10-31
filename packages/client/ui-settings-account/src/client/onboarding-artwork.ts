/** Lazily loaded Desktop-onboarding screenshots. */
import { useEffect, useState } from 'react'

/**
 * One onboarding step's light and dark screenshots, selected for an interface
 * language by the step's artwork module.
 */
export interface OnboardingArtwork {
  /** Screenshot shown in the light theme. */
  readonly src: string
  /** Screenshot shown in the dark theme. */
  readonly darkSrc: string
}

/**
 * Import one step's artwork module and read its screenshots for an interface
 * language. The importer is module-bound so the bundler emits one package-local
 * lazy chunk per step.
 */
export type LoadOnboardingArtwork = (locale: string) => Promise<OnboardingArtwork>

/**
 * Load one step's screenshots after its page mounts.
 *
 * The screenshots are the account client bundle's largest assets and only the
 * Desktop introduction displays them, so each step imports its artwork module
 * on demand: the import becomes a `client.<module>.js` chunk that the client
 * module system fetches lazily ([client-modules](../../../modules/README.md)).
 * The startup combo therefore never carries the images; a plain Web client
 * never requests them. Artwork is decorative, so a failed chunk load leaves
 * the step without a screenshot instead of blocking the introduction.
 * @param load - module-bound loader for this step's artwork.
 * @param locale - active interface language; the loader resolves the matching screenshot pair.
 * @returns the screenshots, or `undefined` until the artwork chunk arrives.
 */
export function useOnboardingArtwork(load: LoadOnboardingArtwork, locale: string): OnboardingArtwork | undefined {
  const [artwork, setArtwork] = useState<OnboardingArtwork>()
  useEffect(() => {
    let current = true
    void load(locale).then(
      (loaded) => { if (current) setArtwork(loaded) },
      () => {
        // A decorative screenshot that fails to load leaves the step usable;
        // there is no user action that would retry it meaningfully.
      },
    )
    return () => { current = false }
  }, [load, locale])
  return artwork
}
