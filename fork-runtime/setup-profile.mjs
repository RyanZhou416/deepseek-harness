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
  version: '0.1.20-dsh017rc1.2',
}
const CONTEXT = {
  name: 'dsh-context',
  version: '0.55.0-dsh017rc1.3',
  bounds: {
    maxRequestSteps: 300,
    maxKeptTurns: 60,
    maxEvents: 100,
    maxNodes: 400,
    maxArchiveNodes: 100,
    maxFileOps: 100,
  },
}
const SUBSCRIPTIONS = {
  name: 'dsh-plugin-subscriptions',
  version: '0.9.4-dsh017rc1.3',
}
const RETIRED_PACKAGES = ['dshmarket']

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

/** Locate canonical top-level rows without evaluating custom YAML tags. */
function rowRanges(text, rowId, keepComments = false) {
  const lines = linesOf(text)
  const starts = []
  const id = new RegExp(`^- id:\\s*(?:${rowId}|'${rowId}'|"${rowId}")\\s*(?:#.*)?$`, 'u')
  for (let index = 0; index < lines.length; index += 1) {
    if (id.test(lines[index].content)) starts.push(index)
  }
  return starts.map((startIndex) => {
    let end = text.length
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const line = lines[index].content
      if (keepComments && /^#/u.test(line)) continue
      if (line !== '' && !/^[ \t]/u.test(line)) {
        end = lines[index].start
        break
      }
    }
    return { start: lines[startIndex].start, end }
  })
}

