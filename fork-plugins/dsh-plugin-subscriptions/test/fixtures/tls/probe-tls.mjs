/**
 * Fetches one URL from the pinned runtime and reports the outcome as one JSON line.
 *
 * The URL is the loopback TLS fixture's; nothing here resolves or contacts anything else.
 */
const url = process.argv[2]

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  const body = await response.text()
  console.log(JSON.stringify({ ok: true, status: response.status, body }))
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    name: error?.name ?? null,
    code: error?.code ?? null,
    message: String(error?.message ?? error),
  }))
}
