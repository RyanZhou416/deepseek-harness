/** Typecheck current source under each dependency's compiler policy without writing checkout artifacts. */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const plugin = path.resolve(import.meta.dirname, '..')
const checkout = path.resolve(plugin, '../..')
const artifacts = path.join(plugin, '.artifacts/typecheck')
const relocated = new Map()
let diagnostics = 0
const formatHost = { getCanonicalFileName: value => value, getCurrentDirectory: () => plugin, getNewLine: () => '\n' }
const report = diagnostic => {
  diagnostics++
  console.error(ts.formatDiagnosticsWithColorAndContext([diagnostic], formatHost))
}

function readConfig(file) {
  const loaded = ts.readConfigFile(file, ts.sys.readFile)
  if (loaded.error) throw new Error(ts.formatDiagnostics([loaded.error], formatHost))
  return loaded.config
}

function relocate(original) {
  original = path.resolve(original)
  if (!original.endsWith('.json')) original = path.join(original, 'tsconfig.json')
  const known = relocated.get(original)
  if (known !== undefined) return known
  const relative = path.relative(checkout, original)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Reference leaves checkout: ${original}`)
  const target = path.join(artifacts, 'projects', relative)
  relocated.set(original, target)
  const loaded = readConfig(original)
  const references = (loaded.references ?? []).map(reference => ({ path: relocate(path.resolve(path.dirname(original), reference.path)) }))
  const output = path.join(artifacts, 'declarations', relative.slice(0, -5))
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify({
    extends: original,
    compilerOptions: { outDir: output, tsBuildInfoFile: `${output}.tsbuildinfo`, emitDeclarationOnly: true, declaration: true, declarationMap: false, sourceMap: false },
    references,
  }, null, 2) + '\n')
  return target
}

const roots = [
  'vendor/cordis', 'vendor/schemastery', 'vendor/loader', 'vendor/include',
  'packages/core/tools', 'packages/llm/llm', 'packages/util/values', 'packages/util/timeout',
  'packages/subprocess/subprocess', 'packages/subprocess/subprocess-local',
  'packages/sandbox/sandbox', 'packages/sandbox/sandbox-policy', 'packages/sandbox/sandbox-windows-acl', 'packages/sandbox/sandbox-local',
  'packages/core/session', 'packages/session/session-projection', 'packages/core/system-prompt', 'packages/shell/shell-env',
  'packages/core/agent', 'packages/jobs/jobs', 'packages/jobs/jobs-local', 'packages/jobs/tool-jobs',
  'packages/test-support/agent-loop-testkit', 'packages/util/brand',
]
const references = roots.map(item => ({ path: relocate(path.join(checkout, item)) }))
const basePaths = readConfig(path.join(checkout, 'tsconfig.base.json')).compilerOptions.paths
const target = path.join(artifacts, 'plugin.json')
mkdirSync(artifacts, { recursive: true })
writeFileSync(target, JSON.stringify({
  extends: path.join(plugin, 'tsconfig.json'),
  compilerOptions: {
    composite: true, incremental: true, noEmit: false, declaration: true, declarationMap: false, sourceMap: false,
    emitDeclarationOnly: true, rootDir: plugin, outDir: path.join(artifacts, 'declarations/plugin'),
    tsBuildInfoFile: path.join(artifacts, 'plugin.tsbuildinfo'),
    paths: Object.fromEntries(Object.entries(basePaths).map(([name, values]) => [name, values.map(value => path.resolve(checkout, value))])),
  },
  references,
}, null, 2) + '\n')
const host = ts.createSolutionBuilderHost(ts.sys, undefined, report)
const write = host.writeFile
host.writeFile = (file, ...args) => {
  const relative = path.relative(artifacts, path.resolve(file))
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Typecheck output leaves private directory: ${file}`)
  write(file, ...args)
}
const status = ts.createSolutionBuilder(host, [target], {}).build()
console.log(`Isolated source typecheck: ${relocated.size} dependency projects, ${diagnostics} diagnostics, status ${status}.`)
process.exitCode = status
