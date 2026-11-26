/** Reject new assertions to unknown while retiring the recorded existing assertions. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  countInventory,
  listInventorySources,
  readInventoryBaseline,
  syntaxFingerprint,
  type InventoryBaseline,
  type InventoryGate,
} from './baseline-inventory.ts'

const root = resolve(import.meta.dirname, '..')

/**
 * Allowances inherited from before a fork merge. They stay out of the official
 * inventory so an upstream merge never edits upstream's recorded file.
 */
const importedBaselinePath = 'scripts/no-unknown-casts.imported-baseline.json'

/** Existing assertion counts, keyed by repository path and syntax fingerprint. */
export type UnknownCastBaseline = InventoryBaseline

/** One direct assertion to unknown in authored source. */
export interface UnknownCast {
  /** Repository-relative path with forward slashes. */
  file: string
  /** One-based source line. */
  line: number
  /** SHA-256 of the assertion's syntax tokens, excluding comments and whitespace. */
  fingerprint: string
}

function assertsUnknown(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type)) return assertsUnknown(type.type)
  return type.kind === ts.SyntaxKind.UnknownKeyword
    || (ts.isUnionTypeNode(type) && type.types.some(assertsUnknown))
}

/**
 * Find assertions to unknown, including angle syntax and unknown members of asserted unions.
 * @param file - repository-relative source path; its extension selects TS or TSX parsing.
 * @param text - source contents.
 * @returns assertions in AST traversal order; comments, strings, aliases and unknown containers do not match.
 */
