/**
 * One-time migration for a web profile written before the dedicated
 * `@deepseek-ai/dsh-llm-cc-pool` bundle owned the `cc-pool` route.
 *
 * This is the only script that knows the legacy `llm-pi-ai`
 * `providers.cc-pool` declaration. It backs the profile and the Harness home's
 * `settings.yaml` up first, removes that declaration structurally (block,
 * quoted, and flow-map forms), ensures the dedicated plugin is linked and
 * listed as a bundle, seeds the portable profile support files, and records a
 * migration marker. A `settings.yaml` section that still declares the route is
 * rewritten without it, because a Host imports the removed settings document
 * into the profile on its next start. It never starts a Host and it does not
 * build the repository.
 *
 * The ordinary root build is a precondition: a profile that lacks the dedicated
 * link is repaired from `packages/llm/llm-cc-pool/lib`, which only the root
 * build produces. On a clean checkout the order is:
 *
 *   pnpm install
 *   pnpm run build
 *   pnpm exec tsx scripts/migrate-legacy-cc-pool-profile.ts [--dsh-home <path>] [--host <address>] [--port <port>] [--allow-running-host]
 *   build.cmd
 *
 * The Harness home is `--dsh-home`, else `DSH_HOME`, else the platform
 * launcher default: `<checkout parent>/deepseek-harness-data` on Windows,
 * `~/.dsh` on macOS and Linux. A leading `~` in either setting is expanded.
 * `settings.yaml` is migrated even when no web profile exists yet, because a
 * Host imports that home document into the profile it starts; that rewrite is
 * backed up like the profile rewrite, and no profile marker is written when
 * there is no profile to complete.
 *
 * The running-Host guard probes `--host`/`--port`, default 127.0.0.1:3080. A
 * Host on another endpoint (another `--host`/`--port`, or a profile override of
 * the bound address) must be named through those options because the guard
 * cannot discover it, and an endpoint the guard cannot verify fails the run
 * instead of assuming no Host is running. Pass `--allow-running-host` only to
 * accept the risk; the migration never rewrites silently under a live Host.
 *
 * Every non-profile composition layer is inspected even when the profile patch
 * is already clean, so a home patch or `--patch` overlay cannot hide the legacy
 * route. A clean or hand-migrated profile still reaches the marker, the
 * dedicated bundle/link check, and the seed, which makes an interrupted run
 * resumable; a profile that already carries the marker is a no-op. This script
 * is deletable after every maintained profile carries the marker
 * (`.dsh-profile-migrations.json` with
 * `legacy-llm-pi-ai-cc-pool-provider`); `build.cmd` carries no legacy
 * detection, a guard, or fallback behavior.
 *
 * @module scripts/migrate-legacy-cc-pool-profile
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import * as yaml from 'js-yaml'
import {
  assertHostNotRunning,
  DEFAULT_HOST_ADDRESS,
  DEFAULT_HOST_PORT,
  ensureProfileBundles,
  parseHostOption,
  parsePortOption,
  pluginProfileProblem,
  resolveDshHome,
  runProfileCommand,
  stagedPluginDirectory,
  stageWorkspacePlugin,
  WORKSPACE_PLUGINS,
  type PluginDefinition,
} from './fork-plugins-build.ts'
import { seedPortableProfile, type SeedResult } from './fork-profile-seed.ts'

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUILD_ROOT = join(REPOSITORY_ROOT, '.build', 'fork-plugins')
const PROFILE_NAME = 'web'
/** Live settings document the removed settings service imports on Host start. */
export const SETTINGS_FILE = 'settings.yaml'
/** Marker written after a successful migration; build ignores it. */
export const MIGRATION_MARKER_FILE = '.dsh-profile-migrations.json'
/** Stable id of the migration recorded in the marker. */
export const LEGACY_MIGRATION_ID = 'legacy-llm-pi-ai-cc-pool-provider'

/** One legacy `providers.cc-pool` declaration inside an `llm-pi-ai` row. */
export interface LegacyPoolFinding {
  /** Path to the `cc-pool` key from the document root. */
  readonly path: readonly (string | number)[]
}

/** Which composition layer a patch file belongs to. */
export interface PatchSource {
  /** Human label used by failure reports. */
  readonly label: string
  /** Absolute patch file path. */
  readonly path: string
  /** Composition layer that owns the file. */
  readonly kind: 'repository' | 'profile' | 'overlay' | 'home'
}

/**
 * YAML type for the loader's `!!js` scalar expressions; detection only reads
 * structure and keeps the expression text opaque.
 */
const JAVASCRIPT_EXPRESSION_TAG = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data: string) => ({ jsExpression: data }),
})

const PATCH_YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend([JAVASCRIPT_EXPRESSION_TAG])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Parse a patch file structurally.
 * @param source - YAML text.
 * @param label - file label for the diagnostic.
 * @returns the parsed document.
 */
export function parsePatchDocument(source: string, label = 'patch'): unknown {
  try {
    return yaml.load(source, { schema: PATCH_YAML_SCHEMA })
  } catch (error) {
    throw new Error(`${label} is not readable YAML: ${errorMessage(error)}`)
  }
}

function ownsLegacyPoolRow(record: Record<string, unknown>): boolean {
  return record['id'] === 'llm-pi-ai' || record['name'] === '@deepseek-ai/dsh-llm-pi-ai'
}

/**
 * Render a finding path for diagnostics.
 * @param path - path segments from the document root.
 * @returns a `$...` path.
 */
export function formatFindingPath(path: readonly (string | number)[]): string {
  return path.reduce<string>(
    (current, segment) => typeof segment === 'number' ? `${current}[${String(segment)}]` : `${current}.${segment}`,
    '$',
  )
}

/**
 * Find every legacy `llm-pi-ai` `providers.cc-pool` declaration.
 * @param source - patch text.
 * @param label - file label for a parse diagnostic.
 * @returns the declarations in document order.
 */
export function findLegacyPoolProviders(source: string, label = 'patch'): LegacyPoolFinding[] {
  const document = parsePatchDocument(source, label)
  const findings: LegacyPoolFinding[] = []
  const visited = new WeakSet<object>()
  const visit = (value: unknown, path: (string | number)[]): void => {
    if (typeof value !== 'object' || value === null) return
    if (visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      value.forEach((entry, index) => { visit(entry, [...path, index]) })
      return
    }
    const record = value as Record<string, unknown>
    if (ownsLegacyPoolRow(record)) {
      const config = record['config']
      if (isRecord(config)) {
        const providers = config['providers']
        if (isRecord(providers) && Object.hasOwn(providers, 'cc-pool')) {
          findings.push({ path: [...path, 'config', 'providers', 'cc-pool'] })
        }
      }
    }
    for (const [key, child] of Object.entries(record)) visit(child, [...path, key])
  }
  visit(document, [])
  return findings
}

