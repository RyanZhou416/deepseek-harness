/** The YAML-loaded web tool fetches loopback without replacing DNS or the HTTP provider. */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as systemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as tools from '@deepseek-ai/dsh-tools'
import * as web from '@deepseek-ai/dsh-web'
import * as fetchHttp from '@deepseek-ai/dsh-web-fetch-http'
import * as toolWeb from '@deepseek-ai/dsh-tool-web'

let context: Context | undefined
let server: Server | undefined

afterEach(async () => {
  try {
    await context?.fiber.dispose()
  } finally {
    context = undefined
    const owned = server
    server = undefined
    if (owned !== undefined) {
      await new Promise<void>((resolve) => {
        owned.close(() => { resolve() })
        owned.closeAllConnections()
      })
    }
  }
})

describe('web_fetch real Loader composition', () => {
  it('renders a loopback page through the loaded tool and keeps URL restrictions', async () => {
    const requests: string[] = []
    const http = server = createServer((request, response) => {
      requests.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<h1>Local page</h1><p>System network transport.</p>')
    })
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve() })
    })
    const url = `http://127.0.0.1:${String((http.address() as AddressInfo).port)}/page`
    const ctx = context = new Context()
    ctx.baseUrl = new URL('./fixtures/', import.meta.url).href
    await ctx.plugin(Loader)
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', systemPrompt],
      ['@deepseek-ai/dsh-tools', tools],
      ['@deepseek-ai/dsh-web', web],
      ['@deepseek-ai/dsh-web-fetch-http', fetchHttp],
      ['@deepseek-ai/dsh-tool-web', toolWeb],
    ])
    // Keep YAML imports in Vitest's source module graph so service identities match.
    ctx.loader.builtins.include = class extends Include {
      override async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      }
    }
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: new URL('./fixtures/cordis.fetch.yml', import.meta.url).href },
    })
    await ctx.loader.await()

    const call = (id: string, url: string) => ctx.tools.execute({
      name: 'web_fetch', callId: ToolCallId(id), arguments: { url }, signal: new AbortController().signal,
    })
    const result = await call('fetch-loopback', url)
    expect(result.isError).toBe(false)
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain(`Fetched ${url}`)
    expect(text).toContain('# Local page')
    expect(text).toContain('System network transport.')
    expect(requests).toEqual(['/page'])

    const credentialUrl = new URL(url)
    credentialUrl.username = 'blocked'
    expect((await call('fetch-credentials', credentialUrl.href)).error?.info?.code).toBe('WEB_BLOCKED_URL')
    expect((await call('fetch-scheme', 'ftp://example.test/page')).error?.info?.code).toBe('WEB_INVALID_URL')
    expect(requests).toEqual(['/page'])
  })
})
