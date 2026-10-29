/**
 * Staged state behind the CC subscription pool settings page.
 *
 * The page edits two stores with one save: the catalogue is a volatile field
 * of the `llm-cc-pool` settings section, so it is written through the shared
 * configuration form, while the token is a credential literal written through
 * the credentials domain and never read back. Every edit stays staged — the
 * form's save is the only step that writes — and the catalogue is validated
 * before that save so a repeated or blank id, an unreadable capacity, or a
 * missing level blocks the write instead of reaching the Host.
 *
 * A save fences the catalogue write with the revision its drafts started from.
 * When another surface wrote the section first, the shared form re-reads the
 * Host; this page keeps the drafts, reports the conflict, and lets the next
 * save fence with the revision that read answered. A landed write rebuilds the
 * rows from what the Host stored, so a normalized draft (trimmed text or a
 * capacity typed with leading zeros) leaves nothing to save.
 *
 * A pool sync only stages drafts too: it asks the Host's discovery what the
 * pool serves, merges that listing into the edited table, and leaves the save
 * to the user. A listing the merge cannot use leaves the table untouched. The
 * request carries a deadline and belongs to this page, so leaving or
 * discarding cancels it instead of leaving the control on "Syncing…".
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFormPathOp, SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives'
import { CC_POOL_API_KEY_REF, CC_POOL_NS, type CcPoolModel, type CcPoolSettings } from './contract.ts'
import { draftsEqual, draftsOf, emptyDraft, modelsOfDrafts, validateDrafts } from './model-draft.ts'
import type {
  CcPoolDraftError, CcPoolDraftErrorKey, CcPoolDraftRow, CcPoolModelDraft, CcPoolModelField,
} from './model-draft.ts'
import { CC_POOL_DISCOVERY_REQUEST } from './operations.ts'
import type { CcPoolCredentialView, CcPoolOperations } from './operations.ts'
import { mergePoolModels, readDiscoveredModels } from './sync.ts'
import type { CcPoolSyncErrorKey, CcPoolSyncMerge } from './sync.ts'

/** Why one pool sync left the table unchanged. */
export type CcPoolSyncError =
  /** The page refused the answer; the copy key names why. */
  | { readonly kind: 'copy'; readonly key: CcPoolSyncErrorKey }
  /** The discovery request failed; the message is the Host's own diagnostic. */
  | { readonly kind: 'host'; readonly message: string }

/**
 * How long one pool discovery may stay unanswered.
 *
 * The read crosses the pool's own endpoint, so the page gives up on a request
 * that never answers rather than leaving the control on "Syncing…" forever.
 */
export const CC_POOL_SYNC_TIMEOUT_MS = 20_000

/** Why the last save did not land as staged. */
export type CcPoolSaveError =
  /** Another surface wrote the section first; the drafts are kept and a retry fences with the re-read revision. */
  | { readonly kind: 'conflict' }
  /** The Host refused the catalogue itself; the drafts are kept for correction. */
  | { readonly kind: 'rejected' }
  /** The credentials domain refused the literal; the message is the Host's own diagnostic. */
  | { readonly kind: 'credential'; readonly message: string }
  /** The write never reached the Host. */
  | { readonly kind: 'transport' }

/** The pool-sync control and what its last attempt left behind. */
export interface CcPoolSyncState {
  /** A discovery request is crossing the wire. */
  running: boolean
  /** Why the last attempt left the table unchanged; cleared by the next attempt. */
  error?: CcPoolSyncError
  /** Ids a staged "the pool is authoritative" merge would drop, awaiting confirmation. */
  pendingRemoval?: readonly string[]
}

/** One drafted row as the component renders it. */
export interface CcPoolRowState {
  /** Stable row identity for React keys. */
  key: number
  /** The row's editable text. */
  draft: CcPoolModelDraft
  /** First problem per field; the save stays blocked while any is present. */
  errors: Readonly<Partial<Record<CcPoolModelField, CcPoolDraftErrorKey>>>
  /** Whether a pool sync added this row with placeholder capacities to review. */
  synced: boolean
}

/** The write-only credential control and the Host's facts about the reference. */
export interface CcPoolTokenState {
  /** Draft literal typed into the control; always empty until the user types. */
  text: string
  /** Whether the Host resolves a value for the reference. */
  configured: boolean
  /** Source layer supplying the configured value. */
  source?: string
  /** Whether this Host accepts a write for the reference. */
  writable: boolean
  /** The Host's read diagnostic, when the credential state could not be read. */
  error?: string
}

