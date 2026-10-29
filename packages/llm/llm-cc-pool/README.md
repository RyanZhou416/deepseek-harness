---
description: "Fork-only mac-pool provider: one fixed cc-pool Anthropic Messages route with a configurable model catalogue (built-in default), installed as an opt-in profile bundle."
kind: "package-bundle"
---

# @deepseek-ai/dsh-llm-cc-pool

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm-cc-pool` adds the mac pool as an optional provider: one Anthropic Messages route whose endpoint, credential reference, and retry policy are fixed, present only when installed. The route serves the built-in four-model catalogue until a deployment replaces it through `models`, which the settings service projects as an editable form. Its default prompt-cache policy is the four-marker Claude Code layout with the explicit one-hour lifetime and the extended-cache beta. The plugin registers no configurable-provider entry; its discovery read reports the pool `/v1/models` listing as candidates and never writes the catalogue, so a model enters this route only through validated configuration.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install the package into a profile, or mount its one row from a profile patch:

```yaml
- id: llm-cc-pool
  name: '@deepseek-ai/dsh-llm-cc-pool'
  config:
    requestLog:
      path: /var/log/dsh/cc-pool-requests.jsonl
    models:
      - id: claude-sonnet-5-5
        name: Claude Sonnet 5.5
        contextWindow: 1000000
        maxTokens: 128000
        defaultReasoning: medium
```

The package manifest declares `dsh.bundle.patch`, so `dsh plugin --profile web add ./packages/llm/llm-cc-pool` records the dependency in the profile and the profile loader applies its patch. The fork's `build.cmd` does the same automatically: `scripts/fork-plugins-build.ts` stages this workspace package beside the fork plugins and links it into the web profile, and the portable seed leaves `cc-pool` to this bundle instead of declaring an `llm-pi-ai` provider. Nothing else in the composition needs a `cc-pool` block: the route facts are plugin source, and `models` is the one model fact a deployment changes.

### Fixed route facts

| Fact | Value |
|---|---|
| Provider route | `cc-pool` (display name `CC 订阅池`) |
| Wire protocol | `anthropic-messages` |
| Endpoint | `https://ccpool.tiancegames.com` |
| Credential reference | `CC_POOL_API_KEY` |
| Deployment header | `x-cc-backend: direct` |
| Session identity | `X-Claude-Code-Session-Id` from the request's session id, `x-cc-session-name` from the owning session's display name, and one `x-client-request-id` per deliberate attempt |
| Retry policy | `normal`, 2 retries, retryable codes `RATE_LIMIT`, `SERVER`, and `POOL_REQUEST_CLOSED` used exactly as written; `TIMEOUT` is excluded because a dispatched attempt may already be unknown |

`CC_POOL_API_KEY` resolves per request through the credentials service, then the launch environment. A miss fails the request with `MISSING_CREDENTIAL` naming the reference; it never falls back to an unrelated ambient provider key. The session header binds the pool's conversation key and prompt identity, so every turn and tool continuation of one conversation presents the same session. The ledger id belongs to one attempt: a deliberate retry sends a fresh id, so the pool cannot answer it as a replay of an id it already closed, while repeated dispatches of one attempt keep their id. These three header names are adapter-owned on this route; a profile header spelling one of them in any casing is removed instead of sent beside it.

The pool admits one in-flight direct request per session and refuses a concurrent one with `cc_pool_session_busy` instead of waiting. The plugin orders streams by the request's session id: a second request for one session reaches the route only after the first stream settled, while different sessions keep running concurrently and still pass through the pool's global slot limiter. A request that is refused with `cc_pool_session_busy` before it forwarded any content (the previous lease releases slightly after its last chunk) is retried up to eight times over 1.8 s, whether or not it queued behind that lease; aborting the request releases its queue slot immediately and opens nothing. Every other refusal — the global-slot `cc_pool_rate_limited` 429, capacity limits, provider rate limits — is returned unchanged with its `Retry-After`, so `dsh-llm-retry` owns it; a refusal naming an already-closed client request id (`cc_pool_request_closed`) is retryable there because the next attempt carries a fresh id. This plugin adds no global or per-IP queue and no throttle between sessions.

### Prompt-cache policy

