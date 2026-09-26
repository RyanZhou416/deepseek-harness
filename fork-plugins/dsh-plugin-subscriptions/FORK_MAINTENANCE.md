# Subscriptions fork maintenance

This subtree carries the private `dsh-plugin-subscriptions` build shipped with this fork.

## Provenance

- Upstream repository: `https://github.com/V1ki/dsh-plugin-subscriptions.git`
- Upstream tag: `v0.9.4`
- Fork package version: `0.9.4-dsh017rc1.1`
- Subtree path: `fork-plugins/dsh-plugin-subscriptions`
- Distribution artifact: `fork-plugins/releases/dsh-plugin-subscriptions-0.9.4-dsh017rc1.1.tgz`

## Fork behavior

The fork keeps upstream provider, account, credential-store, request-translation, and tool names. It uses the RC.1 awaited `agent/created` payload and exact DSH dependency cohort. The V4 adapter maps first-class `role: 'tool'` messages to the existing provider translators' result blocks, preserving call id, failure flag, order, and image attachments; developer messages fail explicitly until a provider supports them. The independent test environment installs the UI primitive runtime dependencies that the Harness Web application normally supplies.

Each Node test process gets a private temporary `DSH_HOME` before plugin imports. Codex and Grok stream tests inject their fetch implementation through the adapter's existing option, so a developer's proxy configuration and credentials cannot redirect synthetic requests to real providers. Production routes still use the configured proxy.

No Session event or Session format changes. Existing Codex, Claude, Grok, Copilot, and Antigravity session objects are unchanged. Cursor adds fields; see below. Existing subscription credentials remain owned by the plugin's configured DSH home and are not copied into this repository.

## Reapply after an upstream import

`V1ki/dsh-plugin-subscriptions` v0.9.4 does not contain the behaviors in this section. A subtree import overwrites `src/`, `test/`, and `package.json`. Restore every item here before packaging, then run the package suite and rebuild the tarball. The tests named below fail if the behavior was dropped.

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
- List credits with `GET /wham/rate-limit-reset-credits` only when the user expands the row. Cache that list for 5 minutes. A 429 cooldown is not bypassed by a forced refresh.
- Consume with `POST /wham/rate-limit-reset-credits/consume` and body `{credit_id, redeem_request_id}`. The client creates the UUID when the confirm dialog opens and reuses it if that attempt is retried. HTTP 200 spends the credit. The pool never calls consume.
- Show the row on the ChatGPT account card and inside the expanded usage dialog. The collapsed pill stays a percentage.

### ChatGPT pool selection

Files: `src/providers/pool.ts`, `src/providers/pool-usage.ts`, `src/providers/common.ts` (`ProviderUsage.resetCredits.soonestExpiresAt`), `test/pool.spec.ts`.

- Other providers still treat a window as full at 95 percent. A ChatGPT account stays in the quota band until a window reaches 100 percent.
- Among ChatGPT accounts that still have quota, sort first an account whose weekly window opened within 24 hours and whose soonest available reset credit expires within 3 days. Sticky hysteresis is unchanged: another account must beat the current account's urgency by `switchMargin` (default 2) to take the session.
- Full accounts stay in the tail. Accounts matching the fresh-window and expiring-credit rule lead that tail. A credit does not promote an account whose weekly window is about to reset on its own.
- Pool selection loads usage through `fetchCodexPoolUsage`. That reads the credit list only when `available_count` is greater than zero, so expiry is known. A list failure leaves the usage snapshot without an expiry. This adds no timer.

### Context setting

`contextWindows` is stored for `codex` and `cursor` only. Codex caps local history at the advertised maximum and does not enlarge the API window. Cursor snaps the number onto a catalog `context` value and sends that parameter, then applies the 500k fallback above.

ChatGPT prompt caching has no `cache_control` field. The plugin already sends `prompt_cache_key` from the session id. Do not expect Claude's explicit breakpoint hit rate from this route.

## Verification and packaging

Run from this directory:

```powershell
corepack pnpm@10.30.2 install --frozen-lockfile --ignore-scripts --ignore-workspace
corepack pnpm@10.30.2 build
corepack pnpm@10.30.2 test
corepack pnpm@10.30.2 pack --pack-destination ..\releases
```

Store the artifact's uppercase SHA-256 beside it as `dsh-plugin-subscriptions-0.9.4-dsh017rc1.1.tgz.sha256`. Inspect the packed manifest before installation.

## Updating upstream

Import an exact reviewed tag through the subtree, reapply the RC.1 cohort and lifecycle adaptations, then reapply every item under "Reapply after an upstream import" above. Run the package suite, advance the private version, and rebuild the fixed artifact. Never install npm `@latest` directly into the live profile.

## Rollback

Rollback changes only the pinned package and profile configuration after DSH stops. Preserve the plugin credential store and do not rewrite Session, attachment, or provider-account data.