/** Profile entry keys the removed settings document may use for the `llm-pi-ai` route. */
const LEGACY_SETTINGS_ENTRIES = ['llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai'] as const

/** One value that the loader's `!!js` tag produced and a YAML dump would lose. */
function holdsJavascriptExpression(value: unknown, visited = new WeakSet<object>()): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (visited.has(value)) return false
  visited.add(value)
  if (Array.isArray(value)) return value.some(entry => holdsJavascriptExpression(entry, visited))
  const record = value as Record<string, unknown>
  if (Object.hasOwn(record, 'jsExpression')) return true
  return Object.values(record).some(entry => holdsJavascriptExpression(entry, visited))
}

/** One legacy `providers.cc-pool` declaration inside the Harness home's settings document. */
export interface LegacySettingsFinding {
  /** Top-level settings section that owns the declaration. */
  readonly section: string
}

/**
 * Find every `llm-pi-ai` `providers.cc-pool` declaration in `settings.yaml`.
 *
 * The removed settings service imports each top-level section as the
 * configuration of the entry with that id, so the legacy route appears as
 * `llm-pi-ai.providers.cc-pool` rather than inside a loader row.
 * @param source - settings document text.
 * @param label - file label for a parse diagnostic.
 * @returns the declarations in document order.
 */
export function findLegacySettingsProviders(source: string, label = SETTINGS_FILE): LegacySettingsFinding[] {
  const document = parsePatchDocument(source, label)
  if (!isRecord(document)) return []
  const findings: LegacySettingsFinding[] = []
  for (const section of LEGACY_SETTINGS_ENTRIES) {
    const values = document[section]
    if (!isRecord(values)) continue
    const providers = values['providers']
    if (!isRecord(providers) || !Object.hasOwn(providers, 'cc-pool')) continue
    findings.push({ section })
  }
  return findings
}

/** Outcome of removing every legacy declaration from the settings document. */
export interface LegacySettingsMigration {
  readonly source: string
  readonly removed: number
}

/**
 * Remove the legacy `llm-pi-ai` `providers.cc-pool` declaration from `settings.yaml`.
 *
 * The document is parsed and re-serialized, so comments are not preserved; the
 * original file is in the migration backup. A document carrying loader `!!js`
 * expressions is refused instead: re-serializing it as data would silently
 * replace those expressions with objects.
 * @param source - settings document text.
 * @param label - file label for diagnostics.
 * @returns the migrated text and the number of declarations removed.
 */
export function migrateLegacySettingsProviders(source: string, label = SETTINGS_FILE): LegacySettingsMigration {
  const findings = findLegacySettingsProviders(source, label)
  if (findings.length === 0) return { source, removed: 0 }
  const document = parsePatchDocument(source, label)
  if (!isRecord(document)) throw new Error(`${label} is not a YAML mapping`)
  if (holdsJavascriptExpression(document)) {
    throw new Error(`${label} declares the legacy llm-pi-ai "providers.cc-pool" route beside a !!js expression this migration cannot rewrite safely; `
      + 'remove the "cc-pool" key under providers manually, then rerun this migration')
  }
  for (const section of LEGACY_SETTINGS_ENTRIES) {
    const values = document[section]
    if (!isRecord(values)) continue
    const providers = values['providers']
    if (!isRecord(providers)) continue
    Reflect.deleteProperty(providers, 'cc-pool')
  }
  return { source: yaml.dump(document, { lineWidth: -1, noRefs: true }), removed: findings.length }
}

/**
 * Resolve the Harness home exactly as the platform launchers do.
 *
 * An explicit `--dsh-home` wins, then `DSH_HOME`; a blank value counts as
 * unset. The platform launchers own the default — the Windows launchers keep
 * `<checkout parent>/deepseek-harness-data`, while the macOS and Linux
 * launchers use `~/.dsh` — and a leading `~` in either configured value is
 * expanded. Those launchers export `DSH_HOME` before invoking any script, so
 * the default only matters for a manual run.
 * @param explicit - `--dsh-home` value.
 * @param env - environment to read `DSH_HOME` from.
 * @param repositoryRoot - checkout root the Windows default sits beside.
 * @returns the absolute Harness home.
 */
export function resolveMigrationHome(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  repositoryRoot = REPOSITORY_ROOT,
): string {
  return resolveDshHome(explicit, env, repositoryRoot)
}

/**
 * Every patch layer the web profile composes before and around seeding.
 * @param input - repository root, Harness home, profile directory, and extra overlays.
 * @returns the composition sources in order.
 */
export function compositionPatchSources(input: {
  readonly home: string
  readonly profileDirectory: string
  readonly repositoryRoot?: string
  readonly overlays?: readonly string[]
}): PatchSource[] {
  const repositoryRoot = input.repositoryRoot ?? REPOSITORY_ROOT
  const sources: PatchSource[] = [
    {
      label: 'repository base bundle patch',
      path: join(repositoryRoot, 'packages', 'bundle', 'base', 'cordis.patch.yml'),
      kind: 'repository',
    },
    {
      label: 'repository web bundle patch',
      path: join(repositoryRoot, 'packages', 'bundle', 'web-app', 'cordis.patch.yml'),
      kind: 'repository',
    },
    {
      label: 'portable profile template',
      path: join(repositoryRoot, 'fork-runtime', 'web', 'portable-profile.patch.yml'),
      kind: 'repository',
    },
    {
      label: 'portable memory-limits template',
      path: join(repositoryRoot, 'fork-runtime', 'web', 'portable-memory-limits.patch.yml'),
      kind: 'repository',
    },
    {
      label: 'repository diagnostics overlay',
      path: join(repositoryRoot, 'fork-runtime', 'diagnostics', 'cordis.patch.yml'),
      kind: 'repository',
    },
    { label: 'profile patch', path: join(input.profileDirectory, 'cordis.patch.yml'), kind: 'profile' },
    { label: 'profile memory-limits overlay', path: join(input.profileDirectory, 'memory-limits.patch.yml'), kind: 'overlay' },
    { label: 'home patch', path: join(input.home, 'cordis.patch.yml'), kind: 'home' },
  ]
  for (const overlay of input.overlays ?? []) {
    sources.push({ label: `--patch overlay ${overlay}`, path: resolve(overlay), kind: 'overlay' })
  }
  return sources
}

