# claude-account-client — pure single-account maintenance client

English | [中文](README.zh.md)

`src/claude-account-client/` is the **protocol read/write client** used by the Mac pool's direct worker: tokens (authorize URL / code exchange / refresh), the strict profile, the managed settings baseline reader, and the transport / deadline seam they share. It reuses the `readBoundedBody` and `CoreTransport` contracts of `claude-core` and the version-rejection vocabulary of `claude-engine/failure-rules`; it **imports no `providers/**`** and imports no DSH/Cordis.

Authoritative sources: `providers/claude.ts` (token helpers / strict profile / `claudeSettingsFetch`), `providers/claude-protocol.ts` (the role header table and the endpoints), `providers/claude-managed-settings.ts` (envelope validation), the fixed source evidence `R/phase34/business-followup/outbound-parity/fixed-source-evidence.json` (9 anchors, UTF-16 offsets + chunk hashes) and `.../desktop-unavoidable-functions/managed-settings-addendum.json` (`adopted-request-construction`: settings request construction and the 200/204/304/404 branches). The Mac-side boundary is documented in `C:/Project/mac-pool-design/COMMUNICATIONS.md` and `CONTRACTS.md`.

## Ownership boundary

| Responsibility | Owner |
|---|---|
| Credential selection, refresh ticket, CAS commit, pending→active promotion | The caller's `CredentialVault` (this module returns only a typed grant and **writes no store**) |
| Account scheduling, account pool, session pin, cancellation finalization | The caller's worker / RequestCoordinator (this module has no poll, no pool, and no timer loop) |
| Egress proxy, TLS, target allowlist | The transport / `EgressBroker` the caller injects (this module **builds no proxy and does no direct global fetch**) |
| The single-use property of `code` / `state` | The host (this module sends one POST per call and claims no exactly-once) |
| Which settings keys may execute and which must block | The caller's policy consumer (this module returns only the envelope and claims no key has executed) |
| The eligibility decision for sending a request | The caller's `required` / `beforeRequest` hook (0 I/O, reads no active credential) |

## Exported API

- `CLAUDE_ACCOUNT_CLIENT_PROFILE`: an explicitly fixed profile (client id `9d1c250a-…2f5e`, plain UA `claude-code/2.1.288`, the authorize/token/profile/settings endpoints, the scope string). **Every call must pass it explicitly**; `claudeAccountProfileFailure(profile)` pins origin + path, so a server response, the environment, or a page cannot change the grant target.
- `buildOAuthAuthorization({profile, redirectUri, codeChallenge, state, scopes?})`: a fixed parameter set and order (`code=true`, `response_type=code`, `S256`); the PKCE challenge and state come from the caller, and `pkceCodeChallenge(verifier)` is only a convenience helper. A non-fixed profile or an empty one-time input → throw (a configuration error fails loud).
- `exchangeAuthorizationCode(input)` / `refreshTokenGrant(input)` → `ClaudeTokenOutcome` (`grant | not-required | cancelled | timeout | invalid_grant | refused | unreachable | invalid`).
  - the grant body matches the CC child: code exchange carries `code/redirect_uri/client_id/code_verifier/state`; refresh carries `refresh_token/client_id/scope`, and `refreshScopeString` removes only `org:create_api_key` while every other scope is kept as-is.
  - the 30s ceiling **covers the POST and body consumption** (`CLAUDE_TOKEN_TIMEOUT_MS`); this module arms its own deadline (`ClaudeAccountTimers` is injectable and defaults to `CLAUDE_SYSTEM_TIMERS`) and hands `timeoutMs` to the injected transport; there is no default fetch.
  - the response is validated field by field into `ClaudeTokenGrant{accessToken, refreshToken?, expiresInSeconds?, scopes, account?}` with no unchecked cast; a grant is permanent only when the endpoint states a permanent grant code (`invalid_grant` / `invalid_token`, written into `failure.reason` and drawn only from fixed allowlist constants).
  - **Credential-destruction criterion**: `claudeFailureDropsCredential(failure)` returns true only for `failure.code === 'invalid_grant'`. A generic 401 (`unauthorized`), a timeout, a cancellation, and unreachable are all false — a worker **must not** destroy a Vault active credential on an ordinary 401, and this module never deletes a credential itself.
  - a failure carries only a fixed code, no body, and no cause.
