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
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "b509f1946336b63750c4062b08452921fb5492c786c08bd78185f796ac8193e8"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "e44ff2e5d8364e80f289b7341918fa8b956e2c6358147b8a5495e9ddeeb84ff6"
    decision: same-version
  - root: "event:llm/request-record"
    previous: "2026-10-15-claude-request-record-and-retry-disposition"
    after: "26627befdc3416d1c40b749a2373c05343d25b33bc31d8cb2caab2599633116a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "bf4857d0cfa5ddea785005c837f8f2ac6210ef4784982a3fc2a4d98e4aba2c7f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "c89af8ad48d00590b490a885e927b0c3adea1f9163dbd3924bbb6a22e3b3857d"
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
