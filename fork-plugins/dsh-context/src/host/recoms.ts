import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_RECOM, RECOM_DATA_URL, recomsOfPayload, type Recom } from '../shared/recoms'
import { type ConnectionHostFace, registerPostRoute } from './connection'

export const RECOM_ROUTE = '/api/dsh-context/recom'

const FETCH_TIMEOUT_MS = 5_000

type RecomFetcher = (url: string, init: RequestInit) => Promise<Response>

const defaultFetcher: RecomFetcher = (url, init) => fetch(url, init)

let fetcher: RecomFetcher = defaultFetcher

export function setRecomFetcher(next: RecomFetcher | null): void {
  fetcher = next ?? defaultFetcher
}

let rotation = 0

export function resetRecomRotation(): void {
  rotation = 0
}

export async function readRecom(): Promise<Recom> {
  try {
    const response = await fetcher(RECOM_DATA_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (response.ok) {
      const recoms = recomsOfPayload(await response.json())
      if (recoms.length > 0) {
        const picked = recoms[rotation % recoms.length]
        rotation++
        return picked
      }
    }
  } catch {
  }
  return DEFAULT_RECOM
}

export function watchRecomChannel(ctx: Context): void {
  ctx.inject(['connection'], (c) => {
    const handler = async (): Promise<Response> => Response.json(
      { ok: true, value: await readRecom() },
      { headers: { 'cache-control': 'no-store' } },
    )
    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, RECOM_ROUTE, handler, 'dsh-context: recom route')
  })
}
