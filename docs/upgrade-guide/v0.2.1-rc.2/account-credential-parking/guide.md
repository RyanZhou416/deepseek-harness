---
kind: upgrade-guide
description: "Rejected account credentials are parked for reauthentication instead of deleted, and account state adds needs-reauth."
---

# Account credential parking

English | [中文](guide.zh.md)

## Change

A stored DeepSeek account grant is no longer deleted when Platform or inference rejects it. Profile or balance HTTP 401, response code `40003`, an inference 401 reported through `rejectToken`, and an issuer that differs from the configured `platformOrigin` park the record instead: its token bytes remain, and the payload becomes version 2 with `invalid.reason` (`needs-reauth` or `issuer-mismatch`) and an ISO `invalid.at`. Fields the provider does not interpret are preserved. Version 1 records without the marker still load as active, so existing installs need no migration step. Account state reports `status: 'needs-reauth'` with `credentialIssue` while the parked record remains; these cases no longer report `signed-out` and do not emit `deepseek-account/signed-out`. Only explicit sign-out deletes the record. A parked grant is never used for Platform or inference requests, so later model requests fail with `ACCOUNT_SIGN_IN_REQUIRED` without another HTTP attempt.

## Migration

1. Accept `needs-reauth` in validators and handlers for `AccountView.status`, and read the optional `credentialIssue`. A parked account behaves like signed-out for sign-in UI and detail queries.
2. Do not treat `deepseek-account/session-expired` as proof that the record was removed; it now means the record was parked. Use explicit sign-out when removal is intended.
3. Keep `needs-reauth` distinct from `signed-out` when showing account state: the credential still exists and must not be recreated or cleaned up automatically.
4. Confirm that a second model request after an inference 401 fails immediately with `ACCOUNT_SIGN_IN_REQUIRED` and that the credential record remains on disk until the user signs out.
