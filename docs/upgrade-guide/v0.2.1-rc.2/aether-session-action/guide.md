---
kind: upgrade-guide
description: "The optional AetherShell adapter replaces five persistent-session tools with aether_session and a required action."
---

# Use one AetherShell session tool with an explicit action

English | [中文](guide.zh.md)

## Change

The optional AetherShell adapter exposes seven tools. `aether_session` replaces `aether_session_open`, `aether_session_eval`, `aether_session_read`, `aether_session_list` and `aether_session_close`; the old names are not aliases. The six discovery/execution/retrieval tools are unchanged. Session ids, result fields, native state, ownership, file-policy checks and timeout/cancellation cleanup keep their existing semantics. Saved transcripts remain history; pending or replayed calls using retired names must be updated before execution.

## Migration

1. Install the updated adapter with its matching Host build, then restart DSH to load it. Replace each old session-tool name in client calls, automation and tool policies with `aether_session`, and add the corresponding `action`:

   | Old tool suffix | New action | Arguments |
   |---|---|---|
   | `_open` | `open` | Optional `cwd`, `name`, `timeoutMs` |
   | `_eval` | `eval` | Required `session_id`, `code`; optional `timeoutMs` |
   | `_read` | `read` | Required `session_id` only |
   | `_list` | `list` | Optional `usage`, `timeoutMs`; no id |
   | `_close` | `close` | Required `session_id`; optional `timeoutMs` |

2. Remove arguments unrelated to the chosen action. They are refused before session lookup or effects, including `timeoutMs` on `read`. Tool policies naming `aether_session` grant access to all five actions; this change does not add action-specific permission rules.
3. Confirm that `{"action":"open"}` returns a `session_id`, evaluate twice through `{"action":"eval","session_id":"…","code":"…"}` to verify persistent state, then close with `{"action":"close","session_id":"…"}`. Verify that tool discovery lists one `aether_session`, not the five retired names. Do not replay earlier side effects to migrate a transcript or reopened session.
