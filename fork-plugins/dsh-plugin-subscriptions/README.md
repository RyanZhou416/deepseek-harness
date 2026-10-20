# dsh-plugin-subscriptions [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English | [中文](README.zh.md)

Use your **ChatGPT (Codex)**, **Claude**, **Grok (X Premium)**, **GitHub Copilot**, and **Google Antigravity** subscriptions as LLM providers in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — no API keys. Codex, Grok, and Antigravity log in via OAuth in the dsh web UI (Settings → Subscriptions), while Copilot uses the GitHub OAuth device flow; Claude imports credentials from an existing Claude Code session when there is one (macOS Keychain or `~/.claude/.credentials.json`) as a read-only copy it re-reads on each use, and otherwise falls back to the same browser OAuth flow, so the Claude Code CLI is not required. Tokens live at `~/.dsh/plugins/subscriptions/auth.json` (mode 0600) and refresh automatically.

## Demo

Settings → **Subscriptions**: per-provider login/logout, no API keys. Claude imports credentials from Claude Code when available and otherwise uses OAuth, as Codex and Grok always do (settings screenshots use demo accounts and catalog data):

![Subscriptions settings page](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/subscriptions.png)

Configure visibility, default reasoning effort, and context together in **Edit model list**, with shared Save and Cancel actions:

![Model settings](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-settings.png)

Configure image generation, video generation, and X search per provider. Tool switches apply only to sessions created after saving:

![Provider tools](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/provider-tools.png)

Logged-in providers join the session model picker with their live model catalogs:

![Model picker with subscription models](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-picker.png)

Models that advertise reasoning levels get an **Effort** selector in the same menu — Codex models, Grok 4.6 / 4.5, Copilot's reasoning models, and Claude's (levels and defaults come from each provider's own catalog, not a hardcoded list: Claude's from the pinned Claude Code catalog, the others' from their live catalog; Copilot's `capabilities.supports.reasoning_effort` array is sent as `reasoning_effort` on chat completions and `reasoning.effort` on the Responses wire). A level the selected model's catalog does not carry is never offered, and a stored override naming one falls back to the model's own default. Models listing both Copilot endpoints (gpt-5.4, gpt-5-mini) normally speak chat completions but reroute to `/responses` when a request combines function tools with an effort — Copilot rejects that combination on the chat wire:

![Reasoning effort selector](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-effort.png)

Models whose catalog advertises a fast tier get a **Speed** row inside the composer's model menu, under the model and reasoning-level rows: selecting it opens the Standard/Fast pane inside that same card, so the choices stay within the menu's bounds. Fast is each route's own priority signal: Codex sends `service_tier: priority`, Cursor its catalog `fast` parameter, and Claude the Claude Code catalog's `speed: fast` field together with the beta that declares it. The choice is stored per model beside its default reasoning effort, so it survives a new session and a restart, and the model list in **Manage** offers the same Standard/Fast picker next to the effort selector. The `/fast` slash command offers the same choice as a popup; it errors with an explanation when the current model has no fast tier. Reading the speed choice consults only the selected provider's catalog, so an unrelated provider cannot delay this control.

![Speed row inside the model menu, with its Standard/Fast options open](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/speed-toggle.png)

The composer's stats row gains a **subscription usage** pill showing the remaining rate-limit window for the provider of the session's current model (Codex when a GPT model is selected, Grok for a Grok model, and so on). Click it to expand every logged-in provider and account — the default account is starred, and the current provider is listed first:

![Subscription usage pill expanded to show every provider and account](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/usage-badge.png)

The `image_generate` tool renders its result inline in the conversation:

![image_generate renders the image inline](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/image-generate-inline.png)

Its `provider` parameter picks the image backend — the same prompt through GPT (`gpt-image-2`, top) and Grok (`grok-imagine-image-2.0`, bottom):

![image_generate with provider gpt vs grok](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/image-generate-providers.png)

The `video_generate` tool plays the generated clip inline:

![video_generate plays the clip inline](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/video-generate-inline.png)

Requests derive image versions from saved normalized attachments without replacing them. Claude applies an 8,000-pixel long-edge cap, reduced to 2,000 when retained user and tool-result images exceed 20 occurrences; repeated attachments count separately. The model’s context tier controls its 100/600-image ceiling. The exact JSON body is checked against the 32 MB Messages limit before submission. Excess image count or body bytes request logged history offload; text and tools that cannot fit fail explicitly. Switching routes can recover the saved resolution, and offloaded images stay omitted until explicitly read again. Image reference metadata still identifies the saved attachment; the adjacent request-preview dimensions describe what the model receives.

## Providers

| Route    | Subscription      | Models |
|----------|-------------------|--------|
| `codex`  | ChatGPT Plus/Pro  | live catalog from `chatgpt.com/backend-api/codex/models` |
| `claude` | Claude Pro/Max    | all models available in your subscription (Opus, Sonnet, Haiku, Fable — static catalog, updated with the plugin) |
| `grok`   | X Premium (xAI)   | live catalog from `api.x.ai/v1/models` (chat models only); reasoning efforts from the Grok CLI catalog (`cli-chat-proxy.grok.com/v1/models`) |
| `copilot` | GitHub Copilot   | live catalog from `api.githubcopilot.com/models` (chat models on both wires, with per-model vision flags and reasoning efforts); login uses the OAuth device flow (enter the shown code at `github.com/login/device`) |
| `antigravity` | Google Antigravity | live catalog from Antigravity `v1internal:fetchAvailableModels`; requests use `generateContent` / `streamGenerateContent` with text, image, streaming reasoning, and tool-call conversion |

Only logged-in providers appear in the session model picker; the lists above refresh on login/logout. Vision-capable models declare `['text', 'image']` input modalities, and image content is translated to each provider's wire format.