function childAt(value: unknown, key: string | number): unknown {
  if (Array.isArray(value) && typeof key === 'number') return value[key]
  if (isRecord(value)) return value[String(key)]
  throw new Error(`cannot follow ${String(key)} in the parsed patch`)
}

/**
 * The parsed document with one legacy provider removed.
 *
 * A `providers` mapping that becomes empty is kept as `{}`: the declaration is
 * gone, and the plugin schema defaults that field to an empty mapping.
 * @param document - parsed patch.
 * @param path - finding path to the `cc-pool` key.
 * @returns a new document value.
 */
function withoutLegacyPoolProvider(document: unknown, path: readonly (string | number)[]): unknown {
  const clone = structuredClone(document)
  const parentPath = path.slice(0, -1)
  let parent: unknown = clone
  for (const key of parentPath) parent = childAt(parent, key)
  if (!isRecord(parent)) throw new Error(`the legacy provider at ${formatFindingPath(path)} has no mapping parent`)
  Reflect.deleteProperty(parent, String(path[path.length - 1]))
  return clone
}

function isSpace(character: string | undefined): boolean {
  return character === ' ' || character === '\t'
}

function isWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n'
}

function skipSpaces(source: string, index: number): number {
  let position = index
  while (isSpace(source[position])) position += 1
  return position
}

function skipWhitespace(source: string, index: number): number {
  let position = index
  while (isWhitespace(source[position])) position += 1
  return position
}

function previousNonWhitespace(source: string, index: number): number {
  let position = index
  while (position >= 0 && isWhitespace(source[position])) position -= 1
  return position
}

/** End index (exclusive) of a quoted scalar, or undefined when it is unterminated. */
function quotedScalarEnd(source: string, start: number): number | undefined {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    const character = source[index]
    if (quote === "'" && character === "'") {
      if (source[index + 1] === "'") {
        index += 2
        continue
      }
      return index + 1
    }
    if (quote === '"' && character === '\\') {
      index += 2
      continue
    }
    if (quote === '"' && character === '"') return index + 1
    index += 1
  }
  return undefined
}

/** Whether the position starts a mapping key in block or flow context. */
function isKeyPosition(source: string, start: number): boolean {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1
  const prefix = source.slice(lineStart, start)
  if (/^[ \t]*$/.test(prefix)) return true
  if (/^[ \t]*-[ \t]+$/.test(prefix)) return true
  const previous = previousNonWhitespace(source, start - 1)
  return previous >= 0 && (source[previous] === '{' || source[previous] === ',')
}

function isKeyColon(source: string, index: number): boolean {
  return source[skipSpaces(source, index)] === ':'
}

function hasNameBoundary(source: string, index: number, length: number): boolean {
  const before = index === 0 ? '' : source[index - 1] ?? ''
  const after = source[index + length] ?? ''
  return !/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)
}

interface KeyOccurrence {
  readonly start: number
  readonly end: number
  readonly name: string
}

