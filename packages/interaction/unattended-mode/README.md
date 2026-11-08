---
description: "The live unattended-mode switch that tells interaction consumers no human is available, for deployments and maintainers of scheduled or remote agent runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-unattended-mode

English | [中文](README.zh.md)

## Summary

`ctx.unattendedMode` reports whether the deployment runs without a human available to answer. The `enabled` field is live configuration and defaults off. `ask_user_question` is the only current consumer: while the switch is on, a call fails with `USER_AWAY` and tells the model to follow the workspace guidance instead of waiting. Other human-interaction seams keep their own behavior.

## Table of Contents

- [Use this package](#use-this-package)
- [Service contract](#service-contract)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin when the agent may run while nobody is watching the chat; the base bundle mounts it off by default.

### When to choose it

Choose it for scheduled, relayed, or automated runs whose human may be away. Leave it off for an interactive session where the model should keep asking questions. The switch is deployment configuration, not Session state: turning it on never rewrites recorded history.

### Minimal configuration

```yaml
- id: unattended-mode
  name: '@deepseek-ai/dsh-unattended-mode'
  config:
    enabled: true
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Whether interaction consumers must assume no human can answer. |

The field is volatile, so a profile or home configuration update applies without restarting the Host. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-unattended-mode) is the exhaustive source for accepted fields.

<a id="service-contract"></a>
## Service contract

`ctx.unattendedMode.enabled()` returns the current value. `ctx.unattendedMode.subscribe(listener)` registers an observer and returns its disposer; the listener receives only value changes, never the current value at registration. Calling the disposer more than once is safe, and disposing the service fiber stops delivery.

Consumers read the switch at execution time. A consumer that read it once at load would miss a live update, and the switch is deliberately optional: a composition without this row keeps the consumer's existing behavior.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service definition, Config schema, and change notification |

### Change detection

The service reads `Config.enabled` through its stable volatile reference on every `enabled()` call. A `loader/volatile-update` event compares that value with the last one delivered to subscribers and notifies only when it differs, so an unrelated profile edit reaches no listener. The service clears its listener set when its fiber disposes; the event listener is a Cordis effect and is removed with the same fiber.

### Configuration surface

The `enabled` field is declared `.volatile()`, so the Settings service projects it into a live form for this profile entry. No shipped client renders Config-driven pages, so deployments currently change the value through the profile patch or another settings client; the plugin inventory lists the plugin from the package locale metadata.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [User interaction subsystem reference](../../../docs/subsystems/user-questions.md) — the question seam behind the only current consumer.
- [tool-ask-user package](../tool-ask-user/README.md) — the `USER_AWAY` refusal and the model-facing text.
- [Settings package](../../settings/settings/README.md) — live Config forms and the `autoGenerate` policy.
- [Interaction group map](../README.md) — adjacent approval, command, and question surfaces.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-ask-user`, whose `USER_AWAY` refusal is the only model-visible effect of this switch.

#### KV Cache effect

No request-prefix change: the switch adds no prompt section, tool schema, or Session event, so toggling it leaves the tool catalog and any cached prefix untouched.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the switch's reach. They are current package constraints, not a UI backlog.

- **No rendered settings switch** — the shipped Web Client renders no page from a Config schema, so deployments edit `enabled` in their profile patch; any client reading `settings.describe()` still sees the volatile field.
- **Only `ask_user_question` reads the switch** — approval prompts, plan review, computer use, and other `ctx.userQuestions` callers keep waiting; each consumer needs its own explicit check.
- **The switch is not Session state** — a recorded Session carries no switch value, so replay and resume follow the current deployment configuration.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The refusal is a `UserQuestionError` so the tool pipeline preserves `{ name: 'UserQuestionError', code: 'USER_AWAY' }` beside the model-facing `Error: ` text. The text names `AGENTS.md`, falling back to `AGENT.md`, because the model must find the user's standing guidance in the workspace without asking.

</details>