The route's default policy is the four-marker Claude Code layout with the explicit one-hour lifetime: `cacheMarkerPolicy: cc4`, `cacheTtl: 1h`, and `extendedCacheBeta: true`. A profile that sets none of them serves that policy. The fields are loader configuration read when the plugin mounts, apply to this route alone, and reach the wire only through this route's profile. `cacheTtl` names the marker lifetime, `extendedCacheBeta` declares `extended-cache-ttl-2025-04-11` (which a one-hour lifetime requires), `cacheMarkerPolicy: cc4` owns placement, and `toolCacheBreakpoint` selects the tool marker only when a policy without `cc4` places markers.

An impossible combination is refused when the plugin loads, and on the settings-write validation that runs at the same point, never at request time: `cacheTtl: 1h` without `extendedCacheBeta: true` is an error, and `cacheMarkerPolicy: cc4` additionally requires `cacheTtl: 1h`. The schema still accepts the three lifetime values, but the configured policy decides whether they can serve, so the route cannot be left without the beta its markers declare. `toolCacheBreakpoint` is accepted and ignored while `cc4` owns placement: the policy always marks the last tool declaration itself, so `false` cannot remove it.

With `cc4`, the adapter owns placement: every `cache_control` the shared transport or a caller placed is removed from `system`, `tools`, and `messages`, then exactly the slots the request has are marked with `{"type": "ephemeral", "ttl": "1h"}` — `system[0]`, the last tool declaration, the last cacheable user content block, and the last cacheable assistant content block. A request with no tool declaration or no assistant turn carries the smaller set rather than gaining a block it did not send, and a final assistant block that is `thinking` or `redacted_thinking` is skipped without searching backward. The beta is carried on the request's `anthropic-beta` header; the forwarded payload gains no `scope` field and no scope beta.

Because the policy is explicit on the profile, an ambient provider preference (`PI_CACHE_RETENTION`, which other routes may still follow) cannot move it. Every other pi-ai Anthropic Messages route states its own `cacheRetention` explicitly, so this route's policy cannot reach it and none of them declares the extended beta.

### Model catalogue

The built-in catalogue a profile serves when it configures no `models` list:

| Model id | Name | Context | Output cap | Default effort |
|---|---|---|---|---|
| `claude-sonnet-5-5` | Claude Sonnet 5.5 | 1,000,000 | 128,000 | `medium` |
| `claude-opus-5-5` | Claude Opus 5.5 | 1,000,000 | 128,000 | `medium` |
| `claude-fable-5-1` | Claude Fable 5.1 | 1,000,000 | 64,000 | `high` |
| `claude-mythos-5-1` | Claude Mythos 5.1 | 1,000,000 | 64,000 | `high` |

Every model offers `low`, `medium`, `high`, `xhigh`, and `max`; `off`, `minimal`, the fast/priority `speed` tier, and a context-management request field are not part of this catalogue. The catalogue turns on `compat.forceAdaptiveThinking`, so a selected level travels as `output_config.effort` under adaptive thinking rather than as a token budget. A model's default effort is materialized into a request that names none.

A profile replaces the list wholesale through `models`. Each entry states its wire id, display name, context window, output cap, and default effort; the levels stay the five above, and adaptive thinking stays on, so an entry cannot remove the pool's level contract or add `off` or `speed`. The list must name at least one model, every id once, with non-empty names and positive integer capacities. An invalid list fails the plugin at load, and the same check refuses a settings write before it persists. A catalogue entry's `maxTokens` is also that model's per-request output cap when the caller names none, and its `defaultReasoning` is the effort materialized into a request that names none.

The list is visible before a key is stored, because it is configuration rather than a discovery result; the pool sync read below never changes what the route serves. Storing the key is what makes requests succeed; sending one without it fails loud with `MISSING_CREDENTIAL`.

`models` is a live field: the settings service projects it as the route's configuration form, an edit persists through the active profile's Cordis patch, and the next request and model listing see the new catalogue without a restart. Resetting the field returns the route to the built-in catalogue. The token is not part of this configuration: `CC_POOL_API_KEY` stays in the credential store, and the settings surface writes it there rather than into the profile.

### Pool model sync

The plugin registers model discovery for the `llm-cc-pool` settings namespace, so a configuration surface can read the models the deployed pool currently advertises. The read uses this route's fixed facts: `GET https://ccpool.tiancegames.com/v1/models` with `Authorization: Bearer <CC_POOL_API_KEY>` resolved from the credentials service, then the launching environment. A request's draft `baseURL`, `api`, and one-time `apiKey` are not consulted, so the namespace can only ever interrogate the pool, and a missing stored credential fails instead of borrowing a draft key.