/** Every plain or quoted mapping-key occurrence of one name, outside comments and values. */
function keyOccurrences(source: string, name: string): KeyOccurrence[] {
  const occurrences: KeyOccurrence[] = []
  let index = 0
  while (index < source.length) {
    const character = source[index]
    if (character === '#') {
      const before = index === 0 ? '\n' : source[index - 1]
      if (before !== undefined && /\s/.test(before)) {
        const newline = source.indexOf('\n', index)
        index = newline < 0 ? source.length : newline + 1
        continue
      }
    }
    const tokenStart = index === 0 || /[\s{[,:-]/.test(source[index - 1] ?? '')
    if ((character === "'" || character === '"') && tokenStart) {
      const end = quotedScalarEnd(source, index)
      if (end === undefined) {
        index += 1
        continue
      }
      const inner = character === '"' ? source.slice(index + 1, end - 1) : source.slice(index + 1, end - 1).replaceAll("''", "'")
      if (inner === name && isKeyPosition(source, index) && isKeyColon(source, end)) {
        occurrences.push({ start: index, end, name })
      }
      index = end
      continue
    }
    if (source.startsWith(name, index)
      && hasNameBoundary(source, index, name.length)
      && isKeyPosition(source, index)
      && isKeyColon(source, index + name.length)) {
      occurrences.push({ start: index, end: index + name.length, name })
      index += name.length
      continue
    }
    index += 1
  }
  return occurrences
}

interface SourceRange {
  readonly start: number
  readonly end: number
}

/** End index of one flow collection starting at `start`, quotes and comments aware. */
function matchingFlowEnd(source: string, start: number): number | undefined {
  const expected: string[] = []
  let index = start
  while (index < source.length) {
    const character = source[index]
    if (character === "'" || character === '"') {
      const end = quotedScalarEnd(source, index)
      if (end === undefined) return undefined
      index = end
      continue
    }
    if (character === '#' && /\s/.test(source[index - 1] ?? '\n')) {
      const newline = source.indexOf('\n', index)
      index = newline < 0 ? source.length : newline + 1
      continue
    }
    if (character === '{') expected.push('}')
    else if (character === '[') expected.push(']')
    else if (character === '}' || character === ']') {
      if (expected.pop() !== character) return undefined
      if (expected.length === 0) return index + 1
    }
    index += 1
  }
  return undefined
}

/** End index of a flow value beginning at `start`. */
function flowValueEnd(source: string, start: number): number | undefined {
  const character = source[start]
  if (character === undefined) return undefined
  if (character === '{' || character === '[') return matchingFlowEnd(source, start)
  if (character === "'" || character === '"') return quotedScalarEnd(source, start)
  let index = start
  while (index < source.length) {
    const current = source[index]
    if (current === ',' || current === '}' || current === ']') return index
    if (current === '#' && /\s/.test(source[index - 1] ?? '\n')) return index
    index += 1
  }
  return index
}

/** End index of a nested block mapping or sequence value starting at `start`. */
function nestedBlockEnd(source: string, start: number, keyIndent: number): number {
  let position = start
  while (position < source.length) {
    const lineEnd = source.indexOf('\n', position)
    const next = lineEnd < 0 ? source.length : lineEnd + 1
    const line = source.slice(position, lineEnd < 0 ? source.length : lineEnd)
    const trimmed = line.trim()
    if (trimmed === '') {
      position = next
      continue
    }
    const indent = /^[ \t]*/.exec(line)?.[0].length ?? 0
    if (trimmed.startsWith('#') && indent <= keyIndent) return position
    if (indent <= keyIndent) return position
    position = next
  }
  return source.length
}

/** Removal range for a block mapping entry. */
function blockKeyRange(source: string, occurrence: KeyOccurrence): SourceRange | undefined {
  const colon = skipSpaces(source, occurrence.end)
  if (source[colon] !== ':') return undefined
  const lineStart = source.lastIndexOf('\n', occurrence.start - 1) + 1
  const prefix = source.slice(lineStart, occurrence.start)
  if (!/^[ \t]*$/.test(prefix) && !/^[ \t]*-[ \t]+$/.test(prefix)) return undefined
  const keyIndent = /^[ \t]*/.exec(prefix)?.[0].length ?? 0
  const inlineStart = skipSpaces(source, colon + 1)
  const rawLineEnd = source.indexOf('\n', colon)
  const lineEnd = rawLineEnd < 0 ? source.length : rawLineEnd
  const inline = source.slice(inlineStart, lineEnd)
  const hasInlineValue = inline.trim() !== '' && !inline.trimStart().startsWith('#')
  if (!hasInlineValue) return { start: lineStart, end: nestedBlockEnd(source, lineEnd + 1, keyIndent) }
  const first = source[inlineStart]
  if (first === '{' || first === '[') {
    const close = matchingFlowEnd(source, inlineStart)
    if (close === undefined) return undefined
    const tail = source.slice(skipSpaces(source, close), lineEnd)
    const finish = tail.trim() === '' || tail.trimStart().startsWith('#') ? (rawLineEnd < 0 ? source.length : rawLineEnd + 1) : close
    return { start: lineStart, end: finish }
  }
  const trimmed = inline.trimStart()
  if (trimmed.startsWith('|') || trimmed.startsWith('>')) {
    return { start: lineStart, end: nestedBlockEnd(source, lineEnd + 1, keyIndent) }
  }
  return { start: lineStart, end: rawLineEnd < 0 ? source.length : rawLineEnd + 1 }
}

/** Removal range for one entry inside a flow mapping. */
function flowEntryRange(source: string, occurrence: KeyOccurrence): SourceRange | undefined {
  const colon = skipSpaces(source, occurrence.end)
  if (source[colon] !== ':') return undefined
  const valueStart = skipWhitespace(source, colon + 1)
  const valueEnd = flowValueEnd(source, valueStart)
  if (valueEnd === undefined) return undefined
  const afterValue = skipWhitespace(source, valueEnd)
  if (source[afterValue] === ',') return { start: occurrence.start, end: afterValue + 1 }
  const beforeEntry = previousNonWhitespace(source, occurrence.start - 1)
  if (source[beforeEntry] === ',') return { start: beforeEntry, end: valueEnd }
  return { start: occurrence.start, end: valueEnd }
}

interface TextEdit extends SourceRange {
  readonly replacement: string
}

/** Replace a block mapping value with an empty flow mapping. */
function blockValueEmptyMapEdit(source: string, occurrence: KeyOccurrence): TextEdit | undefined {
  const colon = skipSpaces(source, occurrence.end)
  if (source[colon] !== ':') return undefined
  const lineStart = source.lastIndexOf('\n', occurrence.start - 1) + 1
  const prefix = source.slice(lineStart, occurrence.start)
  if (!/^[ \t]*$/.test(prefix) && !/^[ \t]*-[ \t]+$/.test(prefix)) return undefined
  const keyIndent = /^[ \t]*/.exec(prefix)?.[0].length ?? 0
  const inlineStart = skipSpaces(source, colon + 1)
  const rawLineEnd = source.indexOf('\n', colon)
  const lineEnd = rawLineEnd < 0 ? source.length : rawLineEnd
  const inline = source.slice(inlineStart, lineEnd)
  if (inline.trim() === '') {
    const blockEnd = nestedBlockEnd(source, lineEnd + 1, keyIndent)
    const newline = blockEnd > colon + 1 && source[blockEnd - 1] === '\n' ? '\n' : ''
    return { start: colon + 1, end: blockEnd, replacement: ` {}${newline}` }
  }
  if (inline.trimStart().startsWith('#')) {
    const blockEnd = nestedBlockEnd(source, lineEnd + 1, keyIndent)
    const newline = blockEnd > inlineStart && source[blockEnd - 1] === '\n' ? '\n' : ''
    return { start: inlineStart, end: blockEnd, replacement: `{} ${source.slice(inlineStart, lineEnd)}${newline}` }
  }
  if (source[inlineStart] !== '{' && source[inlineStart] !== '[') return undefined
  const close = matchingFlowEnd(source, inlineStart)
  return close === undefined ? undefined : { start: inlineStart, end: close, replacement: '{}' }
}

/** Replace a flow mapping entry's value with an empty flow mapping. */
function flowValueEmptyMapEdit(source: string, occurrence: KeyOccurrence): TextEdit | undefined {
  const colon = skipSpaces(source, occurrence.end)
  if (source[colon] !== ':') return undefined
  const valueStart = skipWhitespace(source, colon + 1)
  const valueEnd = flowValueEnd(source, valueStart)
  return valueEnd === undefined ? undefined : { start: valueStart, end: valueEnd, replacement: '{}' }
}

/** Try every textual edit that reproduces the structurally computed target. */
function findTextualRemoval(source: string, target: unknown): string | undefined {
  const edits: TextEdit[] = []
  for (const name of ['cc-pool', 'providers'] as const) {
    for (const occurrence of keyOccurrences(source, name)) {
      const block = blockKeyRange(source, occurrence)
      if (block !== undefined) edits.push({ ...block, replacement: '' })
      const flow = flowEntryRange(source, occurrence)
      if (flow !== undefined) edits.push({ ...flow, replacement: '' })
      if (name !== 'providers') continue
      const blockValue = blockValueEmptyMapEdit(source, occurrence)
      if (blockValue !== undefined) edits.push(blockValue)
      const flowValue = flowValueEmptyMapEdit(source, occurrence)
      if (flowValue !== undefined) edits.push(flowValue)
    }
  }
  const attempted = new Set<string>()
  for (const edit of edits) {
    const key = `${edit.start}:${edit.end}:${edit.replacement}`
    if (attempted.has(key) || edit.end < edit.start) continue
    attempted.add(key)
    const candidate = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end)
    let parsed: unknown
    try {
      parsed = parsePatchDocument(candidate)
    } catch {
      continue
    }
    if (isDeepStrictEqual(parsed, target)) return candidate
  }
  return undefined
}

/** Outcome of removing every legacy provider declaration from one patch. */
export interface LegacyPoolMigration {
  readonly source: string
  readonly removed: number
}

/**
 * Remove the legacy `llm-pi-ai` `providers.cc-pool` declaration structurally.
 *
 * The rewrite is accepted only when re-parsing the edited text equals the parsed
 * document with that provider removed, so comments and unrelated rows are kept
 * and an unusual layout fails instead of producing a half-edited profile.
 * @param source - profile patch text.
 * @param label - file label for diagnostics.
 * @returns the migrated text and the number of declarations removed.
 */
export function migrateLegacyPoolProvider(source: string, label = 'profile patch'): LegacyPoolMigration {
  let current = source
  let removed = 0
  for (;;) {
    const findings = findLegacyPoolProviders(current, label)
    if (findings.length === 0) return { source: current, removed }
    const finding = findings[0]
    if (finding === undefined) return { source: current, removed }
    const document = parsePatchDocument(current, label)
    const target = withoutLegacyPoolProvider(document, finding.path)
    const candidate = findTextualRemoval(current, target)
    if (candidate === undefined) {
      throw new Error(`${label} declares ${formatFindingPath(finding.path)} in a layout this migration cannot rewrite safely`)
    }
    current = candidate
    removed += 1
    if (removed > 32) throw new Error(`${label} has too many legacy cc-pool declarations to migrate`)
  }
}

/** One file recorded by a profile backup. */
export interface ProfileBackupEntry {
  /** Root that owns the file: the profile or the Harness home. */
  readonly root: 'profile' | 'home'
  /** Portable relative path below that root. */
  readonly relative: string
  /** Whether the file existed when the backup was taken. */
  readonly existed: boolean
}

/** Snapshot of every profile and seed file the migration may change. */
export interface ProfileBackup {
  /** Backup directory holding `backup.json` and the copied files. */
  readonly directory: string
  /** Profile directory the backup belongs to. */
  readonly profileDirectory: string
  /** Harness home that owns the seed files. */
  readonly home: string
  /** Whether the profile directory existed before the migration. */
  readonly profileDirectoryExisted: boolean
  /** Whether the profile manifest existed before the migration. */
  readonly profileExisted: boolean
  /** Recorded files and whether each existed. */
  readonly entries: readonly ProfileBackupEntry[]
}

/** Files restored or removed by a rollback. */
export interface ProfileRollbackResult {
  readonly restored: readonly string[]
  readonly removed: readonly string[]
  readonly profileRemoved: boolean
  readonly failures: readonly string[]
}

/** Profile files the migration may rewrite or create. */
const PROFILE_BACKUP_FILES = [
  'package.json',
  'cordis.patch.yml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'compatibility.json',
  'memory-watchdog.cjs',
  'chatgpt-subagent-preset.cjs',
  'goal-disabled.cjs',
  'memory-limits.patch.yml',
  MIGRATION_MARKER_FILE,
] as const

/** Home files the migration may rewrite or create. */
const HOME_BACKUP_FILES = [
  SETTINGS_FILE,
  '.agent-presets/chatgpt-dsh/agent.cordis.yml',
  '.agent-presets/chatgpt-dsh/preset.yml',
  '.agent-presets/chatgpt-dsh/no-escalation.cjs',
] as const

function backupFileDestination(directory: string, entry: ProfileBackupEntry): string {
  return join(directory, entry.root, ...entry.relative.split('/'))
}

/**
 * Snapshot the profile and portable seed files before the migration mutates them.
 * @param options - profile directory and Harness home.
 * @returns the recorded backup.
 */
export async function backupProfile(options: {
  readonly profileDirectory: string
  readonly home: string
}): Promise<ProfileBackup> {
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const directory = join(BUILD_ROOT, 'backups', `${PROFILE_NAME}-migration-${stamp}-${process.pid}`)
  await mkdir(directory, { recursive: true })
  const entries: ProfileBackupEntry[] = []
  for (const [root, base, files] of [
    ['profile', options.profileDirectory, PROFILE_BACKUP_FILES],
    ['home', options.home, HOME_BACKUP_FILES],
  ] as const) {
    for (const relative of files) {
      const source = join(base, ...relative.split('/'))
      const existed = existsSync(source)
      const entry: ProfileBackupEntry = { root, relative, existed }
      entries.push(entry)
      if (!existed) continue
      const destination = backupFileDestination(directory, entry)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination)
    }
  }
  const backup: ProfileBackup = {
    directory,
    profileDirectory: options.profileDirectory,
    home: options.home,
    profileDirectoryExisted: existsSync(options.profileDirectory),
    profileExisted: existsSync(join(options.profileDirectory, 'package.json')),
    entries,
  }
  await writeFile(join(directory, 'backup.json'), `${JSON.stringify(backup, undefined, 2)}\n`)
  await writeFile(join(directory, 'profile-path.txt'), `${options.profileDirectory}\n`)
  if (!backup.profileExisted) {
    await writeFile(
      join(directory, 'profile-created-by-build.txt'),
      'The profile did not exist before this migration; no prior configuration existed to back up.\n',
    )
  }
  return backup
}

