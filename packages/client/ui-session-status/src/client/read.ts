/** Host reading records installed under the Session status table: the access-gated stream and acknowledgements. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteSnapshotStream, type RemoteStreamCarrierFailure } from '@deepseek-ai/dsh-api-gateway/client'
// Type-only: declares the `remoteAccess` Client service.
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
// Type-only: declares the `sessions` Controller service.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionReadFrame } from '../types.ts'
import { installReadingAcknowledgements } from './acknowledge.ts'
import type { UiSessionStatus } from './status.ts'

type SessionReadBaseline = Extract<SessionReadFrame, { type: 'baseline' }>
type SessionReadChange = Extract<SessionReadFrame, { type: 'changed' }>

const CARRIER_LOST: RemoteStreamCarrierFailure['code'] = 'gateway/carrier-lost'
/** First wait before a terminally failed reading stream is opened again; doubles per failure up to the maximum. */
const RESTART_FIRST_MS = 1_000
const RESTART_MAX_MS = 30_000

/**
 * Follow Host reading records into the status table's reading model and acknowledge reading in the visible main view.
 * The stream runs only while the current Peer may follow it, so a LiveShare viewer opens no stream and keeps
 * `readingReady` false; carrier reconnection replaces the complete reading baseline. A terminal failure, such as
 * reconnecting while a reloading Host service is not yet serving, leaves reading unavailable and opens a new stream
 * after 1 s, doubling the wait up to 30 s until a baseline arrives.
 * @param ctx - Client root context with `remote`, `remoteAccess`, and `sessions`.
 * @param status - status table whose reading model receives the records.
 */
export function installReading(ctx: Context, status: UiSessionStatus): void {
  const reading = status.reading
  installReadingAcknowledgements(ctx, ctx.sessions, reading)
  // Each access grant runs one stream. Disposal stops failure reports and carrier retries at once, but a frame
  // already handed to the consumer can still arrive, so a revoked or superseded stream's frames are discarded.
  let active: object | undefined
  const granted = (): boolean => active !== undefined
  ctx.remoteAccess.whenAccess('sessionStatus/follow', function* () {
    const token = {}
    active = token
    const current = (): boolean => active === token
    let control: RemoteSnapshotStream<SessionReadBaseline, SessionReadChange> | undefined
    let restart: ReturnType<typeof setTimeout> | undefined
    let restartDelay = RESTART_FIRST_MS
    const connect = (): void => {
      restart = undefined
      const stream = ctx.remote.$stream<SessionReadFrame>({
        name: 'Session reading state',
        open: signal => ctx.remote.sessionStatus.follow(signal),
        carrierFailed: () => { reading.disconnected() },
        ended: (): RemoteStreamCarrierFailure => Object.assign(
          new Error('Session reading state stream ended'), { code: CARRIER_LOST },
        ),
      })
      const next = new RemoteSnapshotStream<SessionReadBaseline, SessionReadChange>(stream, {
        name: 'Session reading state',
        isSnapshot: (frame): frame is SessionReadBaseline => frame.type === 'baseline',
        replace: (frame) => {
          if (!current()) return
          restartDelay = RESTART_FIRST_MS
          reading.replace(frame.items)
        },
        update: (frame) => { if (current()) reading.accept(frame.state) },
        failed: (error) => {
          // A disposed stream reports no failure, so this stream is the current grant's.
          reading.disconnected()
          console.error(`[session-status] Reminders could not be synchronized; reconnecting in ${String(restartDelay / 1000)} s:`, error)
          restart = setTimeout(connect, restartDelay)
          restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS)
        },
      })
      const previous = control
      control = next
      // The failed stream's consumer has already stopped; disposing it releases its Remote stream.
      void previous?.dispose()
      next.start()
    }
    connect()
    yield async () => {
      active = undefined
      clearTimeout(restart)
      reading.disconnected()
      await control?.dispose()
      // A later grant owns readiness once it starts; otherwise reading stays unavailable.
      if (!granted()) reading.disconnected()
    }
  })
}
