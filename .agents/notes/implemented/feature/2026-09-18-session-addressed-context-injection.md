# Agent Note: Session-addressed Agent messages use attributed context injection

Status: implemented

English | [中文](2026-09-18-session-addressed-context-injection.zh.md)

## Problem

DSH exposes three narrower cross-Session mechanisms: direct continuable parent/child messages, Team mailboxes, and read-only Session references. An ordinary Agent that knows another Session id cannot deliver new information to it without creating one of those relationships. Host `session.prompt` accepts an arbitrary Session id and can resume cold work, but it records the input as a human user prompt and carries no sending Session identity. Exposing that Remote method as a model tool would make Agent-authored content indistinguishable from user authority in durable history.

The desired deployment permits messages across workspace, lineage, and Session-role boundaries, including self-addressing. Runtime target policy, approval, rate limits, and relay-depth limits would therefore contradict the intended capability. The recipient still needs durable sender identity and guidance that receipt alone does not authorize an automatic reply, acknowledgement, forward, or polling exchange.

## Decision

The Web bundle's `standard`, `ptc`, and `cordis` Agent presets mount `@deepseek-ai/dsh-tool-session-message` in their Agent tool scope; the Host global tool layer and the `minimal` preset remain unchanged. The package registers discovery, send, and status tools. `session_find({ query })` delegates to the existing Session-reference candidate directory, so title, id, and workspace matching use the same projection-backed labels and same-workspace ranking as the browser `@` picker without activating candidates. It requires a non-empty substring, excludes self, and joins the result with Session-query header metadata to remove every Session durably marked `origin: subagent`, including AgentTeams teammates. Ordinary user-created forks retain their results because parent lineage alone is not delegation. The tool treats labels as untrusted data and tells the model to present ambiguous matches to the user.

`session_send_message({ session_id, message })` takes its sender only from the exact live `exec.agent`; model input cannot supply or override `senderSessionId`. It accepts any exact live target in `ctx.agents`, regardless of workspace, lineage, origin, or equality with the sender. When no live target exists, it delegates to `ctx.sessionController.resolveAgent()` so an ordinary persisted Session can cold-resume under the controller's existing single-writer and residency ownership.

The target receives one attributed message in its next-step inbox with wakeup enabled. The Agent loop's durable inbox splice records acceptance before the target claims it. A running target admits the context at a later step boundary; an idle target starts a turn and claims it through the same next-step path. This bypasses the ordinary next-turn user queue while preserving the peer-message source. The tool result returns the message, sender, and target ids once insertion succeeds; it is not a read receipt or response future.

The same package registers `session_message_status({ session_id, message_id })`. It inspects the complete validated target log without activating the target and replays durable inbox coordinates to distinguish pending injected context, a legacy queued turn, a pure claim, model-history admission, turn completion, pre-step rejection, durable cancellation, and an unknown target/message pair. It also folds unresolved top-level `tool/call` minus `tool/result` and nested `tool/ptc-dispatch-start` minus `tool/ptc-dispatch` sets. An unresolved native or nested `terminal_send` reports terminal blocking; other calls report tool blocking; a running target without an unresolved call reports model blocking. The result is a point-in-time observation, not a subscription or automatic sender wake.

Every message reuses the existing `agent-message` relay source:

```ts
import type { SessionId } from '@deepseek-ai/dsh-session'

interface AgentMessageSource {
  readonly kind: 'agent-message'
  readonly form: 'relay'
  readonly senderSessionId: SessionId
}
```

The first content block identifies the JSON-encoded sender id and frames the input as untrusted peer context. It tells the recipient not to reply, acknowledge, forward, or send another Session message merely because the message arrived, and to act only when it materially helps the user's current task. The tool description gives the sender the matching rule: no acknowledgements, status-only updates, polling, automatic replies, forwarding, or conversational traffic. These prompts are the only message-storm control; the runtime has no destination, frequency, relay-depth, or self-message restriction.

The tool description also preserves specialized routing without enforcing it in the send operation. A direct continuable parent or child uses `send_message`; teammates use AgentTeams messaging; `session_send_message` is for an independent id explicitly supplied by the user, identified by an incoming Session message, exposed by a user-created Session reference, or returned unambiguously by `session_find` for a user-named target. Discovery remains user-directed: the model cannot request an empty catalog, delegated children never appear in its results, and the model must present ambiguous matches instead of choosing one silently.

### Technical availability is not target policy

