# Agent Note: Context projection cost controls

Status: implemented

English | [中文](2026-09-04-context-projection-cost-controls.zh.md)

## Problem

The `dsh-context` timeline retains request, event, surface, archive, file-operation, timing, and pending-call state. Copying every collection for an event that changes one field makes long sessions allocate in proportion to retained history. Host-only transitions also rebuild and validate a wire value unless consecutive states can prove that every visible input is unchanged.

The closed `/context` overlay can retain timeline, detail, history, token-meter, header, and conversation subscriptions even though it renders no DOM. A checkpoint created under larger retention bounds can also serve those larger arrays once after the bounds are reduced when retention runs only after a relevant event.

## Decision

The fork vendors upstream `dsh-context` `v0.49.0` at `40bb97c5633eabbdf1c22c77a3a0f1e10c6d8108` under [`fork-plugins/dsh-context`](../../../../fork-plugins/dsh-context/FORK_MAINTENANCE.md) and publishes the private package version `0.49.0-dsh015rc1.1`. The deployment config uses `maxRequestSteps: 300`, `maxKeptTurns: 60`, `maxEvents: 100`, `maxNodes: 400`, `maxArchiveNodes: 100`, and `maxFileOps: 100`.

The fork adopts upstream's V0/V2/V3 log fold, host-side File Activity ledger, right-Sidebar panel, and split timeline delivery. The projection value carries a slim head while the open Context tab or modal fetches the heavy collections through the detail channel. The imported `TimelineState` schema uses `stateVersion: 15`; incompatible plugin checkpoints are derived again from immutable Session logs instead of being migrated in place.

The timeline fold uses field-level copy-on-write state and marks which retained collections an event changes. Normalized states run whole-turn, event, archive, and file-operation trimming only for dirty collections. An unrecognized checkpoint receives one forced normalization, while its first slim head, inline value, or detail response applies the same bounds to a private transient copy. The raw checkpoint remains untouched and idle sessions cannot publish oversized restored collections.

The projection definition propagates a weak identity token across transitions whose visible state inputs are reference-equal. Independent weak caches retain inline and slim values so the [session projection registry's two-stage identity checks](../../../../packages/session/session-projection/README.md#understand-the-implementation) skip view validation and publication for pending calls, open-step slots, and buffered Code-Mode operations. A visible input change or a forced normalization that changes retained data receives a fresh identity; no structural comparison of the full payload runs on the event path.

The `/context` overlay separates its modal-store gate from its data body. The closed gate subscribes only to the open flag. Opening mounts projection, detail, history, and conversation hooks plus keyboard and layout lifecycles; closing disposes that subtree.

## Alternatives considered

**Use upstream `v0.49.0` without fork code.** Rejected because the upstream fold clones every retained collection on each changed event, closed modals keep their data hooks mounted, and restored checkpoints are not clamped before their first value is served.

**Reduce retention bounds only.** Rejected because Host-only events would still copy the retained collections, the closed modal would still receive projection and detail activity, and an idle restored checkpoint could serve data retained under older bounds.

**Delete projection caches during installation.** Rejected because cache deletion is unnecessary destructive operational work. The registry handles the imported upstream `stateVersion: 15`, the view-time clamp bounds the first value without changing stored data, and the next relevant event persists a bounded state.

**Deep-compare consecutive wire values.** Rejected because the comparison itself scales with the retained payload. Field identity proves the same condition in constant time after copy-on-write ownership makes unchanged fields reference-stable.

**Keep the modal body mounted and hide it.** Rejected because hidden projection and conversation hooks preserve the subscription and render costs this change removes.

## Consequences

The `contextTimeline` and `contextHeaders` keys and Session event vocabulary remain unchanged. The plugin adopts upstream's version-15 projection state and compatible inline/slim wire schema; plugin checkpoints may refold, but Session artifacts are neither transformed nor overwritten. The lower deployment bounds retain less historical detail, while current composition, whole-turn trimming, hard step limits, event tails, archive coverage floors, and file-operation floors keep their meanings.

Closing `/context` releases its data subscriptions and local browser component state; reopening reconstructs that transient UI from the current projections. The Context tab is unaffected. Weak maps retain no Session or projection state after the framework releases those objects.

Focused Host tests cover field ownership, dirty trimming, stable and fresh inline/slim identities, restored-view bounds, archive and file-operation floors, V0/V2/V3 folding, detail delivery, and plain-JSON immutability. Client component tests cover zero projection or conversation hook calls while closed and normal remount and disposal behavior.
