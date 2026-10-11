/** Offline Chromium geometry regression using real menu components, no server or provider calls. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../../..')
const web = createRequire(resolve(root, 'apps/web/package.json'))
const vite = createRequire(web.resolve('vite'))
const ui = createRequire(resolve(root, 'packages/client/ui-primitives/package.json'))
const { build } = vite('esbuild')
const { chromium } = web('playwright')
const result = await build({
  entryPoints: [resolve(here, 'speed-menu.fixture.tsx')], bundle: true, write: false,
  outfile: resolve(here, 'fixture.js'), format: 'iife', platform: 'browser',
  tsconfig: resolve(root, 'tsconfig.base.client.json'), jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
  logLimit: 3,
  plugins: [{ name: 'shared-browser-react', setup(builder) {
    builder.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, ({ path }) => ({ path: ui.resolve(path) }))
  } }],
})
const code = result.outputFiles.find(file => file.path.endsWith('.js')).text
const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? ''
const browser = await chromium.launch({ headless: true })
try {
  const measurements = []
  for (const locale of ['zh', 'en']) {
    for (const theme of ['dark', 'light']) {
    for (const [width, height] of [[1100, 700], [427, 300], [360, 240]]) {
      const page = await browser.newPage({ viewport: { width, height } })
      const errors = []
      const network = []
      page.on('pageerror', error => errors.push(error.message))
      await page.route(/^https?:/, route => { network.push(route.request().url()); return route.abort() })
      await page.setContent(`<html lang="${locale}"><head><style>
        :root { --dsw-alias-label-primary: #eeeeee; --dsw-alias-label-secondary: #bbb;
          --dsw-alias-label-tertiary: #aaa; --dsw-alias-label-caption: #999;
          --dsw-specific-menu: #292a2d; --dsw-menu-backdrop-filter: none;
          --dsw-alias-interactive-bg-hover: #414246; --dsw-alias-state-error-primary: #ffb0b0; }
        body { margin: 0; background: #191919; font: 14px system-ui; }
        ${css}
      </style></head><body><div id="root"></div></body></html>`)
      if (theme === 'light') await page.addStyleTag({ content: ':root { --dsw-alias-label-primary:#202020;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#666;--dsw-alias-label-caption:#666;--dsw-specific-menu:#fff;--dsw-alias-interactive-bg-hover:#eee; } body { background:#f5f5f5; }' })
      await page.addScriptTag({ content: code })
      const trigger = page.getByRole('button', { name: locale === 'zh' ? /^选择模型/ : /^Select model/ })
      await trigger.click()
      const speed = page.getByRole('menuitem', { name: locale === 'zh' ? /^速度/ : /^Speed/ })
      await speed.click()
      const fast = page.getByRole('menuitemradio', { name: locale === 'zh' ? /^快速/ : /^Fast/ })
      await fast.waitFor()
      const geometry = await fast.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const menu = element.closest('[role="menu"]')
        const parent = menu?.getBoundingClientRect()
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
        const hit = document.elementFromPoint(x, y)
        return {
          option: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
          menu: parent && { top: parent.top, bottom: parent.bottom },
          fullyVisible: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth,
          clickable: hit !== null && (hit === element || element.contains(hit)),
        }
      })
      measurements.push({ locale, theme, width, height, ...geometry })
      console.log(JSON.stringify(measurements.at(-1)))
      assert.equal(geometry.fullyVisible, true, 'Fast must fit inside the viewport')
      assert.equal(geometry.clickable, true, 'Fast must not be clipped or covered')
      assert.equal(await page.getByRole('menuitem', { name: locale === 'zh' ? /^模型/ : /^Model/ }).count(), 0, 'Speed drills in instead of appending under the root cells')
      await fast.click()
      assert.equal(await page.evaluate(() => window.speedFixture.tier), 'fast')
      assert.equal(await page.evaluate(() => window.speedFixture.writes), 1)
      await page.getByRole('menu').waitFor({ state: 'detached' })
      assert.equal(await trigger.evaluate(element => element === document.activeElement), true)
      await trigger.click()
      await speed.focus()
      await page.keyboard.press('Enter')
      await fast.waitFor()
      await page.evaluate(() => { window.speedFixture.controls.fail = true; window.speedFixture.controls.delay = 50 })
      await page.getByRole('menuitemradio', { name: locale === 'zh' ? /^标准/ : /^Standard/ }).click()
      await page.getByRole('alert').waitFor()
      assert.equal(await page.getByRole('menu').count(), 1, 'failed save keeps the speed pane open')
      assert.equal(await page.evaluate(() => window.speedFixture.tier), 'fast')
      await page.keyboard.press('Escape')
      assert.equal(await speed.evaluate(element => element === document.activeElement), true, 'Back returns focus to Speed')
      await page.keyboard.press('Escape')
      await page.getByRole('menu').waitFor({ state: 'detached' })
      assert.equal(await trigger.evaluate(element => element === document.activeElement), true)
      await trigger.click()
      await page.mouse.click(2, 2)
      await page.getByRole('menu').waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
      assert.deepEqual(network, [], 'fixture makes no network requests')
      await page.close()
    }
    }
  }
  console.log('Speed submenu browser geometry checks passed.')
} finally { await browser.close() }
