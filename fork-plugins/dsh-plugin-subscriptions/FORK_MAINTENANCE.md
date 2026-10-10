# Subscriptions fork maintenance

This subtree carries the private `dsh-plugin-subscriptions` build shipped with this fork.

## Provenance

- Upstream repository: `https://github.com/V1ki/dsh-plugin-subscriptions.git`
- Upstream tag: `v0.9.4`
- Fork package version: `0.9.4-dsh017rc1.11`
- Subtree path: `fork-plugins/dsh-plugin-subscriptions`
- Distribution artifact: `fork-plugins/releases/dsh-plugin-subscriptions-0.9.4-dsh017rc1.11.tgz`

## Fork behavior

The fork keeps upstream provider, account, credential-store, request-translation, and tool names. It uses the RC.1 awaited `agent/created` payload and exact DSH dependency cohort. The V4 adapter maps first-class `role: 'tool'` messages to the existing provider translators' result blocks, preserving call id, failure flag, order, and image attachments; developer messages fail explicitly until a provider supports them. The independent test environment installs the UI primitive runtime dependencies that the Harness Web application normally supplies.

Each Node test process gets a private temporary `DSH_HOME` before plugin imports. Codex and Grok stream tests inject their fetch implementation through the adapter's existing option, so a developer's proxy configuration and credentials cannot redirect synthetic requests to real providers. Production routes still use the configured proxy.

No Session event or Session format changes. Existing Codex, Claude, Grok, Copilot, and Antigravity session objects are unchanged. Cursor adds fields; Claude gains two optional wire-identity fields, see below. Existing subscription credentials remain owned by the plugin's configured DSH home and are not copied into this repository.

## Reapply after an upstream import

`V1ki/dsh-plugin-subscriptions` v0.9.4 does not contain the behaviors in this section. A subtree import overwrites `src/`, `test/`, and `package.json`. Restore every item here before packaging, then run the package suite and rebuild the tarball. The tests named below fail if the behavior was dropped.

### One owner for the provider catalog plumbing

The six adapters used to carry their own copy of the same catalog code: `clearAccountCatalog`
was byte-identical in all six, `catalogFor` and `listModels` in five, and `listOwnModels` was
near-identical with per-provider differences. They now delegate to `provider-catalog.ts`, which
owns the cache, the listing skeleton (account union, per-account bound, abort and credential
error mapping), the picker-row shape, and the pool-tier overlay. Per-provider differences stay
explicit: the discovery timeout hook, each adapter's modality rule and description, the warn
label's capitalisation, and grok's last-known short-circuit.

**Preservation rule.** Re-apply the delegation after an upstream import, which would otherwise
restore six copies; keep the adapters' thin `clearAccountCatalog` / `listOwnModels` /
`listModels` methods as real prototype methods, because a spec patches one of them. Re-measure
the duplication ratchet after any change here: `package.json`'s `duplication` script holds
`packages`/`scripts` at zero and the plugin path at a threshold just above what remains.

### Wire fidelity, stream errors, and the store lock

Four contracts the pinned wire and the credential lock depend on:

- **Temperature is forwarded, stop is refused.** A caller-set `temperature` reaches the body
  (absent leaves the library's own value); a non-empty `stop` rejects with `INVALID_REQUEST`
  before assembly, because the pinned request shape has no stop-sequence field. The genuine
  client's main-session body carries a temperature and no stop field at all.
- **A truncated stream is a transport failure.** A body that ends before its terminal event
  raises `TRANSPORT`, which the harness retries and the pool treats as a member switch; the
  genuine client calls the same condition a dropped connection and retries it. `MALFORMED_RESPONSE`
  is retryable on these routes through `subscriptionRetryPolicy`.
- **The credential lock renews its lease.** A held lock touches its own directory every half
  stale interval, and a lock whose lease expired is removed before the waiter retries, so a dead
  holder never blocks a write and live work is never preempted mid-flight.
- **The registered route reports the wrapped adapter's identity.** `AccountPreferencesAdapter`
  delegates `providerInfo`, so each route's display name reaches the model picker instead of the
  raw route id.

**Preservation rule.** Keep every one of these on the plugin side: the harness's retryable-code
set, its provider-info contract, and the client's own lock protocol are the references. Do not
add a fallback that hides a refusal (a replayed reasoning item a gateway rejects must surface),
and do not reintroduce a lock that never removes an abandoned one.

**Focused verification.** `test/claude-wire.spec.ts` (temperature/stop), `test/translate.spec.ts`
and `test/chat-completions.spec.ts` (stream classification), `test/store-lock.spec.ts` (lease and
takeover, run repeatedly because it is concurrent), and `test/account-preferences.spec.ts`
(identity delegation).

### Removed upstream indirection

Four pieces of upstream code were removed here and must not come back through an upstream
import; each was proven to add nothing before it was deleted.

- The Claude `/fast` description wrapper (a module whose body only called the locale getter it
  was handed). The command's description is now the locale call itself.
- The unused disposer `registerWithAlias` returned. Registration is still an effect through the
  tool registry; only the field nobody read is gone, and the function returns the resolved name
  its callers use for the per-agent deny list.
- The defensive `structuredClone` in `provider-settings.get()`. `set()` already writes a fresh
  tree, and every caller only reads; the contract is now stated in the accessor's JSDoc.
- The `pool.autoFamilies` alias, its schema entry, and the two fallbacks that read it. The
  fallbacks were unreachable (the sibling field defaults to true), so removing them preserves
  behaviour even for a configuration that set the alias.

### Claude wire (pinned Claude Code 2.1.288)

Files: `src/providers/claude-wire.ts`, `src/providers/claude.ts`, `src/providers/claude-images.ts`, `src/translate/anthropic.ts`, `src/auth/store.ts`, `src/providers/accounts.ts`, `src/providers/common.ts`, `test/claude-wire.spec.ts`, `test/translate.spec.ts`, `test/models.spec.ts`, `package.json` (`@tormentalabs/claude-code-wire-compat` exact pin).

- All chat requests build through `buildClaudeCodeRequest` with the pinned `CLAUDE_CODE_2_1_288_PROFILE` (CLI 2.1.280, SDK 0.112.1). The builder owns the billing fingerprint block, the identity system block, beta composition, the `metadata.user_id` correlation triple, cache-breakpoint placement, and the header plan. Do not hand-roll `anthropic-beta`, the billing block, `x-app`, or cache markers again.
- Keep `cacheControl: { enabled, systemBreakpoint, toolBreakpoint, messageBreakpoint, ttl: '1h' }` (the genuine client ships 1h cache markers), `stream: true`, `display: 'summarized'` on the thinking request, and `effort` plus `outputConfig: { effort }` when the model advertises efforts. The builder validates both against the pinned catalogue. Send no `accept` header — the genuine client sends none.
- Identity: `sessionId` is the harness session id (a UUID fallback per request when absent), `deviceId` and `accountUuid` come from the stored `ClaudeSession` (minted/discovered at login, preserved across refresh, lazily backfilled for pre-upgrade sessions; a failed backfill fails the request with `INVALID_REQUEST` instead of sending a bogus triple). `deviceId` is minted as a 64-hex string (32 random bytes), the genuine client's format, never a UUID. `previousRequestId` chains the response `request-id` header into the next request's billing block, keyed by (canonical account, wire session) so a pool failover never chains another account's request id (bounded at 256 entries); a response without the header clears the chain. `cc_prompt_id` is derived deterministically from (wire session, prompt turn) by `claudePromptId`: the same session and turn always produce the same id and the same request bytes, while another session or the next turn differs. The value is model-visible, so the harness rule that anything a model sees must be reconstructable from the session log requires the derivation — a random UUID is not reconstructable. The turn's tool-continuation steps reuse it; probe/title-helper suppression is not modelled. The response's `request-id` header is recorded on that assistant message's replay envelope as `response.requestId`, the checkable counterpart of the `cc_prev_req` chain.
- Pool failovers roll the wire session id: the first account span of a harness session reuses the harness session id verbatim (single-account sessions are unchanged), and every later account span gets a fresh UUID (`claudeWireSessionId`, bounded at 256), so one conversation never spans two account identities; switching back resumes the original id and chain.
- Wire-builder rejections map through `mapClaudeWireError` to `INVALID_REQUEST` errors naming the wire code (`INVALID_EFFORT`, `INVALID_THINKING`, `UNSUPPORTED_CAPABILITY`, `CRYPTO_UNAVAILABLE`, `INVALID_IDENTITY`, `INVALID_UNICODE`, and the rest by default); `INPUT_TOO_LARGE` alone goes through the offload path. Do not let a `ClaudeCodeWireError` surface as a generic transport failure.
- Oversize: the builder's `INPUT_TOO_LARGE` maps through `oversizeWireError` to the logged image-offload error; the exact-body 32 MB check stays in `assertClaudeRequestBytes`.
- Mid-conversation system messages ride as user-role `<system-reminder>` blocks on every model — the wire contract models no system-role message, so the old Opus 5 system-role form is gone.
- The usage/models/Files endpoints present the pinned profile's user-agent (`CLAUDE_USER_AGENT`); the local `claude --version` probe is deleted.
- The npm dependency is GPL-3.0-or-later. The plugin is `private: true` and its artifact is not redistributed; keep the exact version pin and this note if the artifact is ever published.
- Tests: `test/claude-wire.spec.ts` (pin, billing/correlation, header plan, breakpoints, chaining, oversize), plus the updated `translate.spec.ts` and `models.spec.ts`. All injected, no credentials.

### Rate-limit state on the usage cards

Each Claude response's `anthropic-ratelimit-unified-*` headers are captured in
`ClaudeAdapter.streamCore` before the response is classified, so a refusal's headers are kept
too, and they reach the Settings usage card through the usage RPC as `rateLimit` alongside the
pool's own `pool` state. The card renders one red line, preferring the header state over the
percentage-derived one and saying whether the account is the constraint or the pool is
(`poolHealth.accountCooling` plus whether a non-cooling peer of the same provider exists).
State is bounded like the wire chain and dropped on login, logout, and credential death.

**Preservation rule.** Keep the capture before the `response.ok` check — moving it after
loses the headers of every refusal — and keep the account-versus-pool split: a dead login is an
account condition even when other accounts could serve.

**Focused verification.** `test/unified-rate-limit.spec.ts` covers parsing and bounding,
`test/claude-rate-limit-capture.spec.ts` covers capture on a warning and on a refusal, and
`test/usage-alert.spec.ts` covers the attribution precedence.

### Request images

`src/translate/resolved.ts` uses the Harness request-variant API for all subscription routes and respects logged image offloads. Claude supplies count-dependent dimensions and model-tier count limits from `src/providers/claude-images.ts`, then checks the exact JSON request-body bytes before dispatch. Preserve each occurrence’s durable reference metadata beside its actual preview dimensions, route changes from the normalized source, and fetch injection for credential-free regression tests. `test/image-policy.spec.ts` uses real temporary attachment stores to cover 20/21 images, model switches, text-only projection, count/body limits, and final Claude request bytes. The source requires the fork Harness export `prepareRequestImages`; package and deploy both together after stopping the Host.

### Cursor

Files: `src/providers/cursor.ts`, `src/auth/store.ts` (`CursorSession`), `src/index.ts`, `src/client/`, `src/providers/catalog-store.ts`, `src/provider-settings.ts`, `tsdown.prepare.config.ts` (`@cursor/sdk` stays external), `package.json` `optionalDependencies.@cursor/sdk` `1.0.32`, `test/cursor.spec.ts`.

- Login uses the browser handshake (`loginDeepControl` plus `POST /auth/poll`), then mints a user API key. Chat uses only that key. `dashboardAccessToken` and `dashboardRefreshToken` are a separate pair used only for usage. Accounts stored before those fields exist must log in again. Do not read the IDE `state.vscdb`, and do not refresh the IDE session.
- Do not pass `systemPrompt` to `Agent.create`. This SDK rejects `--system-prompt`. Prefix system text onto the user prompt.
- Send `tools: []` when the harness has no tools, and `tools: ['mcp']` when custom tools exist. An empty allowlist turns off the MCP group those tools belong to.
- Usage calls `GetCurrentPeriodUsage` and `GetPlanInfo` with the dashboard JWT, on Claude's existing triggers only: the settings card appearing, a manual refresh, pool selection, and the composer badge's 15-minute read. No extra timer. Map `apiPercentUsed` to API and `autoPercentUsed` to Auto.
- Catalog parameters from `Cursor.models.list` are only `context`, `reasoning_effort`, `effort`, `reasoning`, `fast`, and `thinking`. The first reasoning-like id feeds the effort picker, `fast` feeds the speed toggle, and `context` is snapped to a catalog value and sent. `thinking` is sent as the catalog default and has no separate control.
- Grok 4.7 advertises `context=500k`, and the local SDK registry rejects that value with `Invalid parameters for registry model`. The desktop app does not use this local path, so 500k works there. On that error, retry once with the next smaller context (`256k`) and remember the rejected value for the process. Keep the selected effort and fast. Do not switch the user onto the Auto router (`default`).
- Assistant and thinking events arrive one token at a time. Keep one prose block open across consecutive events of the same kind. Closing a block per token makes the host render one token per line.
- The usage popover must set `backdrop-filter: var(--dsw-menu-backdrop-filter)` and `--dsw-elevation-stroke-color: var(--dsw-alias-border-l1)` on top of `var(--dsw-specific-menu)`. The fill alone is translucent, so chat text shows through.

### Codex reasoning replay and shared tool-call pairing

Files: `src/providers/reasoning-replay.ts`, `src/translate/tool-pairing.ts`, `src/providers/codex.ts`, `src/providers/copilot.ts`, `src/providers/grok.ts`, `src/index.ts`, `test/codex.spec.ts`, `test/tool-pairing.spec.ts`.

- Codex asks for `reasoning.encrypted_content` on every request, so the completed reasoning items of its response must be captured and replayed on the next request of the same conversation, the way Copilot's already were. `reasoning-replay.ts` owns the capture, the ACCOUNT × CONVERSATION × MODEL scope, the sliding TTL, and the per-scope caps for both adapters; the host drops the store on every codex and copilot auth transition. Keep one copy of that store shared by both adapters.
- Every Responses route repairs tool-call pairing in its body builder with `reconcileResponsesToolCalls`, and Copilot's chat wire repairs it in `copilotChatRequestBody` with `reconcileChatToolCalls`: a `function_call` without its output, an output without its call, and the chat-wire equivalents are all request errors. The repair is local to the assembled request — the durable history is never mutated.
- Focused verification: `test/codex.spec.ts` and `test/tool-pairing.spec.ts`, plus the pairing cases in `test/grok.spec.ts` and `test/copilot.spec.ts`.

### ChatGPT reset credits

Files: `src/providers/codex.ts`, `src/auth/rpc.ts` (`resetCredits`, `consumeResetCredit`), `src/client/ResetCredits.tsx`, `src/client/SubscriptionsSection.tsx`, `src/client/SubscriptionUsageBadge.tsx`, `test/reset-credits.spec.ts`.

- Read `rate_limit_reset_credits.available_count` from the existing `GET /wham/usage` response. Omit the row when the field is absent. Do not invent zero.
- The UI lists credits with `GET /wham/rate-limit-reset-credits` when the user expands the row and caches the list for 5 minutes. Pool usage reads the list when usage reports available credits, to obtain their expiry. A 429 cooldown is not bypassed by a forced refresh.
- Consume with `POST /wham/rate-limit-reset-credits/consume` and body `{credit_id, redeem_request_id}`. The manual dialog creates and retains the UUID across retries. HTTP 200 spends the credit.
- Show the row on the ChatGPT account card and inside the expanded usage dialog. The collapsed pill stays a percentage.
- Preserve the default-off `autoResetCredits` preference in the ChatGPT account manager, strict provider/boolean validation, and the model editor's merge of the latest value. `codex-auto-reset.ts` owns fresh quota checks, earliest-expiry comparison across every logged-in ChatGPT account, serialized manual/automatic spends, and durable account/card claims before POST. Missing data must never authorize spending. Another account having quota does not prevent the current account from using the globally earliest card. Known exhaustion checks occur at the Codex request and depleted sticky-pool seams; image/search tools do not spend automatically.
- Keep `test/codex-auto-reset.spec.ts`, the sticky recovery case in `test/pool.spec.ts`, preference/RPC tests, `test/account-manager-browser.mjs`, and the automatic-credit cases in `snapshots/session/subscription-pool-routing`. Every consume operation in tests is injected; no real credit may be used for verification.

### Subscription pool scheduling

Files: `src/providers/pool.ts`, `pool-usage.ts`, `pool-scheduling.ts`, `src/index.ts`, and the matching pool tests. The README owns `pool.scheduling` defaults. Preserve bounded reset preferences for Claude and ChatGPT, ChatGPT finishing that fades the ample-quota baseline, a finite reset-card bonus, and hysteresis over the same load-adjusted score. Claude and ChatGPT enter the full-quota fallback band at 100%; automatic credit spending is separately opt-in.

Selection and reservation are synchronous after quota reads. The account counter spans model pools in one Host and covers first-byte waits through iterator cleanup. Release on every outcome, keep visible streams on their original account, and retain the barriers in the concurrency tests. Expired windows stop contributing and refresh without turning stale endpoint responses into a polling loop. Keyless profile evidence lives in `snapshots/session/subscription-pool-routing`.

### Subscription network retries

`AccountPreferencesAdapter.providerRetryPolicy` must forward the raw adapter policy to the registered Host route, preserving ten retries and the subscription backoff. When an attempted pool member remains available after a transport failure, `PoolAdapter` returns that member's original error; it must not borrow a different account's multi-hour quota or authentication cooldown. Only a fully cooling pool supplies a synthesized recovery delay. Preserve the two attempt-order cases in `test/pool.spec.ts`, the facade policy case in `test/account-preferences.spec.ts`, and `snapshots/session/subscription-network-retry`, which records recovery before and after partial output through the real agent retry executor. Keep `rateLimit.wait: false` independent from network retry eligibility.

### Context setting

`contextWindows` is stored for `codex` and `cursor` only. Codex caps local history at the advertised maximum and does not enlarge the API window. Cursor snaps the number onto a catalog `context` value and sends that parameter, then applies the 500k fallback above.

ChatGPT prompt caching has no `cache_control` field. The plugin already sends `prompt_cache_key` from the session id. Do not expect Claude's explicit breakpoint hit rate from this route.

### Windows credential store

`writeStore` in `src/auth/store.ts` writes `auth.json` to a temp file and renames it into place. On Windows that rename returns `EPERM` when the destination is briefly locked. Retry the rename, then copy the finished temp file over `auth.json`. A failed replace drops the login that just completed, including a new Cursor account.

## Verification and packaging

Build the Harness from the repository root first with `pnpm run build`. The fork compiler resolves the LLM and attachment declarations from that build; `test/isolate-home.mjs` selects the repository TypeScript paths before the ESM-only test hook loads. Run the following from this directory:

```powershell
corepack pnpm@10.30.2 install --frozen-lockfile --ignore-scripts --ignore-workspace
corepack pnpm@10.30.2 build
corepack pnpm@10.30.2 test
corepack pnpm@10.30.2 pack --pack-destination ..\releases
```

Store the artifact's uppercase SHA-256 beside it as `<name>-<version>.tgz.sha256`. Inspect the packed manifest before installation.

## Deployment

The live Web profile pins the plugin through a `file:` reference to the tarball in `fork-plugins/releases/`; the credential store lives separately under `DSH_HOME\plugins\subscriptions\` and must never be touched by a code swap. Deploy by stopping the Host, then running `fork-plugins/deploy-subscriptions-web.ps1` from a plain PowerShell window (defaults to the newest version; sha256-verifies the artifact, refuses while the Host listens on port 3080, backs up the installed copy plus `package.json`/`pnpm-lock.yaml`, and swaps through `pnpm add` so a later `pnpm install` cannot downgrade). Restart the Host with its usual launch command. Rollback is the previous tarball through the same `pnpm add` form.

## Updating upstream

Import an exact reviewed tag through the subtree, reapply the RC.1 cohort and lifecycle adaptations, then reapply every item under "Reapply after an upstream import" above. Run the package suite, advance the private version, and rebuild the fixed artifact. Never install npm `@latest` directly into the live profile.

## Rollback

Rollback changes only the pinned package and profile configuration after DSH stops. Preserve the plugin credential store and do not rewrite Session, attachment, or provider-account data.
