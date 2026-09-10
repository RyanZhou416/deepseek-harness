// Touch-first browser regression: selecting Session rows must not focus the
// resident composer and summon the software keyboard. The seeded-history
// fixture supplies two durable rows; no model call is involved.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))

describe('web e2e: mobile Session focus', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const seed = await readFile(SEED, 'utf8')
    await seedSession(scaffold, seed, 'mobile-focus-a')
    await seedSession(scaffold, seed, 'mobile-focus-b')
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      locale: 'en-US',
      timezoneId: 'Asia/Shanghai',
      hasTouch: true,
      isMobile: true,
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps the composer blurred across touch-first Session-row navigation', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-mobile-session-focus'))
    expect(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)).toBe(true)

    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await page.getByRole('button', { name: 'Collapse sidebar' }).waitFor({ timeout: 10_000 })
    const ungroupedRow = page.getByText('Ungrouped', { exact: true }).locator('..').locator('..')
    const ungroupedSection = ungroupedRow.locator('..')
    await expect.poll(async () => {
      if (await ungroupedRow.getAttribute('aria-expanded') !== 'true') {
        await page.getByText('Ungrouped', { exact: true }).click()
      }
      return await ungroupedRow.getAttribute('aria-expanded')
    }, { timeout: 10_000 }).toBe('true')

    const rows = ungroupedSection.locator('[role="treeitem"]')
      .filter({ has: page.locator('button[aria-label^="Session actions for "]') })
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBe(2)
    const composer = page.locator('[data-composer-input][contenteditable="true"]')

    for (const index of [0, 1]) {
      const row = rows.nth(index)
      await row.click()
      await expect.poll(() => row.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')
      expect(await composer.evaluate(element => element !== document.activeElement)).toBe(true)
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
