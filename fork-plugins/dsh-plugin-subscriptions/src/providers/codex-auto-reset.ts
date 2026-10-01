/** Opt-in reset-credit spending after fresh quota and cross-account expiry checks. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { withTimeout } from './common.js'
import type { ProviderUsage, ResetCreditConsumeResult, ResetCreditList } from './common.js'

/** Live dependencies; list and usage must bypass display caches and propagate failures. */
export interface CodexAutoResetOptions {
  enabled: () => boolean
  accounts: () => Promise<string[]>
  usage: (account: string, signal: AbortSignal) => Promise<ProviderUsage>
  list: (account: string, signal: AbortSignal) => Promise<ResetCreditList>
  consume: (account: string, credit: string, requestId: string, signal: AbortSignal) => Promise<ResetCreditConsumeResult>
  changed: (account: string) => void
  onWarn: (message: string) => void
  /** Bound the optional post-spend usage refresh, including manual RPC calls. */
  confirmationTimeoutMs: number
  /** Durable claims contain no credentials and survive an uncertain POST outcome. */
  claimsDirectory?: string
}

/** Serializes automatic and manual spends in one Host; durable claims prevent repeat automatic spends. */
export class CodexAutoReset {
  private tail: Promise<void> = Promise.resolve()
  private readonly directory: string

  constructor(private readonly options: CodexAutoResetOptions) {
    this.directory = options.claimsDirectory ?? dshHomePath('plugins', 'subscriptions', 'auto-reset-claims')
  }