export function findUnknownCasts(file: string, text: string): UnknownCast[] {
  const normalized = file.replaceAll('\\', '/')
  const source = ts.createSourceFile(normalized, text, ts.ScriptTarget.Latest, true)
  const casts: UnknownCast[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (assertsUnknown(node.type)) {
        casts.push({
          file: normalized,
          line: source.getLineAndCharacterOfPosition(node.type.getStart(source)).line + 1,
          fingerprint: syntaxFingerprint(node, source),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return casts
}

/**
 * Scan tracked source and non-ignored new source, including tests and configuration files.
 * @param repoRoot - repository root containing the Git index.
 * @returns every direct unknown assertion in the current working tree.
 * @throws if discovery omits a required source area or an eligible path is a symlink.
 */
export function scanUnknownCasts(repoRoot: string): UnknownCast[] {
  return listInventorySources(repoRoot, 'verify-no-unknown-casts')
    .flatMap(file => findUnknownCasts(file, readFileSync(resolve(repoRoot, file), 'utf8')))
}

const gate: InventoryGate<UnknownCast> = {
  name: 'verify-no-unknown-casts',
  baselinePath: 'scripts/no-unknown-casts.baseline.json',
  scan: scanUnknownCasts,
  rejection: 'new assertions to unknown are forbidden. Use a typed value or narrow the input.',
  describe: cast => `${cast.file}:${String(cast.line)} (${cast.fingerprint})`,
  success: count => `verify-no-unknown-casts: no new assertions; ${String(count)} existing assertions remain.`,
}

const importedGate: InventoryGate<UnknownCast> = { ...gate, baselinePath: importedBaselinePath }

/** Where one allowance is recorded: the official inventory, and the fork's inherited file. */
interface AllowanceSplit {
  /** Count recorded in the official inventory. */
  official: number
  /** Count recorded in the inherited inventory. */
  inherited: number
}

/** Identity of one allowance across both inventories. */
function allowanceKey(file: string, fingerprint: string): string {
  return `${file}\u0000${fingerprint}`
}

/** The inherited inventory, or no allowance when the fork recorded none. */
function readInheritedBaseline(repoRoot: string): UnknownCastBaseline {
  return existsSync(resolve(repoRoot, importedBaselinePath))
    ? readInventoryBaseline(importedGate, repoRoot)
    : {}
}

/** Combine both inventories so one assertion may draw on either. */
function mergeAllowances(official: UnknownCastBaseline, inherited: UnknownCastBaseline): Map<string, AllowanceSplit> {
  const merged = new Map<string, AllowanceSplit>()
  for (const [file, counts] of Object.entries(official)) {
    for (const [fingerprint, count] of Object.entries(counts)) {
      merged.set(allowanceKey(file, fingerprint), { official: count, inherited: 0 })
    }
  }
  for (const [file, counts] of Object.entries(inherited)) {
    for (const [fingerprint, count] of Object.entries(counts)) {
      const key = allowanceKey(file, fingerprint)
      const split = merged.get(key)
      if (split === undefined) merged.set(key, { official: 0, inherited: count })
      else split.inherited += count
    }
  }
  return merged
}

/** Split observed counts back into each inventory's own recorded share. */
function splitObserved(
  observed: UnknownCastBaseline,
  merged: ReadonlyMap<string, AllowanceSplit>,
): { official: UnknownCastBaseline; inherited: UnknownCastBaseline } {
  const official: UnknownCastBaseline = {}
  const inherited: UnknownCastBaseline = {}
  for (const [file, counts] of Object.entries(observed)) {
    for (const [fingerprint, count] of Object.entries(counts)) {
      const split = merged.get(allowanceKey(file, fingerprint))
      const officialCount = Math.min(count, split?.official ?? 0)
      if (officialCount > 0) (official[file] ??= {})[fingerprint] = officialCount
      const inheritedCount = count - officialCount
      if (inheritedCount > 0) (inherited[file] ??= {})[fingerprint] = inheritedCount
    }
  }
  return { official, inherited }
}

/**
 * Count exact assertions without granting a file-wide allowance.
 * @param casts - observed assertions.
 * @returns path and fingerprint counts in stable order for comparison and pruning.
 */
export function countUnknownCasts(casts: readonly UnknownCast[]): UnknownCastBaseline {
  return countInventory(casts)
}

/**
 * Enforce the recorded assertion inventory, optionally deleting retired allowances.
 *
 * A finding may be allowed by either inventory; `--prune` writes each file's own
 * remaining share so a merge never has to edit the official file.
 *
 * @param repoRoot - repository root to scan.
 * @param prune - remove stale entries only after establishing that no new assertion exists.
 * @returns the number of existing assertions still present.
 * @throws for new assertions, malformed inventories, or stale entries without pruning.
 */
export function verifyNoUnknownCasts(repoRoot: string, prune = false): number {
  const official = readInventoryBaseline(gate, repoRoot)
  const merged = mergeAllowances(official, readInheritedBaseline(repoRoot))
  const remaining = new Map<string, number>([...merged].map(([key, split]) => [key, split.official + split.inherited] as const))
  const casts = scanUnknownCasts(repoRoot)
  const added: UnknownCast[] = []
  for (const cast of casts) {
    const key = allowanceKey(cast.file, cast.fingerprint)
    const allowance = remaining.get(key) ?? 0
    if (allowance > 0) remaining.set(key, allowance - 1)
    else added.push(cast)
  }
  if (added.length > 0) {
    throw new Error(`verify-no-unknown-casts: ${gate.rejection}\n`
      + added.map(cast => `  ${gate.describe(cast)}`).join('\n'))
  }
  const stale = [...remaining].filter(([, count]) => count > 0)
  if (stale.length > 0) {
    if (!prune) {
      throw new Error('verify-no-unknown-casts: remove retired baseline entries with '
        + 'pnpm run verify-no-unknown-casts --prune.\n'
        + stale.map(([key]) => {
          const [file, fingerprint] = key.split('\u0000')
          return `  ${file} (${fingerprint})`
        }).join('\n'))
    }
    const observed = countUnknownCasts(casts)
    const split = splitObserved(observed, merged)
    writeFileSync(resolve(repoRoot, gate.baselinePath), `${JSON.stringify(split.official, null, 2)}\n`)
    if (existsSync(resolve(repoRoot, importedBaselinePath))) {
      writeFileSync(resolve(repoRoot, importedBaselinePath), `${JSON.stringify(split.inherited, null, 2)}\n`)
    }
  }
  return casts.length
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1 || (args.length === 1 && args[0] !== '--prune')) {
      throw new Error(`Usage: pnpm run ${gate.name} [--prune]`)
    }
    console.log(gate.success(verifyNoUnknownCasts(root, args[0] === '--prune')))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