/** What the CC subscription pool page renders. */
export interface CcPoolSettingsState {
  /** First load of the Host section. */
  loading: boolean
  /** Whether the Host serves the entry to this client. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether a save would write anything. */
  dirty: boolean
  /** Whether a staged draft cannot be saved as it stands. */
  invalid: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged; cleared by the next edit. */
  failed: boolean
  /** Why the last save did not land; present exactly while {@link failed} is true. */
  saveError?: CcPoolSaveError
  /**
   * Whether the user layer would own the catalogue once the staged edits are
   * saved. A staged reset previews the inherited catalogue, so the badge never
   * contradicts the save that is about to run.
   */
  overridden: boolean
  /** A staged reset returns the catalogue to the composition's built-in list. */
  resetPending: boolean
  /** Rows in edited order. */
  rows: readonly CcPoolRowState[]
  /** True when no row remains; the Host refuses an empty catalogue. */
  emptyCatalogue: boolean
  /** The pool credential control and its Host-reported state. */
  token: CcPoolTokenState
  /** The pool-sync control and its last outcome. */
  sync: CcPoolSyncState
}

/** The registration-side face the page's slot entry injects. */
export interface CcPoolSectionFace {
  hooks: {
    /** Page snapshot bound by the renderer as useCcPool. */
    ccPool: SnapshotStore<CcPoolSettingsState>
  }
  /** Stage the credential literal. */
  editToken(text: string): void
  /** Stage one field of one row. */
  editRow(row: number, field: CcPoolModelField, text: string): void
  /** Append a blank row. */
  addRow(): void
  /** Remove one row. */
  removeRow(row: number): void
  /** Stage a return to the composition's built-in catalogue. */
  resetModels(): void
  /** Ask the pool which models it serves and stage the merge into the table. */
  syncModels(): void
  /** Apply the staged merge and drop the rows the pool no longer lists. */
  confirmSyncRemoval(): void
  /** Apply the staged merge but keep the rows the pool no longer lists. */
  keepSyncRows(): void
  /** Drop the merge a removal confirmation waits on; the table stays as it was. */
  cancelSync(): void
  /** Write every staged edit. */
  save(): void
  /** Drop every staged edit. */
  discard(): void
}

/** Bridges the `llm-cc-pool` settings section and the credentials domain onto the page. */
export class CcPoolSettingsPage {
  private readonly store: SnapshotStore<CcPoolSettingsState>
  private rows: CcPoolDraftRow[] = []
  private nextKey = 0
  private tokenDraft = ''
  private resetPending = false
  /**
   * Whether the catalogue carries an edit of the user's own. Unlike the
   * dirty comparison, this survives an edit that returns a field to its
   * stored text, so an external Host change cannot replace a row the user is
   * still working in.
   */
  private staged = false
  /**
   * Revision the staged drafts started from. A save fences its mutation with
   * it, so a concurrent edit elsewhere is reported as a conflict rather than
   * overwritten silently.
   */
  private baselineRevision: number | undefined
  private saving = false
  private failed = false
  private saveError: CcPoolSaveError | undefined
  private credential: CcPoolCredentialView = { configured: false, writable: true }
  /** Guards against an older credential read publishing after a newer one. */
  private credentialGeneration = 0
  /**
   * Whether a credential read has settled. Before that the page cannot tell a
   * missing token from one it has not read yet, so it asks the Host instead.
   */
  private credentialRead = false
  /** The discovery request in flight, if any; aborting it releases the sync control. */
  private syncAbort: AbortController | undefined
  /** Deadline of the discovery request in flight. */
  private syncTimer: ReturnType<typeof setTimeout> | undefined
  private syncError: CcPoolSyncError | undefined
  /** The merge a removal confirmation waits on; its row indexes address the current table. */
  private pendingMerge: CcPoolSyncMerge | undefined
  private disposed = false
  private readonly unsubscribe: () => void

