---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-15-claude-request-record-and-retry-disposition

English | [中文](2026-10-15-claude-request-record-and-retry-disposition.zh.md)

## Summary

Adds the `llm/request-record` root: one prepared-request record the Claude route appends to the Session log that owns the request and flushes before it sends Messages. The same transition acknowledges the optional `retryDisposition` property on four existing failure carriers — `assistant/attempt.data.stream[].chunk.reason.failure`, `assistant/message.data.stream[].chunk.reason.failure`, `llm/retry.data.failure` and `turn/end.data.reason.error` — which the live source already declared and which the recorded baseline had not acknowledged. No existing root gains a required field, no previously finalized record is rewritten, and the Session format version stays 4.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-15-claude-request-record-and-retry-disposition
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "754aecb40d34579e58b5c2ecaf02b656e77da6b14e5d4d3226d9ac56f233982d"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "715bd97099035ded3c8a0870651479b529846baaaa93922fe241d8277e0ba37f"
    decision: same-version
  - root: "event:llm/request-record"
    previous: null
    after: "942da666ffc494e49f13049e1d970937be8527416663ebe7b59a15b4e9119e87"
    decision: same-version
  - root: "event:llm/retry"
    previous: "2026-09-14-image-offload"
    after: "a486593955d481f24a7da719794f3aa3dcdce2bb6075c84ebc4ab7d102825557"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-09-16-session-format-v4"
    after: "216b0406926982f0683a8f346c416e1a9e24f2f897f84ac26c9e477c989eb97a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

`retryDisposition` is optional and `'forbid'` was already its only accepted value: a reader that knows the property still reads an older log, where the field is simply absent, and an older reader meeting a newer log may retain or ignore the unknown property — that outcome is not evidence the field was ever absent. No disposition code is added. `llm/request-record` is a new required-on-read root, so a Host that predates it refuses the whole log instead of skipping the record: the reader ships before the writer, and the event sets no `ignorable` marker. Required fields of the existing roots are unchanged, which keeps the four carriers same-version.

<a id="verification"></a>
## Verification

Ran in the isolated checkout. The subscription plugin passed TypeScript 5.9.3 checks over all its source and test files, both without emission and with test compilation, with `tsc -p tsconfig.test.json` emit repeated after the migrations, and the Host/Client type graph (113 references) and the SDK client build passed. `compiled-recording-tests/output.log` passed 14 cases — wire-record 7, real `subscriptions.apply` 2, model config 4, process restart 1 — from a compiled test entry that imports the workspace alias to source TypeScript, not built-package acceptance. `affected-consumers-with-recording-fixture/output.log` passed 86 cases across HTTP, stream, credential, quota, control and maintenance-status; the previously green response-fidelity batch was not re-run and is not counted again. The focused run selected 2 passing cases (1 TypeScript record forwarding, 1 existing agent-loop forbid) with 47 not selected, and 1 selected Python record-forwarding case passed; production SDK sources are unchanged. Reader and normalizer cases passed 3 storage-contract unknown-required cases and 3 new normalizer cases, and the schema acknowledgement check reports 63 roots and 8 history records including `llm/request-record`. Earlier service, headless-scenario, source-plane and process-restart runs stay valid and are not re-counted. Remaining unverified: the release bundle and tarball, bare installation and rollback, the full repository documentation and configuration gates, real provider calls and the live window; the continuation/ATIS work is still unwired.

<a id="dev-note"></a>
## Dev Note

None.