function safeRelativePath(root: string, relative: string): string | undefined {
  const normalized = relative.replaceAll('\\', '/')
  const parts = normalized.split('/')
  if (normalized.startsWith('/') || parts.some(part => part === '' || part === '.' || part === '..')) return undefined
  return join(root, ...parts)
}

/**
 * Restore the profile and seed files recorded by {@link backupProfile}.
 *
 * A profile directory that did not exist before the migration is removed
 * entirely; otherwise every recorded file is restored byte-for-byte and every
 * file the migration created is removed.
 * @param backup - snapshot returned by {@link backupProfile}.
 * @returns what was restored or removed, plus any rollback failures.
 */
export async function rollbackProfileBackup(backup: ProfileBackup): Promise<ProfileRollbackResult> {
  const restored: string[] = []
  const removed: string[] = []
  const failures: string[] = []
  for (const entry of backup.entries) {
    if (!backup.profileDirectoryExisted && entry.root === 'profile') continue
    const root = entry.root === 'profile' ? backup.profileDirectory : backup.home
    const target = safeRelativePath(root, entry.relative)
    if (target === undefined) {
      failures.push(`refused unsafe backup path ${entry.relative}`)
      continue
    }
    if (entry.existed) {
      const source = backupFileDestination(backup.directory, entry)
      if (!existsSync(source)) {
        failures.push(`backup copy of ${entry.relative} is missing from ${backup.directory}`)
        continue
      }
      try {
        await mkdir(dirname(target), { recursive: true })
        await copyFile(source, target)
        restored.push(target)
      } catch (error) {
        failures.push(`could not restore ${target}: ${errorMessage(error)}`)
      }
      continue
    }
    if (!existsSync(target)) continue
    try {
      await rm(target, { force: true })
      removed.push(target)
    } catch (error) {
      failures.push(`could not remove ${target}: ${errorMessage(error)}`)
    }
  }
  let profileRemoved = false
  if (!backup.profileDirectoryExisted && existsSync(backup.profileDirectory)) {
    try {
      await rm(backup.profileDirectory, { recursive: true, force: true })
      profileRemoved = true
    } catch (error) {
      failures.push(`could not remove ${backup.profileDirectory}: ${errorMessage(error)}`)
    }
  }
  return { restored, removed, profileRemoved, failures }
}