Logged-in cards also show **subscription usage** — per rate-limit window (5-hour session, weekly, and per-model weekly where the plan has one) with the used percentage, a progress bar, and the reset time, plus a Refresh button that re-reads that account upstream (a live failure cooldown still applies). A plain read serves the account's cached windows. Codex usage comes from `chatgpt.com/backend-api/wham/usage` (also reports the plan), Claude usage from `api.anthropic.com/api/oauth/usage`, and Grok usage from the Grok Build CLI proxy's `cli-chat-proxy.grok.com/v1/billing` (the source of the CLI's `/usage` panel; reports the shared weekly pool and the subscription tier). Antigravity reports plan, credits, and per-model quotas from `loadCodeAssist` and `fetchAvailableModels` when those fields are present. Copilot exposes no usage endpoint, so its card shows no usage section. A card carries a red line when that account cannot serve: the provider's own `anthropic-ratelimit-unified-*` response headers, read off the Messages responses this Host sends, state the account's standing ahead of the usage percentages, and the line says separately whether the account itself is over its limit or needs a new login, or whether the account pool is serving from another account instead. A Claude account whose session window is at or past half used, or whose weekly window is at or past 89 percent, is held back from pool selection until its window resets (`pool.scheduling` sets both thresholds). When only those thresholds hold a pool back, the reported wait is the earliest window reset. If an enabled pool owns no entry for a model, the route says so once and serves that model from a single account instead of failing over silently.

Under **Subscriptions → ChatGPT → Manage**, **Automatically use reset credits when quota is exhausted** is off by default and takes effect after **Save changes**. It applies to Codex LLM requests, including independent account entries. When the current account exhausts a session or weekly window, its earliest-expiring available `codex_rate_limits` credit can be spent only if no available credit on any connected ChatGPT account expires sooner. Accounts excluded from routing still participate in this comparison; another account having quota does not prevent spending, and equal expiry times qualify. Tool-only image and search requests do not trigger this feature.

Automatic recovery uses fresh usage and credit lists. Missing expiry, incomplete lists, discovery failures, and unrecognized reset types preserve the card and normal failover. A quota-full sticky account checks recovery before routing chooses a replacement; a rejected Codex request can retry the same account once before output. Manual and automatic spending serialize within one Host. Durable claims under `plugins/subscriptions/auto-reset-claims/` prevent spending the same card twice and prevent another automatic spend for an account until fresh usage confirms recovery after an uncertain result. Tests use injected operations and never spend real credits; manual use retains its confirmation dialog.

Also included, registered when the matching provider is enabled:

- **`web_search`** provider (Codex) — uses Codex's hosted web search through DSH's native tool and citation UI. It follows the default Codex account and the plugin's proxy configuration. It registers as one candidate behind the host's `web` seam and does not claim it: with no other search provider mounted DSH auto-selects it, and alongside another one you pick the winner with the host's own `web.searchProvider` setting. Turning **Web search** off under Codex's **Provider tools** withdraws this provider, leaving the host's `web_search` tool to whatever else is registered.
- **`x_search`** tool (Grok) — xAI's hosted X search, returning `{ answer, citations }`.
- **`image_generate`** tool (ChatGPT or Grok) — `gpt-image-2` via the Codex backend, or `grok-imagine-image-2.0` via `api.x.ai/v1/images/generations`. The `provider` argument picks the preferred provider (`gpt`, the default, or `grok`); when the preferred one is logged out the other serves as fallback. Images are saved under `~/.dsh/plugins/subscriptions/images/` and the paths returned. The `size`/`quality` arguments map onto Grok's `aspect_ratio`/`quality` on the Grok path.
- **`video_generate`** tool (Grok) — `grok-imagine-video-1.5` via `api.x.ai/v1/videos` (async submit + poll); MP4s are saved under `~/.dsh/plugins/subscriptions/videos/`, the path returned, and the clip plays inline in the conversation. Supports duration (1–15 s), aspect ratio, resolution, and image-to-video via `image_url`.

`image_generate` also supports editing: the model passes optional `referenceImages` (1–5 complete DSH attachment references) to edit or use existing images as sources; omitting it keeps text-to-image generation. References can come from uploads, `read_image`, or previous generated images. Read local files with `read_image` first; paths are not attachment references. Copy references from the image reference text or structured tool results. Their order matches the prompt's image order. Edits save new files and return reusable references, including for subsequent edits with another provider.

Codex edits use `/backend-api/codex/images/edits`; Grok edits use `/v1/images/edits`. Existing provider preference, logged-out fallback, and session tool policy still apply. Empty arrays, duplicate or invalid references, and attachment-limit violations fail explicitly instead of generating a new image. Editing requires the DSH attachment service.

Image generation and editing share same-provider account scheduling: try the default account first, then prefer the successful account in that session. Explicit quota or image-entitlement rejection tries the remaining accounts; a 401 gets at most one credential refresh and retry first, and an authentication or enforcement-shaped refusal (see Waiting out a rate-limit window below) parks the account and ends the attempt instead of moving to a sibling. Image-only cooldowns honor provider reset times and clear on login/logout. Transport failures, timeouts, 5xx responses, and invalid requests do not automatically resend, avoiding duplicate images. Set `pool.enabled: false` or `pool.autoAccounts: false` to use only the default account. Image scheduling does not use chat catalogs, chat quota scoring, `families`, or `tiers`.

## Install

### DSH compatibility

''s source candidate is `0.9.4-dsh017rc1.33`, pinned to DSH `0.1.7-rc.1` and Cordis `4.0.4`. Its V4 tool-role translation, pinned Claude Code 2.1.288 wire, and UI target that exact cohort; do not install it on an older DSH profile. The version a running profile executes is decided by that profile's install manifest, not by this source version — the [implementation status note](docs/claude-implementation-status.md) owns the current install state. The upstream public `0.9.4` package declares a broader peer range, which does not apply to this private package.

### Managing accounts and pool models

Open **Settings → Subscriptions → provider → Manage** to edit account aliases, automatic-pool participation and model allowlists, and independent account model entries. Each model appears once in the provider model list, carrying its own row settings and one pool checkbox per account whose catalog lists it; `(1M)` variants keep separate rows because each is a distinct wire id. Existing accounts continue using automatic pooling by default. Independent entries stay bound to one account and never fall back to another account when unavailable. These settings govern LLM routing, not image/video/search tool account policies. See [Account and model management](docs/account-management.md).

### Cached model lists and usage

Discovered catalogues and usage readings are per-account caches under `~/.dsh/plugins/subscriptions/`, and a plain read answers from local state: it never queries a provider and never starts a timer. `models.json` holds one entry per provider account and `usage-cache.json` the normalized window readings with their observation times and read cooldowns; neither file holds a token. A `models.json` written before accounts were keyed is discarded rather than assigned to an account, and such an account re-discovers at its next refresh. A canonical-key rename moves an account's cached catalogue, usage reading and cooldowns to the new key; a rename the credential store only recorded on an earlier run is reconciled from its own alias records once before the first account read, so no retired key serves a session.

Provider queries happen only on explicit events: a login refreshes that account's catalogue and no usage; opening a provider's **Manage** dialog revalidates that provider's catalogues only where an entry is older than the cache horizon; **Refresh** in **Edit model list** forces every account's catalogue of that provider (and re-checks the Codex client version); opening the usage pill asks for an if-needed reading of the current provider's usage; the usage **Refresh** control forces one account's reading; a consumed ChatGPT reset credit re-reads its account; the account a model request is about to use ensures its own catalogue; and the pool candidate about to serve ensures its own catalogue and usage reading.

Every other read is local and reaches no provider: a finished run, a window focus, a reconnect generation, a model switch, a login/logout roster change, the Settings page's first paint, and the seeding read the browser cache runs for an account it has not seen. Pool ranking reads retained cache entries only, so ranking never sweeps the peer accounts. The only remaining timers are protocol or local: the login-progress poll while an authorization attempt is in flight (which also observes the device grant), the credential-store lock renewal, the badge's open-panel countdown, and the opt-in Claude Code keychain sync (`syncClaudeCodeCredentials`, every five minutes and only for accounts this plugin serves in `legacy-writeback`).

`cache.modelMaxAgeMs` (default 24 h) is the catalogue freshness horizon, `cache.usageMaxAgeMs` (default 5 min) the usage horizon, and `cache.retryDelayMs` (default 60 s) the cooldown a failed read takes when the provider named none. A failed read stores that cooldown in the same file, so a restart still honours it, and an explicit refresh never bypasses a live cooldown.

Only the Claude route reads rate-limit response headers, and only through the recognized `anthropic-ratelimit-unified-*` subset: such a response merges the windows those headers name, while every route merges the windows its own usage endpoint returns. A window an answer omits keeps its own reading and age, so an account whose endpoint reports no window is unknown rather than at zero.

One limitation. An HTTP 403/404 that might mean a model was withdrawn does not trigger an automatic catalogue re-read, because no machine-readable code the plugin can trust separates that from an entitlement or endpoint refusal: the row keeps its last-known state until a manual **Refresh** or the ordinary stale-demand re-read.

If `models.<provider>` is explicitly configured with a non-empty list, that list still overrides discovery. Selecting a model reuses its account's last-known capabilities; sending a request still validates current account membership, and an account with nothing cached contributes its built-in rows until an event refreshes it.

Codex catalog visibility depends on the `client_version` request parameter. By default the plugin reads the stable version from the official npm `@openai/codex` package's public metadata (no CLI installation or subscription credentials sent to npm). Successful lookups are cached in memory for six hours; failures retry after five minutes and retain the last successful version, or the verified `0.153.4` fallback on first use. The lookup has a 5-second deadline, shares in-flight work across accounts, and ignores prerelease or regressed versions. On load the plugin also raises Node's Happy Eyeballs per-address connect attempt timeout to at least 1.5 seconds (never lowering a larger host value), because the 250ms default drops every connection on links where one TCP handshake takes longer than that. Manual model-list refresh also rechecks the version. An explicit plugin configuration field, `codexClientVersion: '0.153.4'`, takes precedence and disables automatic lookup; restart DSH after changing it. Model availability remains account-dependent; see [verification notes](docs/codex-catalog-refresh.md).

### Installation commands

With the `dsh` CLI available, install from npm (prebuilt artifacts, no build permission needed):

```sh
dsh plugin --profile web add dsh-plugin-subscriptions
```

Or install the sources from GitHub:

```sh
dsh plugin --profile web add github:V1ki/dsh-plugin-subscriptions
```

pnpm will ask you to allow this package's build script on first install (git installs fetch sources, not built artifacts); add the printed key to the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-plugin-subscriptions: true
```

and re-run the `add`. Only grant this to packages you trust — it runs the package's code at install time.

From a local checkout instead:

```sh
git clone https://github.com/V1ki/dsh-plugin-subscriptions.git
cd dsh-plugin-subscriptions && pnpm install && pnpm build
dsh plugin --profile web add ./dsh-plugin-subscriptions
```

In this fork's checkout, `build.cmd` stages and links the source-built package into the selected `web` profile after the ordinary build; no tarball is handed out and no private registry is queried. That path requires the Host to be stopped, compiles the Node half and client bundle from source, inlines the pinned `@tormentalabs/claude-code-wire-compat` package and `undici`, and removes the type-only `@deepseek-ai/dsh-llm-request-record` peer from the staged manifest. See [the fork plugin build instructions](../README.md#repo-integrated-build-and-install).

Headless-only usage without installing into a profile (log in via the web UI first — the token file is shared):

```sh
cp overlay.example.yml overlay.yml   # then edit the name: to this checkout's absolute lib/index.js path
dsh --profile headless --patch <checkout>/overlay.yml "your task"
```

## Update

Installed from npm:

```sh
dsh plugin --profile web update --latest dsh-plugin-subscriptions
```

Installed from GitHub: re-run the same `add github:V1ki/dsh-plugin-subscriptions` command — it re-fetches the sources and rebuilds. A linked local checkout just needs `git pull && pnpm build` in the checkout.

Either way, restart `dsh web` afterwards so the new version loads.

## Use

1. `dsh web`, open the printed URL.
2. Settings → **Subscriptions**: click **Connect** on a provider. For Claude, credentials are imported instantly if you have run `claude` and logged in at least once; without them, Claude authorizes in the browser like the others. For Codex, Grok, and Antigravity, authorize in the opened browser tab; Copilot shows a GitHub device code to enter at `github.com/login/device`; if a browser flow can't complete (headless host), expand the manual fallback and paste the callback URL or code.
3. In any session, open the model picker (`/model`) and choose a model under **ChatGPT (Codex)** / **Claude (Subscription)** / **Grok (Subscription)** / **GitHub Copilot** / **Google Antigravity**.

Not logged in? The provider stays out of the picker, and requests fail with `MISSING_CREDENTIAL` pointing at the Settings page; nothing else breaks.

A browser OAuth callback must carry the current attempt's `state`, whether it reports success or an authorization error. A missing or mismatched `state` receives HTTP 400 and leaves the login waiting for its own callback; only a matching callback can complete or reject that attempt.

### Multiple accounts

Every provider accepts several accounts: once one is connected, the card grows an **Add account** button (Claude offers **Browser authorization** and **Import Claude Code** separately). Accounts are keyed by their identity (email / login) — re-logging the same account updates it in place, a different account appends. Browser authorization signs in whichever account the browser currently uses, so switch accounts there first (or use an incognito window with the manual code) to add a different one. The ★ default account serves the direct provider routes; pool routes use every account. A Claude account imported from Claude Code is read-only: the plugin re-reads that store on every use and neither refreshes it nor writes to it, and the account's row can move it to the legacy write-back mode after a risk confirmation. OAuth-added Claude accounts are independent and refresh standalone, so several accounts never fight over the Keychain entry.

### Edit visible models, context windows, and tools

Open **Settings → Subscriptions → provider → Edit model list**, search and select models, then **Save changes**. All discovered models are shown automatically by default. Selecting individual models, selecting all, or clearing the selection saves an explicit list; newly discovered models then stay hidden until selected. Enable automatic display again to restore discovery-driven visibility. Hidden models remain usable by existing sessions, and the editor retains the full catalog so they can be restored. Refreshing discovery preserves preferences. The dialog has one **Save changes** / **Cancel** pair: Save submits the model list together with the account settings above it, and Cancel discards both and closes the dialog.

Codex models also accept a context budget in tokens; leave it blank to follow the provider. The plugin reads each account's `context_window` and `max_context_window`, caps the requested budget at that account's maximum, and uses the advertised default as the conservative ceiling when no maximum is provided. Account pools resolve each member separately and use the smallest window. This changes DSH's local history budget and compaction timing, without sending an API capacity override. Longer contexts can increase response latency.

Claude models have no context-budget field: a context size is chosen the way the Claude Code client chooses it, by the request-time `[1m]` marker on the model id, which the editor lists as a separate **1M** row beside the model. The picker reports the model's own capacity per row, taken from the Claude API documentation for the models it names — currently 1M context and 128K output, with `claude-haiku-4-5` the one 200K/64K entry — and from the pinned Claude Code catalog for the rest. The 1M row appears only where that marker composes the `context-1m-2025-08-07` beta and the catalog declares that beta for the model; a marked id the catalog does not declare it for is clamped back to the catalog's 200K window, and a model named by neither source falls back to a conservative 200K context and 32K output ceiling.

The same editor controls Codex Web Search and image generation, plus Grok image generation, video generation, and X search. Changes apply only to sessions created after saving; existing sessions retain their creation-time policy, including after restart. Image generation is shared: it disappears only when neither configured provider enables it, and execution never falls back to a provider disabled for that session. Claude and Copilot currently have no standalone subscription tools to configure.

Preferences and tool-policy history live in `~/.dsh/plugins/subscriptions/provider-settings.json` (mode 0600), independently of the cached model lists and usage readings. Existing non-empty `models.<provider>` configuration still defines the base catalog; visibility selections filter that catalog.

### Reasoning defaults in the model editor

Default reasoning effort now lives in **Edit model list**, beside each model's visibility and context settings. Apply edits with the dialog's **Save changes**, or discard unsaved edits with Cancel. Hidden models remain editable. Models without reasoning levels have no selector; **Follow provider** clears an override. Choices come from live capabilities, intersected across account-pool members. Custom pool aliases do not offer ineffective effort overrides.

Existing defaults continue to load from and save to `~/.dsh/plugins/subscriptions/model-defaults.json` (mode 0600). If a save fails partway through, unfinished edits remain in the draft; the UI reports any defaults already saved and lets you retry.

## Config

```yaml
- id: llm-subscriptions
  name: dsh-plugin-subscriptions
  config:
    providers: [codex, claude]        # subset; default all five
    streamIdleTimeoutMs: 300000
    rateLimit:
      wait: true                       # wait out a closed rate-limit window (default)
      maxWaitMs: 21600000              # ceiling on one wait; 6 h, covers a 5-hour session window
    cache:
      modelMaxAgeMs: 86400000          # catalogue freshness horizon (default 24 h)
      usageMaxAgeMs: 300000            # usage freshness horizon (default 5 min)
      retryDelayMs: 60000              # failed-read cooldown when the provider names none
    models:                            # override the discovered/built-in catalogs
      codex:
        - { id: gpt-5.6-sol, name: GPT-5.6 Sol, contextWindow: 272000, inputModalities: [text, image] }
      copilot:                         # manual entries disable Copilot catalog discovery
        - { id: gpt-5.6-sol, wire: responses }   # copilot only: force the upstream protocol
```

`wire` (copilot entries only) pins a model to `chat-completions` or `responses`. Manual entries keep working without it — the field exists because a configured model the live catalog does not know would otherwise default to `/chat/completions`, which responses-only families (gpt-5.5/5.6, …) reject. Pinning `chat-completions` also opts out of the tools+effort auto-reroute described above.

Antigravity ships no OAuth client identity: set `antigravity.clientId` and its optional `antigravity.clientSecret`, or `ANTIGRAVITY_CLIENT_ID` and its optional `ANTIGRAVITY_CLIENT_SECRET`, before **Log in** can open Google authorization. Plugin configuration wins over the environment. Each source supplies its own client pair — a custom client ID never inherits another source's secret, and a secret without a matching ID is rejected. Optional `antigravity.baseURL`, `antigravity.userAgent`, and `antigravity.onboard` configure its endpoint, client identity, and account initialization. This route uses Antigravity OAuth and the v1internal project envelope, independently of Gemini CLI.

Antigravity converts Gemini tools to `parametersJsonSchema` and Claude/GPT-OSS tools to the supported `parameters` subset, resolving local schema references without modifying the DSH tool registry. Unresolved/cyclic references and custom-tool unions that cannot be represented fail before the request. Known runtime families expose their reasoning efforts in model settings and use model-specific thinking budgets; signed text, reasoning, and tool calls are replayed only to the same provider/model. Compatibility mapping is based on [pi-antigravity](https://github.com/Rahularya01/pi-antigravity/tree/697858cafcf1faddf2ae898d2f053b2ff26c05e6); offline tests do not verify account eligibility or live API acceptance.

Without `antigravity.baseURL`, generation and catalog/project reads try the daily endpoint, then production on a transport failure or HTTP 404/502/503/504, before returning any stream content. Explicit origins stay pinned. HTTP 400/401/403/429 and cancelled requests do not trigger endpoint fallback; onboarding is never repeated across endpoints.

## Model pools

When a provider has **two or more logged-in accounts**, the picker shows the **union** of every account's catalog (duplicates dropped). Pick `claude-sonnet-5` under Claude (or `gpt-5.4` under ChatGPT) as usual — there is no extra pool group and no new model id.

- **Shared models.** A model listed by ≥2 accounts failovers between them (sticky, quota-aware). Each account is discovered separately, so a Plus login is not asked to serve a Pro-only model.
- **Account-only models.** A model listed by only one account is sent to that account. It still appears in the picker even if that account is not the default.
- **Explicit account lists (`families`).** Replace the auto member list for one catalog model (same provider only; cross-provider members are ignored). Pin `account` or omit it for the default.
  `account` is the stable account key shown by the `status` endpoint — an email for Claude, a login for Grok / Copilot / Antigravity. An account whose provider reported neither takes a random `account-…` id, which stays with it across restarts. Codex keys are per workspace **and** user (`["<workspace-id>","user","<user-id>"]`), so for Codex you may instead pin the login email, or the bare workspace ID when only one user of that workspace is logged in; an ambiguous reference resolves to nothing rather than to the wrong user.
- **Tier extras (`tiers`, optional).** Extra picker rows with heterogeneous fallbacks, listed under the first member's provider. Not created automatically.

A session's turns are bound to one account. `priority` keeps the configured healthy-member order; the default `quota_aware` strategy normalizes the existing `remaining quota / time until reset` scores within each availability band, then adds bounded preferences for Claude and ChatGPT resets and for finishing small ChatGPT remainders. A ChatGPT weekly window opened within 24 hours with an available reset card expiring within three days receives a finite bonus rather than an absolute priority. Automatic credit spending requires the separate opt-in setting described above.

Claude and ChatGPT remain in the primary quota band below 100% used; other providers keep the 95% threshold. Any applicable full window puts a member in the last-resort band. Model-scoped windows affect only matching models. When a cached reset passes, the expired window stops contributing urgency or a full-quota assertion, and the next demand re-reads it; an endpoint that continues returning that expired time does not cause a polling loop.

Inside the ChatGPT finishing range, the ample-quota baseline fades in proportion to the remaining fraction and the finishing bonus grows. This also prefers a smaller remainder when every account has only a few percent left. Reset preference grows toward the reset deadline but stays bounded; each window kind has a configurable lookahead.

The combined score is divided by `1 + loadPenalty * active requests`. An attempt reserves its account before waiting for the first chunk and releases it after completion, failure, cancellation, or iterator teardown. This balances simultaneous pool requests across models of the same provider/account.

**Session-account affinity.** A session keeps the account its turn is bound to, across turns, while that account can serve — even when another account would score higher. A replacement (a *rematch*) happens only when a turn starts (`turn/start` on the session log) and only because the bound account's window closed or a refusal parked it. At most one rematch happens per turn, and no request of an open turn is ever sent to a second account: an ordinary 429, a server fault or a transport failure fails the turn on its account, which the retry policy then retries. A requeued turn that finds no healthy account reports the typed `no_available_account` (`NO_AVAILABLE_ACCOUNT`) and contacts nothing. There is no account switch after the first stream chunk.

### Account concurrency

Every subscription account serves at most two sessions at a time (`pool.concurrency.maxSessionsPerAccount`). A session sends one request at a time, so a second turn of the same session queues behind its first request. The third session of one account waits in FIFO order for a slot; a wait longer than `queueTimeoutMs` is refused with a typed `rate_limited` instead of queueing forever. A turn end releases the slot immediately, and a session whose turn end was never observed releases it after `sessionIdleMs`.

Every account also has one request limiter shared by all of its sessions: a token bucket (`requestsPerMinute` refilled at that rate with `burst` tokens available at once) plus a minimum spacing (`minGapMs`). It is active by default at 20 requests per minute, two burst tokens and 1.5 s between requests; set any of them to disable or retune it for the plan.

An ordinary 429 backs off only the session that received it (`backoff`, or the provider's disclosed wait when it sent one); the other sessions of the account keep sending under the shared limiter. Once a session spends `backoff.maxRetries` consecutive backoffs, its turn stops retrying (the gate reports a hard-stopped `rate_limited`); the next turn starts a fresh budget. A window/quota 429 parks the account until the disclosed reset, and every session of that account sees the same cooldown.

### Error taxonomy

Every failure a pool member reports resolves to exactly one scheduling effect. No effect switches accounts inside a turn; a 429 is never replayed on a sibling.

| Class | Provider signal | Effect |
|---|---|---|
| Transient | 408, 409, ordinary 429, 500/502/503/504/529, network, TLS, timeout, malformed before delivery | `session-backoff`: the same account retries after the disclosed or local delay, bounded by `backoff.maxRetries` |
| Account cooldown | 429 window/quota (claim/reset); an account-shaped 403 (stated-final, billing/credits, disabled account) | Park the account until the reset; all sessions share it; rematch only at the next turn, at most once |
| Refresh | 401, a 403 that names a revoked credential/account | Refresh and retry the same account; after `maxRefreshAttempts` (2) failures the account is parked |
| Model-scoped | 403 that names one model, 404 model not found, in-band refusal naming a model | Fail this model; the account is neither parked nor switched |
| Terminal | 400 `invalid_request` (except context overflow), 413, version/policy/content refusal, user abort, malformed/incomplete stream after delivery, `x-should-retry: false` on a non-403/429 status | End the turn with the provider's error; nothing about the account is recorded |
| In-band `error` event | mapped by `error.type` (`authentication_error`, `permission_error`, `policy_blocked`, `not_found_error`, `invalid_request_error`, `rate_limit_error`, `overloaded_error`, `api_error`, `timeout_error`) | The class its type names; never an account switch |

The hard-stop field wins over the code: a route that stated the logical request may not be repeated is terminal even when its code reads transient. An ordinary 429 with `x-should-retry: true` stays transient, so the same account may retry.

A credential refresh failure reports only safe facts in its error message: the HTTP status, the provider's OAuth `error` code when present, and `retry-after` seconds when disclosed. The provider response body, token values, and free-form detail are not included. A stated `403`/`invalid_grant` therefore identifies an account or grant refusal; a generic `AUTH` without those fields does not establish suspension.

Load accounting covers this Host’s automatic pools and configured tiers. Independent account entries, other Harness processes, and external clients are outside that counter. Accounts without usage telemetry remain fallbacks behind measured accounts; when a band has no usable urgency, equal baseline scores can still be distributed by load.

Optional `pool.scheduling` fields are resolved and validated at plugin load. Zero weights disable their additional preference or load penalty; zero `codexDrainBelowPercent` disables finishing. Horizons must be positive integer milliseconds, percentages must be between 0 and 100, and weights must be finite and nonnegative.

| Field | Default | Purpose |
|---|---|---|
| `sessionResetHorizonMs` | `3600000` | Last hour of a short window |
| `weeklyResetHorizonMs` | `86400000` | Last day of a weekly window |
| `otherResetHorizonMs` | `86400000` | Last day of other windows |
| `resetWeight` | `2` | Maximum additional reset preference |
| `codexDrainBelowPercent` | `10` | ChatGPT remainder range for finishing |
| `codexDrainWeight` | `2` | Maximum additional finishing preference |
| `freshCreditWeight` | `0.5` | Maximum fresh-week/expiring-card bonus |
| `loadPenalty` | `1` | Penalty per active pool request on the account |

Optional `pool.concurrency` fields are validated at plugin load too.

| Field | Default | Purpose |
|---|---|---|
| `maxSessionsPerAccount` | `2` | Concurrent sessions one account serves |
| `queueTimeoutMs` | `120000` | Longest wait for a session slot or request token |
| `sessionIdleMs` | `600000` | Fallback slot release when no turn end was observed |
| `requestsPerMinute` | `20` | Shared account rate cap; zero disables it |
| `burst` | `2` | Tokens a burst may consume at once |
| `minGapMs` | `1500` | Minimum spacing between two account requests |
| `maxRefreshAttempts` | `2` | Credential refresh cycles before the account is parked |
| `backoff.initialDelayMs` | `1000` | First local session backoff |
| `backoff.maxDelayMs` | `60000` | Session backoff ceiling |
| `backoff.jitterRatio` | `0.2` | Symmetric jitter around each backoff |
| `backoff.maxRetries` | `10` | Backoffs one session may spend before its turn stops retrying |

```yaml
- id: llm-subscriptions
  name: dsh-plugin-subscriptions
  config:
    pool:
      enabled: true                   # default; needs ≥2 accounts of one provider
      strategy: quota_aware           # or priority
      autoAccounts: true              # pool each catalog model across that provider's accounts
      concurrency:                    # account concurrency and 429 policy
        maxSessionsPerAccount: 2
        requestsPerMinute: 20         # shared account cap; 0 disables
        burst: 2
        minGapMs: 1500                # minimum spacing between account requests
      families:                       # explicit account list for one catalog model (same provider)
        claude-sonnet-5:
          - { provider: claude, model: claude-sonnet-5 }                   # default account
          - { provider: claude, account: bob@example.com, model: claude-sonnet-5 }
      tiers:                          # optional extra picker rows
        smart:
          - { provider: claude, model: claude-sonnet-5 }
          - { provider: codex, model: gpt-5.6-sol }
          - { provider: grok, model: grok-4.6 }
```

### Waiting out a rate-limit window

A subscription plan is rate-limit shaped by design — a 5-hour session window, a weekly one, and on some plans a per-model weekly one — so an ordinary 429 is not a dead end: the window reopens at a time the provider discloses. Each route reads that reset off its own 429 and turns it into that session's backoff (`pool.concurrency.backoff`) and, for a window/quota rejection, into the account's cooldown instead of a fixed 5-minute guess.

A refusal the provider states is final is neither waited out nor retried, and the pool does not answer it from another account. `x-should-retry: false`, a unified status of `rejected` (on `-status` or `-overage-status`), a disabled organisation/seat/member reason, billing or credit wording, and a 429 that disclosed no reset at all classify as `ENFORCEMENT`: on a 429 the account is parked for the disclosed reset (5 minutes when none was disclosed) and the turn fails immediately; on any other status the refusal is terminal for the turn. No other account of the pool is contacted in either case — repeating such a refusal under another identity is the traffic it exists to stop.

Only a signal that names the window which actually rejected the request is read: Anthropic's `anthropic-ratelimit-unified-reset`, the seconds Codex puts on a `usage_limit_reached` rejection, the delay xAI names in the error body, or a plain `retry-after`. The per-bucket rollover snapshots (`anthropic-ratelimit-{requests,tokens,…}-reset`, `x-codex-*-reset-after-seconds`, `x-ratelimit-reset-*`) ride every response and cannot say which bucket refused — the earliest is usually one that still had room — so a 429 carrying nothing else is a refusal too: the warning sink still names the headers and the head of the body, and the turn ends there rather than parking on a guess.

Reading is confined to a 429. Every other failure keeps its short local backoff: those same headers ride a transient 500 too, and honouring them there would hold a turn for the rest of the window over an overload that clears in a second.

With a pool, this is what actually does the waiting: a 429'd session backs off locally and the turn fails with that account's own retry hint, so `dsh-llm-retry` retries the same account. The request is not replayed on a sibling account, and the other sessions of the account keep sending under its shared request limiter. A window/quota rejection parks the account until its reset, which every session of the account sees; a 401 or a revoked 403 refreshes the credential on the same account first, and parks it only after `maxRefreshAttempts` failures. The next turn rematches to a healthy account. Once no account is healthy, the next turn reports the typed `no_available_account` carrying the earliest known recovery as its hint. With a single account (no pool, or a provider with only one login), the same disclosed reset is reported directly.

Waiting on that reported delay is executed by [`@deepseek-ai/dsh-llm-retry`](https://www.npmjs.com/package/@deepseek-ai/dsh-llm-retry), which every route's retry policy is written for: add it to the composition, or nothing waits and a closed window fails the turn as before.

```yaml
- name: '@deepseek-ai/dsh-llm-retry'
```

```yaml
- name: dsh-plugin-subscriptions
  config:
    rateLimit:
      wait: true            # default; false keeps the previous seconds-scale behaviour
      maxWaitMs: 21600000   # 6 h — covers a 5-hour session window with slack
```

A reset further out than `maxWaitMs` — a weekly window days away, or a whole pool cooling down past it — fails the turn immediately with the reset time attached, rather than parking the session for days. `wait: false` drops back to local backoff alone.

All six routes share Claude Code's own retry shape: ten retries after the first attempt, backing off from 1 s with 20% jitter under a 60 s cap. These are consumer subscription endpoints that shed load in bursts, and the dsh-llm defaults (five retries from 500 ms to 10 s) give up after about fifteen seconds, which is short for that. That budget covers the ordinary rate limit — a 429 with a disclosed reset — and the transient codes; a 429 that discloses no reset is a refusal and fails the turn at once instead of retrying blind into the same block. Copilot currently uses the generic `retry-after` signal; unrecognized GitHub rate-limit headers are surfaced through the plugin warning sink for a future provider-specific reader.

One trade-off worth knowing: the delay ceiling is shared with that local backoff, so raising `maxWaitMs` also raises how long an unrelated transient failure (`TRANSPORT`, `SERVER`, `TIMEOUT`) can back off for before the finite retry budget runs out — up to 512 s on the last of the ten retries instead of the 60 s cap.

Account-management routes preserve the underlying provider's retry policy for pooled and independent accounts. A transport failure leaves its account eligible for another attempt; when every attempted account fails, an eligible account's original error reaches the retry executor without another account's quota or authentication cooldown. Only a fully cooling pool reports its next recovery time. With `rateLimit.wait: false`, transient failures still retry up to ten times with exponential backoff from 1 second to 60 seconds and 20% jitter; the setting prevents long quota-reset waits, not network retries. The agent loop retries the failed model step, including interrupted output, without repeating completed tools; user cancellation stops the wait. A failure that carries `retryDisposition: 'forbid'` is the exception: neither the agent loop nor the retry executor resends it, because the loop skips its request-error recovery dispatch and the executor schedules no wait (see the source-tree section below).

## Claude stream lifetime

Claude Messages share a Bun transport child. An active response does not block later requests or cancellation frames. Each request owns its abort controller; cancelling one response does not cancel other streams. The SSE reader cancels its source when a terminal event, error, or consumer return ends reading before HTTP EOF, and releases its lock without redundant cancellation after normal EOF. Closing or failing the child's input aborts its requests and waits for their tasks to settle.

`claudeTransportMaxQueuedBytes` sets each response's unread-byte limit (positive safe integer, default 33554432). Consumed bytes do not count, so a promptly read response can exceed that total size. Exceeding the unread limit cancels only that request upstream and fails its body with `backpressure`; other streams remain usable. Configure the limit before the shared child starts; a live child or pending start refuses a different limit. After child death, a later request can start a replacement. The failed request is not replayed by the transport and never falls back to Node.

These guarantees concern request lifetime, not TLS or wire equivalence. Request fields and proxy refusal are unchanged. A running Host uses its installed plugin artifact; source edits require rebuilding and explicitly deploying that artifact after the Host stops.

## Claude response limits and usage

A streamed response ending with `model_context_window_exceeded` uses DSH's existing `max-tokens` outcome: partial text is retained and tool calls from the truncated turn are omitted. It is not treated as normal completion or as a rejected-prompt error that requests compaction/retry. The existing prompt-too-long error mapping is unchanged.

New generation-limit responses retain server-tool blocks at their positions among the surviving text/reasoning blocks; omitted local tool calls do not shift that replay order. Older recorded envelopes replay their stored positions without guessing a correction. `pause_turn`, `compaction`, unrecognized non-empty stop reasons, and ordinary completions containing only server-tool blocks fail with `UNSUPPORTED_RESPONSE`. Generation limits and refusals retain their distinct finish kinds. The default subscription policy neither retries nor fails over that code; it does not automatically continue a server-managed turn. Truly empty completions keep `EMPTY_RESPONSE`.

Usage is merged from `message_start` and `message_delta` by field. A later number, including zero, replaces the earlier count; absent or null fields preserve it. Input and cache counts stay disjoint, cumulative output is not added twice, and one final usage chunk precedes the terminal finish.

Claude identity backfill preserves credentials refreshed during its profile lookup. The save compares the prior session, then reads the stored winner; concurrent rotation or re-login cannot be overwritten with the earlier token pair. An unidentifiable account change fails rather than mixing account identity, and Messages/file uploads use the selected post-refresh credential.

## Claude authentication and alignment limits

[Claude request reliability](docs/claude-reliability-design.md) and [account and policy maintenance](docs/claude-account-maintenance-design.md) record the design of terminal refusal, account states, stream integrity and active-session maintenance. The sections below describe the implemented behavior and its limits. The installed package version, not source edits, determines the behavior of a running Host.

A request pins its account before selecting credentials, identity or request-chain state. Messages, profile and usage release a rejected 401 body before refreshing and replaying it. A successful refresh returns the session the store holds after its conditional save, not an uncommitted grant; an absent session raises `MISSING_CREDENTIAL` and is not resurrected by that refresh. Permanent refresh failure conditionally removes only the credential it attempted, preserving a login that replaced it.

Local import requires an OAuth session containing `accessToken`, `refreshToken` and numeric `expiresAt` in epoch milliseconds. On Windows/Linux, the login action reads `.credentials.json` under `CLAUDE_CONFIG_DIR` or `~/.claude`; it does not automatically import at startup. A malformed JSON root is treated as unavailable credentials so OAuth fallback can run. A lone access token, setup-token or API key is not this session format. `syncClaudeCodeCredentials` remains opt-in; importing an existing session does not by itself enable writes to Claude Code's store. A changed source credential is adopted only with matching account information or a shared refresh-token lineage and no known identity conflict. Otherwise `CLAUDE_CREDENTIAL_SOURCE_CHANGED` requires re-import or browser login; the default policy neither parks nor retries the account. A preemptive refresh on the synchronization path may retain its own still-valid token rather than adopt the unconfirmed source. The synchronization lock coordinates cooperating DSH processes, not an established lock shared with Claude Code.

DSH derives a 64-hex device ID from the account UUID and a locally hashed stable OS identity: Windows `MachineGuid`, Linux machine-id, or macOS `IOPlatformUUID`. The same account on the same OS installation reconstructs the same ID without a DSH cache; another account or another OS identity derives a different ID. Raw machine identifiers are neither stored in account data nor sent in requests. Missing or unusable OS identity fails with `CLAUDE_DEVICE_IDENTITY_UNAVAILABLE`, without an account-only or random fallback.

Before Messages, legacy account-only IDs and IDs copied from another machine are conditionally replaced with this local binding; tokens, expiry, scopes and account UUID remain unchanged. The first request after upgrading may therefore use a different device ID. Existing credentials remain usable without re-import or login solely for this migration. OS reinstalls can change an identifier and cloned machines can share one; this is not an immutable hardware fingerprint. CC's config-root random ID remains a different policy; client comparison covers request values and conditions, not a requirement to clone CC's local storage or Keychain implementation.

### Credential ownership

A stored Claude credential's `credentialOwnershipMode` is resolved from the field when the record states one, and otherwise from the compatibility inference: `keychainBound === true` reads as `legacy-writeback` and anything else as `independent-oauth`. The three modes are `independent-oauth` (a real plugin-owned OAuth authorization, so its refresh grant is the plugin's own), `read-only-import` (the credential stays in Claude Code's store and this plugin only reads it), and `legacy-writeback` (the credential stays in Claude Code's store under the pre-existing synchronization path). The set is closed: a value this build does not implement fails the read and refuses the whole store write instead of silently falling back to an inferred mode. A record that states no mode is not migrated, and no background pass rewrites, deletes or re-authorizes existing accounts.

A `read-only-import` account is served from Claude Code's store on every use, never from a preemptively retained or cached copy: the use re-reads that source and adopts its current winner, requires the source to state an unexpired credential for this account (the recorded email, or the recorded refresh token's own lineage) and to declare `user:inference` in the scopes it states, and otherwise stops. A missing, expired or under-scoped source fails with `INVALID_CREDENTIAL` carrying `retryDisposition: 'forbid'`, which the pool parks as an authentication failure so the account reports `reauth_required`; a source that cannot be confirmed as this account's fails with `CLAUDE_CREDENTIAL_SOURCE_CHANGED`, which neither parks nor retries the account; and a source that fails inside an open refresh window is reported as `MISSING_CREDENTIAL` with that same forbid disposition, the one failure that reaches the caller without the stored copy. None of them spends the shared refresh grant or writes to that store, and none deletes the stored authorization or claims the token was cleared.

Only this plugin's own OAuth authorization produces `independent-oauth`: the interactive browser sign-in and its manual code-paste fallback are that same authorization, and an imported token can never be renamed into it. The settings channel refuses `independent-requires-login` for that rename and `account-is-not-external` for moving an account the plugin authorized itself onto an external mode. A permitted `read-only-import` ↔ `legacy-writeback` change is written against the stored credential revision, so a rotation or re-login that landed meanwhile is not overwritten, and the caches built under the previous mode are dropped while the credential itself is untouched.

Choosing `legacy-writeback` needs an explicit risk confirmation: the server refuses a real conversion whose request does not state `riskAcknowledged: true`, and the Settings button asks before sending it. That mode is compatibility behavior, not coordination: it may spend the same refresh grant an external holder spends, and only while `syncClaudeCodeCredentials` is enabled does it also keep the provider's on-demand synchronization and write its rotation back; that option keeps the five-minute Claude Code synchronization running for `legacy-writeback` accounts and may still trigger an on-demand grant, while a `read-only-import` account is never part of that sweep and is checked against its source at use time. The account reports `external-coordination-unproven` for as long as it is served in this mode, never a safe single writer. Only `independent-oauth` arms the plugin's own proactive renewal timer.

The mode never decides eligibility: this route's credential is first-party OAuth by construction, and an organization policy is still judged from the fixed route, the credential's actual scopes and the confirmed subscription metadata, so neither external mode skips one. Account-list and status reads stay local — they project the stored record and read neither Claude Code's store nor the network — and only a credential use reads that source. A Claude account's status carries `credentialOwnership` with `mode`, `external` (true for both external modes) and `coordinationUnproven: true` for `legacy-writeback` alone, and its `credential` dimension, once maintenance is bound to the account, reports `external-coordination-unproven` for that mode and `maintenance-unsupported` for a read-only account.

Identity backfill is conditional on the credential revision read before the profile lookup whenever the backend reports one: a mode change, a logout or a same-token re-login during that work stops the request with `CLAUDE_IDENTITY_CHANGED` instead of binding an identity under the new mode or sending the request, and a read-only account whose backend reports no revision refuses the write with `CLAUDE_IDENTITY_UNVERIFIABLE` rather than downgrade the condition.

The fork preservation rule and focused verification for these modes live in [the plugin's own FORK_MAINTENANCE.md](FORK_MAINTENANCE.md#claude-credential-ownership-modes); this subsection describes the current `src/` tree.

## Claude client metadata and transport defaults

Claude honors `retry-after-ms` before `retry-after`, accepting positive delays up to 2147483647 ms. A disclosed account reset still takes precedence on 429; explicit stop-retry and account-refusal signals remain terminal. Other providers keep their existing header rules.

The first request of an account's wire-session span fixes its `x-cc-atis` value from the latest successful bootstrap read, including an empty pin that sends no header; the initial identity is persisted before that bootstrap read is adopted, so a pin is frozen from a durable fact rather than from a late answer. Later bootstrap values apply only to new spans. Logout or identity invalidation clears the account's pins, and a candidate that arrives after a pin was restored or frozen never revives the older value. This adds no bootstrap polling or extra request; pins are owned by the plugin's private continuation-state documents (salt, spans and identity generation), which keep at most 256 spans per account with oldest-first eviction, so a retired span may pin again and a resume whose facts are missing starts empty.

A main OAuth request declares a one-hour prompt-cache TTL only when its granted scopes include `user:inference` and the account's captured rate-limit report does not say `rejected` with overage `allowed` or `allowed_warning`. Helpers (`compaction`, `session-title`) and other cases omit the TTL and extended-TTL beta, using the provider's five-minute default. Plan labels are not the predicate; the existing account-local report supplies overage state without another request. Sub-agent-only top-level cache eviction is not emitted by this route.

The Bun child starts with `--no-env-file`: working-directory `.env` files cannot add transport settings outside the inherited environment allowlist. With the bridge enabled, certificate and hostname verification remain on; supported CA environment variables are passed explicitly. `SSL_CERT_DIR` uses a subject-hash certificate directory, not arbitrary filenames. A Bun override must support `--no-env-file`, otherwise startup fails rather than silently dropping the option. With the bridge disabled, Host fetch and its configured transport policy apply instead.

## Claude failure recovery and account maintenance (source tree)

This section describes the implemented request and maintenance rules. The [implementation status note](docs/claude-implementation-status.md) records source-level verification, remaining limits and the last verified installation; a source or package version alone does not establish what a running Host has loaded. Claude registers only on a Host that declares `ctx.llm.failureRecoveryVersion` `1`, the contract that carries a failure's `retryDisposition` through adapter normalization, the session log, and every automatic resend path; on any other Host the route is not registered and the provider card reports `CLAUDE_HOST_INCOMPATIBLE`, rather than running a retry guarantee that Host cannot keep. Claude also requires `@deepseek-ai/dsh-llm-request-record`: a Host that provides neither the failure-recovery version nor that recording service withholds only the Claude route, and the other providers keep their registrations.

One ordered classification decides every Claude rejection, whether it arrives as a failed status or as an `error` event inside a `200`. A stated client-version floor (`CLIENT_VERSION_UNSUPPORTED`), a refusal the provider states is final (`ENFORCEMENT`), a bare 403 (`PERMISSION_DENIED`), a structured error type this route does not map (`UNCLASSIFIED_PROVIDER_ERROR`), a request it cannot serve (`INVALID_REQUEST`), and a stream that ended before its business terminal state (`STREAM_INCOMPLETE`) all carry `retryDisposition: 'forbid'`: the retry executor schedules no wait, the agent loop resends no step, and a stated refusal is not answered from another pool account. Output already delivered makes every code a hard stop. A 403 is a permission refusal on this route, so it neither refreshes nor clears the stored credential and is never rendered as an expired login; other providers keep their existing status and header handling. An authentication rejection gets at most one controlled refresh and replay per logical request, and a rejection that arrives after that replay carries the stop, so refresh, resend, refresh cannot repeat; a failure raised after the Messages POST was issued but before any response arrives keeps the Host's bounded transport retry path, accepting that the server may already have acted, while a failure raised before it, a delivered output, and a context overflow keep their own declared recovery.

The account roster reports independent dimensions instead of one status line: `credential` (`ready`, `refreshing`, `reauth_required`, `missing`, `unknown-expiry`, `maintenance-unsupported`, `external-coordination-unproven`), `availability` (`available`, `cooling`, `transient`, `refused`), `protocol` (`current`, `upgrade_required`, `unsupported_response`), `profile` (`fresh`, `stale`, `missing`, `unavailable`), and `policy` (`ineligible`, `loading`, `current`, `stale`, `unavailable`, `consent-required`, `blocked`). Each dimension is computed by its own owner: the credential dimension is always reported, because the account roster itself proves a credential exists, and the others are omitted while their owner has nothing to report rather than defaulted to healthy. A cooldown therefore cannot render as an expired sign-in, and a version refusal is not cleared by a re-login or a quota reset. The provider card's former free-text `detail` is replaced by `lastError`, carrying a fixed `code` and the `operation` it belongs to; the client localizes that code, and a status read whose own projection threw reports a fixed `UNKNOWN` code instead of the thrown text, which stays on the server.

Maintenance is bound to real traffic. The adapter's pre-request hook is the only place a session becomes bound; it awaits the state a previous run stored before judging anything; and a stream ending, an idle turn, or a finished response never releases that binding — only session disposal, a user stop, a logout, or an account removal does, and that release waits for the work the session owned without cancelling another session's shared work. Three works run under one binding: proactive credential renewal before expiry, profile freshness, and the managed-settings read; a request that names no session is refused at the start of the stream, before any credential, file or Messages work, rather than served without a continuation binding; only a bound session's own work runs under that binding.

A stored profile stays fresh for `claudeMaintenance.profileMaxAgeMs`, 24 hours by default, and an age equal to that baseline is already stale: the record is read again rather than reused. A response is adopted only with `account.uuid`, `account.email` and `organization.uuid`, and the reader marks it complete only on the pinned client's own evidence — `organization.billing_type` stated, `account.created_at` present, `organization.subscription_created_at` stated, and `cc_onboarding_flags` present, where an absent flags object counts as `{}` and never blocks completeness. The subscription type is deliberately outside that test: an unknown or `null` plan is a complete answer, not a reason to re-read on every request, and a property a response does not address keeps the value already known. A record written before this evidence contract carries no `completenessVersion`, so it reads as incomplete and one bounded read replaces it, while the policy state stored beside it is kept.

The managed-settings read is conditional on confirmed metadata: an account with no stored credential and an account not served by this plugin's own OAuth path never fetch, a confirmed `pro` or `max` subscription does not fetch, and a `team` or `enterprise` organization plus an unknown or `null` subscription do. That is the `null` versus `pro` distinction — only a value the pinned client itself treats as personal pro/max is confirmed. Enforcement fails closed: an unvalidatable document, an unsupported or unmapped key, a restriction with no registered consumer, and a check that cannot be shown unaffected all refuse the operation instead of allowing it, and the tool guard decides per session at execution time against the accounts that session actually routed to, so a restriction adopted after the agent was created still stops the call. Every `claudeMaintenance` value is validated at load: a zero or negative value is a misconfiguration, not a way to switch a capability off, and `failureBackoffMs` must not exceed `maxFailureBackoffMs`. A restored maintenance record states a policy only when the endpoint's empty success states it whole — an empty checksum and revision, no key, no blocker and `enforced: false` — which restores with no added settings or organization call; every other restored record is read in full once by the next request of an eligible bound account, with no validator, a confirmed `pro`/`max` account still reads nothing, and a real organization mismatch keeps refusing. See [FORK_MAINTENANCE.md](FORK_MAINTENANCE.md#claude-account-maintenance-for-live-sessions).

The managed-settings read sends its own role headers — the plain `claude-code/2.1.288` user agent, the `oauth-2025-04-20` beta, and both `cache-control: no-cache` and `pragma: no-cache`, so a proxy or gateway in front of the endpoint cannot answer it from a cached policy document — under its own ten-second deadline, which the token bound below does not cover. Those are the values the inspected client branch selects in this fixed, non-gateway configuration; they are not a claim that every client branch, provider policy behavior or risk-control decision is equivalent.

Each token-endpoint POST — the authorization-code grant and the refresh — is bounded at 30 seconds for the whole exchange: the fetch plus reading and parsing the answer, a success document or an error body, and not only the response headers. A POST past that bound is aborted and reported as `TIMEOUT` carrying this plugin's own expiry error rather than the endpoint's body; the helper does not replay the grant, and a timeout is not a permanent refresh failure, so it does not by itself remove a stored credential. The bound is an explicit wall-clock deadline on the components it wraps, not a claim that every adapter's timeout is equivalent. The transport this route fetches through applies no deadline of its own, which is why the bound exists.

Defaults, from the current config schema and its resolver:

| Field | Default | Purpose |
|---|---|---|
| `refreshLeadMs` | `300000` | Lead time before credential expiry at which renewal runs; the route's own expiry lead when unset |
| `profileMaxAgeMs` | `86400000` | How long an accepted profile stays fresh |
| `policyPollMs` | `3600000` | Period between managed-settings polls while an account is bound |
| `readTimeoutMs` | `10000` | Bound on one profile or settings read |
| `failureBackoffMs` | `30000` | First retry delay after a failed maintenance cycle |
| `maxFailureBackoffMs` | `900000` | Ceiling the failure backoff doubles up to |
| `minRefreshDelayMs` | `30000` | Floor between two credential checks |

## Claude continuation state (source tree)

The route's continuation state is durable and private to this plugin rather than process memory: `salt.json`, `spans.json` and `identity-generation.json` live under `$DSH_HOME/plugins/subscriptions/claude-continuation/`. They store no token, no account email and no plaintext account key, but the derived account reference and the session identities they keep remain linkable and are held as private identity state; the salt material is not an anonymity guarantee, and the system text the recording service writes may contain a secret the deployment configured, at the confidentiality of the session log.

The chain has one definition: the retained assistant messages whose trusted v1 metadata states a reference kind and version, a `ref`, the `spanEpoch`, the harness and wire identities, and the role and blocks that may be replayed, and whose account reference matches the request's. Within the eligible assistant continuation records, a missing or empty `requestId` scans backward to the previous trusted record; a record whose account reference is missing is skipped as a whole row, and a selected `requestId` that is truthy but fails validation is omitted without backtracking to an earlier one. A model change does not by itself block the chain, while thinking replay stays behind the model gate it already had.

A local identity or span preparation failure refuses the request before any credential use, Files or Messages work: an untrusted store, a failed write and a state wait that reaches its budget all end in `LOCAL_CONTINUATION_STATE_UNAVAILABLE` with `retryDisposition: 'forbid'`. A later epoch check after maintenance, or a failure to persist the span pin, stops the Files and Messages work that would follow, without undoing maintenance or a refresh that already happened. A recording flush failure instead forbids only the Messages send and promises nothing about Files work that may already have happened, and a request with no session is refused before any credential, file or Messages work.

| Field | Default | Purpose |
|---|---|---|
| `continuationStateDeadlineMs` | `5000` | One per-request budget, 100–10000 ms, shared by every continuation-state phase of that request: each phase continues with the remaining budget instead of starting a fresh one, and the bound covers the local state waits, not the provider's network time. It must outlast `continuationStateLockTimeoutMs`, or an operation still waiting for its lock reaches this deadline and refuses a healthy state |
| `continuationStateLockTimeoutMs` | `2000` | Bound, 100–10000 ms, on owning one continuation-state lock; a lock that cannot be owned refuses the operation instead of running it unowned |

Identity changes are gated before the credential commit that would make them real: a token rotation does not advance the identity generation, an unknown active identity cannot take over automatically, and an identity recorded as failed recovers only through an explicit authorization; a request never fabricates a repaired identity.

## Claude policy limits and extractable components (source tree)

The `policy_limits` document is a second, independent Claude policy source: its own cache file, validator and single-flight read, separate from the managed-settings document, and neither replaces the other. It is read on a live binding's own cadence and only for an eligible account — this plugin's own first-party OAuth path, the pinned endpoint base, an inference scope and a stored token. A failed read keeps the last adopted document as stale rather than dropping a known restriction; a record restored from the durable store was not verified by this run, so its known restrictions stay in effect and an item that cannot be safely restored stays blocked, and no validator is sent before a new fresh read; a store that cannot be trusted refuses the operations it might otherwise have restricted.

Verdicts are enforced at two points with the same keys and the same mapping, so no path honours a restriction the other ignores: model inference for the bound account, and the execution-stage tool guard, which judges each session against the accounts that session actually routed to. A key the accepted document refuses stops the operation with `POLICY_LIMITS_DENIED`; a key this build cannot map exactly, an untrusted state, and a failed read refuse rather than pass, reporting `POLICY_LIMITS_UNSUPPORTED` and `POLICY_LIMITS_UNAVAILABLE`. Only a key from the pinned registry may appear in the refusal: an unknown key keeps its denial and is reported under a fixed placeholder, so remote key text never reaches the model, the error projection or the session log. A key whose enforcement belongs to a surface this provider does not have — a client transcript scan, a repository probe — is inapplicable here rather than assumed harmless, and a read failure or an unmapped key is redacted the same way: fixed codes and counts only, never the document, its defaults, its taints or its key names.

The server's `enforce_`/`require_` control family is not a member of the pinned allow-key registry: a control states an obligation rather than a verdict about one operation, so `require_trusted_devices` and `enforce_web_search_mcp_isolation` are classified out of the operation-permission key set and out of its unknown-key count, and the account status reports each of them as `active`, `not-enforced` or `unknown` in `controlRequirements`. This build performs no device-enrollment, cloud-create or link operation and establishes no descriptor-marked web-search or MCP-connector executor, so an `active` control is stated as a capability this client does not provide in one locale-owned warning line — its copy says the requirement is observed, not enforced — and it refuses nothing: neither control alone, nor the two together, is mistaken for an unknown operation key or blocks Messages. A `false` or absent control adds no warning, a non-boolean `allowed` still fails the whole document inside the envelope parser instead of degrading to `unknown`, every genuinely unknown operation key keeps the conservative verdict it already had, and the pinned allow-key registry gains no key and changes no eligibility rule — this classification does not make unknown allow-keys fail open.

The control observation is not persisted: a restored snapshot holds no control key, so after a restart the warning can disappear until the existing policy read flow adopts a new document, and the controls then read as `unknown` rather than `not-enforced`, never as satisfied or executed. A snapshot kept from before this classification keeps the unknown-key count it recorded, because that count cannot be traced to these two controls, and this change neither clears nor migrates it. No new HTTP request, polling cadence or UI switch is introduced; the status gains only the fixed `controlRequirements` projection.

The account roster carries the dimension as its own entry with fixed codes, counts — denied keys, taints, unmapped keys, and capabilities this build does not provide — and, when the provider stated one, the normalized organization monitoring notice. The notice is the provider's own prose: its text is rendered as text, and its `https` URL is a link the user opens deliberately, which the client never fetches. A notice restricts no key and is not a block; a snapshot restored from the durable store that knows only that a notice exists shows it as awaiting the next confirmed read rather than as no notice, and it blocks no unrelated operation, while an unknown real permission still blocks the operation it reaches.

A confirmed data-handling taint suppresses the three pinned mid-conversation betas for that account's builds while the top-level system prompt and ordinary Messages are preserved, through a trusted request-policy input the caller states out of band: the raw request DTO cannot set it, and a top-level system prompt does not suppress them by itself. An unsupported mid-conversation-system input is rejected before any Files or Messages request and records no protocol block. On the actual adapter that refusal is reported as `POLICY_UNSUPPORTED` with automatic resend forbidden; `CLIENT_VERSION_UNSUPPORTED` is reserved for upstream version evidence and is not reused here.

Three source directories are extractable for a caller outside this harness and import neither the harness nor the plugin's provider layer. `src/claude-core` holds the pure single-account protocol core — `policy_limits` parsing, validation, verdict order and organization-pin validation — with credentials, flags, transport and scheduling injected by its caller. `src/claude-engine` builds one wire request from a raw Anthropic Messages DTO and runs one single-account turn over an injected transport; it supports a caller-held continuation chain, splicing a valid previous request id into the billing block and serializing the ATIS header from the caller's own choice, and it never derives a request id itself. `src/claude-account-client` holds the token exchange and refresh, strict profile and managed-settings readers, each with its own body bound and deadline. What those modules deliberately do not carry is the caller's side of that chain: choosing the eligible previous request from retained history and persisting the ATIS state are the caller's, and an extraction may take the pure selector and account reference it needs. That private continuation-state store is not part of the Mac-side pack, and Mac work is paused for this round: nothing in this section says the pool caller or a Mac backend is implemented. Each directory's own README states its contract.

Do not read this section as HIPAA compliance or as parity with a Desktop-managed client. This provider has no surface for the keys whose enforcement belongs to a client transcript scan or a repository probe, so those keys are inapplicable here and a denial never widens into transcript reads or transmission. A key this build does not map is refused conservatively rather than translated. The flag source is caller-injected and closable, with no new flag introduced, and a proactive minimum-version floor is not implemented: source analysis of the flag source shows its closable, unawaited, fail-open check defaults to `0.0.0` with no source or evidence behind it, so it carries no reliable scope or revision for a per-request forecast, and the known-refusal latch that exists records only refusals already seen. A policy applied by another DSH host is outside this plugin's scope — the public pool worker executes no tools here — so a cross-DSH policy handoff is unfinished. Platform identity claims need the deployment's real manifest and a real platform run; a synthetic fixture from one platform is not evidence for another, the checks recorded for this work are synthetic, and the pool caller's bidirectional evidence has not been delivered.

The route does not issue the optional startup `HEAD /api/hello` preconnect. Messages establishes its transport when needed; this deliberate omission adds no heartbeat or periodic connection traffic. Source and test builds do not update an installed plugin: deployment installs a verified versioned package while the Host is stopped.

## Proxy

DSH `v0.1.3-alpha.1` introduces host-managed proxy routing. Prefer configuring `HTTP_PROXY` / `HTTPS_PROXY` (or `ALL_PROXY`) and `NO_PROXY` in the launch environment or `$DSH_HOME/.env`, then restart DSH and **disable the plugin proxy**. See the [DSH network proxy guide](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/docs/user/guide/network-proxy.md). Proxy credentials in environment variables are inherited by child commands; this differs from keeping them in the plugin's private config. Existing settings are not deleted or migrated automatically.

The optional plugin override remains available for supported older DSH hosts and subscription-only routing. Every subscription request — token exchanges, model-API streams, usage lookups, model discovery, and the `web_search` / `x_search` / `image_generate` / `video_generate` tools — can use it. Configure it in **Settings → Subscriptions → Proxy → Configure…**: enable the flag, enter the proxy URL (`http://127.0.0.1:7890`), optional username/password, and an optional comma-separated bypass list (`127.0.0.1`, `localhost`, `*.example.com`). Disabled or bypassed requests use DSH's global fetch routing, **not necessarily a direct connection**; use the host's `NO_PROXY` when direct routing is required. The password is stored in `~/.dsh/plugins/subscriptions/proxy.json` (mode 0600) and is never returned to the browser. A "Test" button probes one endpoint through the current configuration and shows the HTTP status/latency.

Changes apply immediately to subsequent requests — no restart needed. The OAuth authorization page opens in your browser and follows the browser/system proxy, not this setting. SOCKS proxies are not supported.

## Related plugins

This plugin only supplies model routes. Approval policy lives elsewhere:

- [`dsh-plugin-auto-review`](https://github.com/delef/dsh-plugin-auto-review) — provider-native automatic review for DSH tool approvals. It reproduces Codex Guardian and Grok escalation logic on top of the `codex` / `grok` routes registered here (or compatible routes from other DSH LLM adapters) via `ctx.llm.stream()`, and does not touch accounts or credentials. Install with `dsh plugin --profile web add dsh-plugin-auto-review`.

## Develop

```sh
pnpm install   # devDependencies link into a local deepseek-harness checkout — edit the paths first
pnpm build     # tsc (lib/) + tsdown (lib/client.js browser bundle)
pnpm test      # compile to lib-test, then node --test in a private DSH_HOME
```

`prepare` (used by git installs) runs `tsdown.prepare.config.ts`: a self-contained bundle build of both faces with all `@deepseek-ai/*` specifiers external — they resolve from the dsh installation at runtime, so this package never carries a second cordis copy.

After `pnpm build`, restart `dsh web` to pick up changes.

## Layout

- `src/index.ts` — plugin entry: config schema (the cache horizons are resolved in `cache-policy.ts`), adapter registration, auth-change re-announce, RPC wiring
- `src/auth/` — PKCE/JWT helpers, token store, OAuth flow engine (temp loopback callback server), Claude Code credential reader (Keychain/file), `/subscriptions-auth` RPC channel
- `src/auth/claude-credential-ownership.ts` — the single authority for `credentialOwnershipMode`: the three modes, which of them may spend the shared refresh grant or run the plugin's own renewal timer, and the conversions the settings channel may persist
- `src/providers/` — per-provider OAuth constants/exchange/refresh + `LlmAdapter`s, multi-account token plumbing (`accounts.ts`), the pool (`pool.ts` + `pool-health.ts` / `pool-usage.ts` / `pool-family.ts`), `rate-limit.ts` (reset-instant parsing + retry policy), and the durable per-account metadata caches (`catalog-store.ts` / `usage-store.ts`, with `cache-identities.ts` reconciling a stored account rename at load)
- `src/translate/` — dsh `Message[]` ⟷ OpenAI Responses / Anthropic Messages / Antigravity wire formats, SSE → `StreamChunk`
- `src/providers/codex-search.ts` — Codex provider for DSH's native `web_search` capability
- `src/tools/` — `x_search`, `image_generate`, and `video_generate`
- `src/client/` — the Settings → Subscriptions page (browser half, zh/en, theme-token aware) and the one subscription cache the badge and the page share (`subscriptions-cache.ts`)
