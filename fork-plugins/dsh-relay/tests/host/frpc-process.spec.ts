import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FrpcSupervisor, scrubChildEnvironment } from '../../src/frpc-process.ts'
import type { FrpcSupervisorEvent } from '../../src/frpc-process.ts'
import { delay, waitFor } from './helpers/test-server.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-frpc.mjs', import.meta.url))
const supervisors: FrpcSupervisor[] = []

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.dispose()
})

function createSupervisor(mode: string, overrides: { startupTimeoutMs?: number } = {}): {
  supervisor: FrpcSupervisor
  events: FrpcSupervisorEvent[]
  lines: string[]
} {
  const events: FrpcSupervisorEvent[] = []
  const lines: string[] = []
  const supervisor = new FrpcSupervisor({
    launch: { command: process.execPath, args: [FIXTURE, mode], cwd: process.cwd() },
    startupTimeoutMs: overrides.startupTimeoutMs ?? 500,
    initialDelayMs: 10,
    maxDelayMs: 40,
    onEvent: event => { events.push(event) },
    onLine: line => { lines.push(line) },
  })
  supervisors.push(supervisor)
  return { supervisor, events, lines }
}

describe('frpc supervisor', () => {
  it('reports connected when both markers arrive and stops on request', async () => {
    const { supervisor, events, lines } = createSupervisor('success')
    supervisor.start()
    await waitFor(() => events.some(event => event.type === 'connected'), 3_000, 'connected')
    expect(supervisor.starts).toBe(1)
    expect(lines.join('\n')).toContain('login to server success')
    await supervisor.stop()
    await delay(60)
    expect(supervisor.starts).toBe(1)
    expect(events.some(event => event.type === 'retrying')).toBe(false)
  })

  it('reports a failed login and restarts with a growing delay', async () => {
    const { supervisor, events } = createSupervisor('fail')
    supervisor.start()
    await waitFor(() => events.some(event => event.type === 'startup-failed'), 3_000, 'startup failure')
    await waitFor(() => events.filter(event => event.type === 'retrying').length >= 2, 3_000, 'two restarts')
    const delays = events.flatMap(event => event.type === 'retrying' ? [event.delayMs] : [])
    expect(delays[0]).toBe(10)
    expect(delays[1]).toBe(20)
    expect(supervisor.starts).toBeGreaterThanOrEqual(2)
  })

  it('reports a crash after a successful start and retries', async () => {
    const { supervisor, events } = createSupervisor('crash')
    supervisor.start()
    await waitFor(() => events.some(event => event.type === 'connected'), 3_000, 'connected')
    await waitFor(() => events.some(event => event.type === 'exited'), 3_000, 'exit')
    await waitFor(() => events.some(event => event.type === 'retrying'), 3_000, 'retry')
    const exited = events.find(event => event.type === 'exited')
    expect(exited).toMatchObject({ detail: 'frpc exited with code 3' })
  })

  it('reports a startup timeout for a silent process', async () => {
    const { supervisor, events } = createSupervisor('silent', { startupTimeoutMs: 50 })
    supervisor.start()
    await waitFor(() => events.some(event => event.type === 'startup-failed'), 3_000, 'startup timeout')
    const failure = events.find(event => event.type === 'startup-failed')
    expect(failure).toMatchObject({ detail: 'frpc did not report login and proxy startup in time' })
  })

  it('scrubs credential-shaped variables from the child environment', () => {
    const env = scrubChildEnvironment({
      PATH: '/bin',
      HOME: '/home/me',
      DEEPSEEK_API_KEY: 'secret',
      DSH_TOKEN: 'secret',
      SOME_PASSWORD: 'secret',
      SAFE_VALUE: 'ok',
    })
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/me', SAFE_VALUE: 'ok' })
  })
})