/** Migration marker document. */
interface MigrationMarker {
  schema: number
  migrations: Record<string, { appliedAt: string; removedProviders: number }>
}

async function writeMigrationMarker(profileDirectory: string, removed: number): Promise<string> {
  const path = join(profileDirectory, MIGRATION_MARKER_FILE)
  let marker: MigrationMarker = { schema: 1, migrations: {} }
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (isRecord(parsed) && parsed['schema'] === 1 && isRecord(parsed['migrations'])) {
        marker = {
          schema: 1,
          migrations: Object.fromEntries(
            Object.entries(parsed['migrations']).filter((entry): entry is [string, { appliedAt: string; removedProviders: number }] => {
              const value = entry[1]
              return isRecord(value) && typeof value['appliedAt'] === 'string' && typeof value['removedProviders'] === 'number'
            }),
          ),
        }
      }
    } catch {
      // The backup already holds a malformed marker; the migration may replace it.
    }
  }
  marker.migrations[LEGACY_MIGRATION_ID] = { appliedAt: new Date().toISOString(), removedProviders: removed }
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(marker, undefined, 2)}\n`)
  await rename(temporary, path)
  return path
}

async function writeTextAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, text)
  await rename(temporary, path)
}

/** Context passed to the injected migration steps. */
export interface MigrationContext {
  /** Harness home that owns the profile. */
  readonly home: string
  /** Profile directory being migrated. */
  readonly profileDirectory: string
  /** Snapshot taken before the profile patch was rewritten. */
  readonly backup: ProfileBackup
}

/** Hooks that let tests run the migration without pnpm or a built Host. */
export interface MigrationHooks {
  /** Ensure the dedicated bundle/link is installed; defaults to staging plus `dsh plugin add`. */
  readonly ensurePlugin?: (context: MigrationContext) => Promise<void> | void
  /** Seed the portable profile; defaults to {@link seedPortableProfile}. */
  readonly seed?: (context: MigrationContext) => Promise<SeedResult | void> | SeedResult | void
}

/** Input for {@link migrateLegacyProfile}. */
export interface MigrateLegacyProfileOptions {
  /** Harness home; defaults to `DSH_HOME`, then the platform launcher default. */
  readonly dshHome?: string
  /** Profile directory override; defaults to `<home>/profiles/web`. */
  readonly profileDirectory?: string
  /** Repository root override for tests; defaults to this checkout. */
  readonly repositoryRoot?: string
  /** Additional `--patch` overlays to inspect for the legacy route. */
  readonly overlays?: readonly string[]
  /** Continue while the guarded Host endpoint answers, after a loud warning. */
  readonly allowRunningHost?: boolean
  /** Host address to guard; defaults to 127.0.0.1. */
  readonly host?: string
  /** Host port to guard; defaults to 3080. */
  readonly port?: number
  /** Test hooks for the install and seed steps. */
  readonly hooks?: MigrationHooks
}

/** Outcome of one migration invocation. */
export interface MigrationOutcome {
  /**
   * `migrated` removed a legacy declaration, `completed` recorded the
   * completion state of an already-clean profile, and `skipped` changed nothing.
   */
  readonly status: 'migrated' | 'completed' | 'skipped'
  /**
   * Why the migration skipped, or why `settings.yaml` was migrated without
   * completing a profile.
   */
  readonly reason?: string
  /** Backup directory written before mutation, when the run wrote anything. */
  readonly backup?: string
  /** Marker file written after migration, when the run wrote one. */
  readonly markerPath?: string
  /** Number of legacy declarations removed from the profile patch. */
  readonly removed?: number
  /** Number of legacy declarations removed from `settings.yaml`. */
  readonly removedSettings?: number
}

function log(message: string): void {
  process.stdout.write(`[migrate-cc-pool] ${message}\n`)
}

function warn(message: string): void {
  process.stderr.write(`[migrate-cc-pool] warning: ${message}\n`)
}

function fail(message: string): never {
  throw new Error(message)
}

/** Whether the profile already records this migration in its marker. */
async function hasMigrationMarker(path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isRecord(parsed) || parsed['schema'] !== 1 || !isRecord(parsed['migrations'])) return false
    return Object.hasOwn(parsed['migrations'], LEGACY_MIGRATION_ID)
  } catch {
    // A malformed marker records nothing; the migration rewrites it.
    return false
  }
}

async function ensureDedicatedPlugin(context: MigrationContext): Promise<void> {
  const plugin = WORKSPACE_PLUGINS[0]
  if (plugin === undefined) fail('the workspace plugin definition for @deepseek-ai/dsh-llm-cc-pool is missing')
  const stagedDirectory = stagedPluginDirectory(plugin)
  if (await pluginProfileProblem(plugin, context.profileDirectory, stagedDirectory) === undefined) {
    log('@deepseek-ai/dsh-llm-cc-pool is already linked and listed in the profile')
    return
  }
  log(`staging ${plugin.name} from the root build output`)
  try {
    await stageWorkspacePlugin(plugin, stagedDirectory)
  } catch (error) {
    throw new Error([
      `cannot stage ${plugin.name}: ${errorMessage(error)}`,
      'Run the ordinary root build (`pnpm run build`) once so the workspace package has lib/ output, then rerun this migration; run build.cmd only after migration.',
    ].join('\n'))
  }
  log(`linking ${plugin.name} into profile ${PROFILE_NAME}`)
  runProfileCommand(['plugin', '--profile', PROFILE_NAME, 'add', stagedDirectory], context.home)
  await ensureProfileBundles(context.profileDirectory, [plugin.name])
  const problem = await pluginProfileProblem(plugin, context.profileDirectory, stagedDirectory)
  if (problem !== undefined) {
    throw new Error(`the migrated profile still does not resolve ${plugin.name}: ${problem}`)
  }
}

async function seedProfile(context: MigrationContext): Promise<SeedResult> {
  return seedPortableProfile({ dshHome: context.home })
}

function assertOnlyProfileHasLegacy(source: PatchSource, sourceText: string): void {
  const findings = findLegacyPoolProviders(sourceText, source.label)
  if (findings.length === 0) return
  const locations = findings.map(finding => formatFindingPath(finding.path)).join(', ')
  throw new Error([
    `${source.label} at ${source.path} still declares the legacy llm-pi-ai "providers.cc-pool" route (${locations}).`,
    `This migration only rewrites the target profile patch. Remove the "cc-pool" key under the llm-pi-ai row's config.providers in ${source.path} (block, quoted, or flow-map form), then rerun this migration.`,
    'No profile or staging file was changed.',
  ].join('\n'))
}

