#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import process from 'node:process'

const AGENT_TEAMS = {
  name: '@nanmicoder/dsh-agent-teams',
  version: '0.1.15-dsh012rc1.2',
}
const CONTEXT = {
  name: 'dsh-context',
  version: '0.41.3-dsh012rc1.1',
  bounds: {
    maxRequestSteps: 300,
    maxKeptTurns: 60,
    maxEvents: 100,
    maxNodes: 400,
    maxArchiveNodes: 100,
  },
}

/** Exit with one concise setup diagnostic. */
function fail(message) {
  process.stderr.write(`dsh fork setup: ${message}\n`)
  process.exit(1)
}

/** Return physical lines with offsets while preserving the source newline bytes. */
function linesOf(text) {
  const lines = []
  const pattern = /[^\r\n]*(?:\r\n|\n|$)/g
  for (const match of text.matchAll(pattern)) {
    if (match[0] === '') break
    const content = match[0].replace(/(?:\r\n|\n)$/u, '')
    lines.push({ start: match.index, end: match.index + match[0].length, content })
  }
  return lines
}

/** Locate top-level `dsh-context` sequence items without parsing unrelated custom YAML tags. */
function contextRanges(text) {
  const lines = linesOf(text)
  const starts = []
  const id = /^- id:\s*(?:dsh-context|['"]dsh-context['"])\s*(?:#.*)?$/u
  for (let index = 0; index < lines.length; index += 1) {
    if (id.test(lines[index].content)) starts.push(index)
  }
  return starts.map((startIndex) => {
    let end = text.length
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const line = lines[index].content
      if (line !== '' && !/^[ \t]/u.test(line)) {
        end = lines[index].start
        break
      }
    }
    return { start: lines[startIndex].start, end }
  })
}

/** Extract the one managed context row from the repository template. */
function managedBlock(template) {
  const ranges = contextRanges(template)
  if (ranges.length !== 1) fail('the managed template must contain exactly one top-level dsh-context row')
  const block = template.slice(ranges[0].start, ranges[0].end).trimEnd()
  if (block === '') fail('the managed template row is empty')
  return block
}

/** Merge the managed row while preserving every unrelated byte in the user patch. */
function mergePatch(current, managed) {
  const ranges = contextRanges(current)
  if (ranges.length > 1) fail('the profile patch contains multiple top-level dsh-context rows; resolve the ambiguity manually')
  const newline = current.includes('\r\n') ? '\r\n' : '\n'
  const block = managed.replace(/\n/gu, newline)
  if (ranges.length === 1) {
    const range = ranges[0]
    const suffix = current.slice(range.end)
    const replacement = block + (suffix === '' ? newline : newline)
    return current.slice(0, range.start) + replacement + suffix.replace(/^(?:\r\n|\n)/u, '')
  }

  const lines = linesOf(current)
  const emptyRows = lines.filter(line => /^\s*\[\]\s*(?:#.*)?$/u.test(line.content))
  if (emptyRows.length > 1) fail('the profile patch contains multiple empty-list documents')
  if (emptyRows.length === 1) {
    const row = emptyRows[0]
    return current.slice(0, row.start) + block + newline + current.slice(row.end)
  }

  const substantive = lines.filter(line => line.content.trim() !== '' && !/^\s*#/u.test(line.content))
  if (substantive.length > 0 && !substantive.some(line => /^- /u.test(line.content))) {
    fail('the profile patch is not a top-level YAML sequence')
  }
  const prefix = current === '' || /(?:\r\n|\n)$/u.test(current) ? current : current + newline
  return prefix + block + newline
}

/** Atomically replace one profile patch in its existing directory. */
function writeAtomic(path, text) {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary = `${path}.setup-${String(process.pid)}.tmp`
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', mode, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/** Read and validate one JSON file with a path-specific error. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`cannot read valid JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Read one package manifest whose top level must be a JSON object. */
function readJsonObject(path) {
  const value = readJson(path)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must contain a top-level JSON object`)
  }
  return value
}

/** Resolve the Harness home exactly as the launcher does. */
function resolveHomeCommand(args) {
  if (args.length !== 0) fail('usage: setup-profile.mjs resolve-home')
  const configured = process.env.DSH_HOME
  let selected = configured !== undefined && configured.trim() !== ''
    ? configured
    : resolve(homedir(), '.dsh')
  if (selected === '~') selected = homedir()
  else if (selected.startsWith('~/') || selected.startsWith('~\\')) {
    selected = resolve(homedir(), selected.slice(2))
  }
  process.stdout.write(resolve(selected) + '\n')
}

/** Verify one vendored artifact before pnpm can consume it. */
function verifySha256Command(args) {
  if (args.length !== 2) fail('usage: setup-profile.mjs verify-sha256 <file> <sha256>')
  const [path, expected] = args
  if (!/^[0-9a-f]{64}$/iu.test(expected)) fail('expected SHA256 must contain 64 hexadecimal digits')
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (actual !== expected.toLowerCase()) fail(`SHA256 mismatch for ${path}: got ${actual}`)
  process.stdout.write(`verified SHA256 ${basename(path)}\n`)
}

/** Extract exactly one top-level context item from a rendered config dump. */
function dumpedContextBlock(text) {
  const ranges = contextRanges(text)
  if (ranges.length !== 1) fail(`dump-config produced ${String(ranges.length)} top-level dsh-context rows, expected one`)
  return text.slice(ranges[0].start, ranges[0].end)
}

function mergeCommand(args) {
  const dryRun = args.includes('--dry-run')
  const positional = args.filter(argument => argument !== '--dry-run')
  if (positional.length !== 2) fail('usage: setup-profile.mjs merge-patch <target> <template> [--dry-run]')
  const [target, templatePath] = positional
  const existed = existsSync(target)
  const current = existed ? readFileSync(target, 'utf8') : '[]\n'
  const next = mergePatch(current, managedBlock(readFileSync(templatePath, 'utf8')))
  if (next === current) {
    process.stdout.write(`unchanged ${target}\n`)
    return
  }
  if (dryRun) {
    process.stdout.write(`${existed ? 'would update' : 'would create'} ${target}\n`)
    return
  }
  writeAtomic(target, next)
  process.stdout.write(`${existed ? 'updated' : 'created'} ${target}\n`)
}

function pinPackageManagerCommand(args) {
  if (args.length !== 2) {
    fail('usage: setup-profile.mjs pin-package-manager <profile-package.json> <repository-package.json>')
  }
  const [profilePath, repositoryPath] = args
  const expected = readJsonObject(repositoryPath).packageManager
  if (typeof expected !== 'string' || !/^pnpm@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(expected)) {
    fail(`repository packageManager is not an exact pnpm pin in ${repositoryPath}`)
  }
  const profile = readJsonObject(profilePath)
  if (profile.packageManager === expected) {
    process.stdout.write(`unchanged packageManager ${expected}\n`)
    return
  }
  writeAtomic(profilePath, JSON.stringify({ ...profile, packageManager: expected }, undefined, 2) + '\n')
  process.stdout.write(`pinned packageManager ${expected}\n`)
}

async function verifyManifestCommand(args) {
  if (args.length !== 2) fail('usage: setup-profile.mjs verify-manifest <name> <version>')
  let source = ''
  for await (const chunk of process.stdin) source += chunk
  let manifest
  try {
    manifest = JSON.parse(source)
  } catch {
    fail('tarball package/package.json is not valid JSON')
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('tarball package/package.json must contain a top-level JSON object')
  }
  if (manifest.name !== args[0] || manifest.version !== args[1]) {
    fail(`tarball identity is ${String(manifest.name)}@${String(manifest.version)}, expected ${args[0]}@${args[1]}`)
  }
  process.stdout.write(`verified ${args[0]}@${args[1]}\n`)
}

function verifyProfileCommand(args) {
  if (args.length !== 4) {
    fail('usage: setup-profile.mjs verify-profile <profile-dir> <agent-teams-tgz> <context-tgz> <package-manager>')
  }
  const [profileDir, agentArtifact, contextArtifact, packageManager] = args
  const manifest = readJson(resolve(profileDir, 'package.json'))
  if (manifest.packageManager !== packageManager) {
    fail(`profile packageManager is ${String(manifest.packageManager)}, expected ${packageManager}`)
  }
  const expected = [
    { ...AGENT_TEAMS, artifact: agentArtifact },
    { ...CONTEXT, artifact: contextArtifact },
  ]
  for (const item of expected) {
    const specifier = manifest.dependencies?.[item.name]
    if (typeof specifier !== 'string' || !specifier.startsWith('file:')) {
      fail(`${item.name} is not pinned to a local artifact in the profile manifest`)
    }
    const specifiedArtifact = resolve(profileDir, specifier.slice('file:'.length))
    let installedArtifact
    try {
      installedArtifact = realpathSync(specifiedArtifact)
    } catch {
      fail(`${item.name} artifact path does not exist: ${specifiedArtifact}`)
    }
    if (installedArtifact !== realpathSync(item.artifact)) {
      fail(`${item.name} is not pinned to ${basename(item.artifact)} in the profile manifest`)
    }
    const count = (manifest.dsh?.profile?.bundles ?? []).filter(value => value === item.name).length
    if (count !== 1) fail(`${item.name} must occur exactly once in dsh.profile.bundles`)
    const installed = readJson(resolve(profileDir, 'node_modules', ...item.name.split('/'), 'package.json'))
    if (installed.name !== item.name || installed.version !== item.version) {
      fail(`installed ${item.name} version is ${String(installed.version)}, expected ${item.version}`)
    }
  }
  const lock = readFileSync(resolve(profileDir, 'pnpm-lock.yaml'), 'utf8')
  for (const item of expected) {
    if (!lock.includes(basename(item.artifact)) || !lock.includes(item.version)) {
      fail(`profile lockfile does not pin ${item.name}@${item.version}`)
    }
  }
  process.stdout.write('verified profile package pins, installed versions, bundle membership, and lockfile\n')
}

function verifyPatchCommand(args) {
  if (args.length !== 2) fail('usage: setup-profile.mjs verify-patch <target> <template>')
  const [target, templatePath] = args
  if (!existsSync(target)) fail(`profile patch is missing at ${target}`)
  const current = readFileSync(target, 'utf8')
  const next = mergePatch(current, managedBlock(readFileSync(templatePath, 'utf8')))
  if (next !== current) fail('profile patch does not contain the managed dsh-context row')
  process.stdout.write('verified profile dsh-context patch\n')
}

async function verifyDumpCommand(args) {
  if (args.length !== 1) fail('usage: setup-profile.mjs verify-dump <dump-file>')
  let source
  if (args[0] === '-') {
    source = ''
    for await (const chunk of process.stdin) source += chunk
  } else {
    source = readFileSync(args[0], 'utf8')
  }
  const block = dumpedContextBlock(source)
  if (!/^\s*disabled:\s*false\s*$/mu.test(block)) fail('dump-config does not enable dsh-context')
  for (const [field, value] of Object.entries(CONTEXT.bounds)) {
    const pattern = new RegExp(`^\\s*${field}:\\s*${String(value)}\\s*$`, 'mu')
    if (!pattern.test(block)) fail(`dump-config does not contain ${field}: ${String(value)}`)
  }
  process.stdout.write('verified dump-config dsh-context low-overhead bounds\n')
}

const [command, ...args] = process.argv.slice(2)
switch (command) {
  case 'resolve-home':
    resolveHomeCommand(args)
    break
  case 'resolve-path':
    if (args.length !== 1) fail('usage: setup-profile.mjs resolve-path <path>')
    process.stdout.write(resolve(args[0]) + '\n')
    break
  case 'verify-sha256':
    verifySha256Command(args)
    break
  case 'merge-patch':
    mergeCommand(args)
    break
  case 'pin-package-manager':
    pinPackageManagerCommand(args)
    break
  case 'verify-manifest':
    await verifyManifestCommand(args)
    break
  case 'verify-profile':
    verifyProfileCommand(args)
    break
  case 'verify-patch':
    verifyPatchCommand(args)
    break
  case 'verify-dump':
    await verifyDumpCommand(args)
    break
  default:
    fail('expected resolve-home, resolve-path, verify-sha256, merge-patch, pin-package-manager, verify-manifest, verify-profile, verify-patch, or verify-dump')
}
