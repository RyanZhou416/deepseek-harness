/**
 * Shared synthetic workload for Web stress scenarios, calibrated against
 * read-only aggregate counts of a heavy multi-agent deployment: roots that fan
 * out continuable children, short mixed-tool child turns (read, shell, grep,
 * glob, write, todo), streamed reasoning plus text, occasional retryable
 * provider failures, compaction under long history, and optional nesting.
 * Only model output is synthetic; tools, persistence and delivery are real.
 *
 * Knobs (environment), all optional:
 * - DSH_STRESS_SEED: PRNG seed (default 1).
 * - DSH_STRESS_CHILDREN: children each root turn spawns (default 3).
 * - DSH_STRESS_NESTED: `1` lets first-level children spawn one grandchild.
 * - DSH_STRESS_STEPS: maximum tool steps per child turn (default 6); roots use twice that.
 * - DSH_STRESS_STREAM_KIB: median streamed bytes per reply in KiB (default 4).
 * - DSH_STRESS_PACE_MS: delay between 64-byte stream chunks (default 4).
 * - DSH_STRESS_MARKDOWN: `0` streams plain repeated prose instead of Markdown
 *   with inline marks, lists, fenced code, tables and headings.
 * - DSH_STRESS_RETRY_PERCENT: chance a model call fails retryably first (default 2).
 * - DSH_STRESS_CONTEXT_K: advertised context window in thousands of tokens (default 200).
 * - DSH_STRESS_EXTRA_TOOLS: comma list of `edit` (exact one-line edits),
 *   `jobs` (background shell jobs that later steps read with job_output or kill
 *   with job_kill; long ones may outlive their Agent), and root-turn delegation
 *   paths taken at most once per turn: `message` (send_message to a child of an
 *   earlier round, which cold-resumes an evicted child), `session`
 *   (session_send_message to another root in `sessionTargets`, which resumes an
 *   evicted root), and `workflow` (a workflow run that starts two children).
 * - DSH_STRESS_FORK_PLUGINS: `1` for all fork bundles, or a comma list of
 *   dsh-context, dsh-agent-teams, dsh-plugin-subscriptions.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  LlmAdapter, LlmError, ToolCallId, createAssistantMessage, createSystemMessage, createToolResultMessage,
  createUserMessage, type GenerateOptions, type LlmResolvedModelInfo, type RequestMessage, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { REPO_ROOT } from '../tests/support.ts'

/**
 * Read a positive integer knob.
 * @param name - environment variable name.
 * @param fallback - value used when the variable is unset.
 * @returns the validated value.
 */
