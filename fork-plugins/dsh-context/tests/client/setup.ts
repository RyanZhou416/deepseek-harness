// DeepSeek Harness fork modification: scope the RC.1 Tooltip ResizeObserver fixture to each test file.
// Client project setup: React 18 `act` requires this flag to flush effects
// synchronously in tests; every jsdom spec shares the real React runtime.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { afterAll, beforeAll } from 'vitest'

const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
class LayoutFreeResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: LayoutFreeResizeObserver })
})
afterAll(() => {
  if (resizeObserverDescriptor === undefined) Reflect.deleteProperty(globalThis, 'ResizeObserver')
  else Object.defineProperty(globalThis, 'ResizeObserver', resizeObserverDescriptor)
})

import { resetModelPrices, setModelPricesLoader } from '../../src/client/modelPrices'

// jsdom does not implement scrollIntoView; the plugin calls it when focusing
// a browser row. A no-op polyfill stands in for the platform (layout-free).
if (typeof Element !== 'undefined' && Element.prototype.scrollIntoView === undefined) {
  Element.prototype.scrollIntoView = () => {}
}

// The model-price store starts DORMANT in tests: its loader resolves never,
// so no spec ever reaches the network. Specs that need prices inject their
// own loader (resetModelPrices + setModelPricesLoader, see modelPrices.spec).
resetModelPrices()
setModelPricesLoader(() => new Promise(() => {}))
