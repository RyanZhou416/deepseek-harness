---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-28-user-message-revisions

English | [中文](2026-09-28-user-message-revisions.zh.md)

## Summary

Records same-session human message revisions with optional replacement and pending-draft metadata, a bounded user-input projection, and the merge-time normalization of the prepared-request purpose union.

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
    previous: "2026-11-19-cua-input-notices"
    after: "d14b0c68498e095d27b2c9fa67f1638fcffd9cfc534870d5ce1cfd152ba28ca5"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-19-cua-input-notices"
    after: "86470b16c479a8ff37a95ebbf37e4d17b395816f0edb8f7b55e8d6a9d0360b7c"
    decision: same-version
  - root: "event:llm/request-record"
    previous: "2026-10-15-claude-request-record-and-retry-disposition"
    after: "07a2d3cebb38b31956542cb5da3004c8ee5965bde94558a4a3b160882c753ea5"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-19-cua-input-notices"
    after: "377033e3dd28f5c13db68f547465a5a233691fd2acb8042f0bc4a5ef0b6fd2cf"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-19-cua-input-notices"
    after: "9eb4b800ca2efd80c05f75bf6e7a89dc4fde4103235322ba95123cb6f5e51476"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid. The four message roots gain only optional fields: pending revisions keep edited text for display and contribute no model message until processed input replaces them, and the userInput projection is a version-1 projection rebuilt from the append-only log. The prepared-request `purpose` union is recorded again after the upstream `LlmRequestPurposeMap` generalization added the `auto-review` variant; `purpose` is model-hidden metadata with no reader discriminator, so a reader that already handles `compaction`, `session-title` and `conversation` treats the added variant as opaque data and interprets no existing record differently. Session format version 4 and committed generations are unchanged.

<a id="verification"></a>
## Verification

Integration stage executed the persistence gates: `pnpm run verify-persistence-changes`, `pnpm run verify-persistence-catalog` and `pnpm run verify-persistence-formats`; the focused Session and conversation regressions recorded in the original acknowledgement are unchanged by the merge and run in the next stage.

<a id="dev-note"></a>
## Dev Note

None.
