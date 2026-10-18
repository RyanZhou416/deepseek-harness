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
    previous: "2026-10-13-user-rpc-principal"
    after: "ea1a81f67d4a0f20e95589b1d95fc879ea9e45d25b3fef040771e86a16254aea"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "c0c7977f3c84204e1d98cfa62430678b58df50994c9681a1c9e9fa2498c6ca3f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "0ce71693ef964c3edacbff894b35177282d2b54e7fcc5abd7b3457f6aee0859d"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "33bdc1a0000847a17f8500e4188cbddc52ae676fdffe525b5dae80d21dfadfdf"
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