Each `data[]` entry contributes exactly an `id` and a `name` taken from `display_name`, falling back to the id. The pool discloses no context window, output cap, default effort, or modality, so none is invented: a surface adopting a candidate still owes those values, and adding it remains an explicit settings write through the same catalogue validation as a hand edit.

A successful read returns candidates in pool order, and an id listed twice keeps its first entry. An empty listing is an empty candidate list. A missing credential, an unreachable or refusing endpoint, and a reply that is not a JSON `data` array each fail typed (`MISSING_CREDENTIAL`, `DISCOVERY_FAILED`) and never fall back to the built-in or configured catalogue. The read writes nothing: it does not adopt a model, persist a profile, register a route, or enter the generic Models page.

### Request diagnostics

Each attempt is recorded as one structured log record when it starts and one when it settles: route, model, endpoint, session id, this attempt's ledger id, the attempt number within its logical request, response status, the pool's `x-cc-pool-request-id` when the response carries one, and a failure's code, message, and cause chain. A queued request that the pool refuses while its previous lease releases is retried as the next attempt of the same logical request: the attempt number advances and the retry sends a new ledger id, so it is a new pool ledger entry rather than a replay. Records never carry messages, request bodies, credentials, token counts, or session titles.

`requestLog` persists the same records as NDJSON. With no configuration the pool route writes to `$DSH_HOME/logs/llm-pi-ai-requests.jsonl` — the path the generic pi-ai adapter used, kept so existing evidence collection survives the plugin split. `path` moves the file, `maxFileBytes` (default 16 MiB) sets the rotation point, `maxFiles` (default 8) the retained count; rotation deletes the oldest file first and the retained set stays within 128 MiB. Writes are queued off the request path, and a failed write is reported once through the plugin logger without failing a request.

<a id="understand-the-implementation"></a>
## Understand the implementation

