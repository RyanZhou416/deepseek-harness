import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/turn-tail-actions/session.v3.jsonl', import.meta.url))
const FIRST_PARAGRAPH = 'The completed reply stays readable without switching Sessions.'
const FINAL_PARAGRAPH = 'Final paragraph for the translation compatibility check.'
const MARKDOWN = [
  '# Translation compatibility reply', '', FIRST_PARAGRAPH, '',
  '| Item | State |', '| --- | --- |', '| Reply | Complete |', '| Tools | Unchanged |', '',
  'See [the local note](<notes/设计.md>) and keep **this emphasis**.', '', FINAL_PARAGRAPH,
].join('\n')

type RewriteMode = 'replace' | 'reparent'

/** Model a translator that replaces text or retains the original under its translated wrapper. */
async function installTextRewriter(page: Page, mode: RewriteMode): Promise<void> {
  await page.addInitScript(({ mode }) => {
    let scheduled = false
    const rewrite = () => {
      scheduled = false
      for (const root of document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')) {
        if (root.closest('[translate="no"], .notranslate')) continue
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        const texts: Text[] = []
        while (walker.nextNode()) {
          const text = walker.currentNode as Text
          if (text.textContent?.trim() && !text.parentElement?.closest('[data-test-translation], pre, code, script, style')) {
            texts.push(text)
          }
        }
        for (const text of texts) {
          const parent = text.parentNode
          if (parent === null) continue
          // oxlint-disable-next-line typescript/no-deprecated -- Model the legacy wrapper inserted by translation extensions.
          const wrapper = document.createElement('font')
          wrapper.dataset.testTranslation = 'true'
          wrapper.dataset.sourceText = text.textContent ?? ''
          wrapper.textContent = `译：${text.textContent ?? ''}`
          parent.replaceChild(wrapper, text)
          if (mode === 'reparent') {
            const original = document.createElement('span')
            original.hidden = true
            original.append(text)
            wrapper.append(original)
          }
        }
      }
    }
    new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(rewrite)
    }).observe(document, { childList: true, characterData: true, subtree: true })
  }, { mode })
}

it.skipIf(webSnapshotMode() === 'record').each(['replace', 'reparent'] as const)(
  'keeps translation visible during streaming and settlement (%s text nodes)', async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-translation-browser-'))
    let scaffold: WebScaffold | undefined
    let browser: Browser | undefined
    let disposeStreamGate: (() => void) | undefined
    let settled: Promise<unknown> | undefined
    const releases = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    const failures: unknown[] = []
    try {
      const chunks: StreamChunk[] = [{ type: 'block-start', index: 0, blockType: 'text' }]
      for (let i = 0; i < MARKDOWN.length; i += 9) chunks.push({ type: 'text-delta', index: 0, text: MARKDOWN.slice(i, i + 9) })
      chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text: MARKDOWN } }, { type: 'finish', reason: { kind: 'stop' } })
      const override = join(directory, 'replay.override.json')
      await writeFile(override, JSON.stringify([{ kind: 'chunks', chunks }]))
      scaffold = await launchWebScaffold({ replayFixture: FIXTURE, replayOverride: override, compareReplaySession: false, paceMs: 12 })
      const stops = [MARKDOWN.indexOf('| Item'), MARKDOWN.indexOf(FINAL_PARAGRAPH)]
      disposeStreamGate = scaffold.ctx.on('llm/stream', async function* (_options, next) {
        let length = 0
        let stop = 0
        for await (const chunk of next()) {
          yield chunk
          if (chunk.type === 'text-delta') length += chunk.text.length
          const threshold = stops[stop]
          if (threshold !== undefined && length >= threshold) {
            await releases[stop]!.promise
            stop += 1
          }
        }
      })
      browser = await chromium.launch()
      const page = await newEnglishPage(browser)
      await installTextRewriter(page, mode)
      const errors: string[] = []
      const pageErrors: string[] = []
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
      page.on('pageerror', (error) => { pageErrors.push(error.message) })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      settled = scaffold.whenTurnSettled(30_000)
      // Attach rejection handling before browser assertions can interrupt the turn wait.
      void settled.catch((_error: unknown) => { /* The same promise is awaited during teardown. */ })
      const input = page.locator('[data-composer-input]').first()
      await input.fill('Show the translation compatibility example.')
      await input.press('Enter')
      const row = page.locator('[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]')
      const translatedPrefix = row.locator(`[data-test-translation][data-source-text="${FIRST_PARAGRAPH}"]`)
      await translatedPrefix.waitFor({ state: 'visible', timeout: 10_000 })
      expect(await row.locator('[data-streaming]').count()).toBe(1)
      expect(await row.innerText()).toContain(`译：${FIRST_PARAGRAPH}`)
      expect(await row.innerText()).not.toContain(FINAL_PARAGRAPH)
      expect(await row.getAttribute('translate')).toBeNull()
      await translatedPrefix.evaluate((element) => { element.setAttribute('data-preserved-prefix', 'true') })
      releases[0]!.resolve(undefined)

      await row.locator('[data-test-translation][data-source-text="this emphasis"]').waitFor({ state: 'visible', timeout: 10_000 })
      expect(await row.locator('[data-streaming]').count()).toBe(1)
      expect(await row.locator('[data-preserved-prefix]').count()).toBe(1)
      expect(await row.innerText()).toContain(`译：${FIRST_PARAGRAPH}`)
      releases[1]!.resolve(undefined)
      await settled
      await expect.poll(() => row.locator('[data-streaming]').count()).toBe(0)
      await expect.poll(() => row.innerText()).toContain(`译：${FINAL_PARAGRAPH}`)
      expect(await row.locator('[data-slot-error]').count()).toBe(0)
      expect(await row.locator('h1').count()).toBe(1)
      expect(await row.locator('table').count()).toBe(1)
      expect(await row.locator('[data-preserved-prefix]').count()).toBe(1)
      expect(pageErrors).toEqual([])
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    finally {
      for (const release of releases) release.resolve(undefined)
      disposeStreamGate?.()
      await settled?.catch((error: unknown) => { failures.push(error) })
      await browser?.close().catch((error: unknown) => { failures.push(error) })
      await scaffold?.close().catch((error: unknown) => { failures.push(error) })
      await rm(directory, { recursive: true, force: true }).catch((error: unknown) => { failures.push(error) })
    }
    if (failures.length > 0) throw new AggregateError(failures, 'translation browser regression failed')
  },
)
