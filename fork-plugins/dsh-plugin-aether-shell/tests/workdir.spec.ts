/**
 * The directory an interpreter process runs in.
 *
 * The Host's `working-directory` service owns a Session's committed directory,
 * and the file policy's workspace boundary reads that same value. A Host move
 * therefore has to move the interpreter with the boundary; resolving the
 * immutable Session header alone would run a `workspace-write` call outside the
 * directory it was granted. The header stays the fallback for a composition that
 * does not mount the service, which the shared tool and session suites cover.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { sessionDirectory } from '../src/workdir.ts'
import { createHarness, installedInterpreter, sessionAgent, valueOf } from './helpers/harness.ts'
import type { Harness } from './helpers/harness.ts'
import { createSessionHarness } from './helpers/sessions-harness.ts'
import type { SessionHarness } from './helpers/sessions-harness.ts'

/** The installed interpreter, or undefined on a host without one. */
const interpreter = installedInterpreter()

let harness: (Harness | SessionHarness) | undefined
/** Directories this suite created and must remove after the processes that work in them are gone. */
const ownedDirectories: string[] = []

afterEach(async () => {
  const owned = harness
  harness = undefined
  await owned?.dispose()
  for (const directory of ownedDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

/** The Session face of a fixture agent, for the resolver's pure cases. */
function sessionOf(agent: object): Agent['session'] {
  return (agent as { session: Agent['session'] }).session
}

describe('session workspace resolution', () => {
  it('prefers the committed working directory over the Session header', () => {
    const session = sessionOf(sessionAgent('/origin'))
    expect(sessionDirectory({ get: () => '/moved' }, session)).toBe('/moved')
  })

  it('falls back to the Session header without the service', () => {
    expect(sessionDirectory(undefined, sessionOf(sessionAgent('/origin')))).toBe('/origin')
  })

  it('reports no directory for a call without a Session', () => {
    expect(sessionDirectory(undefined, undefined)).toBeUndefined()
    expect(sessionDirectory({ get: () => '/moved' }, undefined)).toBeUndefined()
  })
})

describe('interpreter working directory', () => {
  it('runs the interpreter in the committed directory and resolves a relative cwd against it', async () => {
    const origin = await mkdtemp(join(tmpdir(), 'dsh-aether-origin-'))
    const moved = await mkdtemp(join(tmpdir(), 'dsh-aether-moved-'))
    ownedDirectories.push(origin, moved)
    await mkdir(join(moved, 'sub'))
    const mounted = await createHarness({ workspaceRoot: origin, workingDirectory: moved })
    harness = mounted
    const pwd = valueOf(await mounted.call('aether_call', { builtin: 'pwd' }))
    expect(pwd['value']).toBe(moved)
    const nested = valueOf(await mounted.call('aether_call', { builtin: 'pwd', cwd: 'sub' }))
    expect(nested['value']).toBe(join(moved, 'sub'))
  })
})

describe.skipIf(interpreter === undefined)('session working directory', () => {
  it('opens a session in the committed directory, under the policy that grants it', async () => {
    const moved = await mkdtemp(join(tmpdir(), 'dsh-aether-moved-'))
    ownedDirectories.push(moved)
    const mounted = await createSessionHarness({ workingDirectory: moved })
    harness = mounted
    const owner = await mounted.agent('sess-workdir-owner')
    const opened = valueOf(await mounted.call('aether_session', { action: 'open', name: 'work' }, { agent: owner }))
    expect(opened['cwd']).toBe(moved)
    expect(opened['policy']).toEqual({ mode: 'danger-full-access', workspace_root: moved })
  })
})
