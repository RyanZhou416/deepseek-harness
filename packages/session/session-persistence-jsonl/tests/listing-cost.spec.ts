/**
 * Startup listing cost over a large synthetic corpus: a header listing must not
 * traverse the whole store for a historical revision, while `list()` must keep
 * that revision bound to the related artifacts.
 */

import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SESSION_CATALOG_FILE } from '../src/catalog.ts'
import {
  encodeSegment, generationLogPath, projectDir, sessionDir, toHeaderLine,
} from '../src/format.ts'

const tally = vi.hoisted(() => ({
  enabled: false,
  readdir: [] as string[],
  stat: [] as string[],
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      if (tally.enabled) tally.readdir.push(String(args[0]))
      return actual.readdir(...args)
    }) as typeof actual.readdir,
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      if (tally.enabled) tally.stat.push(String(args[0]))
      return actual.stat(...args)
    }) as typeof actual.stat,
  }
})

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  tally.enabled = false
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** One generation file written for the corpus, with the catalog row that describes it. */
interface WrittenArtifact {
  readonly id: SessionId
  readonly path: string
  readonly header: object
  readonly formatStatus: 'current' | 'migration-required'
}

/** A historical V3 header of the shape released artifacts carry. */
function historicalHeader(id: SessionId, createdAt: number, child = false): Record<string, unknown> {
  return {
    type: 'session',
    version: 3,
    id,
    createdAt,
    isSeeded: false,
    delegationDepth: child ? 1 : 0,
    ...(child ? { origin: 'subagent', parentSession: 'archived-legacy-parent' } : {}),
  }
}

