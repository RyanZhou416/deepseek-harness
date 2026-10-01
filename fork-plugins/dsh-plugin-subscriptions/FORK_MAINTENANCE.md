# Subscriptions fork maintenance

This subtree carries the private `dsh-plugin-subscriptions` build shipped with this fork.

## Provenance

- Upstream repository: `https://github.com/V1ki/dsh-plugin-subscriptions.git`
- Upstream tag: `v0.9.4`
- Fork package version: `0.9.4-dsh017rc1.3`
- Subtree path: `fork-plugins/dsh-plugin-subscriptions`
- Distribution artifact: `fork-plugins/releases/dsh-plugin-subscriptions-0.9.4-dsh017rc1.3.tgz`

## Fork behavior

The fork keeps upstream provider, account, credential-store, request-translation, and tool names. It uses the RC.1 awaited `agent/created` payload and exact DSH dependency cohort. The V4 adapter maps first-class `role: 'tool'` messages to the existing provider translators' result blocks, preserving call id, failure flag, order, and image attachments; developer messages fail explicitly until a provider supports them. The independent test environment installs the UI primitive runtime dependencies that the Harness Web application normally supplies.

Each Node test process gets a private temporary `DSH_HOME` before plugin imports. Codex and Grok stream tests inject their fetch implementation through the adapter's existing option, so a developer's proxy configuration and credentials cannot redirect synthetic requests to real providers. Production routes still use the configured proxy.

No Session event or Session format changes. Existing Codex, Claude, Grok, Copilot, and Antigravity session objects are unchanged. Cursor adds fields; see below. Existing subscription credentials remain owned by the plugin's configured DSH home and are not copied into this repository.

## Reapply after an upstream import

`V1ki/dsh-plugin-subscriptions` v0.9.4 does not contain the behaviors in this section. A subtree import overwrites `src/`, `test/`, and `package.json`. Restore every item here before packaging, then run the package suite and rebuild the tarball. The tests named below fail if the behavior was dropped.

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

Store the artifact's uppercase SHA-256 beside it as `dsh-plugin-subscriptions-0.9.4-dsh017rc1.3.tgz.sha256`. Inspect the packed manifest before installation.

## Updating upstream

Import an exact reviewed tag through the subtree, reapply the RC.1 cohort and lifecycle adaptations, then reapply every item under "Reapply after an upstream import" above. Run the package suite, advance the private version, and rebuild the fixed artifact. Never install npm `@latest` directly into the live profile.

## Rollback

Rollback changes only the pinned package and profile configuration after DSH stops. Preserve the plugin credential store and do not rewrite Session, attachment, or provider-account data.
