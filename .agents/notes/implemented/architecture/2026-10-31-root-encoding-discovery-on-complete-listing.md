# Agent Note: Root encoding discovery belongs to the complete listing

Status: implemented

English | [中文](2026-10-31-root-encoding-discovery-on-complete-listing.zh.md)

## Problem

A JSONL root belongs to one physical encoding, so a backend configured for `zstd` must not silently ignore Sessions stored as plaintext (or the reverse). The backend enforced that with `ensureRootEncoding()`: once per process, before the first `create`, `open`, `stat`, `readWindow`, or unexcluded listing, it traversed every Session directory and rejected a directory holding the other suffix.

That pre-pass had two costs. First, it was a whole-corpus traversal on a per-Session operation: a targeted `stat` or window read paid one `readdir` per Session directory before reading the one directory it needed. Second, `checkRootEncoding()` ran through `mapSessionDirectories` and therefore the shared `listLimit`, the same FIFO limiter as `list()` and `listHeaders()`. In the reported reproduction (18,985 Session directories, a revisited user whose 322 MB Session was opened by a window read while `session.list` arrived), the listing issued no filesystem call for 3.86 s while the check completed 18,985 `readdir` and 360 `stat` calls; the listing's own directory and `stat` work then took 63 ms.

The traversal was also redundant. Every complete scan already selects each Session directory through `resolveGenerationInDirectory`, which rejects a generation with the other suffix, so an unexcluded listing proved the same fact at the end of the pre-pass it had just paid for.

## Decision

### Per-Session operations validate the directory they touch

`stat`, `open`, `readWindow`, and `resolveCurrentLog` locate their artifact through `findLog`/`resolveGenerationInDirectory`, which rejects an opposite-encoding generation in that Session's directory and names the highest canonical version there. Materialization and write-lease acquisition validate the target directory through `rejectOppositeArtifact` before publishing. No pre-pass runs on these paths, so their cost is the project-directory traversal plus the one accessed Session directory.

### The complete scan is the root-wide check

`listGenerations` applies `resolveGenerationInDirectory` to every visited Session directory, so an unexcluded `list()` or `listHeaders()` traverses the whole root and fails on the first directory holding the other encoding. The duplicate pre-pass in `listArtifacts` is removed; the traversal itself is the check. A listing that skips directories (`excludeSessionIds`/`excludeSubagentSessions`) proves only the directories it visits, which was already that path's contract.

### Reporting points

A mixed root fails loudly at the complete listing (startup discovery and any later full listing) and at every targeted access to an affected Session. An unrelated targeted read of a Session stored in the configured encoding succeeds; it is not a root audit. A write into a new Session directory validates only that directory, so a wrong `compression` setting on an existing root surfaces at the next complete listing rather than at creation. Cross-process posture is unchanged: the check was always best-effort, because another process can write after any check.

## Alternatives considered

**Give the encoding check its own limiter.** This keeps a concurrent listing from queueing behind the check, but the first window read still waits for the whole-corpus traversal, and that traversal still competes for the same I/O. The latency being fixed lives on the read path, not only in the limiter.

**Run the whole-root check in the background.** A fire-and-forget rejection can only be logged, so a misconfigured root would not fail the user-visible operation that needs the answer; calling that "loud" would rely on log inspection. A background pass also still spends the corpus `readdir` calls.

**Skip known directories using `.session-catalog.json`.** The catalog records headers and log identity, not physical encoding, and another process can write or replace entries after it was read, so trusting it for encoding would silently ignore an opposite generation. Adding encoding to the catalog is a persisted-format change for a fact the complete scan already observes.

**Keep the global check on `create` only.** The first message would still pay the whole-corpus traversal, and the new Session directory `create` writes is the one directory that cannot reveal the encoding of Sessions elsewhere in the root.

**Add a durable root-encoding marker file.** A new persisted artifact, plus migration for roots that predate it, replaces a check that a complete listing already performs from the data itself.

## Consequences

- The first `stat`, `open`, or `readWindow` reads the project directories and the one accessed Session directory instead of every Session directory, and encoding work never occupies the listing limiter, so a concurrent listing starts immediately.
- A mixed root still fails loudly, but the failure time moves: discovery reports it, affected Session accesses report it immediately, and unrelated targeted reads do not. A new Session written under the other encoding is reported by the next complete listing.
- No persisted format, catalog entry, configuration field, or cross-process rule changes; the diagnostic for a refused directory keeps naming the highest canonical opposite generation.

## Verification

`packages/session/session-persistence-jsonl/tests/root-encoding-read-cost.spec.ts` counts `readdir` calls over a corpus with 60 unwritten Session directories: the first `stat` and `readWindow` touch only the root and the accessed directory; a concurrent `listHeaders()` completes while a held whole-root traversal would block; and a mixed root is refused by `list()` and by a targeted access to the opposite-encoded Session while a same-encoding target still reads. Restoring the `ensureRootEncoding` pre-pass on `stat`/`readWindow` fails all four cases (62 Session directories touched, three held directories traversed, the listing queued for two seconds).

## Related

The [physical encoding contract](../../../../packages/session/session-persistence-jsonl/README.md) states the user-facing rule, and the [Known Limitations](../../../../packages/session/session-persistence-jsonl/README.md#known-limitations-and-deferred-work) note records the reporting time for a wrong `compression` value.
