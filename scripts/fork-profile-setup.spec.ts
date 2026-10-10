import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repository = resolve(here, '..')
const helper = resolve(repository, 'fork-runtime', 'setup-profile.mjs')
const template = resolve(repository, 'fork-runtime', 'web', 'cordis.patch.yml')
const setup = resolve(repository, 'setup.command')
const releases = resolve(repository, 'fork-plugins', 'releases')
const shell = process.platform === 'win32' ? 'sh.exe' : 'sh'
const shellAvailable = spawnSync(shell, ['-c', 'exit 0']).status === 0

/** The three fork packages `setup.command` installs, with their sources and artifact pins. */
const BUNDLES = [
  {
    directory: 'dsh-agent-teams',
    name: '@nanmicoder/dsh-agent-teams',
    artifactName: 'nanmicoder-dsh-agent-teams',
    variable: 'DSH_AGENT_TEAMS_ARTIFACT',
  },
  {
    directory: 'dsh-context',
    name: 'dsh-context',
    artifactName: 'dsh-context',
    variable: 'DSH_CONTEXT_ARTIFACT',
  },
  {
    directory: 'dsh-plugin-subscriptions',
    name: 'dsh-plugin-subscriptions',
    artifactName: 'dsh-plugin-subscriptions',
    variable: 'DSH_SUBSCRIPTIONS_ARTIFACT',
  },
] as const

const setupScript = readFileSync(setup, 'utf8')

/** The artifact basename `setup.command` installs for one fork package. */
function pinnedArtifact(variable: string): string {
  const match = new RegExp(`^${variable}=\\$SCRIPT_DIR/(\\S+)$`, 'mu').exec(setupScript)
  if (match === null) throw new Error(`setup.command does not pin ${variable}`)
  return basename(match[1]!)
}

/** The version one release artifact basename encodes for `name`. */
function artifactVersion(artifact: string, name: string): string {
  const prefix = `${name}-`
  const suffix = '.tgz'
  if (!artifact.startsWith(prefix) || !artifact.endsWith(suffix)) {
    throw new Error(`release artifact ${artifact} does not name ${name}`)
  }
  return artifact.slice(prefix.length, -suffix.length)
}

/** One fork plugin's source manifest. */
function forkManifest(directory: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(repository, 'fork-plugins', directory, 'package.json'), 'utf8'),
  ) as Record<string, unknown>
}

/** The version one fork plugin's source manifest declares. */
function sourceVersion(directory: string): string {
  const version = forkManifest(directory).version
  if (typeof version !== 'string') throw new Error(`fork-plugins/${directory} declares no version`)
  return version
}

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
    expect(once).toMatch(/maxFileOps: 100/u)

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

