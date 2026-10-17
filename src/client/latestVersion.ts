/** Lazy 1h TTL check for the update hints: npm first, npmmirror as fallback, one at a time; all
 *  sources failing resolves null. */

import { useEffect, useState } from 'react'
import { PLUGIN_NAME, PLUGIN_VERSION } from './meta'

const REGISTRY_HOSTS = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
]

const TTL_MS = 60 * 60 * 1000

let cached: { at: number; promise: Promise<string | null> } | null = null

function readVersion(host: string): Promise<string | null> {
  return fetch(host + '/' + PLUGIN_NAME + '/latest')
    .then(res => (res.ok ? res.json() as Promise<{ version?: unknown }> : null))
    .then(body => (body !== null && typeof body.version === 'string' ? body.version : null))
    .catch(() => null)
}

export function fetchLatestVersion(): Promise<string | null> {
  if (!cached || Date.now() - cached.at >= TTL_MS) {
    cached = {
      at: Date.now(),
      promise: (async () => {
        for (const host of REGISTRY_HOSTS) {
          const v = await readVersion(host)
          if (v !== null) return v
        }
        return null
      })(),
    }
  }
  return cached.promise
}

/** Numeric semver compare; the pre-release suffix is dropped (1.2.0-rc.1 == 1.2.0). */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split('-', 1)[0].split('.').map(n => parseInt(n, 10) || 0)
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x !== y) return x > y
  }
  return false
}

/** The newer registry version for this build, or null — the read behind every surface's update hint. A dev
 *  build never asks; the 1h TTL cache answers every later mount from the first fetch. */
export function useNewerVersion(): string | null {
  const [latest, setLatest] = useState<string | null>(null)
  useEffect(() => {
    if (PLUGIN_VERSION.includes('-dev')) return
    let on = true
    // fetchLatestVersion never rejects (every failure narrows to null); the `on` flag drops late results.
    void fetchLatestVersion().then((v) => { if (on && v) setLatest(v) })
    return () => { on = false }
  }, [])
  return latest !== null && isNewerVersion(latest, PLUGIN_VERSION) ? latest : null
}
