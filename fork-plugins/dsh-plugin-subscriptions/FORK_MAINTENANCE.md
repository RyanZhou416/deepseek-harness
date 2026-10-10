# Subscriptions fork maintenance

This subtree carries the private `dsh-plugin-subscriptions` build shipped with this fork.

## Provenance

- Upstream repository: `https://github.com/V1ki/dsh-plugin-subscriptions.git`
- Upstream tag: `v0.9.4`
- Fork package version: `0.9.4-dsh017rc1.18`
- Subtree path: `fork-plugins/dsh-plugin-subscriptions`
- Distribution artifact: `fork-plugins/releases/dsh-plugin-subscriptions-0.9.4-dsh017rc1.18.tgz`

## Fork behavior

The fork keeps upstream provider, account, credential-store, request-translation, and tool names. It uses the RC.1 awaited `agent/created` payload and exact DSH dependency cohort. The V4 adapter maps first-class `role: 'tool'` messages to the existing provider translators' result blocks, preserving call id, failure flag, order, and image attachments; developer messages fail explicitly until a provider supports them. The independent test environment installs the UI primitive runtime dependencies that the Harness Web application normally supplies.

Each Node test process gets a private temporary `DSH_HOME` before plugin imports. Codex and Grok stream tests inject their fetch implementation through the adapter's existing option, so a developer's proxy configuration and credentials cannot redirect synthetic requests to real providers. Production routes still use the configured proxy.

No Session event or Session format changes. Existing Codex, Claude, Grok, Copilot, and Antigravity session objects are unchanged. Cursor adds fields; Claude gains two optional wire-identity fields, see below. Existing subscription credentials remain owned by the plugin's configured DSH home and are not copied into this repository.

## Reapply after an upstream import

`V1ki/dsh-plugin-subscriptions` v0.9.4 does not contain the behaviors in this section. A subtree import overwrites `src/`, `test/`, and `package.json`. Restore every item here before packaging, then run the package suite and rebuild the tarball. The tests named below fail if the behavior was dropped.

### One owner for the provider catalog and pool plumbing

The six adapters used to carry their own copy of the same catalog code: `clearAccountCatalog`
was byte-identical in all six, `catalogFor` and `listModels` in five, and `listOwnModels` was
near-identical with per-provider differences. They now delegate to `provider-catalog.ts`, which
owns the cache, the listing skeleton (account union, per-account bound, abort and credential
error mapping), the picker-row shape, and the pool-tier overlay. Per-provider differences stay
explicit: the discovery timeout hook, each adapter's modality rule and description, the warn
label's capitalisation, and grok's last-known short-circuit.

The account-pool delegation has the same single owner: `PoolBackedAdapter` in
`pool-delegation.ts` owns `listModels` (own rows plus configured tiers), `listOwnModels`,
`resolveModel`, the `stream` pool prelude, and `streamAccount`. An adapter keeps only its own
catalogue data, its model-field assembly (`resolveOwnModel`) and its wire path (`streamOwn`).
`clearAccountCatalog` stays per adapter because claude's also drops the account's uploaded File
ids.

A catalogue entry the provider marks disabled stays listed, and its reason travels all the way to
the surfaces that offer the row: `modelDisabledReason` in `provider-catalog.ts` reads the extension
the adapters put on their rows, `index.ts` carries it into the `modelDefaults` rows and the
`providerSettings` account rows, and the settings model list and the account allowlist print it
through `modelRowLabel` with the localized `modelsDisabled` copy. The harness `LlmModelInfo`
contract has no such field, so the plugin owns the extension and must route every reader through
`modelDisabledReason` rather than re-casting.

The session model picker is not one of those surfaces. It belongs to the harness client, reads the
model catalog RPC, and its `LlmModelInfo` / `ModelCatalogModel` carry no disabled marker, so a
provider-disabled model still appears there as an ordinary selectable row. Making that picker state
the condition is a harness-side change — the model-info contract, the catalog projection, the
picker component, and its locale dictionaries — and is not made from this subtree.

