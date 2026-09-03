import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repository = resolve(here, '..')
const helper = resolve(repository, 'fork-runtime', 'setup-profile.mjs')
const template = resolve(repository, 'fork-runtime', 'web', 'cordis.patch.yml')
const setup = resolve(repository, 'setup.command')
const shell = process.platform === 'win32' ? 'sh.exe' : 'sh'
const shellAvailable = spawnSync(shell, ['-c', 'exit 0']).status === 0

/** Run the setup helper and retain its diagnostics for assertions. */
function run(...args: string[]) {
  return spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8' })
}

/** Run the helper with stdin content. */
function runWithInput(args: string[], input: string) {
  return spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8', input })
}

it('preserves unrelated context patch rows and handles idempotence, dry-run, and ambiguity', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh setup with spaces '))
  try {
    const fresh = join(root, 'fresh-cordis.patch.yml')
    const created = run('merge-patch', fresh, template)
    expect(created.status, created.stderr).toBe(0)
    expect(created.stdout).toMatch(/^created /u)

    const patch = join(root, 'cordis.patch.yml')
    writeFileSync(patch, [
      '# user row before',
      '- id: keep-before',
      '  config:',
      '    expression: !!js ctx.value',
      '',
      '# old context row',
      '- id: dsh-context',
      '  disabled: true',
      '',
      '# user row after',
      '- insert:',
      '    - id: keep-after',
      '      name: ./plugin.cjs',
      '',
    ].join('\n'))

    const first = run('merge-patch', patch, template)
    expect(first.status, first.stderr).toBe(0)
    const once = readFileSync(patch, 'utf8')
    expect(once).toMatch(/expression: !!js ctx\.value/u)
    expect(once).toMatch(/- id: keep-after/u)
    expect(once).toMatch(/maxRequestSteps: 300/u)
    expect(once).toMatch(/maxArchiveNodes: 100/u)

    const second = run('merge-patch', patch, template)
    expect(second.status, second.stderr).toBe(0)
    expect(second.stdout).toMatch(/^unchanged /u)
    expect(readFileSync(patch, 'utf8')).toBe(once)

    writeFileSync(patch, once.replace('maxEvents: 100', 'maxEvents: 999'))
    const beforeDryRun = readFileSync(patch, 'utf8')
    const dryRun = run('merge-patch', patch, template, '--dry-run')
    expect(dryRun.status, dryRun.stderr).toBe(0)
    expect(dryRun.stdout).toMatch(/^would update /u)
    expect(readFileSync(patch, 'utf8')).toBe(beforeDryRun)

    writeFileSync(patch, '- id: dsh-context\n- id: dsh-context\n')
    const ambiguous = run('merge-patch', patch, template)
    expect(ambiguous.status).not.toBe(0)
    expect(ambiguous.stderr).toMatch(/multiple top-level dsh-context rows/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('rejects drift in artifacts, profile pins, patches, and composed config', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh setup verify with spaces '))
  try {
    const agentArtifact = join(root, 'nanmicoder-dsh-agent-teams-0.1.15-dsh012rc1.2.tgz')
    const contextArtifact = join(root, 'dsh-context-0.41.3-dsh012rc1.1.tgz')
    writeFileSync(agentArtifact, 'agent artifact')
    writeFileSync(contextArtifact, 'context artifact')
    const digest = createHash('sha256').update('agent artifact').digest('hex')
    expect(run('verify-sha256', agentArtifact, digest).status).toBe(0)
    expect(run('verify-sha256', agentArtifact, '0'.repeat(64)).status).not.toBe(0)
    expect(runWithInput(['verify-manifest', 'pkg', '1.0.0'], 'null').status).not.toBe(0)

    const profile = join(root, 'profile')
    const agentInstall = join(profile, 'node_modules', '@nanmicoder', 'dsh-agent-teams')
    const contextInstall = join(profile, 'node_modules', 'dsh-context')
    mkdirSync(agentInstall, { recursive: true })
    mkdirSync(contextInstall, { recursive: true })
    writeFileSync(join(agentInstall, 'package.json'), JSON.stringify({
      name: '@nanmicoder/dsh-agent-teams',
      version: '0.1.15-dsh012rc1.2',
    }))
    writeFileSync(join(contextInstall, 'package.json'), JSON.stringify({
      name: 'dsh-context',
      version: '0.41.3-dsh012rc1.1',
    }))
    const profileManifest = join(profile, 'package.json')
    writeFileSync(profileManifest, JSON.stringify({
      private: true,
      custom: { preserved: true },
      dependencies: {
        '@nanmicoder/dsh-agent-teams': `file:${relative(profile, agentArtifact)}`,
        'dsh-context': `file:${relative(profile, contextArtifact)}`,
      },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@nanmicoder/dsh-agent-teams', 'dsh-context'],
        },
      },
    }))
    const repositoryManifest = join(root, 'repository-package.json')
    writeFileSync(repositoryManifest, JSON.stringify({ packageManager: 'pnpm@11.7.0' }))
    const firstPin = run('pin-package-manager', profileManifest, repositoryManifest)
    expect(firstPin.status, firstPin.stderr).toBe(0)
    expect(firstPin.stdout).toMatch(/^pinned packageManager pnpm@11\.7\.0/u)
    const pinned = readFileSync(profileManifest, 'utf8')
    expect(JSON.parse(pinned)).toMatchObject({ custom: { preserved: true } })
    const secondPin = run('pin-package-manager', profileManifest, repositoryManifest)
    expect(secondPin.status, secondPin.stderr).toBe(0)
    expect(secondPin.stdout).toMatch(/^unchanged packageManager pnpm@11\.7\.0/u)
    expect(readFileSync(profileManifest, 'utf8')).toBe(pinned)
    writeFileSync(join(profile, 'pnpm-lock.yaml'), [
      'nanmicoder-dsh-agent-teams-0.1.15-dsh012rc1.2.tgz',
      '0.1.15-dsh012rc1.2',
      'dsh-context-0.41.3-dsh012rc1.1.tgz',
      '0.41.3-dsh012rc1.1',
    ].join('\n'))
    writeFileSync(join(profile, 'cordis.patch.yml'), readFileSync(template, 'utf8'))

    const verified = run('verify-profile', profile, agentArtifact, contextArtifact, 'pnpm@11.7.0')
    expect(verified.status, verified.stderr).toBe(0)
    expect(run('verify-profile', profile, agentArtifact, contextArtifact, 'pnpm@11.25.0').status).not.toBe(0)
    expect(run('verify-patch', join(profile, 'cordis.patch.yml'), template).status).toBe(0)

    const dump = runWithInput(['verify-dump', '-'], readFileSync(template, 'utf8'))
    expect(dump.status, dump.stderr).toBe(0)
    const badDump = runWithInput(
      ['verify-dump', '-'],
      readFileSync(template, 'utf8').replace('maxNodes: 400', 'maxNodes: 401'),
    )
    expect(badDump.status).not.toBe(0)

    const manifest = JSON.parse(readFileSync(profileManifest, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    manifest.dsh.profile.bundles.push('dsh-context')
    writeFileSync(profileManifest, JSON.stringify(manifest))
    expect(run('verify-profile', profile, agentArtifact, contextArtifact, 'pnpm@11.7.0').status).not.toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('rejects non-object manifests and non-exact pnpm selectors without writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh setup invalid manifests '))
  try {
    const profileManifest = join(root, 'profile-package.json')
    const repositoryManifest = join(root, 'repository-package.json')
    const validProfile = '{"private":true,"custom":{"preserved":true}}\n'
    writeFileSync(profileManifest, validProfile)

    for (const invalidRepository of [
      'null\n',
      '[]\n',
      '"package"\n',
      '{"packageManager":"pnpm@latest"}\n',
      '{"packageManager":"pnpm@^11"}\n',
    ]) {
      writeFileSync(repositoryManifest, invalidRepository)
      expect(run('pin-package-manager', profileManifest, repositoryManifest).status).not.toBe(0)
      expect(readFileSync(profileManifest, 'utf8')).toBe(validProfile)
    }

    writeFileSync(repositoryManifest, '{"packageManager":"pnpm@11.7.0"}\n')
    for (const invalidProfile of ['null\n', '[]\n', '"profile"\n']) {
      writeFileSync(profileManifest, invalidProfile)
      expect(run('pin-package-manager', profileManifest, repositoryManifest).status).not.toBe(0)
      expect(readFileSync(profileManifest, 'utf8')).toBe(invalidProfile)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.runIf(shellAvailable)('does not create Harness home or private runtime directories during dry-run', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh setup dry run '))
  try {
    const fakeBin = join(root, 'bin')
    const home = join(root, 'home must stay absent')
    const runtime = join(root, 'runtime must stay absent')
    mkdirSync(fakeBin)
    const uname = join(fakeBin, 'uname')
    writeFileSync(uname, '#!/bin/sh\nprintf "%s\\n" Darwin\n')
    chmodSync(uname, 0o755)
    const result = spawnSync(shell, [setup, '--dry-run'], {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_HOME: home,
        TMPDIR: runtime,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      },
      timeout: 15_000,
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toMatch(/Dry run complete; no files or directories were written\./u)
    expect(runExistsProbe(home)).toBe(false)
    expect(runExistsProbe(runtime)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Check fixture absence in a separate process, matching the setup's filesystem view. */
function runExistsProbe(path: string): boolean {
  return spawnSync(
    process.execPath,
    ['-e', 'process.exit(require("node:fs").existsSync(process.argv[1]) ? 0 : 1)', path],
  ).status === 0
}