export function positive(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

export const PROVIDER = 'stress-workload'
export const ROOT_MODEL = 'stress-root'
export const CHILD_MODEL = 'stress-child'
export const ROUND_MARK = 'STRESS_ROUND'
/** Extra tool families enabled by `DSH_STRESS_EXTRA_TOOLS`. */
export const EXTRA_TOOLS: ReadonlySet<string> = new Set((process.env.DSH_STRESS_EXTRA_TOOLS ?? '').split(',').filter(name => name.length > 0))
/** Run time of a background job that outlives its turn; its owner cannot unload before it ends or is killed. */
export const LONG_JOB_SECONDS = 120
const CHILD_MARK = 'STRESS_CHILD'
const GRANDCHILD_MARK = 'STRESS_GRANDCHILD'

const ALL_FORK_PLUGINS = ['dsh-context', 'dsh-agent-teams', 'dsh-plugin-subscriptions']

/** Fork bundle names selected by DSH_STRESS_FORK_PLUGINS, validated against the known set. */
export const FORK_PLUGINS: readonly string[] = (() => {
  const raw = process.env.DSH_STRESS_FORK_PLUGINS ?? ''
  const names = raw === '1' ? ALL_FORK_PLUGINS : raw.split(',').filter(name => name.length > 0)
  for (const name of names) {
    if (!ALL_FORK_PLUGINS.includes(name)) throw new Error(`DSH_STRESS_FORK_PLUGINS has unknown plugin ${name}`)
  }
  return names
})()

/**
 * Profile packages for the selected fork bundles, for `launchWebScaffold({ profile })`.
 * @returns the scaffold profile option, or `undefined` for the shipped composition.
 */
export function forkProfile(): { hmr: false; packages: { dir: string; enabled: true }[] } | undefined {
  if (FORK_PLUGINS.length === 0) return undefined
  return { hmr: false, packages: FORK_PLUGINS.map(name => ({ dir: join(REPO_ROOT, 'fork-plugins', name), enabled: true })) }
}

/**
 * Write the overlay that mirrors the heavy deployment's composition choices:
 * children route to a separate model through `subagent.modelOverride`, and the
 * dsh-context bounds match the deployment when that bundle is mounted.
 * @param dir - test-owned directory for the overlay file.
 * @param idleSessionRetentionMs - Session controller idle eviction delay.
 * @returns the overlay path.
 */
export async function writeWorkloadOverlay(dir: string, idleSessionRetentionMs: number): Promise<string> {
  const lines = [
    '- id: session-controller',
    '  config:',
    `    idleSessionRetentionMs: ${String(idleSessionRetentionMs)}`,
    '- id: subagent',
    '  config:',
    '    modelOverride:',
    `      provider: ${PROVIDER}`,
    `      model: ${CHILD_MODEL}`,
  ]
  if (FORK_PLUGINS.includes('dsh-context')) {
    lines.push(
      '- id: dsh-context',
      '  config:',
      '    maxRequestSteps: 300',
      '    maxKeptTurns: 60',
      '    maxEvents: 100',
      '    maxNodes: 400',
      '    maxArchiveNodes: 100',
      '    maxFileOps: 100',
    )
  }
  const path = join(dir, 'workload.patch.yml')
  await writeFile(path, `${lines.join('\n')}\n`)
  return path
}

const WORKSPACE_FILES = 40

/**
 * Populate a workspace with source-like files so read, grep and glob return
 * outputs in the observed size range (median about 1 KiB, tail tens of KiB).
 * @param cwd - the scaffold's temp workspace.
 */
export async function seedWorkspace(cwd: string): Promise<void> {
  const random = mulberry32(positive('DSH_STRESS_SEED', 1))
  await mkdir(join(cwd, 'src'), { recursive: true })
  await mkdir(join(cwd, 'notes'), { recursive: true })
  for (let index = 0; index < WORKSPACE_FILES; index++) {
    const lines = Math.round(20 + 600 * random() ** 3)
    const body = Array.from({ length: lines }, (_, line) =>
      `export const value_${String(index)}_${String(line)} = compute('${'k'.repeat(line % 40)}', ${String(line)}) // stress marker`)
    await writeFile(join(cwd, 'src', `module-${String(index).padStart(2, '0')}.ts`), `${body.join('\n')}\n`)
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function textOf(message: RequestMessage): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

interface PlannedCall { name: string; arguments: object }

/** Per-run counters the scenarios report beside their own measurements. */
export interface WorkloadCounters {
  calls: number
  failures: number
  summaries: number
  toolCalls: Record<string, number>
  /** Failed tool results seen in later requests, keyed by their leading text. */
  toolErrors: Record<string, number>
  streamedBytes: number
  /** Largest estimated request size, in tokens at four characters each. */
  maxInputTokens: number
}

/**
 * Deterministic model whose behavior depends only on the request: the marker
 * of the latest human or delegated prompt, the replies after it, and the model
 * route chosen by `subagent.modelOverride`.
 */
export class WorkloadAdapter extends LlmAdapter {
  readonly counters: WorkloadCounters = {
    calls: 0, failures: 0, summaries: 0, toolCalls: {}, toolErrors: {}, streamedBytes: 0, maxInputTokens: 0,
  }
  private readonly random = mulberry32(positive('DSH_STRESS_SEED', 1))
  private readonly children = positive('DSH_STRESS_CHILDREN', 3)
  private readonly nested = process.env.DSH_STRESS_NESTED === '1'
  private readonly maxSteps = Math.max(1, positive('DSH_STRESS_STEPS', 6))
  private readonly streamBytes = Math.max(1, positive('DSH_STRESS_STREAM_KIB', 4)) * 1024
  private readonly paceMs = positive('DSH_STRESS_PACE_MS', 4)
  private readonly markdownOutput = process.env.DSH_STRESS_MARKDOWN !== '0'
  private readonly retryPercent = positive('DSH_STRESS_RETRY_PERCENT', 2)
  private readonly contextWindow = Math.max(8, positive('DSH_STRESS_CONTEXT_K', 200)) * 1000
  private readonly extraTools = EXTRA_TOOLS
  private nextCall = 0
  private readonly shell = process.platform === 'win32' ? 'pwsh' : 'bash'
  /** Root Session ids the `session` extra may message; the scenario fills it after creating roots. */
  sessionTargets: readonly string[] = []

  /** @param workspace - absolute workspace root that `seedWorkspace` populated. */
  constructor(private readonly workspace: string) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.contextWindow } })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.counters.calls++
    const signal = options.signal
    const inputTokens = Math.ceil(options.messages.reduce((sum, message) => sum + JSON.stringify(message.content).length, 0) / 4)
    this.counters.maxInputTokens = Math.max(this.counters.maxInputTokens, inputTokens)
    if (this.random() * 100 < this.retryPercent) {
      this.counters.failures++
      await delay(5 + this.random() * 50, undefined, { signal })
      throw new LlmError('synthetic upstream overload', 'SERVER', { status: 503 })
    }
    const tools = new Set((options.tools ?? []).map(tool => tool.name))
    const messages = options.messages
    const last = messages.at(-1)
    // Compaction reuses the conversation prefix and appends its checkpoint instruction.
    if (tools.size === 0 || (last?.role === 'user' && textOf(last).includes('Output only the checkpoint text'))) {
      this.counters.summaries++
      yield* this.reply(2048, inputTokens, signal)
      return
    }
    for (const message of messages.slice(messages.findLastIndex(message => message.role === 'assistant') + 1)) {
      if (message.role !== 'tool' || message.isError !== true) continue
      const reason = textOf(message).slice(0, 80)
      this.counters.toolErrors[reason] = (this.counters.toolErrors[reason] ?? 0) + 1
    }
    const mark = this.markOf(messages, options.model)
    const inputIndex = messages.findLastIndex(message => message.role === 'user' && textOf(message).includes(mark))
    const replies = inputIndex < 0 ? Number.POSITIVE_INFINITY : messages.slice(inputIndex + 1).filter(message => message.role === 'assistant').length
    const steps = mark === ROUND_MARK ? this.maxSteps * 2 : this.maxSteps
    const calls = replies < steps ? this.plan(mark, replies, tools, messages, inputIndex < 0 ? [] : messages.slice(inputIndex + 1)) : []
    if (calls.length === 0) {
      yield* this.reply(this.sampleBytes(), inputTokens, signal)
      return
    }
    yield* this.toolCalls(calls, inputTokens, signal)
  }

  private markOf(messages: readonly RequestMessage[], model: string): string {
    if (model !== CHILD_MODEL) return ROUND_MARK
    const texts = messages.filter(message => message.role === 'user').map(textOf)
    return texts.some(text => text.includes(GRANDCHILD_MARK)) ? GRANDCHILD_MARK : CHILD_MARK
  }

  private plan(
    mark: string, step: number, tools: ReadonlySet<string>, messages: readonly RequestMessage[], since: readonly RequestMessage[],
  ): PlannedCall[] {
    const calls: PlannedCall[] = []
    const job = this.extraTools.has('jobs') ? this.jobFollowUp(since, tools) : undefined
    if (job !== undefined) return [job]
    const delegation = mark === ROUND_MARK && step > 0 ? this.delegation(tools, messages, since) : undefined
    if (delegation !== undefined) return [delegation]
    if (step === 0 && tools.has('subagent')) {
      const spawn = mark === ROUND_MARK ? this.children : mark === CHILD_MARK && this.nested ? 1 : 0
      const childMark = mark === ROUND_MARK ? CHILD_MARK : GRANDCHILD_MARK
      for (let index = 0; index < spawn; index++) {
        calls.push({ name: 'subagent', arguments: {
          description: `Stress ${childMark.toLowerCase()} ${String(index)}`,
          prompt: `${childMark} inspect the workspace modules and report findings.`,
        } })
      }
    }
    // Most steps issue one call, about a tenth two or more.
    const count = this.random() < 0.88 ? 1 : 2 + Math.floor(this.random() * 3)
    for (let index = 0; index < count; index++) {
      const call = this.tool(tools, since)
      if (call !== undefined) calls.push(call)
    }
    return calls
  }

  /** Module indexes this turn already read; `edit` requires a prior read of its target. */
  private readModules(since: readonly RequestMessage[]): number[] {
    return [...new Set(since.flatMap(message => message.role === 'assistant'
      ? message.content.flatMap((block) => {
        if (block.type !== 'tool-call' || block.name !== 'read') return []
        const match = /module-(\d+)\.ts/u.exec(block.arguments)
        return match === null ? [] : [Number(match[1])]
      })
      : []))]
  }

  private tool(tools: ReadonlySet<string>, since: readonly RequestMessage[]): PlannedCall | undefined {
    const file = `src/module-${String(Math.floor(this.random() * WORKSPACE_FILES)).padStart(2, '0')}.ts`
    const roll = this.random()
    const candidates: [number, PlannedCall][] = [
      [0.42, { name: 'read', arguments: { file_path: join(this.workspace, file) } }],
      [0.28, { name: this.shell, arguments: {
        command: this.shell === 'pwsh' ? `Get-Content ${file} -TotalCount ${String(10 + Math.floor(this.random() * 200))}` : `head -n ${String(10 + Math.floor(this.random() * 200))} ${file}`,
        description: 'Inspect a module',
      } }],
      [0.13, { name: 'grep', arguments: { pattern: `value_${String(Math.floor(this.random() * WORKSPACE_FILES))}_1`, path: 'src' } }],
      [0.05, { name: 'glob', arguments: { pattern: 'src/**/*.ts' } }],
      [0.08, { name: 'write', arguments: {
        file_path: join(this.workspace, 'notes', `stress-${String(Math.floor(this.random() * 1e9))}.md`),
        content: `# Findings\n\n${'Observed module behavior. '.repeat(Math.ceil(this.random() * 80))}\n`,
      } }],
      [0.04, { name: 'todo_write', arguments: { todos: [
        { content: 'Inspect modules', status: 'completed' },
        { content: 'Summarize findings', status: 'in_progress' },
      ] } }],
    ]
    const readModules = this.extraTools.has('edit') ? this.readModules(since) : []
    if (readModules.length > 0 && this.random() < 0.3) {
      const module = readModules[Math.floor(this.random() * readModules.length)]!
      const line = Math.floor(this.random() * 20)
      const text = `export const value_${String(module)}_${String(line)} = compute('${'k'.repeat(line % 40)}', ${String(line)}) // stress marker`
      // Repeating an edit on the same line fails with a missing old_string, as real stale edits do.
      return tools.has('edit') ? { name: 'edit', arguments: {
        file_path: join(this.workspace, 'src', `module-${String(module).padStart(2, '0')}.ts`), old_string: text, new_string: `${text}.`,
      } } : undefined
    }
    if (this.extraTools.has('jobs') && this.random() < 0.06 && tools.has(this.shell)) {
      // Half the jobs finish within a second; the rest outlive the turn unless a later step kills them.
      const seconds = this.random() < 0.5 ? 0.3 + this.random() : LONG_JOB_SECONDS
      return { name: this.shell, arguments: {
        command: this.shell === 'pwsh' ? `Start-Sleep -Seconds ${seconds.toFixed(1)}; Get-Content ${file} -TotalCount 5` : `sleep ${seconds.toFixed(1)}; head -n 5 ${file}`,
        description: 'Long-running module check', run_in_background: true,
      } }
    }
    let cumulative = 0
    for (const [weight, call] of candidates) {
      cumulative += weight
      if (roll < cumulative) return tools.has(call.name) ? call : undefined
    }
    return undefined
  }

  /** One enabled root delegation path this turn has not taken yet, sampled per step. */
  private delegation(
    tools: ReadonlySet<string>,
    messages: readonly RequestMessage[],
    since: readonly RequestMessage[],
  ): PlannedCall | undefined {
    const taken = new Set(since.flatMap(message => message.role === 'assistant'
      ? message.content.flatMap(block => block.type === 'tool-call' ? [block.name] : [])
      : []))
    if (this.extraTools.has('message') && !taken.has('send_message') && tools.has('send_message') && this.random() < 0.25) {
      // Children of the current turn are excluded so the message reaches an earlier, likely evicted child.
      const current = new Set(since.flatMap(message => message.role === 'tool' ? [...textOf(message).matchAll(/started subagent (\S+)/gu)].map(match => match[1]!) : []))
      const earlier = [...new Set(messages.flatMap(message => message.role === 'tool' ? [...textOf(message).matchAll(/started subagent (\S+)/gu)].map(match => match[1]!) : []))]
        .filter(id => !current.has(id))
      if (earlier.length > 0) {
        return { name: 'send_message', arguments: {
          agent_id: earlier[Math.floor(this.random() * earlier.length)]!,
          message: `${CHILD_MARK} follow-up: re-check the modules you inspected and report changes.`,
        } }
      }
    }
    if (this.extraTools.has('session') && !taken.has('session_send_message') && tools.has('session_send_message') && this.random() < 0.15) {
      // The model sees no Session id, so a target may be the sender itself, which the tool accepts.
      const targets = this.sessionTargets
      if (targets.length > 0) {
        return { name: 'session_send_message', arguments: {
          session_id: targets[Math.floor(this.random() * targets.length)]!,
          message: 'Module audit note: src/module-07.ts changed its cache order; take it into account.',
        } }
      }
    }
    if (this.extraTools.has('workflow') && !taken.has('workflow') && tools.has('workflow') && this.random() < 0.1) {
      return { name: 'workflow', arguments: {
        meta: { name: 'stress-module-audit', description: 'Audit workspace modules with two helpers.' },
        script: `const results = await parallel([0, 1].map(index => () => agent('${CHILD_MARK} workflow helper ' + index + ': inspect the workspace modules and report findings.')))\nreturn results.length`,
      } }
    }
    return undefined
  }

  /** Read or kill a background job this turn started and has not touched since. */
  private jobFollowUp(since: readonly RequestMessage[], tools: ReadonlySet<string>): PlannedCall | undefined {
    const started = since.flatMap(message => message.role === 'tool' ? [...textOf(message).matchAll(/background job ([\w-]+)/gu)].map(match => match[1]!) : [])
    const touched = new Set(since.flatMap(message => message.role === 'assistant'
      ? message.content.flatMap(block => block.type === 'tool-call' && block.name.startsWith('job_') ? [String((JSON.parse(block.arguments) as { job_id?: unknown }).job_id)] : [])
      : []))
    const pending = started.filter(id => !touched.has(id))
    if (pending.length === 0 || this.random() < 0.4) return undefined
    const id = pending[Math.floor(this.random() * pending.length)]!
    if (this.random() < 0.6 && tools.has('job_output')) return { name: 'job_output', arguments: { job_id: id, wait: true, timeout_ms: 1500 } }
    return tools.has('job_kill') ? { name: 'job_kill', arguments: { job_id: id, reason: 'no longer needed' } } : undefined
  }

  /** Log-normal-ish reply size around the configured median with a long tail. */
  private sampleBytes(): number {
    const gaussian = Math.sqrt(-2 * Math.log(1 - this.random())) * Math.cos(2 * Math.PI * this.random())
    return Math.min(64 * 1024, Math.max(128, Math.round(this.streamBytes * Math.exp(gaussian * 0.9))))
  }

  private async *toolCalls(calls: PlannedCall[], inputTokens: number, signal: AbortSignal | undefined): AsyncIterable<StreamChunk> {
    yield* this.reasoning(Math.round(this.sampleBytes() / 2), signal)
    for (const [offset, call] of calls.entries()) {
      const index = offset + 1
      const id = ToolCallId(`stress-call-${String(++this.nextCall)}`)
      const args = JSON.stringify(call.arguments)
      this.counters.toolCalls[call.name] = (this.counters.toolCalls[call.name] ?? 0) + 1
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
    }
    yield { type: 'usage', usage: { inputTokens, outputTokens: 200 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }

  /** Markdown in the observed mix: prose with inline marks, lists, fenced code, tables and headings. */
  private markdown(bytes: number): string {
    const words = ['module', 'handler', 'session', 'request', 'value', 'cache', 'listener', 'buffer', 'state', 'config']
    const word = (): string => words[Math.floor(this.random() * words.length)]!
    const sections: string[] = []
    let length = 0
    while (length < bytes) {
      const roll = this.random()
      let section: string
      if (roll < 0.35) {
        section = Array.from({ length: 2 + Math.floor(this.random() * 4) }, () =>
          `The **${word()}** path calls \`${word()}_${String(Math.floor(this.random() * 40))}()\` before the ${word()} settles.`).join(' ')
      } else if (roll < 0.55) {
        section = Array.from({ length: 3 + Math.floor(this.random() * 5) }, () =>
          `- \`src/module-${String(Math.floor(this.random() * WORKSPACE_FILES)).padStart(2, '0')}.ts\`: ${word()} ${word()} keeps its *${word()}* order`).join('\n')
      } else if (roll < 0.85) {
        const lines = Array.from({ length: 10 + Math.floor(this.random() * 50) }, (_, line) =>
          `  const ${word()}${String(line)} = await ${word()}.${word()}({ id: ${String(line)}, label: '${word()}' }) // ${word()}`)
        section = `\`\`\`ts\nexport async function ${word()}Flow(): Promise<void> {\n${lines.join('\n')}\n}\n\`\`\``
      } else if (roll < 0.93) {
        const rows = Array.from({ length: 3 + Math.floor(this.random() * 6) }, () =>
          `| ${word()} | ${String(Math.floor(this.random() * 1000))} | \`${word()}\` |`)
        section = `| Name | Count | Owner |\n| --- | ---: | --- |\n${rows.join('\n')}`
      } else {
        section = `## ${word()} ${word()}`
      }
      sections.push(section)
      length += section.length + 2
    }
    return sections.join('\n\n')
  }

  private async *reply(bytes: number, inputTokens: number, signal: AbortSignal | undefined): AsyncIterable<StreamChunk> {
    yield* this.reasoning(Math.round(bytes / 2), signal)
    const body = this.markdownOutput ? this.markdown(Math.round(bytes / 2)) : 'Synthetic analysis of the inspected modules. '
    const text = yield* this.paced(1, 'text', Math.round(bytes / 2), body, signal)
    yield { type: 'block-end', index: 1, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens, outputTokens: Math.ceil(bytes / 4) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  private async *reasoning(bytes: number, signal: AbortSignal | undefined): AsyncGenerator<StreamChunk> {
    const text = yield* this.paced(0, 'reasoning', bytes, 'Considering the next inspection step. ', signal)
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text } }
  }

  /** Stream `body` (repeated as needed) in 64-character deltas until `bytes` are sent. */
  private async *paced(
    index: number, blockType: 'text' | 'reasoning', bytes: number, body: string, signal: AbortSignal | undefined,
  ): AsyncGenerator<StreamChunk, string> {
    const source = body.repeat(Math.ceil(bytes / body.length))
    let text = ''
    yield { type: 'block-start', index, blockType }
    while (text.length < bytes) {
      signal?.throwIfAborted()
      const piece = source.slice(text.length, text.length + 64)
      text += piece
      this.counters.streamedBytes += piece.length
      yield blockType === 'text' ? { type: 'text-delta', index, text: piece } : { type: 'reasoning-delta', index, text: piece }
      if (this.paceMs > 0) await delay(this.paceMs, undefined, { signal })
    }
    return text
  }
}

/**
 * Build a closed synthetic Session log of about `events` events whose turn,
 * step, tool and output proportions follow the calibrated workload.
 * @param id - Session id the fixture is seeded under.
 * @param title - sidebar title.
 * @param events - approximate event count.
 * @returns seed fixture text for `seedSession`.
 */
export function longHistoryFixture(id: string, title: string, events: number): string {
  const random = mulberry32(positive('DSH_STRESS_SEED', 1) ^ events)
  const session = Session.create(SessionId(id))
  const source = { provider: PROVIDER, model: ROOT_MODEL }
  let turn = 0
  let call = 0
  while (session.snapshotEvents().length < events) {
    turn++
    session.append('turn/start', { turn })
    let step = 1
    session.append('step/start', { turn, step })
    if (turn === 1) session.append('system/message', { turn, step, message: createSystemMessage('Synthetic stress system prompt.') }, { surfaceOp: 'append' })
    const user = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `Seeded request ${String(turn)}: continue the module audit. ${'context '.repeat(20)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    if (turn === 1) session.append('session/title', { title, messageSeqs: [user.seq], source: { kind: 'fallback' } })
    const steps = 1 + Math.floor(random() ** 2 * 30)
    for (; step <= steps; step++) {
      if (step > 1) session.append('step/start', { turn, step })
      if (step === steps) {
        session.append('assistant/message', {
          stream: [], turn, step,
          message: createAssistantMessage({ content: [{ type: 'text', text: `Turn ${String(turn)} summary. ${'finding '.repeat(Math.round(50 + random() * 400))}` }], source }),
          usage: { inputTokens: 4000, outputTokens: 400 },
        }, { surfaceOp: 'append' })
      } else {
        const callId = ToolCallId(`seed-${String(++call)}`)
        const args = JSON.stringify({ file_path: `src/module-${String(call % WORKSPACE_FILES).padStart(2, '0')}.ts` })
        session.append('assistant/message', {
          stream: [], turn, step,
          message: createAssistantMessage({ content: [
            { type: 'reasoning', text: `Inspecting module ${String(call)}. ${'reason '.repeat(Math.round(random() * 200))}` },
            { type: 'tool-call', id: callId, name: 'read', arguments: args },
          ], source }),
          usage: { inputTokens: 4000, outputTokens: 200 },
        }, { surfaceOp: 'append' })
        const callEvent = session.append('tool/call', { turn, step, callId, name: 'read', arguments: args })
        session.append('tool/result', {
          turn, step,
          message: createToolResultMessage({
            callId,
            content: [{ type: 'text', text: `export const seeded_${String(call)} = 1 // ${'r'.repeat(Math.round(200 + random() ** 3 * 8000))}` }],
            isError: false,
          }),
        }, { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] })
      }
      session.append('step/end', { turn, step })
    }
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const header = {
    type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}',
    createdAt: Date.now() - 3_600_000, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0,
  }
  return [JSON.stringify(header), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}
