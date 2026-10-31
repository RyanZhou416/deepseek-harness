/**
 * One document-wide IntersectionObserver gate shared by viewport-activated
 * rendering. Activation is permanent per element: an activated element leaves
 * the observer, and the observer is released with its last registration. A
 * React owner that moves a scrollport imperatively rechecks the gate after the
 * write, so an element the user is about to see activates before paint instead
 * of on the observer's next delivery.
 */

/**
 * Whether an element's box intersects the window expanded by `screens` viewport heights.
 * @param element - element whose box is measured.
 * @param screens - margin in viewport heights; zero tests the window itself.
 * @returns whether the box intersects the expanded window.
 */
export function withinScreens(element: Element, screens: number): boolean {
  const rect = element.getBoundingClientRect()
  // A box-less element — `content-visibility: hidden` content such as a
  // `hidden="until-found"` transcript fold, or an environment without a layout
  // engine — cannot be decided from geometry; only the observer reports it.
  if (rect.width === 0 && rect.height === 0) return false
  const margin = window.innerHeight * screens
  return rect.bottom >= -margin && rect.top <= window.innerHeight + margin
}

/** Permanent first-intersection activation for one shared observer. */
export class ViewportActivationGate {
  private observer: IntersectionObserver | undefined
  private readonly activations = new Map<Element, () => void>()

  /** @param screens - activation margin, in viewport heights. */
  constructor(private readonly screens: number) {}

  /**
   * Observe one element until it first intersects the gate margin.
   * @param element - element whose box gates activation.
   * @param activate - called once, when the element enters the margin.
   * @returns disposer that stops observing an element that has not activated.
   */
  observe(element: Element, activate: () => void): () => void {
    this.observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const current = this.activations.get(entry.target)
        /* v8 ignore next -- the observer reports only elements still registered with it. */
        if (current === undefined) continue
        this.activations.delete(entry.target)
        this.observer?.unobserve(entry.target)
        current()
      }
      this.releaseEmptyObserver()
    }, { rootMargin: `${this.screens * 100}% 0px` })
    this.activations.set(element, activate)
    this.observer.observe(element)
    return () => {
      this.activations.delete(element)
      this.observer?.unobserve(element)
      this.releaseEmptyObserver()
    }
  }

  /** Activate every registered element already inside the gate margin. */
  recheck(): void {
    const pending: Array<() => void> = []
    for (const [element, activate] of this.activations) {
      if (!withinScreens(element, this.screens)) continue
      this.activations.delete(element)
      this.observer?.unobserve(element)
      pending.push(activate)
    }
    this.releaseEmptyObserver()
    for (const activate of pending) activate()
  }

  private releaseEmptyObserver(): void {
    if (this.activations.size > 0) return
    this.observer?.disconnect()
    this.observer = undefined
  }
}
