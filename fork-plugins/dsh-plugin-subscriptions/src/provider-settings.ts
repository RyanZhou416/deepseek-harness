import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { PROVIDER_IDS, type ProviderId } from './auth/store.js'

export const PROVIDER_TOOLS = {
  codex: ['image_generate', 'web_search'],
  claude: [],
  grok: ['image_generate', 'video_generate', 'x_search'],
  copilot: [],
  antigravity: [],
  cursor: [],
} as const
export type SubscriptionTool = 'image_generate' | 'video_generate' | 'x_search' | 'web_search'
export interface AccountPreferences {
  alias?: string
  /** Absent means included. */
  poolEnabled?: boolean
  /** Absent means no separate picker entries. */
  independentEntry?: boolean
  /** Absent allows every model; [] allows none. */
  poolModels?: string[]
}
export interface ProviderPreferences {
  /** ChatGPT only; absent disables automatic spending of the globally earliest-expiring credit. */
  autoResetCredits?: boolean
  accounts?: Record<string, AccountPreferences>
  /** Absent follows discovery; an explicit selection hides newly discovered models. */
  visibleModels?: string[]
  contextWindows?: Record<string, number>
  tools?: Partial<Record<SubscriptionTool, boolean>>
}
interface ToolRevision {
  at: number
  provider: ProviderId
  tools: Partial<Record<SubscriptionTool, boolean>>
}
interface Document {
  providers: Partial<Record<ProviderId, ProviderPreferences>>
  toolHistory: ToolRevision[]
}

export function validatePreferences(provider: ProviderId, input: unknown): ProviderPreferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('settings must be an object')
  const raw = input as Record<string, unknown>
  const result: ProviderPreferences = {}
  if (raw.autoResetCredits !== undefined) {
    if (provider !== 'codex' || typeof raw.autoResetCredits !== 'boolean') {
      throw new Error('autoResetCredits must be a boolean and is supported only for ChatGPT')
    }
    result.autoResetCredits = raw.autoResetCredits
  }
  if (raw.accounts !== undefined) {
    if (!raw.accounts || typeof raw.accounts !== 'object' || Array.isArray(raw.accounts)) throw new Error('accounts must be an account-to-preferences map')
    result.accounts = Object.create(null) as Record<string, AccountPreferences>
    for (const [key, value] of Object.entries(raw.accounts)) {
      if (!key.trim() || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid account preferences')
      const account = value as Record<string, unknown>
      const parsed: AccountPreferences = {}
      if (account.alias !== undefined) {
        if (typeof account.alias !== 'string') throw new Error('account alias must be a string')
        parsed.alias = account.alias.trim()
      }
      for (const field of ['poolEnabled', 'independentEntry'] as const) {
        if (account[field] !== undefined) {
          if (typeof account[field] !== 'boolean') throw new Error(`${field} must be a boolean`)
          parsed[field] = account[field]
        }
      }
      if (account.poolModels !== undefined) {
        if (!Array.isArray(account.poolModels) || account.poolModels.some(id => typeof id !== 'string' || !id.trim())) throw new Error('poolModels must be an array of model ids')
        parsed.poolModels = [...new Set(account.poolModels as string[])]
      }
      result.accounts[key] = parsed
    }
  }
  if (raw.visibleModels !== undefined) {
    if (!Array.isArray(raw.visibleModels) || raw.visibleModels.some(id => typeof id !== 'string' || !id.trim())) {
      throw new Error('visibleModels must be an array of model ids')
    }
    result.visibleModels = [...new Set(raw.visibleModels as string[])]
  }
  if (raw.contextWindows !== undefined) {
    if (provider !== 'codex' && provider !== 'cursor') {
      throw new Error('context window overrides are currently supported only for ChatGPT and Cursor')
    }
    if (!raw.contextWindows || typeof raw.contextWindows !== 'object' || Array.isArray(raw.contextWindows)) {
      throw new Error('contextWindows must be a model-to-token map')
    }
    result.contextWindows = Object.create(null) as Record<string, number>
    for (const [model, value] of Object.entries(raw.contextWindows)) {
      if (!model.trim() || typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error('context windows must be positive safe integers')
      }
      result.contextWindows[model] = value
    }
  }
  if (raw.tools !== undefined) {
    if (!raw.tools || typeof raw.tools !== 'object' || Array.isArray(raw.tools)) throw new Error('tools must be an object')
    result.tools = {}
    for (const [tool, enabled] of Object.entries(raw.tools)) {
      if (!(PROVIDER_TOOLS[provider] as readonly string[]).includes(tool) || typeof enabled !== 'boolean') {
        throw new Error(`unsupported tool setting: ${provider}/${tool}`)
      }
      result.tools[tool as SubscriptionTool] = enabled
    }
  }
  return result
}

/** Durable user preferences, independent of expiring discovery caches. */
export class ProviderSettingsStore {
  private current: Document = { providers: {}, toolHistory: [] }
  private writes: Promise<void> = Promise.resolve()
  /**
   * Retired account key -> canonical key, per provider, for a rename whose
   * durable move may not have landed. It projects the SAME stored policy onto
   * the canonical key for every reader, so a failed migration write cannot
   * silently restore the permissive defaults the user turned off.
   */
  private readonly renames = new Map<ProviderId, Map<string, string>>()
  readonly path: string

