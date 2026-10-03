#!/usr/bin/env node
/**
 * Offline strong-retainer chains for selected objects in a V8 `.heapsnapshot`.
 *
 * The parser streams the file into typed arrays, so snapshot size is limited by
 * process memory rather than V8's maximum string length. Reachability starts at
 * the synthetic root, never follows `weak` edges, and admits a WeakMap value
 * only after both its key and its table are reachable. Each reported chain is a
 * shortest path under those rules; a target outside every chain is collectable.
 */
import { createReadStream } from 'node:fs'
import { pathToFileURL } from 'node:url'

const EPHEMERON = / \/ part of key \(.* @(\d+)\) -> value \(.* @(\d+)\) pair in WeakMap \(table @(\d+)\)$/u
const NONE = 0xffffffff

/**
 * Parse a snapshot into typed node and edge arrays, closure locations, and its string table.
 * @param {string} file - Path to a `.heapsnapshot` written by V8 or Chrome DevTools.
 * @returns {Promise<{meta: object, nodes: Uint32Array, edges: Uint32Array, locations: number[], strings: string[]}>} Parsed snapshot.
 */
export async function readHeapSnapshot(file) {
  let header = ''
  let meta
  let nodes
  let edges
  const locations = []
  const strings = []
  let section = 'header'
  let target
  let fill = 0
  let number = -1
  let depth = 0
  let stringBytes = null
  let stringParts = []
  let escaped = false
  let pending = ''
  const decoder = new TextDecoder()

  const startSection = (key) => {
    section = key
    fill = 0
    number = -1
    depth = 1
    if (key === 'nodes') target = nodes
    else if (key === 'edges') target = edges
    else if (key === 'locations') target = locations
    else target = undefined
  }
  const finishString = (chunk, end) => {
    stringParts.push(chunk.subarray(stringBytes, end))
    const raw = stringParts.length === 1 ? stringParts[0] : Buffer.concat(stringParts)
    strings.push(JSON.parse(`"${decoder.decode(raw)}"`))
    stringParts = []
    stringBytes = null
  }

  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) {
    let index = 0
    if (section === 'header' || section === 'between') {
      pending += chunk.toString('latin1')
      const match = (section === 'header' ? /"(nodes)":\s*\[/u : /"(\w+)":\s*\[/u).exec(pending)
      if (match === null) continue
      if (section === 'header') {
        header = pending.slice(0, match.index).replace(/[\s,]+$/u, '')
        const parsed = JSON.parse(`${header}}`)
        meta = parsed.snapshot
        nodes = new Uint32Array(meta.node_count * meta.meta.node_fields.length)
        edges = new Uint32Array(meta.edge_count * meta.meta.edge_fields.length)
      }
      const consumed = Buffer.byteLength(pending.slice(0, match.index + match[0].length), 'latin1')
      index = chunk.length - (Buffer.byteLength(pending, 'latin1') - consumed)
      pending = ''
      startSection(match[1])
    }
    for (; index < chunk.length; index++) {
      const byte = chunk[index]
      if (section === 'strings') {
        if (stringBytes !== null) {
          if (escaped) escaped = false
          else if (byte === 0x5c) escaped = true
          else if (byte === 0x22) finishString(chunk, index)
          continue
        }
        if (byte === 0x22) { stringBytes = index + 1; continue }
        if (byte === 0x5d) { section = 'done'; break }
        continue
      }
      if (section === 'between' || section === 'done') {
        if (section === 'done') break
        pending += String.fromCharCode(byte)
        const match = /"(\w+)":\s*\[$/u.exec(pending)
        if (match !== null) { pending = ''; startSection(match[1]) }
        continue
      }
      if (byte >= 0x30 && byte <= 0x39) {
        number = number < 0 ? byte - 0x30 : number * 10 + (byte - 0x30)
        continue
      }
      if (number >= 0) {
        if (target !== undefined) target[fill++] = number
        number = -1
      }
      if (byte === 0x5b) depth++
      else if (byte === 0x5d && --depth === 0) section = 'between'
    }
    if (section === 'strings' && stringBytes !== null) {
      stringParts.push(chunk.subarray(stringBytes))
      stringBytes = 0
    }
  }
  if (meta === undefined || section !== 'done') throw new Error(`${file} is not a complete heap snapshot`)
  return { meta, nodes, edges, locations, strings }
}

/**
 * Find shortest strong retainer chains for selected objects.
 * @param {{meta: object, nodes: Uint32Array, edges: Uint32Array, strings: string[]}} snapshot - Parsed snapshot.
 * @param {object} selection - Target selection and report bounds.
 * @param {string[]} [selection.classNames] - Object constructor names to select.
 * @param {number[]} [selection.ids] - Exact snapshot node ids to select.
 * @param {number} [selection.maxGroups] - Maximum distinct chains to return.
 * @returns {object} Reachability totals and chains grouped by their normalized hops.
 */
export function findRetainers(snapshot, selection) {
  const { meta, nodes, edges, strings } = snapshot
  const nodeFields = meta.meta.node_fields
  const edgeFields = meta.meta.edge_fields
  const nodeTypes = meta.meta.node_types[0]
  const edgeTypes = meta.meta.edge_types[0]
  const NF = nodeFields.length
  const EF = edgeFields.length
  const N = nodes.length / NF
  const typeOf = nodeFields.indexOf('type')
  const nameOf = nodeFields.indexOf('name')
  const idOf = nodeFields.indexOf('id')
  const countOf = nodeFields.indexOf('edge_count')
  const weakType = edgeTypes.indexOf('weak')
  const namedTypes = new Set(['context', 'property', 'internal', 'shortcut'].map(type => edgeTypes.indexOf(type)))

  const firstEdge = new Uint32Array(N + 1)
  for (let node = 0, offset = 0; node < N; node++) {
    firstEdge[node] = offset
    offset += nodes[node * NF + countOf] * EF
    firstEdge[node + 1] = offset
  }
  const indexById = new Map()
  const wanted = new Set(selection.ids ?? [])
  const classes = new Set(selection.classNames ?? [])
  const objectType = nodeTypes.indexOf('object')
  const targets = []
  for (let node = 0; node < N; node++) {
    const id = nodes[node * NF + idOf]
    indexById.set(id, node)
    if (wanted.has(id) || (nodes[node * NF + typeOf] === objectType && classes.has(strings[nodes[node * NF + nameOf]]))) {
      targets.push(node)
    }
  }

  const ephemeronByName = new Map()
  const ephemeronOf = (nameIndex) => {
    let parsed = ephemeronByName.get(nameIndex)
    if (parsed === undefined) {
      const match = EPHEMERON.exec(strings[nameIndex])
      parsed = match === null ? null : { key: Number(match[1]), value: Number(match[2]), table: Number(match[3]) }
      ephemeronByName.set(nameIndex, parsed)
    }
    return parsed
  }
  const parent = new Uint32Array(N).fill(NONE)
  const parentEdge = new Uint32Array(N).fill(NONE)
  const queue = new Uint32Array(N)
  let head = 0
  let tail = 0
  parent[0] = 0
  queue[tail++] = 0
  const deferred = []
  const reach = (from, edge, to) => {
    if (parent[to] !== NONE) return
    parent[to] = from
    parentEdge[to] = edge
    queue[tail++] = to
  }
  for (;;) {
    while (head < tail) {
      const from = queue[head++]
      for (let edge = firstEdge[from]; edge < firstEdge[from + 1]; edge += EF) {
        const type = edges[edge]
        if (type === weakType) continue
        const to = edges[edge + 2] / NF
        if (parent[to] !== NONE) continue
        const ephemeron = namedTypes.has(type) ? ephemeronOf(edges[edge + 1]) : null
        if (ephemeron !== null) {
          deferred.push({ from, edge, to, ephemeron })
          continue
        }
        reach(from, edge, to)
      }
    }
    let progressed = false
    for (let index = deferred.length - 1; index >= 0; index--) {
      const item = deferred[index]
      const key = indexById.get(item.ephemeron.key)
      const table = indexById.get(item.ephemeron.table)
      if (parent[item.to] !== NONE) {
        deferred.splice(index, 1)
      } else if (key !== undefined && table !== undefined && parent[key] !== NONE && parent[table] !== NONE) {
        deferred.splice(index, 1)
        reach(item.from, item.edge, item.to)
        progressed = true
      }
    }
    if (!progressed) break
  }

  const locationFields = meta.meta.location_fields ?? []
  const LF = locationFields.length
  const locationOf = new Map()
  for (let index = 0; LF > 0 && index < (snapshot.locations?.length ?? 0); index += LF) {
    const row = snapshot.locations
    locationOf.set(row[index + locationFields.indexOf('object_index')] / NF, row[index + locationFields.indexOf('line')] + 1)
  }
  const edgeTarget = (node, name) => {
    for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge += EF) {
      if (namedTypes.has(edges[edge]) && strings[edges[edge + 1]] === name) return edges[edge + 2] / NF
    }
    return undefined
  }
  const closureType = nodeTypes.indexOf('closure')
  const closureLabel = (node) => {
    const name = strings[nodes[node * NF + nameOf]] || '(anonymous)'
    const shared = edgeTarget(node, 'shared')
    const script = shared === undefined ? undefined : edgeTarget(shared, 'script')
    const source = script === undefined ? undefined : edgeTarget(script, 'name')
    const file = source === undefined ? '' : strings[nodes[source * NF + nameOf]].replace(/^.*[\\/](?=[^\\/]+[\\/][^\\/]+$)/u, '')
    const line = locationOf.get(node)
    return `${name}${file === '' ? '' : ` @ ${file}${line === undefined ? '' : `:${line}`}`}`
  }
  const label = node => {
    const type = nodeTypes[nodes[node * NF + typeOf]]
    const name = strings[nodes[node * NF + nameOf]]
    if (type === 'closure') return `fn ${closureLabel(node)}`
    const short = `${type === 'object' ? '' : `(${type}) `}${name.length > 80 ? `${name.slice(0, 77)}...` : name}`
    if (type === 'object' && name === 'AsyncContextFrame') {
      const table = edgeTarget(node, 'table')
      if (table === undefined) return short
      const stores = []
      for (let edge = firstEdge[table]; edge < firstEdge[table + 1] && stores.length < 12; edge += EF) {
        if (edges[edge] === weakType) continue
        const to = edges[edge + 2] / NF
        stores.push(strings[nodes[to * NF + nameOf]].slice(0, 40) || nodeTypes[nodes[to * NF + typeOf]])
      }
      return `${short} {${stores.join(', ')}}`
    }
    if (type === 'object' && name === 'Timeout') {
      const callback = edgeTarget(node, '_onTimeout')
      const duration = edgeTarget(node, '_idleTimeout')
      const ms = duration === undefined ? '' : ` ${strings[nodes[duration * NF + nameOf]]}ms`
      if (callback !== undefined && nodes[callback * NF + typeOf] === closureType) return `${short}${ms} [${closureLabel(callback)}]`
      return `${short}${ms}`
    }
    return short
  }
  const edgeLabel = (edge) => {
    const type = edges[edge]
    const name = namedTypes.has(type) ? strings[edges[edge + 1]] : `[${edges[edge + 1]}]`
    return { type: edgeTypes[type], name: name.length > 120 ? `${name.slice(0, 117)}...` : name }
  }
  const groups = new Map()
  let unreachable = 0
  for (const target of targets) {
    if (parent[target] === NONE) { unreachable++; continue }
    const hops = []
    for (let node = target; node !== 0; node = parent[node]) {
      hops.push({ from: label(parent[node]), edge: edgeLabel(parentEdge[node]), to: label(node) })
    }
    hops.reverse()
    const key = hops.map(hop => `${hop.from}|${hop.edge.type}|${/^\[\d+\]$/u.test(hop.edge.name) ? '[]' : hop.edge.name}`).join('>')
    const group = groups.get(key)
    const id = nodes[target * NF + idOf]
    if (group === undefined) groups.set(key, { count: 1, ids: [id], target: label(target), hops })
    else {
      group.count++
      if (group.ids.length < 8) group.ids.push(id)
    }
  }
  const ordered = [...groups.values()].sort((left, right) => right.count - left.count)
  return {
    nodeCount: N,
    edgeCount: edges.length / EF,
    targets: targets.length,
    retained: targets.length - unreachable,
    unreachable,
    groups: ordered.slice(0, selection.maxGroups ?? 20),
    omittedGroups: Math.max(0, ordered.length - (selection.maxGroups ?? 20)),
  }
}

/**
 * Render a retainer report as plain text, one chain per group.
 * @param {ReturnType<typeof findRetainers>} report - Report from findRetainers.
 * @returns {string} Human-readable chains.
 */
export function formatRetainers(report) {
  const lines = [
    `targets=${report.targets} retained=${report.retained} collectable=${report.unreachable} nodes=${report.nodeCount} edges=${report.edgeCount}`,
  ]
  for (const [index, group] of report.groups.entries()) {
    lines.push('', `#${index + 1} ${group.count} x ${group.target} (ids ${group.ids.join(', ')})`)
    for (const hop of group.hops) lines.push(`  ${hop.from} --${hop.edge.type}:${hop.edge.name}--> ${hop.to}`)
  }
  if (report.omittedGroups > 0) lines.push('', `${report.omittedGroups} more chain group(s) omitted`)
  return `${lines.join('\n')}\n`
}

const usage = 'usage: node retainers.mjs <file.heapsnapshot> [--class Name]... [--id N]... [--max-groups N] [--json]'

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const selection = { classNames: [], ids: [], maxGroups: 20 }
  let file
  let json = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--class') selection.classNames.push(args[++index])
    else if (arg === '--id') selection.ids.push(Number(args[++index]))
    else if (arg === '--max-groups') selection.maxGroups = Number(args[++index])
    else if (arg === '--json') json = true
    else if (file === undefined && !arg.startsWith('--')) file = arg
    else throw new Error(`${usage}\nunknown argument: ${arg}`)
  }
  if (file === undefined || (selection.classNames.length === 0 && selection.ids.length === 0)) throw new Error(usage)
  const report = findRetainers(await readHeapSnapshot(file), selection)
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatRetainers(report))
}