**Preservation rule.** Re-apply the delegation after an upstream import, which would otherwise
restore six copies; keep `clearAccountCatalog` and `resolveOwnModel` as real prototype methods
on the adapters, because `test/model-defaults-rpc.spec.ts` and
`test/provider-settings-rpc.spec.ts` patch `CodexAdapter.prototype.clearAccountCatalog` and
`CodexAdapter.prototype.resolveOwnModel`; and keep `disabledReason` on both RPC payloads, because a
row that loses it reads as an ordinary selectable model. Re-measure the duplication ratchet after
any change here: `package.json`'s `duplication` script holds `packages`/`scripts` at zero and the
plugin path at a threshold just above what remains. Measured on this jscpd build with this config,
the duplicated-lines percentage in the report is the signal: `--threshold` alone does not change
the exit code (any clone exits with the config's `exitCode: 1`, a clone-free run exits 0), so the
script's `--exit-code 0` is what keeps the documented run green.

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

Files: `src/providers/claude-wire.ts`, `src/providers/claude.ts`, `src/providers/claude-catalogue.ts`, `src/providers/claude-images.ts`, `src/translate/anthropic.ts`, `src/transport/bridge.ts`, `src/transport/bun-child.ts`, `src/auth/store.ts`, `src/providers/accounts.ts`, `src/providers/common.ts`, `test/claude-wire.spec.ts`, `test/claude-request-id.spec.ts`, `test/translate.spec.ts`, `test/transport-bridge.spec.ts`, `test/atis-header.spec.ts`, `test/models.spec.ts`, `package.json` (`@tormentalabs/claude-code-wire-compat` exact pin).

- All chat requests build through `buildClaudeCodeRequest` with the pinned `CLAUDE_CODE_2_1_288_PROFILE` (CLI 2.1.288, SDK 0.128.0). The builder owns the billing fingerprint block, the identity system block, beta composition, the `metadata.user_id` correlation triple, cache-breakpoint placement, and the header plan. Do not hand-roll `anthropic-beta`, the billing block, `x-app`, or cache markers again.
- Keep `cacheControl: { enabled, systemBreakpoint, toolBreakpoint, messageBreakpoint, ttl: '1h' }` (the genuine client ships 1h cache markers), `stream: true`, `display: 'summarized'` on the thinking request, and `effort` plus `outputConfig: { effort }` when the model advertises efforts. The builder validates both against the pinned catalogue.
- Header names go out in the client's own mixed casing, because the runtime that performs the fetch preserves it and the request is identified partly by those bytes: `Accept`, `Authorization`, `User-Agent`, `X-Claude-Code-Session-Id`, and the `X-Stainless-*` platform block are title-cased, while `anthropic-beta`, `anthropic-version`, `content-type`, `x-app`, `x-client-request-id`, `x-claude-code-prompt-id`, and `x-claude-code-request-class` are lower-cased. Nothing downstream may route the plan through a `Headers`: `src/transport/bridge.ts` frames the caller's names verbatim, and `src/transport/bun-child.ts` compares its own runtime-version field case-insensitively before replacing it.
- Header plan: `x-claude-code-prompt-id` carries the same value the billing block's `cc_prompt_id` carries, under the same UUID guard, and `x-claude-code-request-class` states the class the client derives from its query source (`main` for this route, whose requests are the conversation's own).
- Identity: `deviceId` and `accountUuid` come from the stored `ClaudeSession` (minted/discovered at login, preserved across refresh, lazily backfilled for pre-upgrade sessions; a failed backfill fails the request with `INVALID_REQUEST` instead of sending a bogus triple). `deviceId` is minted as a 64-hex string (32 random bytes), the genuine client's format, never a UUID. `previousRequestId` chains the response `request-id` header into the next request's billing block, keyed by (canonical account, wire session) so a pool failover never chains another account's request id (bounded at 256 entries); a response without the header clears the chain. `cc_prompt_id` is derived deterministically from (wire session, prompt turn) by `claudePromptId`: the same session and turn always produce the same id and the same request bytes, while another session or the next turn differs. The value is model-visible, so the harness rule that anything a model sees must be reconstructable from the session log requires the derivation — a random UUID is not reconstructable. The turn's tool-continuation steps reuse it; probe/title-helper suppression is not modelled. The response's `request-id` header is recorded on that assistant message's replay envelope as `response.requestId`, the checkable counterpart of the `cc_prev_req` chain.
- The session identity is a UUID in both places the client declares it, `X-Claude-Code-Session-Id` and `metadata.user_id.session_id`, so `claudeWireSessionId` mints one per (canonical account, harness session) and `buildClaudeWireRequest` refuses a wire session id that is not UUID-shaped. The harness session id is the key that table is indexed by, never a value on the wire: it is `session-<uuid>`, which no genuine client sends. Every account span of a harness session gets its own UUID (`claudeWireSessionId`, bounded at 256), so one conversation never spans two account identities; switching back resumes the original id and chain.
- The system prompt has exactly one carrier. When the loop supplied `systemSections`, those sections are it: the leading system-role message of the derived history holds the same rendered prompt, and lifting it into the `system` array would both send the prompt twice and put the unfiltered `harness:identity` text and the machine-local `harness:source` checkout path on the wire. A request without sections still passes `options.system` and the history's leading system text through `toAnthropicSystem`.
- Wire-builder rejections map through `mapClaudeWireError` to `INVALID_REQUEST` errors naming the wire code (`INVALID_EFFORT`, `INVALID_THINKING`, `UNSUPPORTED_CAPABILITY`, `CRYPTO_UNAVAILABLE`, `INVALID_IDENTITY`, `INVALID_UNICODE`, and the rest by default); `INPUT_TOO_LARGE` alone goes through the offload path. Do not let a `ClaudeCodeWireError` surface as a generic transport failure.
- Oversize: the builder's `INPUT_TOO_LARGE` maps through `oversizeWireError` to the logged image-offload error; the exact-body 32 MB check stays in `assertClaudeRequestBytes`.
- Mid-conversation system messages ride as user-role `<system-reminder>` blocks on every model — the wire contract models no system-role message, so the old Opus 5 system-role form is gone.
- The usage/models/Files endpoints present the pinned profile's user-agent (`CLAUDE_USER_AGENT`); the local `claude --version` probe is deleted.
- The model catalogue is the client's baked-in table plus the account's own options. `claudeBuiltInCatalogue` takes membership from the pinned profile's `supportedModels` and supplies the display text the wire library deliberately omits; `fetchClaudeCatalogue` merges the bootstrap document's `additional_model_options` onto that table — an option naming a built-in id rewrites that row in place, a new id is appended, and a `disabled_reason` marks the row unavailable instead of dropping it. The endpoint carries additions only, so it must never be the sole source: a refused or malformed response leaves the built-in table standing. A configured non-empty `models.claude` list still overrides discovery.
- Reported model capacity comes from `src/providers/claude-model-limits.ts`: the Claude API documentation's per-model limits answer first and the pinned profile's catalogue entry second, and an id neither source names takes a conservative 200K context / 32K output pair. A documented 1M window that only the `context-1m-2025-08-07` beta reaches is reported at the catalogue's own window instead, because this route sends a plain model id and never composes that beta (`claude-sonnet-4-6` and `claude-opus-4-6` today).
  **Preservation rule.** An upstream import restores a universal 200K/32K fallback and reports the beta-gated million. Keep the documented table ahead of the catalogue, and keep `documentedWindowReachable` withholding a window no request on this route can use.
