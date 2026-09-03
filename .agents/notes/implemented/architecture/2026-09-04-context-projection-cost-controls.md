# Agent Note: Context projection cost controls

Status: implemented

English | [中文](2026-09-04-context-projection-cost-controls.zh.md)

## Problem

The vendored `dsh-context` timeline copied every retained collection and rebuilt, validated, serialized, and published its complete wire value for host-only events. A saturated default projection measured 520,244 bytes; one user-event fold through view construction, schema validation, and JSON serialization took 3.54 ms with a 10.51 MB immediate heap delta. `step/start`, the first token chunk, and `tool/call` changed only private fold state but still paid most of that cost.

The closed `/context` overlay also retained timeline, token-meter, header, and conversation subscriptions. Projection pushes continued to render a dialog that returned no DOM. A checkpoint created under larger retention bounds could serve those larger arrays once after the bounds were reduced because retention ran only after a relevant event.

## Decision

The fork vendors upstream `dsh-context` `v0.41.3` at `dce08e0db3ad1dae40da0eb586e7da7f587b32b6` under [`fork-plugins/dsh-context`](../../../../fork-plugins/dsh-context/FORK_MAINTENANCE.md) and publishes the private package version `0.41.3-dsh012rc1.1`. The deployment config uses the existing bounds `maxRequestSteps: 300`, `maxKeptTurns: 60`, `maxEvents: 100`, `maxNodes: 400`, and `maxArchiveNodes: 100`. The saturated wire value under these bounds measures 108,146 bytes, 79.2% below the upstream defaults; the measured fold/view/schema/JSON path takes 0.836 ms with a 2.207 MB immediate heap delta.

The timeline fold uses field-level copy-on-write state and marks which retained collections an event changes. Normalized states run whole-turn and archive trimming only for dirty collections. An unrecognized checkpoint receives one forced normalization, while its first wire view applies the same bounds to a private transient copy. The raw checkpoint remains untouched and idle sessions cannot publish an oversized restored value.

The projection definition propagates a weak identity token across transitions whose visible state inputs are reference-equal. Its weak view cache returns the same raw object for host-only changes, so the [session projection registry's two-stage identity checks](../../../../packages/session/session-projection/README.md#understand-the-implementation) skip view validation and publication. A visible input change or a forced normalization that changes retained data receives a fresh identity; no structural comparison of the full payload runs on the event path.

The `/context` overlay separates its modal-store gate from its data body. The closed gate subscribes only to the open flag. Opening mounts projection and conversation hooks plus keyboard and layout lifecycles; closing disposes that subtree.

## Alternatives considered

**Reduce retention bounds only.** Rejected because private fold events would still copy and publish the retained payload, the closed modal would still render every projection push, and an idle restored checkpoint could serve data retained under older bounds.

**Bump the projection state version or delete projection caches.** Rejected because a version bump forces full-log refolding during rollout, while cache deletion is destructive operational work. The wire-time clamp bounds the first view without changing stored data, and the next relevant event persists a bounded state.

**Deep-compare consecutive wire values.** Rejected because the comparison itself scales with the retained payload. Field identity proves the same condition in constant time after copy-on-write ownership makes unchanged fields reference-stable.

**Keep the modal body mounted and hide it.** Rejected because hidden projection and conversation hooks preserve the exact subscription and render costs this change removes.

## Consequences

The `contextTimeline` key, every projection response field, persisted state schema and `stateVersion`, and session event vocabulary remain unchanged. The lower deployment bounds retain less historical detail, while current composition, whole-turn trimming, hard step limits, event tails, and archive coverage floors keep their existing meanings.

Closing `/context` releases its data subscriptions and local browser component state; reopening reconstructs that transient UI from the current projections. The Context tab is unaffected. Weak maps retain no Session or projection state after the framework releases those objects.

Focused host tests cover field ownership, dirty trimming, stable and fresh wire identities, restored-view bounds, archive floors, and plain-JSON immutability. Client component tests cover zero projection or conversation hook calls while closed and normal remount and disposal behavior.
