---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-28-user-message-revisions

English | [中文](2026-09-28-user-message-revisions.zh.md)

## Summary

Records same-session human message revisions with optional replacement and pending-draft metadata, plus a bounded user-input projection.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-28-user-message-revisions
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "5756ffc9009c737a18b010e3a3faf243141ede9e9fd622ab5f4df5f22d00b3c2"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "801c7011d48ddb967e1c069a5161867661a6a0b6511b89896a1e153443144754"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "a48348e345a29814b0a5d98c088468456e6bbed2d1d2f5633ece02de9e60d2ad"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "4a2f5a6fef33732bab391f140ce9bc45d031e7cd00f7a1c2597a58fd9860443a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing events remain valid without the optional fields. Pending revisions retain edited text for display but contribute no model message until processed input replaces them. The userInput cache is a new version-1 projection rebuilt from the append-only log. Session format and committed generations remain unchanged.

<a id="verification"></a>
## Verification

Focused Session surface, controller, conversation and editor regressions cover derivation, replay, preparation failure, repeated edits, idempotence and concurrent input. The Web message-actions scenario verifies regeneration in the same Session, unchanged URL and session count, and reload. Both SDKs have same-session revision output snapshots.

<a id="dev-note"></a>
## Dev Note

None.
