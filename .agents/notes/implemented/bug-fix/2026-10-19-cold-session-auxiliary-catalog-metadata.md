# Agent Note: Cold Session auxiliary catalogs read metadata, not logs

Status: implemented

English | [中文](2026-10-19-cold-session-auxiliary-catalog-metadata.zh.md)

## Problem

Opening a large historical Session runs fast for the first paint because the history opening path reads a validated window, but the composer that renders with the conversation then used to start auxiliary catalog work that materialized the complete stored log. The trigger is the input-trigger controller's scope-birth warm: constructing the per-session controller calls every registered source's `warm()` hook. `skills/list` called `sessionQuery.observeSession` with the default projection mode, whose cold path reads the complete log and hydrates projections. `commands/list` takes an Agent parameter, so the Typert Agent lookup can resume a cold Agent during parameter resolution. On a large history (observed: 166 MB, 176,508 events, 82,431 zstd frames) the background work cost seconds after an otherwise fast first paint.

The skill catalog needed only two facts: a directory and the recorded preset. The directory already exists in the immutable Session header, and both values exist as retained projection-cache rows. Neither requires reading the event log.

## Decision

### A metadata-only Session observation

`SessionQueryEngine.observeSessionMetadata(sessionId, { signal?, projectionKeys? })` returns the immutable header plus optional projection values and never materializes a stored log:

- A live Session serves its current projection cut for the requested keys.
- A stored Session costs one `sessionPersistence.stat` (header, revision, cheap metadata) and, when a projection cache is mounted, a zero-I/O `cachedSnapshot` view of the retained checkpoint row. It never calls `open`, never reads events, and retains no prepared Session.

Checkpoint values may trail the stored log and are absent when the row was dropped (the cache keeps only listing hints outside its retained-byte budget) or belongs to another lifecycle. Consumers must fall back per key rather than treating the block as a complete baseline.

### The skill catalog uses durable metadata

`SessionSkillCatalog.list` requests `workingDirectory` and `agentPreset` through that metadata read. The directory resolves as retained current directory, then the header's recorded directory, then the deployment default. The preset standing scope is acquired only from an available projection value; otherwise the catalog falls back to the global skill registry. A live Agent keeps its effective working directory (`workingDirectory.ensure`) and its preset-owned registry. Remote capability and access control are unchanged: the method stays Session-addressed with the same request field and authorization.

### The roster prewarms on first user intent

`InputTriggerController` no longer calls `warm()` in its constructor. `ensureWarm()` runs once, on the first user intent the pipeline sees: a non-empty draft (`track`), a launcher gesture (`toggleSource`), or a reference preview (`openReference`). A source registered after that moment warms immediately; one registered earlier joins the lexicon channels but waits for the same moment. `/` menu behavior is unchanged because every source's candidates fetch stays on the menu's own fetch path.

## Evidence

A synthetic zstd JSONL Session written through the shipped backend, 6,000 events in 12 separate append frames, measured on Windows with Node 24.13:

| Path | Operation | Elapsed |
| --- | --- | --- |
| Cold catalog | `SessionSkillCatalog.list` (one `stat` + checkpoint view) | 5.5 ms |
| Same fixture, old read path | `sessionQuery.observeSession` (`open` + complete-log read) | 36.6 ms |

The fixture is deliberately smaller than the reported workload; the ratio, not the absolute number, is the relevant result, and the host spec asserts the causal fact (no `open`, no `observeSession`) rather than a CI-sensitive ratio. The reported 5-second cost belongs to the user's real Session; that Session and its content were not accessed while implementing or verifying this change.

## Alternatives considered

**Warm at idle instead of at scope birth.** Rejected. A timer or idle callback still performs the complete-log read and still costs seconds in the background; it only moves the stall after first paint instead of removing it.

**Keep the scope-birth warm and only make `skills/list` metadata-only.** Rejected. `commands/list` resolves the Agent lookup, so mounting a composer on a cold Session would still resume a cold Agent. The eager warm itself was the trigger.

**Cache the preset and directory in the skill catalog across Sessions.** Rejected. That adds a second staleness owner with its own invalidation surface. The projection cache already owns checkpoint identity, lifecycle matching, and retention; keying off its rows needs no new invalidation rule.

**Read only the tail of the stored log to fold the last preset or directory event.** Rejected. It still opens the stored log, depends on per-backend frame indexes, and duplicates folding that the projection registry and its cache already provide.

**Fall back to the header directory instead of the retained current directory.** Rejected. A Session may have moved directories; the retained current directory is a real value from its log and is never from another lifecycle, while the header keeps only the original project directory.

## Consequences

- Cold skill catalog cost changes from O(log) to O(metadata). A large stored history pays one `stat` and one in-memory checkpoint view.
- When a Session's checkpoint row was dropped or lightened, a cold catalog loses preset scoping and the current directory: it falls back to the header directory and the global registry. The preset scope is only as fresh as the last durable checkpoint, which the cache writes at turn end, on the throttled write-behind, and at detach.
- `commands/list` still resolves or resumes a cold Agent through the Typert Agent lookup. Opening the `/` menu on a cold Session still pays that resume, and the deferred warm now starts it on the first keystroke or menu gesture instead of at mount. A cold-safe command catalog needs a preset-scoped command registry that composes no Agent; that remains open work.
- The Client still waits for the Session's initial history open before sending `skills/list` (`sessions.using`), as [the earlier coordination note](2026-09-20-session-open-read-coordination.md) requires.

## Verification

- `packages/api/session-controller/tests/session-skills.host.spec.ts` covers cold header-only, retained-checkpoint, live-Agent, standing-preset, and fallback paths, plus a multi-frame stored Session that must not call `open` or `observeSession` and uses `observeSession` as a negative control.
- `packages/session-query/session-query/tests/observation.spec.ts` covers the live cut, the checkpoint hint, absence, attach-during-stat, stat failure, cancellation, and projection failure of the metadata path.
- Client suites for the trigger pipeline and the skill source cover the interaction-time warm, the containment of a faulty warm, and late source registration.
- Repository typecheck passes for the changed packages and aggregates.

## Relationship to existing records

- [Session opening cache identity and read ordering](2026-09-20-session-open-read-coordination.md) retains the Client-side wait for the initial open and the persistence identity rule. This note replaces only the Host `skills/list` complete-observation read.
- [Session working directory](../architecture/2026-09-13-session-working-directory.md) retains ownership of the working-directory projection. This note reads a retained checkpoint row without committing recovery and without activating an Agent.
- [Session observations and projection-owned Client state](../architecture/2026-08-25-session-observations-and-projection-owned-client-state.md) retains the exact-observation cut rules. A metadata observation is an explicitly lossy sibling, not a replacement for an exact cut.