- `x-claude-code-request-class` follows the call's purpose as the genuine client derives it from its query source: `compaction` for a compact call, `auxiliary` for the session-title helper, `main` for everything else. The `context_management` body field is asserted to travel with the `context-management-2025-06-27` beta, because the builder decides the beta from the model's capability while the adapter decides the field from its planned edits.
  **Preservation rule.** An upstream import restores a hard-coded `main` and drops the coupling assertion. Keep `claudeRequestClass` fed from `GenerateOptions.purpose` and `assertContextManagementBeta` on the builder's result.
- The context edits themselves are planned in `src/providers/context-management.ts`, and two of its decisions deliberately differ from the genuine client:
  - **It clears by default.** `planContextManagement` states an edit from its own thresholds alone, while the client reaches the same two edits only when its `tengu_zany_pike` gate is on, and that gate defaults off. Thinking is cleared whenever a request carries thinking (`keep: 'all'`), and the tool edit fires when the adapter's measured silence reaches 3,900,000 ms and the clearable result count — text results of at least 64 characters, any image or file result, estimated at four characters per token — minus three exceeds both the five kept and the minimum trigger of twenty, stating `keep: 5` and `clear_at_least: 20,000` input tokens.
    **Preservation rule.** Keep the plan unconditional. Reproducing the client's default-off gate would silently stop clearing in every deployment, which is the opposite of what this route wants; keep the numbers as the client's own and keep them in this module rather than inline in `claude.ts`.
  - **The idle interval comes from this plugin, not from the transcript.** The client measures the gap between consecutive transcript messages; the harness transcript carries no timestamps. `ClaudeAdapter` therefore keeps a per-session request clock — bounded at 64 sessions, evicting the oldest — and reads the gap between a session's consecutive requests as the same silence, remembering a break it already acted on so one long gap keeps clearing until a request follows it.
    **Preservation rule.** Keep the clock in `claude.ts` and keep returning the threshold for a break already acted on. There are no transcript timestamps to read instead, and deriving the gap anywhere but the adapter's own request path would measure a different quantity.
