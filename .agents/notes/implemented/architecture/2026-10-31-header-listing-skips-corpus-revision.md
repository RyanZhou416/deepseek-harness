# Agent Note: Header listings skip the historical corpus revision

Status: implemented

English | [中文](2026-10-31-header-listing-skips-corpus-revision.zh.md)

## Problem

Workspace startup indexed every stored Session header through `sessionPersistence.list()`. A historical JSONL artifact's revision folds in one fingerprint of every selected generation under the persistence root, because its logical events complete the parent catalog from its subagent children. A store with many archived historical parents therefore paid one directory read and one generation stat for every Session in the root during startup, although the header index never compares a revision. The cold-title fold had the same shape: it listed the corpus without the caller's exclusions and asked for snapshot revisions it never read.

## Decision

The persistence seam exposes `listHeaders(options)`. It selects exactly what `list` selects — the same exclusions, the same created-but-unmaterialized Sessions, and no promised order — and returns each Session's `header` and `formatStatus` without a revision. The JSONL backend serves it from the same shared metadata scan as `list` and skips the corpus fingerprint; `list` and `stat` keep that fingerprint. A backend whose revisions are cheap inherits the default implementation, which delegates to `list` and drops revisions.

`WorkspaceRegistry` builds its startup and attach-validation header index through `listHeaders`. `SessionQuery` pulls stored headers the same way, and `readTitleSnapshots` accepts the caller's listing exclusions so the cold-title backfill does not list the archived and subagent rows the visible listing already hid.

## Alternatives considered

**Index no archived Session at startup.** Recorded archived members stay in Workspace accounting, and membership is decided from validated headers by `candidateMatches` and `reportFilteredCandidates`. Dropping them would remove them from `sessionIds`, change filtering warnings, or require a deferred-account state that preserves ownership without validation. The measured cost came from the corpus fingerprint, not from the archived headers themselves.

**Give `list` an option that scopes a historical revision to the generation file.** The returned token would then mean less than `list`'s contract promises, and a later caller could cache derived logical events under it. A method that cannot return a revision removes that misuse.

**Narrow the fingerprint to each historical parent's children, or reuse it within a process.** Children are discoverable only by scanning the corpus or trusting the persisted catalog, whose entries another process may have outlived; and no process-local reuse can prove a foreign writer did not add a child. The conservative fingerprint stays.

## Consequences

Startup touches only the Session directories the listing selects, so a header-only caller no longer pays a corpus-wide scan. The seam gains one method, and every backend keeps the same selection: the default implementation serves it at `list` cost. Historical `stat` and `list` revisions remain corpus-wide and conservative, so opening a historical Session still pays the scan and an unrelated artifact change still invalidates its revision.