it('updates only the managed Session catalog field while preserving user config, metadata, and CRLF bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh catalog patch '))
  try {
    const patch = join(root, 'cordis.patch.yml')
    const context = readFileSync(template, 'utf8').split('- id: session-controller')[0]!.trimEnd().replace(/\r?\n/gu, '\r\n')
    const controller = [
      "- id: 'session-controller' # operator row",
      "  name: '@deepseek-ai/dsh-api-session-controller'",
      '  disabled: false',
      '  config: # keep this comment',
      '    nativeOpen: !!js Boolean(ctx.native)',
      '    idleSessionRetentionMs: 7777',
      '    operatorExpression: !!js |',
      '      ({ enabled: true, value: ctx.value })',
      '  isolate: [sessions]',
      '# independent plugin',
      '- id: keep-after',
      '  config: !!js ctx.userConfig',
      '',
    ].join('\r\n')
    const original = context + '\r\n' + controller
    writeFileSync(patch, original)
    const result = run('merge-patch', patch, template)
    expect(result.status, result.stderr).toBe(0)
    const once = readFileSync(patch, 'utf8')
    const managedField = '    listProjectionExcludeKeys:\r\n      - contextHeaders\r\n      - turnOutline\r\n'
    expect(once.replace(managedField, '')).toBe(original)
    expect(once).not.toContain('\r\r\n')
    expect(run('merge-patch', patch, template).stdout).toMatch(/^unchanged /u)
    expect(readFileSync(patch, 'utf8')).toBe(once)
    expect(run('verify-patch', patch, template).status).toBe(0)

    writeFileSync(patch, once.replace(managedField, '    listProjectionExcludeKeys: [outdated]\r\n'))
    expect(run('merge-patch', patch, template).status).toBe(0)
    expect(readFileSync(patch, 'utf8')).toBe(once)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('adds catalog config to an existing controller without replacing its metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh catalog config '))
  try {
    const patch = join(root, 'cordis.patch.yml')
    writeFileSync(patch, '- id: session-controller\n  disabled: true\n  isolate: [sessions]\n')
    const result = run('merge-patch', patch, template)
    expect(result.status, result.stderr).toBe(0)
    const current = readFileSync(patch, 'utf8')
    expect(current).toContain('- id: session-controller\n  config:\n    listProjectionExcludeKeys:\n')
    expect(current).toContain('  disabled: true\n  isolate: [sessions]\n')
    expect(current.match(/^- id: session-controller$/gmu)).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.each([
  '- id: session-controller\n- id: session-controller\n',
  '- { id: session-controller, config: { nativeOpen: false } }\n',
  '- id: session-controller\n  config: { nativeOpen: false }\n',
  '- id: session-controller\n  config: *operatorSettings\n',
  '- id: session-controller\n  config: !!js ctx.operatorSettings\n',
  '- *operatorController\n',
  '- name: custom-controller\n  id: session-controller\n',
  '- id: session-controller\n  config:\n    nativeOpen: false\n  config:\n    nativeOpen: true\n',
  '- id: session-controller\n  config:\n    listProjectionExcludeKeys: []\n    listProjectionExcludeKeys: []\n',
  '- id: session-controller\n  config:\n    <<: *operatorSettings\n',
  '- id: session-controller\n  config:\n    !!js ctx.operatorSettings\n',
])('rejects ambiguous controller configuration without writing the patch (%s)', (source) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh ambiguous catalog '))
  try {
    const patch = join(root, 'cordis.patch.yml')
    writeFileSync(patch, source)
    const result = run('merge-patch', patch, template)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/session-controller/u)
    expect(readFileSync(patch, 'utf8')).toBe(source)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('checks the effective catalog exclusions in composed config rather than unrelated mentions', () => {
  const source = readFileSync(template, 'utf8')
  expect(runWithInput(['verify-dump', '-'], source).status).toBe(0)
  const absent = source.split('- id: session-controller')[0]!
  expect(runWithInput(['verify-dump', '-'], absent).status).not.toBe(0)
  const overridden = source.replace('      - turnOutline', '      - somethingElse')
    + '# turnOutline is mentioned only in a comment\n'
  expect(runWithInput(['verify-dump', '-'], overridden).status).not.toBe(0)
  const extra = source.replace('      - turnOutline', "      - 'turnOutline'\n      - operatorDetail")
  expect(runWithInput(['verify-dump', '-'], extra).status).toBe(0)
})

it('keeps each pinned release artifact present at the version its source manifest declares', () => {
  for (const bundle of BUNDLES) {
    const artifact = pinnedArtifact(bundle.variable)
    expect(existsSync(join(releases, artifact)), `${bundle.name} artifact`).toBe(true)
    expect(artifactVersion(artifact, bundle.artifactName), `${bundle.name} artifact version`)
      .toBe(sourceVersion(bundle.directory))
  }
})

it('resolves the shipped wire compatibility pin from the plugin directory', () => {
  const directory = 'dsh-plugin-subscriptions'
  const dependencies = forkManifest(directory).dependencies as Record<string, string> | undefined
  const spec = dependencies?.['@tormentalabs/claude-code-wire-compat']
  if (spec === undefined) throw new Error(`${directory} does not pin @tormentalabs/claude-code-wire-compat`)
  // pnpm reads a drive-letter `file:` spec as an absolute path on every
  // platform, so an absolute pin names a path the macOS install cannot open.
  expect(spec).toMatch(/^file:\.\.\/releases\/[\w.-]+\.tgz$/u)
  expect(existsSync(resolve(repository, 'fork-plugins', directory, spec.slice('file:'.length)))).toBe(true)
})

it('rejects drift in artifacts, profile pins, patches, and composed config', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh setup verify with spaces '))
  try {
    // The fixtures carry the versions the fork actually ships, so a helper
    // constant left behind by a version bump fails the verify-profile call
    // below instead of agreeing with a stale synthetic version.
    const agentArtifact = join(root, pinnedArtifact('DSH_AGENT_TEAMS_ARTIFACT'))
    const contextArtifact = join(root, pinnedArtifact('DSH_CONTEXT_ARTIFACT'))
    const subscriptionsArtifact = join(root, pinnedArtifact('DSH_SUBSCRIPTIONS_ARTIFACT'))
    const agentVersion = sourceVersion('dsh-agent-teams')
    const contextVersion = sourceVersion('dsh-context')
    const subscriptionsVersion = sourceVersion('dsh-plugin-subscriptions')
    writeFileSync(agentArtifact, 'agent artifact')
    writeFileSync(contextArtifact, 'context artifact')
    writeFileSync(subscriptionsArtifact, 'subscriptions artifact')
    const digest = createHash('sha256').update('agent artifact').digest('hex')
    expect(run('verify-sha256', agentArtifact, digest).status).toBe(0)
    expect(run('verify-sha256', agentArtifact, '0'.repeat(64)).status).not.toBe(0)
    expect(runWithInput(['verify-manifest', 'pkg', '1.0.0'], 'null').status).not.toBe(0)

    const profile = join(root, 'profile')
    const agentInstall = join(profile, 'node_modules', '@nanmicoder', 'dsh-agent-teams')
    const contextInstall = join(profile, 'node_modules', 'dsh-context')
    const subscriptionsInstall = join(profile, 'node_modules', 'dsh-plugin-subscriptions')
    mkdirSync(agentInstall, { recursive: true })
    mkdirSync(contextInstall, { recursive: true })
    mkdirSync(subscriptionsInstall, { recursive: true })
    writeFileSync(join(agentInstall, 'package.json'), JSON.stringify({
      name: '@nanmicoder/dsh-agent-teams',
      version: agentVersion,
    }))
    writeFileSync(join(contextInstall, 'package.json'), JSON.stringify({
      name: 'dsh-context',
      version: contextVersion,
    }))
    writeFileSync(join(subscriptionsInstall, 'package.json'), JSON.stringify({
      name: 'dsh-plugin-subscriptions',
      version: subscriptionsVersion,
    }))
    const profileManifest = join(profile, 'package.json')
    writeFileSync(profileManifest, JSON.stringify({
      private: true,
      custom: { preserved: true },
      dependencies: {
        '@nanmicoder/dsh-agent-teams': `file:${relative(profile, agentArtifact)}`,
        'dsh-context': `file:${relative(profile, contextArtifact)}`,
        'dsh-plugin-subscriptions': `file:${relative(profile, subscriptionsArtifact)}`,
      },
      dsh: {
        profile: {
          bundles: [
            '@deepseek-ai/dsh-base',
            '@nanmicoder/dsh-agent-teams',
            'dsh-context',
            'dsh-plugin-subscriptions',
          ],
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
      pinnedArtifact('DSH_AGENT_TEAMS_ARTIFACT'),
      agentVersion,
      pinnedArtifact('DSH_CONTEXT_ARTIFACT'),
      contextVersion,
      pinnedArtifact('DSH_SUBSCRIPTIONS_ARTIFACT'),
      subscriptionsVersion,
    ].join('\n'))
    writeFileSync(join(profile, 'cordis.patch.yml'), readFileSync(template, 'utf8'))

    const verified = run(
      'verify-profile',
      profile,
      agentArtifact,
      contextArtifact,
      subscriptionsArtifact,
      'pnpm@11.7.0',
    )
    expect(verified.status, verified.stderr).toBe(0)
    expect(run(
      'verify-profile',
      profile,
      agentArtifact,
      contextArtifact,
      subscriptionsArtifact,
      'pnpm@11.25.0',
    ).status).not.toBe(0)
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
    expect(run(
      'verify-profile',
      profile,
      agentArtifact,
      contextArtifact,
      subscriptionsArtifact,
      'pnpm@11.7.0',
    ).status).not.toBe(0)

    manifest.dsh.profile.bundles = [
      '@deepseek-ai/dsh-base',
      '@nanmicoder/dsh-agent-teams',
      'dsh-context',
      'dsh-plugin-subscriptions',
      'dshmarket',
    ]
    writeFileSync(profileManifest, JSON.stringify(manifest))
    expect(run(
      'verify-profile',
      profile,
      agentArtifact,
      contextArtifact,
      subscriptionsArtifact,
      'pnpm@11.7.0',
    ).status).not.toBe(0)

    expect(run('has-package', profileManifest, 'dshmarket').status).toBe(1)
    const withLegacyDependency = JSON.parse(readFileSync(profileManifest, 'utf8')) as {
      dependencies: Record<string, string>
    }
    withLegacyDependency.dependencies.dshmarket = '1.47.0'
    writeFileSync(profileManifest, JSON.stringify(withLegacyDependency))
    expect(run('has-package', profileManifest, 'dshmarket').status).toBe(0)
    expect(run(
      'verify-profile',
      profile,
      agentArtifact,
      contextArtifact,
      subscriptionsArtifact,
      'pnpm@11.7.0',
    ).status).not.toBe(0)
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