The package is a named Cordis function plugin (`name`, `inject`, `Config`, `apply`) with no default export. `apply` resolves the effective catalogue through `dsh-llm-pi-ai`'s generic profile resolver, so a malformed catalogue fails at plugin load rather than at the first request, and registers it on `ctx.llm`. Before that resolution it validates the cache policy's cross-field requirements, and the same check runs on the settings-write waterfall, so an impossible lifetime/beta combination is refused where it is written. That profile carries the configured `cacheTtl` as its pi-ai `cacheRetention` tier, `extendedCacheBeta` as the profile's beta declaration, `toolCacheBreakpoint` as the route compat switch `supportsCacheControlOnTools`, and `cacheMarkerPolicy` as the profile's four-marker policy, which is how the policy reaches the request without this plugin touching a body (the `cc4` rewrite runs in `dsh-llm-pi-ai`'s one `onPayload` hook). The resolved catalogue and profiles are memoized by the raw `models` value, so an unchanged configuration keeps one snapshot while a settings write produces the next one.

The adapter is `dsh-llm-pi-ai`'s `PiAiAdapter` with two overrides: `listModels` answers from the effective catalogue instead of resolving the credential first, and `stream`/`prepareCall` route each dispatch through the per-session queue. The generic adapter's HTTP/SSE transport, context conversion, stream projection, pool-error classification, and replay handling are reused, not copied. The plugin contributes the route facts, the catalogue, the fixed retry policy, session headers, session ordering, logging, and the durable sink.

All registrations go through the Cordis fiber: disposing the plugin withdraws the route and the model discovery, closes the request log, and settles any request still queued for a session. The plugin registers no configurable-provider entry, so no generic Models page drafts a route of its own; its own discovery offers the pool listing as candidates and writes nothing. Its `models` field is volatile, which is what the settings service projects as the route form; the plugin registers a presentation policy of its own, so the dedicated page is the only settings presentation.

<a id="further-exploration"></a>
## Further Exploration

- [dsh-llm service](../llm/README.md) — the provider-neutral service this plugin registers on.
- [llm-pi-ai adapter](../llm-pi-ai/README.md) — the generic pi-ai adapter and pool-error classification this plugin reuses.
- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the `StreamChunk` protocol and adapter contract.
- [Fork maintenance](../../../FORK_MAINTENANCE.md) — the preservation rules the mac-pool fork records for this plugin.

<a id="model-experience"></a>
## Model Experience

### Provider request through the mac pool

#### What the model sees

The selected pool model receives the assembled system prompt, conversation history, and tool declarations from the shared pi-ai transport, with the pool's `x-cc-backend` and Claude Code session headers added and the model's default effort sent as `output_config.effort` under `thinking: {type: "adaptive"}`.

#### Token effect

The effective catalogue's `maxTokens` becomes the per-request output cap when the caller names none, and reasoning tokens at the selected level count toward it. Nothing else in this plugin adds input tokens: the route facts and headers are not model-visible text.

#### KV Cache effect

The fixed catalogue, endpoint, and headers are stable across requests, so they do not disturb the provider's reusable prefix. The session identity is derived from the request session and its conversation position, so a retry repeats it while a request with new content starts a new conversation key. The default `cc4` policy marks the four fixed slots with an explicit one-hour lifetime and declares the extended beta; `cacheTtl`, `extendedCacheBeta`, and `toolCacheBreakpoint` remain the route's fields, but the policy requires the one-hour, beta-declaring combination and owns the marker set, so the marker layout does not vary between requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Pool failure classification still lives in `dsh-llm-pi-ai`** — this plugin reuses the generic adapter's pool-error classifier and `dsh-llm-retry`'s executor, so a build without `dsh-llm-pi-ai` cannot mount the route. Moving the mac-pool-only classification into this package is deferred; the migration must not add mac-pool branches to the generic package.
- **The durable log keeps the generic file name** — with no configured `path`, records go to `$DSH_HOME/logs/llm-pi-ai-requests.jsonl` so existing evidence collection keeps working. A deployment that wants a pool-named file sets `requestLog.path`.
- **The catalogue is edited through this plugin's own field** — a deployment changes its model set through `models`, and the pool sync only reports candidates: adopting one is an explicit settings write through the validated catalogue, never a silent overwrite, and the read cannot adopt into the generic Models page. Adding a level, removing adaptive thinking, or changing a route fact ships with a plugin version.
- **Only the effective catalogue ids are advertised** — routing accepts unlisted model ids at the service level, but selector surfaces show this list and the configured catalogue is the source of truth.
- **Image modalities are a declaration, not a probe** — every catalogue entry receives `text` and `image`; a pool endpoint refusing images surfaces as a provider refusal mid-turn.
- **The cache layout is a fixed four-marker policy, not CC's full planner** — the route marks `system[0]`, the last tool declaration, the last user content block, and the last assistant content block, and skips a trailing assistant `thinking` block without searching backward. It does not reproduce the client's `markerIndices`, fork-point, or compaction breakpoint planning. `toolCacheBreakpoint` is accepted but ignored while `cc4` owns placement, and a policy without the required one-hour/beta combination is refused at load rather than silently falling back.
- **The base bundles do not include this package** — the route exists only in a profile that links the bundle. The fork's `build.cmd` does that for the web profile, but a profile created without it has no `cc-pool` route. A profile that still declares an `llm-pi-ai` `cc-pool` provider must remove it, or both adapters would claim `cc-pool` and plugin loading fails.
- **Same-session ordering is per Host process** — the queue belongs to one plugin instance, so a second DSH process or another CC client using the same pool session is not coordinated. The bounded retry absorbs a lease that releases slightly late, but a session still active elsewhere surfaces `POOL_SESSION_BUSY` to the caller.

<a id="dev-note"></a>
### Dev Note

- A route fact, a capacity the deployment does not configure, or the level set changes with a plugin version. The package owns those values so no profile edit can drift from the deployed pool; the deployment's own model set is configuration, not a version fact.
- The session-busy retry schedule is a pool behavior fact, not a deployment tunable: the lease releases shortly after a stream ends, and the fixed 100-250 ms steps bound the wait without letting a stuck session hang a turn. Only `POOL_SESSION_BUSY` is retried here; the global slot limit and provider rate limits remain `dsh-llm-retry`'s business.
- The plugin's `Config` has six fields: `requestLog`, an installation fact, `models`, the deployment's catalogue, and `cacheTtl`, `extendedCacheBeta`, `toolCacheBreakpoint`, and `cacheMarkerPolicy`, the route's prompt-cache policy. The cache defaults are the four-marker one-hour policy (`cacheTtl: 1h`, `extendedCacheBeta: true`, `cacheMarkerPolicy: cc4`), and an impossible combination is refused at load. None of the fields admits a level map, an arbitrary compat switch, a retry schedule, or a credential literal.