- The tool-clearing edit states its trigger, keep count and `clear_at_least` and never `exclude_tools`, although the pinned `ClearToolUses20250919Edit` carries that field. The condition the field exists for — a tool whose results must survive clearing — never occurs on this route, because the harness registers no such tool.
  **Preservation rule.** Leave `exclude_tools` off rather than restoring it from the client's request shape; an empty or invented exclusion list changes nothing the API does and would only look like fidelity.
- The npm dependency is GPL-3.0-or-later. The plugin is `private: true` and its artifact is not redistributed; keep the exact version pin and this note if the artifact is ever published.
- Tests: `test/claude-wire.spec.ts` (pin, billing/correlation, header plan and casing, breakpoints, chaining, the single system-prompt carrier, the wire-session rule, oversize, the request class per call kind, and the context-management field with its beta), plus `test/context-management.spec.ts` (the two edits, their thresholds, and the requests that state neither), `test/claude-request-id.spec.ts` (the wire session identity end to end), `models.spec.ts` (the built-in catalogue with no request, the account's options merged onto it rather than replacing it, a disabled option surfacing as a disabled row, and the per-model reported capacity across documented, catalogue, and beta-gated windows), and the updated `translate.spec.ts`, `test/transport-bridge.spec.ts` and `test/atis-header.spec.ts`. All injected, no credentials.

### Rate-limit state on the usage cards

Each Claude response's `anthropic-ratelimit-unified-*` headers are captured in
`ClaudeAdapter.streamOwn` before the response is classified, so a refusal's headers are kept
too, and they reach the Settings usage card through the usage RPC as `rateLimit` alongside the
pool's own `pool` state. The card renders one red line, preferring the header state over the
percentage-derived one and saying whether the account is the constraint or the pool is.
`usagePoolState` in `pool.ts` computes that split from the pool's own rule: the account's
parking record, plus whether a peer exists whose health record is clear AND that is not past a
Claude usage floor. Health alone would let the card claim a failover that cannot happen. The
floor test is model-independent (`PoolAdapter.accountAtFloor` reads the session and weekly
windows through a model-less `quotaFor`), so a Settings read still triggers no model discovery.
State is bounded like the wire chain and dropped on login, logout, and credential death.

**Preservation rule.** Keep the capture before the `response.ok` check — moving it after
loses the headers of every refusal — and keep the account-versus-pool split: a dead login and an
`allowed_warning` near-limit verdict are account conditions even when other accounts could serve.
A pool attribution is only printed for a peer the pool would itself accept, so keep the floor
check in the peer test rather than reverting it to `health.isAvailable`.

**Focused verification.** `test/unified-rate-limit.spec.ts` covers parsing and bounding,
`test/claude-rate-limit-capture.spec.ts` covers capture on a warning and on a refusal,
`test/usage-alert.spec.ts` covers the attribution precedence, and the peer rule is covered by
`test/pool.spec.ts` ("the usage card counts a peer only when the pool would accept it").

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

### The pool's availability rule outside the pool

A model the pool owns no entry for is served by `AccountPreferencesAdapter.fallback`, which walks the logged-in accounts in the pool's own availability order. It asks `PoolAdapter.accountHoldback` why an account is held back, and when no account qualifies it reports that same cause and hint: the code `exhaustionCode` derives from the collected holdback reasons (a cooling record's own code, `RATE_LIMIT` for a breached usage floor) and the earliest `providerRetryAfterMs` among them. `NO_ADAPTER` is reserved for a model no account's catalog lists, because that is the only case a retry cannot fix.