/**
 * Migrate one legacy web profile.
 *
 * `settings.yaml` is migrated first, before the missing-profile and
 * missing-package.json skips: a Host imports that home document into the
 * profile it starts, so a home whose web profile does not exist yet must not
 * keep the removed route. That rewrite is backed up and guarded like the
 * profile rewrite, and it runs without a profile completion or marker when
 * there is no profile to complete.
 *
 * A profile that already records the migration and declares the route nowhere
 * is a no-op. A clean profile without the marker — hand-migrated, or left clean
 * by an interrupted run — still verifies the dedicated bundle, seeds, and
 * writes the marker, so the completion state is reachable without
 * reintroducing the legacy declaration.
 * @param options - Harness home, profile override, host endpoint, and test hooks.
 * @returns what was migrated, completed, or why it was skipped.
 */
export async function migrateLegacyProfile(options: MigrateLegacyProfileOptions = {}): Promise<MigrationOutcome> {
  const home = resolveMigrationHome(options.dshHome)
  const profileDirectory = options.profileDirectory ?? join(home, 'profiles', PROFILE_NAME)
  const profilePatch = join(profileDirectory, 'cordis.patch.yml')
  const profileHasPatch = existsSync(profilePatch)
  const profileHasManifest = existsSync(join(profileDirectory, 'package.json'))
  const current = profileHasPatch ? await readFile(profilePatch, 'utf8') : ''
  const profileFindings = profileHasPatch ? findLegacyPoolProviders(current, profilePatch) : []

  // Every non-profile composition layer is inspected before the profile decides
  // to skip: a home patch or --patch overlay that still declares the route fails
  // loudly instead of being skipped with an already-clean profile patch.
  if (profileHasPatch) {
    const sources = compositionPatchSources({
      home,
      profileDirectory,
      ...options.repositoryRoot === undefined ? {} : { repositoryRoot: options.repositoryRoot },
      ...options.overlays === undefined ? {} : { overlays: options.overlays },
    })
    for (const source of sources) {
      if (source.kind === 'profile' || !existsSync(source.path)) continue
      assertOnlyProfileHasLegacy(source, await readFile(source.path, 'utf8'))
    }
  }

  // The removed settings service imports this document on Host start, so the
  // legacy route is cleaned even when no web profile exists beside it.
  const settingsPath = join(home, SETTINGS_FILE)
  const settingsText = existsSync(settingsPath) ? await readFile(settingsPath, 'utf8') : undefined
  const settings = settingsText === undefined
    ? undefined
    : migrateLegacySettingsProviders(settingsText, settingsPath)
  const removedSettings = settings?.removed ?? 0

  const markerPath = join(profileDirectory, MIGRATION_MARKER_FILE)
  if (profileFindings.length === 0 && removedSettings === 0 && await hasMigrationMarker(markerPath)) {
    return { status: 'skipped', reason: `the profile already records ${LEGACY_MIGRATION_ID}` }
  }
  const canCompleteProfile = profileHasPatch && profileHasManifest
  if (!canCompleteProfile) {
    if (profileFindings.length > 0) {
      // Only a profile patch that exists can carry findings.
      throw new Error(`the legacy profile at ${profileDirectory} has no package.json; restore the profile before migrating it`)
    }
    if (removedSettings === 0) {
      return {
        status: 'skipped',
        reason: profileHasPatch
          ? `the profile directory at ${profileDirectory} has no package.json`
          : `no profile patch exists at ${profilePatch}`,
      }
    }
  }
  // Mutating from here: refuse while a Host could read or import these files.
  await assertHostNotRunning({
    allowRunningHost: options.allowRunningHost === true,
    action: canCompleteProfile ? 'migrating the profile' : 'migrating the home settings document',
    warn,
    ...options.host === undefined ? {} : { host: options.host },
    ...options.port === undefined ? {} : { port: options.port },
  })
  const migrated = profileFindings.length === 0
    ? { source: current, removed: 0 }
    : migrateLegacyPoolProvider(current, profilePatch)
  const backup = await backupProfile({ profileDirectory, home })
  try {
    if (migrated.removed > 0) {
      await writeTextAtomic(profilePatch, migrated.source)
      log(`removed ${String(migrated.removed)} legacy llm-pi-ai "providers.cc-pool" declaration(s) from ${profilePatch}`)
    }
    if (removedSettings > 0 && settings !== undefined) {
      await writeTextAtomic(settingsPath, settings.source)
      log(`removed ${String(removedSettings)} legacy llm-pi-ai "providers.cc-pool" declaration(s) from ${settingsPath}`
        + ' (the rewrite normalizes YAML formatting; the original document is in the backup)')
    }
    let written: string | undefined
    if (canCompleteProfile) {
      const context: MigrationContext = { home, profileDirectory, backup }
      await (options.hooks?.ensurePlugin ?? ensureDedicatedPlugin)(context)
      await (options.hooks?.seed ?? seedProfile)(context)
      written = await writeMigrationMarker(profileDirectory, migrated.removed)
      log(`wrote migration marker ${written}`)
    } else {
      log(`no web profile to complete at ${profileDirectory}; migrated the home settings document only`)
    }
    // The settings removal is reported even when it happens beside no profile:
    // the caller must not describe a partial run as a completed migration.
    const partialReason = canCompleteProfile
      ? undefined
      : profileHasPatch
        ? `the profile directory at ${profileDirectory} has no package.json; migrated settings.yaml only`
        : `no profile patch exists at ${profilePatch}; migrated settings.yaml only`
    return {
      status: migrated.removed > 0 || removedSettings > 0 ? 'migrated' : 'completed',
      backup: backup.directory,
      ...partialReason === undefined ? {} : { reason: partialReason },
      ...written === undefined ? {} : { markerPath: written },
      removed: migrated.removed,
      ...removedSettings === 0 ? {} : { removedSettings },
    }
  } catch (error) {
    let rollbackText: string
    try {
      const rollback = await rollbackProfileBackup(backup)
      const actions: string[] = []
      if (rollback.restored.length > 0) actions.push(`restored ${String(rollback.restored.length)} file(s)`)
      if (rollback.removed.length > 0) actions.push(`removed ${String(rollback.removed.length)} file(s) created by this migration`)
      if (rollback.profileRemoved) actions.push('removed the profile created by this migration')
      rollbackText = rollback.failures.length === 0
        ? `Profile rollback: ${actions.length > 0 ? actions.join(', ') : 'no profile files needed changing'}.`
        : `Profile rollback is incomplete: ${rollback.failures.join('; ')}.`
    } catch (rollbackError) {
      rollbackText = `Profile rollback failed: ${errorMessage(rollbackError)}.`
    }
    throw new Error([
      errorMessage(error),
      `Migration backup: ${backup.directory}`,
      rollbackText,
      'Do not run build.cmd until the reported problem is fixed.',
    ].join('\n'), { cause: error })
  }
}

