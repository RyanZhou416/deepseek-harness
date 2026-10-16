/**
 * `scripts/fork-subscriptions-maintenance.ps1` is the hash-bound hook `build.cmd`
 * runs around a local subscription install. These cases drive the real hook with
 * a toy plan whose steps are fixture files, so ordering, refusals and receipt
 * handling are observed without a runtime build, a provider, or the user's plan.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const maintenanceScript = join(repositoryRoot, 'scripts', 'fork-subscriptions-maintenance.ps1')
const pwshPath = resolvePwshPath()
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function privateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-subscriptions-maintenance-'))
  temporaryRoots.push(root)
  return root
}

/** A loopback listener; the hook reads the TCP table and never connects to it. */
async function openListener(): Promise<{ server: Server; port: number }> {
  const server = createServer()
  await new Promise<void>((settle, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => { settle() })
  })
  return { server, port: (server.address() as AddressInfo).port }
}

/** Resolves once the listener has released its port, not when close() is called. */
function closeListener(server: Server): Promise<void> {
  return new Promise<void>((settle, fail) => {
    server.close((error) => {
      if (error === undefined) settle()
      else fail(error)
    })
  })
}

/**
 * Only what the hook and its steps need: the Windows variables PowerShell and
 * Node resolve from, plus every user or credential location redirected into the
 * private root. No ambient `*_TOKEN`, `*_KEY`, proxy or DSH_* value crosses over.
 */
function hookEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATH', 'PATHEXT', 'ProgramFiles', 'PSModulePath']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  const home = join(root, 'home')
  for (const [name, value] of Object.entries({
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    DSH_HOME: join(home, '.dsh'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    TEMP: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
  })) {
    mkdirSync(value, { recursive: true })
    env[name] = value
  }
  return env
}

type HookRun = { status: number | null; stdout: string; stderr: string }

