/** Record protected requests through a loopback-only proxy in a shipped profile. */
import dns from 'node:dns'
import { createServer } from 'node:http'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installProxyFromEnvironment } from '../../src/index.ts'

export const name = 'claude-egress-probe'
export const inject = ['tools']

export function apply(ctx) {
  ctx.effect(async () => {
    let refuse = false
    const requests = []
    const lookups = []
    const server = createServer((request, response) => {
      requests.push(request.url)
      if (refuse) request.socket.destroy()
      else response.end('PROXIED')
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const originalLookup = dns.lookup
    let disposePolicy
    let disposeTool
    try {
      // A broken guard may fail the fixture, but can never resolve an external destination.
      dns.lookup = (...args) => {
        lookups.push(String(args[0]))
        args.at(-1)(Object.assign(new Error('External DNS forbidden by fixture'), { code: 'ENOTFOUND' }))
      }
      const values = { DSH_CLAUDE_PROXY_URL: `http://127.0.0.1:${server.address().port}`, NO_PROXY: '*' }
      disposePolicy = await installProxyFromEnvironment({ get: key => values[key] === undefined ? undefined : { value: values[key] } }, () => {})
      disposeTool = ctx.tools.register(defineTool({
        name: 'claude_egress_probe',
        description: 'Verify mandatory proxy routing and refusal without any external request.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute() {
          const url = 'http://api.anthropic.com/claude-egress-probe'
          const allowed = await (await fetch(url)).text()
          refuse = true
          let blocked = false
          try { await fetch(url) } catch (_proxyRefusal) { blocked = true }
          if (allowed !== 'PROXIED' || !blocked || requests.length < 2 || lookups.length !== 0) throw new Error('Protected routing did not hold')
          return JSON.stringify({ routedThroughProxy: true, proxyFailureBlocked: true, directDestinationLookups: 0 })
        },
        presentCall: args => ({ card: 'generic', title: 'Verify protected Claude routing', kind: 'other', rawInput: args }),
      }))
    } catch (error) {
      await disposePolicy?.()
      dns.lookup = originalLookup
      await new Promise(resolve => server.close(resolve))
      throw error
    }
    return async () => {
      disposeTool()
      await disposePolicy()
      dns.lookup = originalLookup
      await new Promise(resolve => server.close(resolve))
    }
  })
}
