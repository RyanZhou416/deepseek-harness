/** Small asynchronous test helpers. */

/**
 * Poll until a predicate holds.
 * @param predicate - condition to check.
 * @param timeoutMs - deadline in milliseconds.
 * @param label - description used in the timeout failure.
 */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * Resolve after a delay.
 * @param ms - delay in milliseconds.
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Start one HTTP server on a random loopback port.
 * @param handler - request handler that owns the response.
 * @returns the port and a close function.
 */
export async function startHttpServer(
  handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, body: string) => void | Promise<void>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      Promise.resolve(handler(request, response, Buffer.concat(chunks).toString('utf8'))).catch(() => {
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no port')
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
