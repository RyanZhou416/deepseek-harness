/** Optional dual-runtime capture for synthetic browser diagnostics; no production inspector listener is opened. */
import { mkdir, writeFile } from 'node:fs/promises'
import { Session } from 'node:inspector/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Page, CDPSession } from 'playwright'

/**
 * Capture browser timeline/CPU and the source Host's CPU over the same synthetic interaction.
 * Timings gathered with this enabled are diagnostic, not ordinary benchmark samples.
 * @param page - isolated benchmark page.
 * @param cdp - that page's CDP connection.
 * @param label - test-owned workload label used for local artifact names.
 * @returns an idempotent async stop operation that saves all captures under tmp/runtime-profiles.
 */
export async function captureRuntimeProfile(page: Page, cdp: CDPSession, label: string): Promise<{ stop(): Promise<void> }> {
  const directory = fileURLToPath(new URL('../../../tmp/runtime-profiles/', import.meta.url))
  await mkdir(directory, { recursive: true })
  const host = new Session()
  host.connect()
  const scriptMaps = new Map<string, string>()
  cdp.on('Debugger.scriptParsed', ({ url, sourceMapURL }) => {
    if (url !== '' && sourceMapURL !== undefined) scriptMaps.set(url, sourceMapURL)
  })
  await cdp.send('Debugger.enable')
  const traceEvents: object[] = []
  const onData = ({ value }: { value: object[] }): void => { traceEvents.push(...value) }
  cdp.on('Tracing.dataCollected', onData)
  const completed = new Promise<void>((resolve) => { cdp.once('Tracing.tracingComplete', () => { resolve() }) })
  try {
    await host.post('Profiler.enable')
    await host.post('Profiler.setSamplingInterval', { interval: 1000 })
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack' })
    await host.post('Profiler.start')
    await cdp.send('Profiler.start')
    await page.evaluate(() => performance.mark('dsh-profile:start'))
  } catch (error) {
    host.disconnect()
    cdp.off('Tracing.dataCollected', onData)
    throw error
  }
  let stopping: Promise<void> | undefined
  const stop = async (): Promise<void> => {
    try {
      await page.evaluate(() => performance.mark('dsh-profile:end'))
      const browser = await cdp.send('Profiler.stop')
      const backend = await host.post('Profiler.stop')
      await cdp.send('Tracing.end')
      await completed
      await Promise.all([
        writeFile(join(directory, `${label}.browser.cpuprofile`), JSON.stringify(browser.profile)),
        writeFile(join(directory, `${label}.host.cpuprofile`), JSON.stringify(backend.profile)),
        writeFile(join(directory, `${label}.trace.json`), JSON.stringify({ traceEvents })),
      ])
      const maps: object[] = []
      for (const [url, sourceMapURL] of scriptMaps) {
        if (!url.startsWith(page.url().split('/').slice(0, 3).join('/'))) continue
        const resolved = new URL(sourceMapURL, url).href
        const response = await page.request.get(resolved)
        if (!response.ok()) continue
        if (!(response.headers()['content-type'] ?? '').includes('json')) continue
        const path = `${label}.source-map-${String(maps.length)}.json`
        await writeFile(join(directory, path), await response.body())
        maps.push({ url, path })
      }
      await writeFile(join(directory, `${label}.maps.json`), JSON.stringify(maps))
      process.stdout.write(`RUNTIME_PROFILE ${JSON.stringify({ label, directory, maps: maps.length, events: traceEvents.length })}\n`)
    } finally {
      host.disconnect()
      cdp.off('Tracing.dataCollected', onData)
      await cdp.send('Debugger.disable')
    }
  }
  return { stop: () => stopping ??= stop() }
}