  /**
   * @param scope - the shared configuration form of the `llm-cc-pool` entry.
   * @param operations - the Host credential operations.
   */
  constructor(
    private readonly scope: SettingsFormScope<CcPoolSettings>,
    private readonly operations: CcPoolOperations,
  ) {
    this.rows = this.seed(this.effectiveModels())
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      // An accepted write (or another surface's edit) reseeds the drafts only
      // while nothing is staged here; otherwise the user's edits would be
      // replaced under them.
      if (!this.staged) {
        this.rows = this.seed(this.effectiveModels())
        // A reseed replaces the rows a pending merge's indexes address.
        this.pendingMerge = undefined
      }
      this.publish()
    })
    void this.refreshCredential()
  }

  /**
   * Re-read the credential state after the Host reports a change to this
   * reference, or after a reconnect: a key can be written elsewhere and no
   * settings section changes when it is.
   * @returns settlement after the published read.
   */
  async refreshCredential(): Promise<void> {
    const generation = ++this.credentialGeneration
    const answer = await this.operations.describeCredential(CC_POOL_API_KEY_REF)
    if (this.disposed || generation !== this.credentialGeneration) return
    this.credential = answer
    this.credentialRead = true
    this.publish()
  }

  /**
   * Build the face the page's slot registration injects.
   * @returns the page's snapshot and its staged edits.
   */
  inject(): CcPoolSectionFace {
    return {
      hooks: { ccPool: this.store },
      editToken: (text) => {
        this.tokenDraft = text
        this.clearFailure()
        this.publish()
      },
      editRow: (row, field, text) => {
        this.rows = this.rows.map((item, index) => index === row
          ? { ...item, draft: { ...item.draft, [field]: text } }
          : item)
        // A row edit supersedes a staged reset: what is on screen is now the
        // catalogue a save writes.
        this.resetPending = false
        this.staged = true
        this.stageBaseline()
        this.clearFailure()
        this.publish()
      },
      addRow: () => {
        this.rows = [...this.rows, { key: this.nextKey++, draft: emptyDraft(), synced: false }]
        this.resetPending = false
        this.staged = true
        this.stageBaseline()
        this.clearFailure()
        this.publish()
      },
      removeRow: (row) => {
        this.rows = this.rows.filter((_item, index) => index !== row)
        this.resetPending = false
        this.staged = true
        this.stageBaseline()
        this.clearFailure()
        this.publish()
      },
      resetModels: () => {
        this.rows = this.seed(this.baseModels())
        this.resetPending = true
        this.staged = true
        this.stageBaseline()
        this.clearFailure()
        this.publish()
      },
      syncModels: () => { void this.syncModels() },
      confirmSyncRemoval: () => { this.applyPendingMerge(true) },
      keepSyncRows: () => { this.applyPendingMerge(false) },
      cancelSync: () => {
        this.pendingMerge = undefined
        this.publish()
      },
      save: () => { void this.save() },
      discard: () => {
        this.cancelSyncRequest()
        this.rows = this.seed(this.effectiveModels())
        this.tokenDraft = ''
        this.resetPending = false
        this.staged = false
        this.baselineRevision = undefined
        this.clearFailure()
        this.pendingMerge = undefined
        this.syncError = undefined
        this.publish()
      },
    }
  }

  /** Release the configuration subscription and any discovery still crossing the wire. */
  dispose(): void {
    this.disposed = true
    this.cancelSyncRequest()
    this.unsubscribe()
  }

  /**
   * Ask the Host's pool discovery what the pool serves and stage the merge.
   *
   * Nothing is written here: the merge only edits the drafts, so the page's
   * save stays the one step that reaches the settings document. A refused or
   * unusable answer leaves the table exactly as it was. The request carries a
   * deadline, and an answer that arrives after this page gave up (a timeout, a
   * discard, or leaving the page) is dropped.
   * @returns settlement after the merge, the reported error, or the cancellation.
   */
  private async syncModels(): Promise<void> {
    const state = this.projection()
    if (this.syncAbort !== undefined || !state.available || !state.writable || state.saving) return
    this.pendingMerge = undefined
    this.syncError = undefined
    if (this.credentialRead && !this.credential.configured) {
      this.syncError = { kind: 'copy', key: 'syncNoToken' }
      this.publish()
      return
    }
    const abort = new AbortController()
    this.syncAbort = abort
    this.syncTimer = setTimeout(() => { this.timeOutSync(abort) }, CC_POOL_SYNC_TIMEOUT_MS)
    this.publish()
    try {
      const outcome = await this.operations.discoverModels(CC_POOL_NS, CC_POOL_DISCOVERY_REQUEST, abort.signal)
      if (this.disposed || this.syncAbort !== abort) return
      if (outcome.kind === 'refused') {
        this.syncError = { kind: 'host', message: outcome.message }
        return
      }
      const listing = readDiscoveredModels(outcome.models)
      if (listing.kind === 'problem') {
        this.syncError = { kind: 'copy', key: listing.problem }
        return
      }
      const merge = mergePoolModels(this.rows.map(row => row.draft), listing.models)
      if (merge.added.length === 0 && merge.keptRows.length === this.rows.length) return
      if (merge.removedIds.length === 0) {
        this.stageMerge(merge)
        return
      }
      // The pool is authoritative by default, but dropping rows is the user's
      // call: stage the additions now and wait for the confirmation.
      this.pendingMerge = merge
    } catch (error) {
      // A transport failure has no Host diagnostic; the table stays as it is.
      if (this.disposed || this.syncAbort !== abort) return
      this.syncError = { kind: 'host', message: messageOf(error) }
    } finally {
      if (this.syncAbort === abort) {
        this.releaseSync()
        this.publish()
      }
    }
  }

  /**
   * Give up on one discovery request that outlived its deadline.
   * @param abort - the request's cancellation handle.
   */
  private timeOutSync(abort: AbortController): void {
    this.syncError = { kind: 'copy', key: 'syncTimeout' }
    this.releaseSync()
    abort.abort()
    this.publish()
  }

  /** Cancel the discovery request in flight, if any; its answer is dropped. */
  private cancelSyncRequest(): void {
    const abort = this.syncAbort
    if (abort === undefined) return
    this.releaseSync()
    abort.abort()
  }

  /** Forget the in-flight request: its deadline and its cancellation handle. */
  private releaseSync(): void {
    clearTimeout(this.syncTimer)
    this.syncTimer = undefined
    this.syncAbort = undefined
  }

  /**
   * Apply the merge a removal confirmation was waiting on.
   * @param remove - whether the pool's absence drops the rows it no longer lists.
   */
  private applyPendingMerge(remove: boolean): void {
    const merge = this.pendingMerge
    if (merge === undefined) return
    this.pendingMerge = undefined
    this.stageMerge(merge, remove)
    this.publish()
  }

  /**
   * Stage one merge as the edited catalogue.
   * @param merge - the merge to apply.
   * @param remove - whether rows the pool no longer lists leave the table;
   *   omitted stages the default "the pool is authoritative" outcome.
   */
  private stageMerge(merge: CcPoolSyncMerge, remove = true): void {
    const keep = new Set(merge.keptRows)
    const kept = remove ? this.rows.filter((_row, index) => keep.has(index)) : this.rows
    const added: CcPoolDraftRow[] = merge.added.map(draft => ({ key: this.nextKey++, draft, synced: true }))
    this.rows = [...kept, ...added]
    // A sync supersedes a staged reset: what is on screen is now the catalogue
    // a save writes.
    this.resetPending = false
    this.staged = true
    this.stageBaseline()
    this.clearFailure()
    this.syncError = undefined
  }

  /**
   * Write the staged catalogue and credential, then re-seed from what the Host accepted.
   *
   * The two stores are written in order: the catalogue first, so a refused
   * credential leaves the accepted catalogue in place with only the typed key
   * staged. A catalogue the Host refused keeps every draft; a refusal after a
   * concurrent edit is reported as a conflict and retried against the revision
   * the shared form re-read, instead of staying fenced to the stale one.
   */
  private async save(): Promise<void> {
    const state = this.projection()
    if (!state.available || state.invalid || state.saving) return
    const models = modelsOfDrafts(this.rows.map(row => row.draft))
    const token = this.tokenDraft.trim()
    const writeCatalogue = this.resetPending || !draftsEqual(draftsOf(this.effectiveModels()), this.rows.map(row => row.draft))
    if (!writeCatalogue && token === '') return
    this.saving = true
    this.clearFailure()
    this.publish()
    try {
      if (writeCatalogue) {
        const ops: SettingsFormPathOp[] = this.resetPending
          ? [{ op: 'unset', path: ['models'] }]
          // The invalid guard above refused a catalogue that cannot convert, so
          // this write always carries the converted list.
          : [{ op: 'set', path: ['models'], value: models as CcPoolModel[] }]
        const landed = await this.scope.mutate(ops, this.baselineRevision)
        if (!landed) {
          this.reportCatalogueRefusal()
          return
        }
        this.adoptAcceptedCatalogue()
      }
      if (token.length > 0) {
        const refusal = await this.operations.storeCredential(CC_POOL_API_KEY_REF, token)
        if (refusal !== undefined) {
          this.failed = true
          this.saveError = { kind: 'credential', message: refusal }
          await this.refreshCredential()
          return
        }
        this.tokenDraft = ''
        await this.refreshCredential()
      }
    } catch (_error) {
      this.failed = true
      this.saveError = { kind: 'transport' }
    } finally {
      this.saving = false
      this.publish()
    }
  }

  /**
   * Report a refused catalogue write as a conflict or a rejection.
   *
   * The shared form re-reads the Host after a refusal, so a revision that moved
   * past the staged one is another surface's write winning the fence. The
   * drafts stay, and the recovered revision becomes the next save's fence.
   */
  private reportCatalogueRefusal(): void {
    const revision = this.scope.getSnapshot().revision
    this.failed = true
    if (revision === undefined || this.baselineRevision === undefined || revision === this.baselineRevision) {
      this.saveError = { kind: 'rejected' }
      return
    }
    this.baselineRevision = revision
    this.saveError = { kind: 'conflict' }
  }

  /**
   * Take the accepted catalogue as the drafts on screen.
   *
   * The Host is the only authority on how the written list reads back — it may
   * trim text or resolve a reset to the composition default — so the rows are
   * rebuilt from it: what the save stored is what remains to review, and a
   * normalized draft no longer reports itself as unsaved.
   */
  private adoptAcceptedCatalogue(): void {
    this.rows = this.seed(this.effectiveModels())
    this.pendingMerge = undefined
    this.resetPending = false
    this.staged = false
    this.baselineRevision = undefined
  }

  /** Clear the last save's failure, which every edit and every save attempt does. */
  private clearFailure(): void {
    this.failed = false
    this.saveError = undefined
  }

  /** Remember which revision the staged drafts started from. */
  private stageBaseline(): void {
    this.baselineRevision ??= this.scope.getSnapshot().revision
  }

  /** Whether the rows carry an edit against the catalogue the Host currently serves. */
  private stagedCatalogue(): boolean {
    return this.resetPending || !draftsEqual(draftsOf(this.effectiveModels()), this.rows.map(row => row.draft))
  }

  /**
   * Turn stored entries into rows with fresh identities.
   * @param models - the catalogue to show.
   * @returns the rows, in catalogue order.
   */
  private seed(models: readonly CcPoolModel[]): CcPoolDraftRow[] {
    return draftsOf(models).map(draft => ({ key: this.nextKey++, draft, synced: false }))
  }

  /** The catalogue the Host currently serves (its default when nothing overrides it). */
  private effectiveModels(): readonly CcPoolModel[] {
    return this.scope.getSnapshot().value?.models ?? []
  }

  /** The composition's catalogue: what a reset returns to. */
  private baseModels(): readonly CcPoolModel[] {
    const base = this.scope.getSnapshot().base as CcPoolSettings | undefined
    return base?.models ?? []
  }

  /** Build the page state from the Host section, the drafts, and the credential facts. */
  private projection(): CcPoolSettingsState {
    const snapshot = this.scope.getSnapshot()
    const available = snapshot.status === 'ready'
    const errors = validateDrafts(this.rows.map(row => row.draft))
    const user = snapshot.user as CcPoolSettings | undefined
    return {
      loading: snapshot.status === 'loading',
      available,
      writable: snapshot.writable,
      dirty: this.stagedCatalogue() || this.tokenDraft.trim().length > 0,
      invalid: errors.length > 0 || available && this.rows.length === 0,
      saving: this.saving,
      failed: this.failed,
      ...this.saveError === undefined ? {} : { saveError: this.saveError },
      overridden: !this.resetPending && user !== undefined && Object.hasOwn(user, 'models'),
      resetPending: this.resetPending,
      rows: this.rows.map((row, index) => ({
        key: row.key,
        draft: row.draft,
        errors: errorsOfRow(errors, index),
        synced: row.synced,
      })),
      emptyCatalogue: available && this.rows.length === 0,
      token: {
        text: this.tokenDraft,
        configured: this.credential.configured,
        ...this.credential.source === undefined ? {} : { source: this.credential.source },
        writable: this.credential.writable,
        ...this.credential.error === undefined ? {} : { error: this.credential.error },
      },
      sync: {
        running: this.syncAbort !== undefined,
        ...this.syncError === undefined ? {} : { error: this.syncError },
        ...this.pendingMerge === undefined ? {} : { pendingRemoval: this.pendingMerge.removedIds },
      },
    }
  }

  private publish(): void {
    if (this.disposed) return
    this.store.set(this.projection())
  }
}

/**
 * Read one thrown value as the message a user-facing report shows.
 * @param error - the rejection or thrown value.
 * @returns its message, or the value's own text when it carries no Error.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Fold one row's problems into a field map for the control that renders it.
 * @param errors - every problem of the drafted catalogue.
 * @param row - the row position to select.
 * @returns the first problem per field of that row.
 */
function errorsOfRow(
  errors: readonly CcPoolDraftError[],
  row: number,
): Readonly<Partial<Record<CcPoolModelField, CcPoolDraftErrorKey>>> {
  const byField: Partial<Record<CcPoolModelField, CcPoolDraftErrorKey>> = {}
  for (const error of errors) {
    if (error.row !== row) continue
    byField[error.field] ??= error.key
  }
  return byField
}