**Preservation rule.** Keep the fallback's terminal error sourced from `accountHoldback` rather than a boolean availability test: a temporary quota condition reported as `NO_ADAPTER` names an unavailable model, drops the provider's disclosed recovery instant, and takes the turn out of the retry policy. Do not move the holdback decision out of `pool.ts`, and do not let the fallback consult health directly.

**Focused verification.** `test/account-preferences.spec.ts` covers the held-back-by-everything case (cause plus recovery hint), the refusal that outranks a rate limit, and the unlisted model that stays `NO_ADAPTER`; `test/pool.spec.ts` covers the floor-holdback code and reset hint through the pool-exhausted path.

### Enforcement-shaped refusals

Files: `src/providers/common.ts`, `pool-health.ts`, `pool.ts`, `image-pool.ts`, `unified-rate-limit.ts`, `test/rate-limit.spec.ts`, `test/pool-health.spec.ts`, `test/pool.spec.ts`, `test/image-pool.spec.ts`, `test/unified-rate-limit.spec.ts`.

An upstream import restores a classifier that reads every 429 as a retryable `RATE_LIMIT` and every 403 as a switchable `AUTH`, which answers a refusal with one request per pool account and then ten more rounds of them. Keep the enforcement classification instead:

- `httpLlmError` classifies as `ENFORCEMENT` (through `isEnforcementRefusal`) when the provider stated the refusal is final: `x-should-retry: false`, a unified `-status` or `-overage-status` of `rejected`, a disabled organisation/seat/member `overage-disabled-reason`, billing or credit wording, or a 429 that disclosed no reset. `ENFORCEMENT` is deliberately absent from `SUBSCRIPTION_RETRYABLE_CODES`, and a disclosed reset still rides `providerRetryAfterMs` as the park duration.
- `pool-health.ts` owns the refusal vocabulary: `isRefusalCode` names the codes a pool must not answer from another account, and `exhaustionCode` reports one of them ahead of any other reason.
- `classifyPoolFailure` returns `park` for `ENFORCEMENT` and for the credential codes: the account is parked (its disclosed reset, else `DEFAULT_QUOTA_COOLDOWN_MS`, or `AUTH_COOLDOWN_MS` for a dead login) and the turn ends on the original error without contacting another member.
- `exhausted()` and the image pool's all-accounts-cooling error both report through `exhaustionCode`, so a pool that ran out alongside a refusal stays non-retryable.
- `ImageAccountPool` applies the same split to its own health registry and switch loop: an enforcement or credential refusal parks the account and ends the attempt, an ordinary rate limit with a disclosed reset still fails over to the sibling, and its own duplicate-image rule (transport, timeout, 5xx and invalid requests are never resent) is untouched.
- `parseUnifiedRateLimit` reports `other`, not `allowed`, when a report carried no status member.
- The same refusal can arrive inside a 200 as an `error` event. `AnthropicStreamTranslator` takes the caller's `AnthropicRefusalProbe`, and `ClaudeAdapter.streamOwn` supplies one that classifies the event against the response it arrived on, so an in-band `rate_limit_error` the response marks final raises `ENFORCEMENT` while an ordinary one with a disclosed reset keeps `RATE_LIMIT`. The probe is consulted for the retryable event type only: `AUTH` and `CONTEXT_WINDOW_EXCEEDED` keep their codes.
- Only the ordinary disclosed-reset 429 keeps failover, and an `ENFORCEMENT` refusal does not invalidate the usage cache, so a refusal costs no `/api/oauth/usage` poll.