The unrestricted rule governs authorization, not whether a target can be materialized correctly. Any live Agent id is deliverable, including a live subagent. Generic Session Controller resume deliberately refuses a cold Session whose lifecycle belongs to the subagent subsystem, so a cold subagent remains unavailable until its parent or Team path activates it. Unknown, corrupt, concurrently unavailable, or no-longer-live identities fail before inbox acceptance.

Caller cancellation is checked before target resolution and again immediately before insertion. Session Controller resume is shared and deduplicated rather than owned by this tool call, so cancellation during cold activation may leave an ordinary target resident while preventing the message from being inserted. After `send()` accepts the message, the caller cannot retract it. Wake-enabled next-step delivery starts an idle target turn and may retain a cold-resumed ordinary Agent until that turn settles or the Controller stops.

## Verification

Focused unit coverage pins delegated-child exclusion during discovery, unrestricted live delivery, self-addressing, exact sender attribution, cold ordinary-Session resolution, validation, cancellation, stale-sender rejection, HMR cleanup, every durable status phase, concurrent-tool projection, and terminal blocking. A production Agent-loop fixture verifies that delivery wakes an idle target through the next-step lane and leaves the ordinary next-turn inbox empty. A real Loader composition verifies that the Cordis row registers the model tools and delivers the attributed content. The Web bundle composition, generated tool catalog, paired package documentation, and a keyless recorded Web schema snapshot own the shipped presentation.

## Alternatives considered

**Widen `SubagentRuntime.sendMessage()`.** That operation owns adjacency authorization, continuable Activation residency, and Steer semantics. Removing its relationship check would erase the parent/child lifecycle guarantee and make unrelated Session communication depend on a subagent manager. The Session-addressed tool remains a separate Consumer over the Agent registry and Session Controller.

**Expose `session.prompt` directly.** This would reuse cold resume and Queue/Steer selection with little code, but it persists Agent-authored text as a human user source without durable sender attribution. A wrapper cannot repair that attribution after inbox acceptance.

**Add a separate mailbox file and queued/delivered event protocol.** A sidecar mailbox could accept messages without materializing the target, but it would duplicate the durable Agent inbox, require recovery and acknowledgement state, and introduce another source of ordering beside the Session log. Existing ordinary-Session cold resume and bounded residency make direct durable inbox insertion sufficient.

**Apply workspace, lineage, self-target, rate, or hop restrictions.** These controls reduce exfiltration and feedback-loop risk, but they contradict this deployment's explicit unrestricted addressing requirement. The tool pipeline remains available for a later deployment-owned approval or deny policy; the shipped plugin itself relies on prompt guidance.

**Build another title index.** Session-reference discovery already owns projection-backed title fallback, cwd affinity, cancellation, and candidate limits for the Web `@` picker. A second index would drift on cold titles and duplicate its performance policy; the model tool delegates to that owner, then uses Session-query headers only to remove child Sessions.

**Use FIFO follow-up or plain inject delivery.** Follow-up places peer content in the ordinary next-turn lane; plain inject leaves an idle target asleep. A wake-enabled next-step send preserves peer attribution, avoids the ordinary user queue, and starts the target when the recipient is idle.

**Push every transition back to the sender.** Automatic notifications would create extra sender context and could wake another reply cycle, the failure this feature's prompt framing avoids. Explicit read-only status inspection reports current durable evidence without producing cross-session traffic.

## Consequences

- Web Agents can inject attributed text into unrelated live Agents and cold ordinary Sessions by exact id without creating a subagent or Team relation.
- A user can name an independent Session instead of copying its id; title lookup reuses the Web reference directory, filters delegated children without activating candidates, and makes ambiguity visible.
- Source attribution is durable and server-derived, but it grants no authority to the received content.
- The mechanism intentionally permits self-messages, cross-workspace messages, and unbounded message graphs; models that ignore guidance can create costly loops.
- A cold subagent remains under its existing lifecycle owner, while a live subagent is an unrestricted target.
- A sender can inspect durable processing progress and current foreground tool blocking without waking the target; `pending-context` explicitly distinguishes an unclaimed context from an ordinary user queue, and `model-context` is not described as human comprehension.
- A peer message wakes an idle target through next-step delivery. A cold-resumed ordinary Agent can remain resident while its target turn runs or until the Controller stops.
- The feature adds a fixed tool-schema cost to every Web Agent request and an attributed peer-framing cost to every target message.
- The implementation adds a tool package and Agent-preset rows without changing Agent Loop, Session format, SDK protocols, the Host global tool layer, or the adjacent-Agent messaging service.

This decision leaves the adjacency guarantees in [Adjacent Agents share one Steer send_message operation](../architecture/2026-08-27-adjacent-agent-steer-messaging.md) intact and adds a separate Session-addressed context operation for the broader case.