- `readClaudeStrictProfile(input)` → `ClaudeProfileOutcome` (`profile | not-required | withheld | cancelled | unauthorized | refused | unreachable | invalid`).
  - GET `/api/oauth/profile`: Bearer + plain UA + `content-type: application/json` + `cache-control: no-cache`, 10s, 64 KiB product ceiling (this module's own bound, declared as such).
  - `account.uuid`, `account.email`, and `organization.uuid` are all required, otherwise `invalid`; `billing_type` is read from the **organization**; `complete` = the organization billing_type has a value ∧ account.created_at has a value ∧ organization.subscription_created_at is not null; a missing `cc_onboarding_flags` normalizes to `{}` and therefore does not affect completeness; `subscriptionType` may be `null` and is independent of complete.
  - it returns only the safe projection plus presence flags (`accountCreated`/`subscriptionCreated`/`onboardingFlags`), never raw dates, the flag body, or the whole document.
  - version rejection (`client_version_unsupported`) comes **before** any replay decision and is never swallowed as missing; a mismatched `expected` identity (account / organization) → `invalid` + `identity_mismatch`, without mixing in an old identity.
  - no refresh by default; `reauthorize` is a caller hook, at most once, and a replayed result is still validated against the same `expected`; `beforeRequest` is re-evaluated before every attempt, and `false` means no request.
- `readClaudeManagedSettings(input)` → `ClaudeManagedSettingsOutcome` (`accepted | empty | unchanged | not-required | withheld | cancelled | unauthorized | refused | unreachable | invalid`).
  - GET `/api/claude_code/settings` with the settings role's own headers: plain UA, `anthropic-beta: oauth-2025-04-20`, `accept: application/json`, `cache-control: no-cache`, `pragma: no-cache`, plus `if-none-match: "<checksum>"` when a cached checksum exists (`claudeIfNoneMatch` owns the quoting).
  - `accepted` returns `{uuid, checksum, settings}`, and `settings` keeps unknown keys as-is; this is **syntax-only**: the module neither projects nor claims execution, and the caller's consumer decides the unsafe unknowns.
  - a 304 holds only when this call actually sent a validator (otherwise `invalid`/`unexpected_304`); 204/404 are empty sentinels; a `redirected` response is always refused; a 10s ceiling and a 1 MiB product ceiling; short-lived in-memory values, no store, no raw log.
- `exchangeClaudeRequest` / `ClaudeAccountTimers` / `ClaudeResponseBody` / `readClaudeBody` / `cancelClaudeBody`: the transport, deadline, and body release of each request.
  - this module **holds the body reader itself** (not `claude-core`'s `readBoundedBody`: once it calls `getReader()` it cannot be cancelled from outside, whereas here that reader must really be cancelled when the deadline or the caller wins). Only `reader.cancel()` settles a pending `read()` and runs `releaseLock()`; calling `body.cancel()` on a locked stream throws, and that only means the cancellation did not succeed — it does not mean the stream was released. The byte ceiling, the truncation decision, and the per-path release semantics match core.
  - when the deadline or a caller abort wins: `reader.cancel()` first, then **await that read's quiescence** (releaseLock completed) before returning, so a returned `timeout` / `cancelled` already has its resources truly released.
  - a response whose transport resolves only after losing `Promise.race`: when the scope is already closed / expired / cancelled, **that body is cancelled immediately and never handed to a handler** (`getReader()` count 0), and the late promise is always observed, so no connection leaks.
  - a caller abort settles through the scope's own race and returns `cancelled` **immediately**, without waiting 30s; a deadline likewise returns `timeout`.
  - an injected transport must honor `request.signal` (a declarative obligation covering the request itself); the response body this module holds is released by this module and does not rely on the transport complying. A non-cooperative infinite native promise is not required to be interruptible — that is the cancel owner's obligation.

## Product safeguard declarations (deliberate differences)

`CLAUDE_TOKEN_BODY_LIMIT` (65536), `CLAUDE_PROFILE_BODY_LIMIT` (65536), and `CLAUDE_SETTINGS_BODY_LIMIT` (1048576) are this module's **own** body byte ceilings, not fixed source constants of the analyzed client (whose transport has no such cap). Exceeding a ceiling is a rejection with no re-fetch; body content never reaches a failure, a log, or a cause.

## Runtime platform declaration

The runtime of this module fabricates no Mac / OS field and fixes only the protocol's plain UA constant `claude-code/2.1.288`. Real Bun / macOS platform identity, TLS, proxy, and preconnect behavior belong to the engine layer and are accepted separately per `VALIDATION.md`; this module claims no equivalence with server acceptance or risk control.

## Not implemented (explicit gaps)

- the standalone `policy_limits` interface (in `claude-core`), the organization pin validate poll, HEAD preconnect, and the usage / bootstrap / files roles.
- the exact policy consumer and execution semantics of settings: registered separately per pool capability, and this module provides only the envelope.
- credential commit, pending promotion, state files, and session logs: they belong to the Mac pool's `CredentialVault` / `DirectStore`.