  constructor(path = dshHomePath('plugins', 'subscriptions', 'provider-settings.json')) {
    this.path = path
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Document
      if (!raw.providers || !Array.isArray(raw.toolHistory)) throw new Error('invalid settings document')
      for (const provider of PROVIDER_IDS) {
        if (Object.hasOwn(raw.providers, provider)) this.current.providers[provider] = validatePreferences(provider, raw.providers[provider])
      }
      this.current.toolHistory = raw.toolHistory.map(revision => {
        if (!PROVIDER_IDS.includes(revision.provider) || !Number.isSafeInteger(revision.at) || revision.at < 0) throw new Error('invalid tool history')
        const tools = validatePreferences(revision.provider, { tools: revision.tools }).tools ?? {}
        return { at: revision.at, provider: revision.provider, tools }
      }).sort((a, b) => a.at - b.at)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot read provider settings at ${path}`, { cause: error })
    }
  }

  /**
   * The provider's stored preferences, with any pending account rename projected
   * onto the canonical key; callers must treat the result as read-only.
   * @param provider - provider whose preferences are read.
   * @returns the stored preferences, or an empty object when the provider has none.
   */
  get(provider: ProviderId): ProviderPreferences {
    const preferences = this.current.providers[provider] ?? {}
    const aliases = this.renames.get(provider)
    if (aliases === undefined || aliases.size === 0) return preferences
    const accounts = preferences.accounts
    if (accounts === undefined) return preferences
    let projected: Record<string, AccountPreferences> | undefined
    for (const [from, to] of aliases) {
      if (!Object.hasOwn(accounts, from)) continue
      const moved = accounts[from]
      if (moved === undefined) continue
      projected ??= { ...accounts }
      const held = projected[to] ?? accounts[to]
      delete projected[from]
      projected[to] = held === undefined ? moved : { ...moved, ...held }
    }
    return projected === undefined ? preferences : { ...preferences, accounts: projected }
  }

  visible(provider: ProviderId, model: string): boolean {
    return this.current.providers[provider]?.visibleModels?.includes(model) ?? true
  }

  contextWindow(provider: ProviderId, model: string): number | undefined {
    const windows = this.current.providers[provider]?.contextWindows
    return windows && Object.hasOwn(windows, model) ? windows[model] : undefined
  }

  /** Creation-time policy survives restarts and never changes an existing session. */
  toolEnabled(provider: ProviderId, tool: SubscriptionTool, createdAt = Date.now()): boolean {
    let enabled = true
    for (const revision of this.current.toolHistory) {
      if (revision.at > createdAt) break
      if (revision.provider === provider) enabled = revision.tools[tool] !== false
    }
    return enabled
  }

  set(provider: ProviderId, input: unknown): Promise<void> {
    const preferences = validatePreferences(provider, input)
    return this.enqueue(provider, preferences)
  }

  /** Apply one validated preference set on the write queue, in call order. */
  private enqueue(provider: ProviderId, preferences: ProviderPreferences): Promise<void> {
    const run = this.writes.then(async () => { await this.write(provider, preferences) })
    this.writes = run.catch(() => undefined)
    return run
  }

  /**
   * Move one account's stored preferences onto the canonical key the token store
   * renamed it to.
   *
   * This is user policy, not a cache: the account's pool membership, its model
   * allowlist, its independent-picker flag and its alias decide whether the
   * account may serve at all. Losing them at a rename would silently restore the
   * permissive defaults the user turned off, so the entry moves whole. When the
   * canonical key already carries an entry — the user edited it after the rename
   * — that entry's own fields win and the moved entry fills the rest, so neither
   * edit is discarded.
   *
   * The rename is projected in memory FIRST and independently of the write, so
   * every reader of the canonical key sees the same policy even if this write
   * fails; the durable move only makes that projection unnecessary. The edit
   * itself runs on the write queue after any save already queued, so it cannot
   * overwrite that save with a snapshot taken before it landed.
   * @param provider - the provider route.
   * @param from - the key the account's preferences were stored under.
   * @param to - the canonical key the account now resolves to.
   * @returns nothing once the moved preferences are durable.
   */
  async renameAccount(provider: ProviderId, from: string, to: string): Promise<void> {
    if (from === to) return
    const aliases = this.renames.get(provider) ?? new Map<string, string>()
    aliases.set(from, to)
    this.renames.set(provider, aliases)
    const run = this.writes.then(async () => {
      const preferences = this.current.providers[provider]
      const accounts = preferences?.accounts
      if (preferences === undefined || accounts === undefined || !Object.hasOwn(accounts, from)) return
      const moved = accounts[from]
      if (moved === undefined) return
      const held = accounts[to]
      const next: Record<string, AccountPreferences> = { ...accounts }
      delete next[from]
      next[to] = held === undefined ? moved : { ...moved, ...held }
      await this.write(provider, validatePreferences(provider, { ...preferences, accounts: next }))
    })
    this.writes = run.catch(() => undefined)
    return run
  }

  /** One validated provider preference set, written to disk and adopted. */
  private async write(provider: ProviderId, preferences: ProviderPreferences): Promise<void> {
    const next = structuredClone(this.current)
    const before = next.providers[provider]?.tools ?? {}
    next.providers[provider] = preferences
    if (PROVIDER_TOOLS[provider].some(tool => (before[tool] !== false) !== (preferences.tools?.[tool] !== false))) {
      next.toolHistory.push({ at: Date.now(), provider, tools: preferences.tools ?? {} })
    }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true })
    }
    this.current = next
  }
}