**Preservation rule.** The genuine client is the reference: it stops retrying on `x-should-retry: false`, on the `org_spend_cap_reached` / `org_level_disabled_until` / `org_level_disabled` / `org_service_level_disabled` / `out_of_credits` reasons, and on `credits_required`, "usage credits are required", and "extra usage is required" wording. Do not fold `ENFORCEMENT` back into `RATE_LIMIT` or `AUTH` to shorten the diff, and do not list it among the retryable codes. Keep the refusal rule in `pool-health.ts` rather than in either pool, so the chat pool and the image pool cannot drift apart.

**Focused verification.** `test/rate-limit.spec.ts` covers each signal plus the ordinary rate limit that must keep its code, `test/pool-health.spec.ts` the classification, the refusal vocabulary, and the exhaustion precedence, `test/pool.spec.ts` the missing sibling request, the unchanged usage snapshot, and the exhaustion precedence end to end, `test/image-pool.spec.ts` the enforcement and auth refusals, the park duration, and the exhausted-pool code, `test/unified-rate-limit.spec.ts` the statusless report, `test/translate.spec.ts` the translator's two in-band directions, and `test/claude-rate-limit-capture.spec.ts` the same split through the adapter with a real response.

### Context setting

`contextWindows` is stored for `codex` and `cursor` only. Codex caps local history at the advertised maximum and does not enlarge the API window. Cursor snaps the number onto a catalog `context` value and sends that parameter, then applies the 500k fallback above.

ChatGPT prompt caching has no `cache_control` field. The plugin already sends `prompt_cache_key` from the session id. Do not expect Claude's explicit breakpoint hit rate from this route.

### Windows credential store

`writeStore` in `src/auth/store.ts` writes `auth.json` to a temp file and renames it into place. On Windows that rename returns `EPERM` when the destination is briefly locked. Retry the rename, then copy the finished temp file over `auth.json`. A failed replace drops the login that just completed, including a new Cursor account.

The 0600 write mode is the owner-only guarantee on POSIX only. Windows keeps the mode byte without turning it into an ACL, so the store inherits the ACL of the directory holding it, and a harness home under a path that grants `Authenticated Users` Modify leaves the bearer tokens readable by every authenticated user of the machine. Node cannot narrow that: the fix is an ACL on the home directory (`icacls`), not a code change.

### Host-published proxy policy

Files: `src/transport/host-egress.ts`, `src/http.ts` (`proxiedFetch`), `src/transport/claude-fetch.ts`, `test/proxy-host.spec.ts`, `test/transport-wiring.spec.ts`.

A launcher that configures a proxy publishes its resolved policy into the process environment before any plugin mounts — `HTTP_PROXY` / `HTTPS_PROXY`, `NO_PROXY`, and the mandatory Claude route `DSH_CLAUDE_PROXY_URL` — and the dispatcher it installed is what applies that policy to an ordinary `fetch`. This plugin declares no dependency on the host's transport package (it lives outside the workspace, so the seam is not resolvable from its directory, and a bundled copy would read module state that is always empty), so the published environment is the honest seam:

- `proxiedFetch` attaches no dispatcher of its own to a Claude destination (`anthropic.com`, `claude.com`) while `DSH_CLAUDE_PROXY_URL` is published: the installed dispatcher applies the mandated route to Messages, token refresh, usage and profile alike, ahead of the plugin's own proxy.
- For every other destination it leaves the process dispatcher in charge whenever the host published a proxy for the request's scheme and the plugin's own proxy did not take the request, so this module's direct agent cannot carry it around that proxy. `NO_PROXY` and loopback decisions stay the installed dispatcher's rather than a second matcher here.
- The plugin's own proxy and its bypass list still decide the requests they cover, and when the host published nothing the plugin's direct agent (which carries the module's connect budget) is attached to the remaining ones as before.
- The Bun bridge refuses the Messages request with `BridgeUnavailableError` naming the variable and its credential-free origin, before the child is resolved or spawned. The child runs its own runtime and its environment allowlist carries no such variable, so a bridge that took the request would send it outside the route. `DSH_SUBSCRIPTIONS_BRIDGE=off` is the offered remedy and stays inside the route, because the fallback path defers to the host dispatcher as described above.

**Preservation rule.** An upstream import restores none of this. Keep `host-egress.ts`, the three decision points above, and the refusal ahead of `startBridge`. Importing the host's own seam (`proxyRouteFor` / `proxyEnvironmentForChild`) is deliberately not taken: the package is not resolvable from this plugin's directory, and declaring it would mean making the plugin a workspace member. Bridge proxy support, which would let the bridge carry the route instead of refusing it, stays deferred until Bun's proxy-environment behavior is measured and `Config` gains its switch.

**Verification.** `test/proxy-host.spec.ts` proves the deferral on both Claude hosts and on a published general route, that the plugin route and its own direct agent survive when nothing is published, that a refusal names no proxy credential, and that an enabled plugin proxy still carries other providers; `test/transport-wiring.spec.ts` proves the refusal precedes the child and that the child environment never receives the variable.

### Endpoint and credential guards

Files: `src/providers/claude.ts`, `src/providers/antigravity.ts`, `src/auth/device-flow.ts`, `src/http.ts` (the probe), `src/auth/store.ts` (`accountKeyOf` and the store read), `test/login.spec.ts`, `test/antigravity.spec.ts`, `test/copilot.spec.ts`, `test/proxy-host.spec.ts`, `test/rpc.spec.ts`, `test/store.spec.ts`, `test/cursor.spec.ts`.

- `CLAUDE_CODE_CUSTOM_OAUTH_URL` moves both Claude OAuth URLs to the origin it names, and only the three endpoints the genuine client approves are accepted — `beacon.claude-ai.staging.ant.dev`, `claude.fedstart.com`, `claude-staging.fedstart.com`, after dropping one trailing slash and matching exactly. An unapproved value aborts module load. The launcher's `.env` rules admit this name from the invoking directory, which arrives with a clone, so anything looser lets a repository choose the endpoint that receives the account's tokens.
- Every token request refuses redirects: the Claude code exchange and refresh, the Antigravity code exchange and refresh, and both GitHub device-flow requests. A followed redirect replays the code, refresh token, or client secret to another origin, and the device-flow poll would store a token another origin returned.
- The `proxyTest` probe answers only for the API hosts this plugin's providers contact, and refuses a target a host-published route covers (the mandatory Claude route or a published scheme proxy) instead of testing a transport the host never authorized. The refusal lives in `proxyTestConnection`, so no caller can probe around it.
- An account without a display identity is keyed by a random `account-…` id carried by the session, never by a value derived from its refresh token, because `status` serves that key to the web client. A stored `token-…` key is replaced once while reading the store and written back with the old key kept as an alias.

**Preservation rule.** An upstream import restores the https-only OAuth check, the missing `redirect: 'error'`, the unguarded probe target, and the refresh-token-derived key. Keep the approved-endpoint list beside `CLAUDE_TOKEN_URL` in `claude.ts`, the probe refusals inside `proxyTestConnection` rather than only at the RPC payload, and the account id on the session so a refreshed session is written under the key it already has.

**Focused verification.** `test/login.spec.ts` evaluates a fresh `claude.ts` instance under an unapproved and an approved `CLAUDE_CODE_CUSTOM_OAUTH_URL`; `test/antigravity.spec.ts` and `test/copilot.spec.ts` assert `redirect: 'error'` on every token request; `test/proxy-host.spec.ts` covers both refusals and keeps the disabled/bypassed probe on the host dispatcher; `test/rpc.spec.ts` drives `status` over a store holding a token-derived key and asserts the minted key is stable across a fresh mount and written to disk; `test/store.spec.ts` and `test/cursor.spec.ts` pin the identity-less key contract.

### Speed write outcomes

The `/fast` popup and the composer Speed control both settle a picked tier through `settleSpeedTier`. A false answer is the setter's failure result and has to reach the user: the composer control shows `speedSaveFailed` in place inside its still-open menu, and the popup rejects the settlement so the shell's own error strip states the same copy — never a silent close.

**Preservation rule.** An upstream import restores the silent discard at both entry points. Keep the failure surfacing without adding a second notice surface beside the shell's strip.

**Focused verification.** `test/fast-command.spec.ts` covers both outcomes in both languages; `test/rpc.spec.ts` covers the `speed`/`setSpeed` endpoints.

### Locale-owned client copy

`src/client/locales.ts` owns every user-visible string of the client half in both languages, including the badge's window abbreviations and remaining-time templates, the tool-row titles, and the absolute-time template behind `src/client/format.ts`. The zh dictionary is typed against the en keys, so a missing translation fails the build.

**Preservation rule.** An upstream import restores hard-coded copy. Route new strings through `locales.ts` and `t`, and format dates through `formatDateTime` rather than `Date#toLocaleString`, which follows the browser language instead of the app locale.

**Focused verification.** `npx pnpm run verify-client-ui-i18n` from the repository root scans this subtree; `test/subscriptions-date-format.spec.ts`, `test/subscription-usage-badge.spec.ts`, and `test/account-manager-ui.spec.ts` cover the localized output. The upstream `dsh-agent-teams` and `dsh-context` subtrees stay outside that gate.

## Verification and packaging

Build the Harness from the repository root first with `pnpm run build`. The fork compiler resolves the LLM and attachment declarations from that build; `test/isolate-home.mjs` selects the repository TypeScript paths before the ESM-only test hook loads. Run the following from this directory:

```powershell
corepack pnpm@10.30.2 install --frozen-lockfile --ignore-scripts --ignore-workspace
corepack pnpm@10.30.2 build
corepack pnpm@10.30.2 test
corepack pnpm@10.30.2 pack --pack-destination ..\releases
```

Store the artifact's uppercase SHA-256 beside it as `<name>-<version>.tgz.sha256`: one line, the 64 hex digits and nothing else, LF-terminated, no surrounding whitespace and no CR. Inspect the packed manifest before installation.

## Deployment

The live Web profile pins the plugin through a `file:` reference to the tarball in `fork-plugins/releases/`; the credential store lives separately under `DSH_HOME\plugins\subscriptions\` and must never be touched by a code swap. The plugin's own `@tormentalabs/claude-code-wire-compat` dependency must keep the absolute `file:C:/Project/deepseek-harness/fork-plugins/releases/tormentalabs-claude-code-wire-compat-0.7.2-dsh14.tgz` specifier in the packed `package.json`: pnpm resolves a dependency's nested `file:` specifier relative to the installing profile, not to the plugin directory, so `file:../releases/...` made the artifact fail to install with `ENOENT` on `<profiles>\releases\...`. Deploy by stopping the Host, then running `fork-plugins/deploy-subscriptions-web.ps1` from a plain PowerShell window (defaults to the newest version; sha256-verifies the artifact, refuses while the Host listens on port 3080, backs up the installed copy plus `package.json`/`pnpm-lock.yaml`, and swaps through `pnpm add` so a later `pnpm install` cannot downgrade). Restart the Host with its usual launch command. Rollback is the previous tarball through the same `pnpm add` form.

**macOS install limitation.** That same absolute specifier is what lets the artifact install for the consumer, and it is a Windows drive-letter path. The macOS leg of `setup.command` therefore cannot install this plugin as it stands: the profile's install resolves the nested pin against itself and finds no `C:\...` target. The plugin serves the Windows Web profile; macOS support is out of scope by the owner's decision, and the limitation is recorded here rather than worked around. Making both legs work means shipping the wire package inside the plugin package (`bundledDependencies`) instead of referencing a tarball, which changes the release layout and is not done.

## Updating upstream

Import an exact reviewed tag through the subtree, reapply the RC.1 cohort and lifecycle adaptations, then reapply every item under "Reapply after an upstream import" above. Run the package suite, advance the private version, and rebuild the fixed artifact. Never install npm `@latest` directly into the live profile.

## Rollback

Rollback changes only the pinned package and profile configuration after DSH stops. Preserve the plugin credential store and do not rewrite Session, attachment, or provider-account data. The artifact a rollback targets today is the retained previous release, `fork-plugins/releases/dsh-plugin-subscriptions-0.9.4-dsh017rc1.17.tgz`, installed through the same `pnpm add "dsh-plugin-subscriptions@file:<path>"` form the deployment step uses; the current release and every earlier tarball stay in `fork-plugins/releases/`. Never repack or delete a released tarball to make room.