  /**
   * Try to recover a rejected or quota-full account. A failed check preserves normal failover.
   * @param account - canonical ChatGPT account key.
   * @param signal - request cancellation, including the provider's request deadline.
   * @returns whether the caller can retry once with this account.
   */
  recover(account: string, signal: AbortSignal): Promise<boolean> {
    if (!this.options.enabled()) return Promise.resolve(false)
    return this.serial(async () => {
      try {
        if (!this.options.enabled()) return false
        signal.throwIfAborted()
        const usage = await this.options.usage(account, signal)
        const windows = usage.windows?.filter(window => window.resetsAt === undefined || window.resetsAt > Date.now()) ?? []
        if (!usage.supported || windows.length === 0) return false
        const exhausted = windows.filter(window => window.usedPercent >= 100)
        const accountClaim = this.claimPath('account', account)
        if (exhausted.length === 0) {
          await rm(accountClaim, { force: true })
          this.options.changed(account)
          return true
        }
        // Cards reset ordinary Codex windows, not an unrecognized model-specific limit.
        if (exhausted.some(window => window.scope !== undefined || window.kind === 'other')) return false
        const accounts = [...new Set(await this.options.accounts())].sort()
        if (!accounts.includes(account)) return false
        const lists = await Promise.all(accounts.map(async key => ({ key, list: await this.options.list(key, signal) })))
        let earliest = Infinity
        let selected: { id: string; expiresAt: number } | undefined
        for (const { key, list } of lists) {
          if (!list.supported || list.credits === undefined) return false
          const available = list.credits.filter(credit => credit.status === 'available')
          if (list.availableCount !== undefined && list.availableCount > available.length) return false
          for (const credit of available) {
            const expiresAt = Date.parse(credit.expiresAt ?? '')
            if (!Number.isFinite(expiresAt)) return false
            if (expiresAt <= Date.now()) continue
            earliest = Math.min(earliest, expiresAt)
            if (key === account && credit.resetType === 'codex_rate_limits'
              && (selected === undefined || expiresAt < selected.expiresAt)) selected = { id: credit.id, expiresAt }
          }
        }
        if (selected === undefined || selected.expiresAt !== earliest) return false
        const latestAccounts = [...new Set(await this.options.accounts())].sort()
        if (JSON.stringify(accounts) !== JSON.stringify(latestAccounts)) return false
        const latestUsage = await this.options.usage(account, signal)
        const live = latestUsage.windows?.filter(window => window.resetsAt === undefined || window.resetsAt > Date.now()) ?? []
        if (!latestUsage.supported || live.length === 0) return false
        if (live.every(window => window.usedPercent < 100)) {
          await rm(accountClaim, { force: true })
          this.options.changed(account)
          return true
        }
        if (live.some(window => window.usedPercent >= 100 && (window.scope !== undefined || window.kind === 'other'))) return false
        if (!this.options.enabled() || selected.expiresAt <= Date.now()) return false
        signal.throwIfAborted()
        await mkdir(this.directory, { recursive: true })
        const requestId = randomUUID()
        const record = JSON.stringify({ creditId: selected.id, requestId, at: new Date().toISOString() })
        // An account remains claimed until fresh usage confirms recovery. A card stays claimed permanently.
        if (!await this.claim(accountClaim, record)) return false
        const creditClaim = this.claimPath('credit', account, selected.id)
        let ownsCredit = false
        let sent = false
        try {
          ownsCredit = await this.claim(creditClaim, record)
          if (!ownsCredit || !this.options.enabled()) return false
          signal.throwIfAborted()
          sent = true
          try {
            await this.options.consume(account, selected.id, requestId, signal)
          } finally {
            // Even a lost response may have consumed the card.
            this.options.changed(account)
          }
          await this.confirmUsage(account, signal)
          return true
        } finally {
          if (!sent) {
            if (ownsCredit) await rm(creditClaim, { force: true })
            await rm(accountClaim, { force: true })
          }
        }
      } catch (error) {
        if (signal.aborted) throw error
        this.options.onWarn(`ChatGPT automatic reset skipped: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    })
  }

  /**
   * Preserve manual confirmation and its caller-owned idempotency key while excluding concurrent auto spends.
   * @param account - canonical account key.
   * @param credit - selected credit id.
   * @param requestId - UUID reused by the manual dialog on retry.
   * @param signal - RPC cancellation.
   * @returns the provider's consume response.
   */
  manual(account: string, credit: string, requestId: string, signal: AbortSignal): Promise<ResetCreditConsumeResult> {
    return this.serial(async () => {
      signal.throwIfAborted()
      await mkdir(this.directory, { recursive: true })
      const record = JSON.stringify({ creditId: credit, requestId, at: new Date().toISOString() })
      // Manual retries remain authorized; their durable claims also exclude automatic follow-up spends.
      await this.claim(this.claimPath('account', account), record)
      await this.claim(this.claimPath('credit', account, credit), record)
      signal.throwIfAborted()
      try {
        const result = await this.options.consume(account, credit, requestId, signal)
        await this.confirmUsage(account, signal)
        return result
      }
      finally { this.options.changed(account) }
    })
  }

  /**
   * Rearm after an independent fresh usage poll confirms recovery. Pre-spend polls cannot clear newer claims.
   * @param account - canonical ChatGPT account key.
   * @param usage - successful uncached provider response.
   * @param startedAt - epoch milliseconds before that usage request began.
   * @returns completion of the serialized observation; filesystem failures retain the claim.
   */
  observeUsage(account: string, usage: ProviderUsage, startedAt: number): Promise<void> {
    if (!usage.supported || !usage.windows?.length || usage.windows.some(window => window.usedPercent >= 100)) return Promise.resolve()
    return this.serial(async () => {
      const path = this.claimPath('account', account)
      try {
        const record: unknown = JSON.parse(await readFile(path, 'utf8'))
        if (typeof record !== 'object' || record === null || !('at' in record) || typeof record.at !== 'string') return
        const claimedAt = Date.parse(record.at)
        if (Number.isFinite(claimedAt) && claimedAt < startedAt) await rm(path, { force: true })
      } catch (_unavailableClaim) {
        // Missing, unreadable, and malformed claims cannot authorize another spend.
      }
    })
  }

  private async confirmUsage(account: string, signal: AbortSignal): Promise<void> {
    try {
      const refreshed = await withTimeout(deadline => this.options.usage(account, AbortSignal.any([signal, deadline])),
        this.options.confirmationTimeoutMs)
      if (refreshed?.supported && refreshed.windows?.length
        && refreshed.windows.every(window => window.usedPercent < 100)) await rm(this.claimPath('account', account), { force: true })
    } catch (_refreshFailure) {
      // A confirmed spend remains successful; the claim stays until quota recovery can be verified.
    }
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private claimPath(kind: string, ...ids: string[]): string {
    return join(this.directory, `${kind}-${createHash('sha256').update(JSON.stringify(ids)).digest('hex')}.json`)
  }

  private async claim(path: string, record: string): Promise<boolean> {
    try { await writeFile(path, record, { flag: 'wx', mode: 0o600 }); return true }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  }
}