function usage(): string {
  return [
    'Usage: tsx scripts/migrate-legacy-cc-pool-profile.ts [options]',
    '',
    'One-time migration for a web profile that still declares llm-pi-ai providers.cc-pool.',
    'It backs the profile and settings.yaml up first, removes the legacy declaration,',
    'ensures the dedicated @deepseek-ai/dsh-llm-cc-pool bundle/link, seeds the portable',
    'profile, and writes .dsh-profile-migrations.json. A marked, clean profile is a no-op;',
    'a clean profile without the marker is completed without reintroducing the route.',
    'settings.yaml is cleaned even when no web profile exists yet, without writing a',
    'profile marker because there is no profile to complete.',
    '',
    'Options:',
    `  --host <address>      Host address to guard; default ${DEFAULT_HOST_ADDRESS}`,
    `  --port <port>         Host port to guard; default ${String(DEFAULT_HOST_PORT)}`,
    '  --dsh-home <path>     Harness home instead of DSH_HOME or the launcher default',
    '  --allow-running-host  Continue while the guarded endpoint listens (unsafe; warns loudly)',
    '  --help                Show this help',
    '',
    'A Host on a non-default endpoint (another --host/--port, or a profile that',
    'overrides the bound address) must be named here: the guard probes one endpoint',
    'and cannot discover another. When the endpoint cannot be verified the run',
    'fails instead of assuming no Host is running.',
    '',
    'The launcher default home is <checkout parent>/deepseek-harness-data on Windows',
    'and ~/.dsh elsewhere; a leading ~ in DSH_HOME or --dsh-home is expanded.',
    '',
    'Preconditions: run the ordinary root build (`pnpm run build`) once before this',
    'script, because staging the dedicated plugin needs its lib/ output. Run build.cmd',
    'after a successful migration. Delete this script after every maintained profile',
    'carries the migration marker.',
    '',
  ].join('\n')
}

/** Parse only the options this script owns. */
export function parseArguments(argv: readonly string[]): MigrateLegacyProfileOptions | undefined {
  let dshHome: string | undefined
  let allowRunningHost = false
  let host = DEFAULT_HOST_ADDRESS
  let port = DEFAULT_HOST_PORT
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue
    if (argument === '--help' || argument === '-h') return undefined
    if (argument === '--allow-running-host') allowRunningHost = true
    else if (argument === '--host') {
      host = parseHostOption(argv[index + 1])
      index += 1
    } else if (argument.startsWith('--host=')) host = parseHostOption(argument.slice('--host='.length))
    else if (argument === '--port') {
      port = parsePortOption(argv[index + 1])
      index += 1
    } else if (argument.startsWith('--port=')) port = parsePortOption(argument.slice('--port='.length))
    else if (argument === '--dsh-home') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) fail('--dsh-home requires a path')
      dshHome = value
      index += 1
    } else if (argument.startsWith('--dsh-home=')) dshHome = argument.slice('--dsh-home='.length)
    else fail(`unknown argument ${JSON.stringify(argument)}; pass --help to see supported options`)
  }
  return {
    ...dshHome === undefined ? {} : { dshHome },
    allowRunningHost,
    host,
    port,
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = parseArguments(process.argv.slice(2))
  if (options === undefined) {
    process.stdout.write(usage())
  } else {
    migrateLegacyProfile(options).then((outcome) => {
      if (outcome.status === 'skipped') {
        log(`skipped: ${outcome.reason}; nothing changed`)
        return
      }
      if (outcome.status === 'completed') {
        log('no legacy declaration remained; verified the dedicated bundle, seeded the profile, and wrote the marker')
      } else {
        log(`migration complete (${String(outcome.removed ?? 0)} profile declaration(s), `
          + `${String(outcome.removedSettings ?? 0)} settings declaration(s) removed)`)
      }
      if (outcome.reason !== undefined) log(outcome.reason)
      log(`backup: ${outcome.backup}`)
      if (outcome.markerPath === undefined) return
      log(`marker: ${outcome.markerPath}`)
      log('run build.cmd now to build and install the current profile format')
    }).catch((error: unknown) => {
      process.stderr.write(`[migrate-cc-pool] error: ${errorMessage(error)}\n`)
      process.exitCode = 1
    })
  }
}

/** Exported plugin definition type used by the default install step. */
export type { PluginDefinition }