/** Write one header-only generation under the no-cwd project directory. */
async function writeArtifact(
  root: string,
  id: SessionId,
  version: number,
  header: object,
): Promise<WrittenArtifact> {
  const path = generationLogPath(root, undefined, id, version, 'none')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(header)}\n`)
  return { id, path, header, formatStatus: version < SESSION_FORMAT_VERSION ? 'migration-required' : 'current' }
}

/**
 * Persist the catalog a previous process would have left, so subagent
 * directories are skipped from their headers alone — the measured corpus has a
 * complete `.session-catalog.json`.
 */
async function writeCatalog(root: string, artifacts: readonly WrittenArtifact[]): Promise<void> {
  const sessions: Record<string, unknown> = {}
  for (const artifact of artifacts) {
    const identity = await stat(artifact.path, { bigint: true })
    sessions[encodeSegment(artifact.id)] = {
      header: artifact.header,
      formatStatus: artifact.formatStatus,
      sizeBytes: Number(identity.size),
      mtimeMs: Number(identity.mtimeMs),
    }
  }
  await writeFile(join(root, SESSION_CATALOG_FILE), `${JSON.stringify({ version: 1, sessions })}\n`)
}

/** One synthetic store: an archived historical parent, a current session, and many subagents. */
interface Corpus {
  readonly root: string
  readonly project: string
  readonly archived: SessionId
  readonly current: SessionId
  readonly unreferenced: SessionId
  readonly subagents: readonly string[]
  readonly subagentDirs: readonly string[]
  readonly subagentPaths: readonly string[]
  readonly parentPath: string
  readonly currentPath: string
  readonly unreferencedPath: string
}

const SUBAGENT_COUNT = 60

async function corpus(): Promise<Corpus> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-listing-cost-'))
  roots.push(root)
  const archived = SessionId('archived-legacy-parent')
  const current = SessionId('active-current')
  const unreferenced = SessionId('unreferenced-archived')
  const written: WrittenArtifact[] = []
  const historicalParent = await writeArtifact(root, archived, 3, historicalHeader(archived, 1))
  written.push(historicalParent)
  const currentSession = await writeArtifact(root, current, SESSION_FORMAT_VERSION,
    toHeaderLine({ version: SESSION_FORMAT_VERSION, id: current, createdAt: 2, isSeeded: false }))
  written.push(currentSession)
  const unreferencedArtifact = await writeArtifact(root, unreferenced, SESSION_FORMAT_VERSION,
    toHeaderLine({ version: SESSION_FORMAT_VERSION, id: unreferenced, createdAt: 3, isSeeded: false }))
  written.push(unreferencedArtifact)
  const subagents = Array.from({ length: SUBAGENT_COUNT }, (_, index) => `subagent-${String(index)}`)
  const subagentPaths: string[] = []
  for (const [index, id] of subagents.entries()) {
    const artifact = await writeArtifact(root, SessionId(id), 3, historicalHeader(SessionId(id), 100 + index, true))
    written.push(artifact)
    subagentPaths.push(artifact.path)
  }
  await writeCatalog(root, written)
  return {
    root,
    project: projectDir(root, undefined),
    archived,
    current,
    unreferenced,
    subagents,
    subagentDirs: subagents.map(id => sessionDir(root, undefined, SessionId(id))),
    subagentPaths,
    parentPath: historicalParent.path,
    currentPath: currentSession.path,
    unreferencedPath: unreferencedArtifact.path,
  }
}

async function mount(root: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx
}

function startTally(): void {
  tally.readdir = []
  tally.stat = []
  tally.enabled = true
}

describe('startup listing cost', () => {
  it('skips archived and subagent directories and never derives a historical revision for headers', async () => {
    const fixture = await corpus()
    const ctx = await mount(fixture.root)

    startTally()
    const headers = await ctx.sessionPersistence.listHeaders({
      excludeSessionIds: new Set([fixture.unreferenced]),
      excludeSubagentSessions: true,
    })
    tally.enabled = false

    expect(headers.map(row => row.header.id).sort()).toEqual([fixture.archived, fixture.current].sort())
    // No revision: a caller comparing change tokens must use `list`.
    expect(headers.every(row => Object.hasOwn(row, 'revision'))).toBe(false)
    expect(headers.find(row => row.header.id === fixture.archived)?.formatStatus).toBe('migration-required')

    // Only the root, the one project, and the two included Session directories
    // are read; every skipped directory stays untouched.
    expect(new Set(tally.readdir)).toEqual(new Set([
      fixture.root,
      fixture.project,
      sessionDir(fixture.root, undefined, fixture.archived),
      sessionDir(fixture.root, undefined, fixture.current),
    ]))
    expect(new Set(tally.stat)).toEqual(new Set([
      fixture.project,
      fixture.parentPath,
      fixture.currentPath,
    ]))
    for (const dir of fixture.subagentDirs) expect(tally.readdir).not.toContain(dir)
    for (const path of fixture.subagentPaths) expect(tally.stat).not.toContain(path)
    expect(tally.stat).not.toContain(fixture.unreferencedPath)
  })

  it('keeps list() scanning the corpus whenever a historical artifact is selected', async () => {
    const fixture = await corpus()
    const ctx = await mount(fixture.root)

    startTally()
    const snapshots = await ctx.sessionPersistence.list({
      excludeSessionIds: new Set([fixture.unreferenced]),
      excludeSubagentSessions: true,
    })
    tally.enabled = false

    expect(snapshots.map(row => row.header.id).sort()).toEqual([fixture.archived, fixture.current].sort())
    // The corpus fingerprint is the point of `list`: it reads and stats every
    // selected generation, including the subagent rows this listing hides.
    for (const dir of fixture.subagentDirs) expect(tally.readdir).toContain(dir)
    for (const path of fixture.subagentPaths) expect(tally.stat).toContain(path)
    expect(tally.stat).toContain(fixture.unreferencedPath)
  })

  it('keeps a historical revision bound to subagent changes on the list() path', async () => {
    const fixture = await corpus()
    const ctx = await mount(fixture.root)
    const options = {
      excludeSessionIds: new Set([fixture.unreferenced]),
      excludeSubagentSessions: true,
    }
    const revision = async (): Promise<string> => {
      const row = (await ctx.sessionPersistence.list(options)).find(item => item.header.id === fixture.archived)
      if (row === undefined) throw new Error('historical parent missing from the listing')
      return row.revision
    }

    const before = await revision()
    expect(await revision()).toBe(before)

    // A hidden child grew: the parent's completed catalog can change, so the
    // revision that guards cached logical events must change with it.
    await writeFile(fixture.subagentPaths[0] as string,
      `${JSON.stringify(historicalHeader(SessionId(fixture.subagents[0] as string), 500, true))}\n`)
    expect(await revision()).not.toBe(before)
  })

  it('keeps created-but-unmaterialized Sessions under the listing exclusions', async () => {
    const fixture = await corpus()
    const ctx = await mount(fixture.root)
    const header = (id: string, extra: Partial<SessionHeader> = {}): SessionHeader => ({
      version: SESSION_FORMAT_VERSION,
      id: SessionId(id),
      createdAt: 7,
      isSeeded: false,
      cwd: '/work',
      ...extra,
    })
    const pending = await ctx.sessionPersistence.create(header('pending-headers'))
    const hidden = await ctx.sessionPersistence.create(header('pending-hidden'))
    const child = await ctx.sessionPersistence.create(header('pending-child', {
      origin: 'subagent',
      parentSession: fixture.archived,
      delegationDepth: 1,
    }))
    const options = {
      excludeSessionIds: new Set([fixture.unreferenced, SessionId('pending-hidden')]),
      excludeSubagentSessions: true,
    }

    // Neither listing kind returns a hidden or subagent row, and both observe
    // the pending Session this process created but has not materialized.
    expect((await ctx.sessionPersistence.listHeaders(options)).map(row => row.header.id).sort())
      .toEqual([fixture.archived, fixture.current, SessionId('pending-headers')].sort())
    expect((await ctx.sessionPersistence.list(options)).map(row => row.header.id).sort())
      .toEqual([fixture.archived, fixture.current, SessionId('pending-headers')].sort())

    await pending.close()
    await hidden.close()
    await child.close()
  })
})
