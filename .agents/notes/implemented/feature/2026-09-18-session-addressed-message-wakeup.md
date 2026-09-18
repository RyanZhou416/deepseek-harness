# Agent Note: Session-addressed messages wake idle targets

Status: implemented

English | [中文](2026-09-18-session-addressed-message-wakeup.zh.md)

## Problem

`session_send_message` originally used `inject()`, which intentionally leaves an idle Agent asleep. That behavior is correct for passive context producers such as background completion notices, but it makes an explicit peer message wait indefinitely unless unrelated input later wakes the target. The message transport must preserve direct next-step placement without using the ordinary next-turn user queue and must also reach an idle recipient.

## Decision

`session_send_message` routes the attributed message with `Agent.send(message, 'next-step', true)`. The durable inbox event remains a `next-step` splice, and the sender identity remains `agent-message`; `wakeup: true` opens a target turn when the recipient is idle and preserves the nearest-step behavior when it is running. The transport does not call `followup()` and does not put peer content into the ordinary `next-turn` queue. `session_message_status` remains read-only and never wakes a target.

The earlier context-injection note retains the discovery, authorization, attribution, status, and message-storm guidance. Its delivery section now records this wake-enabled next-step behavior; the distinction from passive `inject()` remains a package-level lifecycle rule.

## Verification

The tool package test spies on the exact `send(message, 'next-step', true)` call. A production Agent-loop fixture observes `turn/start` for an idle recipient, waits for the target to settle, and verifies that `next-turn` is empty and the next-step splice was claimed. The loader composition and generated tool schema continue to cover sender attribution and direct presentation.

## Alternatives considered

**Keep passive `inject()`.** This preserves quiet background context but leaves explicit peer messages pending on idle recipients, which violates the communication feature's delivery expectation.

**Use `followup()`.** This wakes the target but places peer content in the ordinary next-turn user queue and gives it user-prompt scheduling semantics that the feature explicitly avoids.

**Wake through a second synthetic message.** A separate wake event would create two delivery paths, complicate ordering and cancellation, and risk a wake without the attributed context. The existing `send()` wake flag owns both insertion and wake-latch behavior atomically.

## Consequences

- Explicit Session messages wake idle ordinary Agents and still arrive through the next-step inbox.
- Running Agents receive the message at the next step boundary; an already-claimed step may not include a message that arrives after its claim.
- Peer messages can start a target turn and therefore consume model/tool resources; prompt guidance still forbids acknowledgements, relays, and message storms.
- Passive producers that must not start work continue using `inject()` directly.

This note supersedes only the non-waking delivery choice in [Session-addressed Agent messages use attributed context injection](2026-09-18-session-addressed-context-injection.md).