/** Runs one stage and proves no signal or child bound ended it before its status. */
function runHook(stage: 'BeforeBuild' | 'AfterBuild', planPath: string, root: string, resumeBuilt = false): HookRun {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', maintenanceScript, '-Stage', stage, '-PlanFile', planPath]
  if (resumeBuilt) args.push('-ResumeBuilt')
  const run = spawnSync(pwshPath, args, { encoding: 'utf8', env: hookEnvironment(root), timeout: 20_000 })
  expect(run.error, run.stderr).toBeUndefined()
  expect(run.signal, run.stderr).toBeNull()
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

/**
 * A released ephemeral port can be claimed by a foreign process before the hook
 * checks it. That is a setup collision, not a product refusal.
 */
function expectPortFreeForHook(run: HookRun, port: number): void {
  if (run.stderr.includes('still listens on port')) {
    throw new Error(`Setup collision: another process listens on released port ${port}.`)
  }
}

function readPhase(runRoot: string, stage: 'BeforeBuild' | 'AfterBuild'): { state: string; reason?: string } {
  return JSON.parse(readFileSync(join(runRoot, `build-maintenance-${stage}.phase.json`), 'utf8')) as { state: string; reason?: string }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function recordedCalls(root: string): { script: string; entry: string; args: string[] }[] {
  const path = join(root, 'calls.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { script: string; entry: string; args: string[] })
}

// The toy steps record the child argv the hook produced and write only inside the
// private root, so a real apply, finalizer or runtime build cannot masquerade as one.
const applySource = [
  "import { appendFileSync, writeFileSync } from 'node:fs'",
  "import { join } from 'node:path'",
  'const [mode] = process.argv.slice(2)',
  "appendFileSync(join(import.meta.dirname, 'calls.jsonl'), JSON.stringify({ script: 'apply', entry: process.argv[1], args: process.argv.slice(2) }) + '\\n')",
  "writeFileSync(join(import.meta.dirname, 'apply-' + mode.replace(/^--/, '') + '.marker'), '')",
  '',
].join('\n')

const finalizeSource = [
  "import { appendFileSync, writeFileSync } from 'node:fs'",
  "import { join } from 'node:path'",
  "appendFileSync(join(import.meta.dirname, 'calls.jsonl'), JSON.stringify({ script: 'finalize', entry: process.argv[1], args: process.argv.slice(2) }) + '\\n')",
  "writeFileSync(join(import.meta.dirname, 'finalize.marker'), '')",
  '',
].join('\n')

/** Writes a plan whose hashed inputs and steps are all fixture files. */
function toyFixture(port: number) {
  const root = privateRoot()
  const runRoot = join(root, 'run')
  mkdirSync(runRoot)
  const applyScript = join(root, 'apply.mjs')
  const finalizeScript = join(root, 'finalize.mjs')
  const manifest = join(root, 'source-inputs.txt')
  const candidatePath = join(root, 'candidate.bin')
  const receiptPath = join(runRoot, 'complete-receipt.json')
  const planPath = join(root, 'plan.json')
  writeFileSync(applyScript, applySource)
  writeFileSync(finalizeScript, finalizeSource)
  writeFileSync(manifest, 'toy source inputs\n')
  writeFileSync(candidatePath, 'toy candidate\n')
  writeFileSync(planPath, JSON.stringify({
    repo: root,
    node: process.execPath,
    runRoot,
    port,
    applyScript,
    applyScriptSha256: sha256(applyScript),
    finalizeScript,
    finalizeScriptSha256: sha256(finalizeScript),
    sourceInputsManifestPath: manifest,
    sourceInputsManifestSha256: sha256(manifest),
    candidatePath,
    candidateSha256: sha256(candidatePath),
    completeReceipt: receiptPath,
    version: '0.0.0-test',
    afterBuildSteps: [{ exe: process.execPath, args: [finalizeScript], cwd: root, timeoutSeconds: 60 }],
  }, null, 2))
  return { root, runRoot, planPath, receiptPath, candidatePath }
}

// Windows owns the PowerShell and the TCP table the hook reads, so the suite runs
// there only; nothing probes for them with a spawned command. Every case starts
// PowerShell and the resume flow starts several Node children, so the suite is
// bound by process creation: the value matches the --testTimeout the Windows
// coverage lane passes, and a describe value overrides that flag.
describe.skipIf(process.platform !== 'win32')('fork-subscriptions-maintenance.ps1', { timeout: 90_000 }, () => {
  it('refuses a plan before hashing it while DSH still listens on the plan port', async () => {
    const root = privateRoot()
    const runRoot = join(root, 'run')
    const planPath = join(root, 'plan.json')
    const { server, port } = await openListener()
    try {
      // Only the four fields the port guard reads exist, so reaching the hash
      // loop would report a missing script field instead of the listener.
      writeFileSync(planPath, JSON.stringify({ repo: root, node: process.execPath, runRoot, port }, null, 2))
      const run = runHook('BeforeBuild', planPath, root)

      expect(run.status, run.stderr).toBe(1)
      expect(run.stderr).toContain(`DSH still listens on port ${port}`)
      expect(run.stderr).not.toContain('Missing maintenance field')
      expect(readPhase(runRoot, 'BeforeBuild').state).toBe('failed')
      expect(recordedCalls(root)).toEqual([])
    } finally {
      await closeListener(server)
    }
  })

  it('applies the toy plan, resumes the prepared finalizer, and stops at the receipt', async () => {
    const { server, port } = await openListener()
    await closeListener(server)
    const fixture = toyFixture(port)

    const before = runHook('BeforeBuild', fixture.planPath, fixture.root)
    expectPortFreeForHook(before, port)
    expect(before.status, before.stderr).toBe(0)
    expect(before.stdout).toContain('Subscriptions source integration applied with verified backups.')
    expect(readPhase(fixture.runRoot, 'BeforeBuild').state).toBe('applied')

    const resume = runHook('AfterBuild', fixture.planPath, fixture.root, true)
    expectPortFreeForHook(resume, port)
    expect(resume.status, resume.stderr).toBe(0)
    expect(readPhase(fixture.runRoot, 'AfterBuild').state).toBe('completed')
    const receipt = JSON.parse(readFileSync(fixture.receiptPath, 'utf8')) as Record<string, string>
    expect(receipt).toMatchObject({
      version: '0.0.0-test',
      candidateSha256: sha256(fixture.candidatePath),
      status: 'installed-and-verified',
    })

    // The only children are the toy steps inside the private root: the finalizer
    // stands in for the runtime build, which this hook never runs itself.
    const apply = (mode: string) => `apply ${mode} ${fixture.planPath}`
    const calls = recordedCalls(fixture.root)
    expect(calls.map(call => `${call.script} ${call.args.join(' ')}`)).toEqual([
      apply('--preflight'),
      apply('--apply'),
      apply('--preflight'),
      'finalize --resume-built',
      apply('--verify'),
    ])
    expect(calls.every(call => call.entry.toLowerCase().startsWith(fixture.root.toLowerCase()))).toBe(true)
    expect(['apply-preflight.marker', 'apply-apply.marker', 'apply-verify.marker', 'finalize.marker']
      .every(name => existsSync(join(fixture.root, name)))).toBe(true)

    const repeat = runHook('AfterBuild', fixture.planPath, fixture.root, true)
    expect(repeat.status, repeat.stderr).toBe(0)
    expect(repeat.stdout).toContain('Subscriptions maintenance already completed: 0.0.0-test')
    expect(recordedCalls(fixture.root)).toEqual(calls)
  })

  it('refuses a candidate that changed after its recorded hash', async () => {
    const { server, port } = await openListener()
    await closeListener(server)
    const fixture = toyFixture(port)
    writeFileSync(fixture.candidatePath, 'toy candidate changed after hashing\n')

    const run = runHook('BeforeBuild', fixture.planPath, fixture.root)
    expectPortFreeForHook(run, port)
    expect(run.status, run.stderr).toBe(1)
    expect(run.stderr).toContain('Maintenance input changed: candidatePath')
    expect(run.stderr).not.toContain('Maintenance input changed: applyScript')
    const phase = readPhase(fixture.runRoot, 'BeforeBuild')
    expect(phase.state).toBe('failed')
    expect(phase.reason).toContain('Maintenance input changed: candidatePath')
    expect(recordedCalls(fixture.root)).toEqual([])
    expect(existsSync(join(fixture.root, 'apply-preflight.marker'))).toBe(false)
    expect(existsSync(fixture.receiptPath)).toBe(false)
  })
})