/** Locate the context row managed as one complete config item. */
function contextRanges(text) {
  return rowRanges(text, 'dsh-context')
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
  const block = managed.replace(/\r?\n/gu, newline)
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

/** Locate one unambiguous Session Controller row; aliases and flow rows require manual editing. */
function controllerRange(text) {
  const ranges = rowRanges(text, 'session-controller', true)
  if (ranges.length > 1) fail('the profile patch contains multiple top-level session-controller rows')
  const mentions = linesOf(text).filter(line => !/^\s*#/u.test(line.content)
    && /(?:^|[ {])(?:id|'id'|"id"):\s*(?:session-controller|'session-controller'|"session-controller")(?=\s|[,}\]]|$)/u.test(line.content))
  const alias = linesOf(text).some(line => /^-\s+[*&]/u.test(line.content)
    || /^-\s+(?:id|'id'|"id"):\s*[*&!{\[]/u.test(line.content))
  if (alias || mentions.length !== ranges.length) {
    fail('session-controller patch ownership is ambiguous; use a canonical top-level block row without id aliases')
  }
  return ranges[0]
}

/** Locate a direct mapping field and its indented value without absorbing following comments. */
function mappingField(text, range, key, indent) {
  const lines = linesOf(text).filter(line => line.start >= range.start && line.start < range.end)
  const pattern = new RegExp(`^${' '.repeat(indent)}(?:${key}|'${key}'|"${key}")\\s*:`, 'u')
  const matches = lines.filter(line => pattern.test(line.content))
  if (matches.length > 1) fail(`session-controller contains multiple ${key} fields`)
  const first = matches[0]
  if (first === undefined) return undefined
  let end = first.end
  for (const line of lines) {
    if (line.start <= first.start) continue
    if (line.content.trim() === '' || /^\s*#/u.test(line.content)) continue
    const depth = line.content.length - line.content.trimStart().length
    if (depth <= indent) break
    end = line.end
  }
  return { start: first.start, end, headerEnd: first.end, suffix: first.content.slice(first.content.indexOf(':') + 1).trim() }
}

/** Require an explicit config mapping so other user fields cannot be lost through replacement. */
function controllerConfig(text, range) {
  const config = mappingField(text, range, 'config', 2)
  if (config !== undefined && config.suffix !== '' && !config.suffix.startsWith('#')) {
    fail('session-controller config must be a block mapping; flow maps, aliases, and whole-config !!js need manual editing')
  }
  if (config !== undefined && linesOf(text).some(line => line.start > config.start && line.start < config.end
    && /^ {4}<<\s*:/u.test(line.content))) {
    fail('session-controller config merge aliases need manual editing')
  }
  if (config !== undefined && linesOf(text).some((line) => {
    if (line.start <= config.start || line.start >= config.end || /^\s*(?:#|$)/u.test(line.content)) return false
    const depth = line.content.length - line.content.trimStart().length
    const value = line.content.trimStart()
    return depth === 4 && (value.startsWith('- ') || ['[', ']', '{', '}', '*', '&', '!'].includes(value[0])
      || !/:\s|:$/u.test(value))
  })) {
    fail('session-controller config must contain block mapping fields, not tagged scalars or aliases')
  }
  return config
}

/** Extract the only Session Controller field owned by the fork template. */
function managedController(template) {
  const range = controllerRange(template)
  if (range === undefined) fail('the managed template must contain one top-level session-controller row')
  const config = controllerConfig(template, range)
  if (config === undefined) fail('the managed session-controller template needs a config mapping')
  const field = mappingField(template, config, 'listProjectionExcludeKeys', 4)
  if (field === undefined) fail('the managed session-controller template needs listProjectionExcludeKeys')
  return { row: template.slice(range.start, range.end).trimEnd(), field: template.slice(field.start, field.end).trimEnd() }
}

/** Change only the owned exclusion field, preserving other controller config and metadata bytes. */
function mergeControllerPatch(current, managed) {
  const range = controllerRange(current)
  const newline = current.includes('\r\n') ? '\r\n' : '\n'
  const field = managed.field.replace(/\r?\n/gu, newline) + newline
  if (range === undefined) {
    const prefix = current === '' || /(?:\r\n|\n)$/u.test(current) ? current : current + newline
    return prefix + managed.row.replace(/\r?\n/gu, newline) + newline
  }
  const config = controllerConfig(current, range)
  if (config === undefined) {
    const header = linesOf(current).find(line => line.start === range.start)
    const prefix = current.slice(0, header.end)
    return prefix + (/(?:\r\n|\n)$/u.test(prefix) ? '' : newline)
      + `  config:${newline}` + field + current.slice(header.end)
  }
  const existing = mappingField(current, config, 'listProjectionExcludeKeys', 4)
  if (existing !== undefined) {
    return current.slice(0, existing.start) + field + current.slice(existing.end)
  }
  const prefix = current.slice(0, config.headerEnd)
  return prefix + (/(?:\r\n|\n)$/u.test(prefix) ? '' : newline) + field + current.slice(config.headerEnd)
}

/** Apply both managed policies before any file write. */
function mergeManagedPatch(current, template) {
  const controller = managedController(template)
  const merged = mergePatch(current, managedBlock(template))
  return mergeControllerPatch(merged, controller)
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
  const next = mergeManagedPatch(current, readFileSync(templatePath, 'utf8'))
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

function hasPackageCommand(args) {
  if (args.length !== 2) fail('usage: setup-profile.mjs has-package <profile-package.json> <package>')
  const [profilePath, name] = args
  const manifest = readJsonObject(profilePath)
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies']
  const installed = sections.some(section => Object.hasOwn(manifest[section] ?? {}, name))
  process.exit(installed ? 0 : 1)
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
  if (args.length !== 5) {
    fail('usage: setup-profile.mjs verify-profile <profile-dir> <agent-teams-tgz> <context-tgz> <subscriptions-tgz> <package-manager>')
  }
  const [profileDir, agentArtifact, contextArtifact, subscriptionsArtifact, packageManager] = args
  const manifest = readJson(resolve(profileDir, 'package.json'))
  if (manifest.packageManager !== packageManager) {
    fail(`profile packageManager is ${String(manifest.packageManager)}, expected ${packageManager}`)
  }
  const expected = [
    { ...AGENT_TEAMS, artifact: agentArtifact },
    { ...CONTEXT, artifact: contextArtifact },
    { ...SUBSCRIPTIONS, artifact: subscriptionsArtifact },
  ]
  for (const name of RETIRED_PACKAGES) {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (Object.hasOwn(manifest[section] ?? {}, name)) fail(`${name} remains in profile ${section}`)
    }
    if ((manifest.dsh?.profile?.bundles ?? []).includes(name)) {
      fail(`${name} remains in dsh.profile.bundles`)
    }
  }
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
  const next = mergeManagedPatch(current, readFileSync(templatePath, 'utf8'))
  if (next !== current) fail('profile patch does not contain the managed context and Session catalog policies')
  process.stdout.write('verified profile context and Session catalog patch\n')
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
  const controller = controllerRange(source)
  if (controller === undefined) fail('dump-config has no top-level session-controller row')
  const config = controllerConfig(source, controller)
  const exclusions = config === undefined ? undefined : mappingField(source, config, 'listProjectionExcludeKeys', 4)
  if (exclusions === undefined) fail('dump-config has no Session catalog projection exclusions')
  const value = source.slice(exclusions.start, exclusions.end)
  for (const key of ['contextHeaders', 'turnOutline']) {
    const pattern = new RegExp(`^ {6}-\\s*(?:${key}|'${key}'|"${key}")\\s*(?:#.*)?$`, 'mu')
    if (!pattern.test(value)) fail(`dump-config does not exclude ${key} from Session catalog hints`)
  }
  process.stdout.write('verified dump-config context bounds and Session catalog exclusions\n')
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
  case 'has-package':
    hasPackageCommand(args)
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
    fail('expected resolve-home, resolve-path, verify-sha256, merge-patch, pin-package-manager, has-package, verify-manifest, verify-profile, verify-patch, or verify-dump')
}
