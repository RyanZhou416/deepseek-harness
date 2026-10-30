---
kind: upgrade-guide
description: "The base bundle no longer declares a cc-pool provider or its models; install the llm-cc-pool plugin and move custom models to its entry."
---

# The base `cc-pool` provider and models moved into `@deepseek-ai/dsh-llm-cc-pool`

English | [中文](guide.zh.md)

## Change

The base bundle's `llm-pi-ai` row no longer ships a `cc-pool` provider block or its nine models. The mac-pool route is now owned solely by the `@deepseek-ai/dsh-llm-cc-pool` plugin bundle: its endpoint, credential reference, headers, retry policy, and default four-model catalogue live in that package. A profile that still declares `providers.cc-pool` under `llm-pi-ai` — in a profile patch, an overlay, or stored settings — fails to load once the plugin is installed, because both adapters would claim the `cc-pool` route; a profile that relied on the base declaration loses the route entirely. The Messages endpoint is fixed at `https://ccpool.tiancegames.com`; there is no base-URL, gateway, or proxy override, and `CC_POOL_API_KEY` must be the member key for that canonical host. A key minted for a gateway or another host fails at the pool, and the fixed endpoint cannot be redirected.

## Migration

1. Install the bundle into each profile that serves the pool. The package is private and is not published to npm: on Windows, stop the Host and run `build.cmd`; on macOS, run `build.command` and then `pnpm exec tsx scripts/fork-plugins-build.ts`. The build stages the package under `.build/fork-plugins/llm-cc-pool` and links it into the profile.
2. Remove every `llm-pi-ai` `config.providers.cc-pool` block, including its `models` list, from that profile's patch, overlays, and settings document. Keep `CC_POOL_API_KEY` where it is: the plugin reads the same credential reference, and that key must belong to the canonical `ccpool.tiancegames.com` host.
3. Move a custom model list to the `llm-cc-pool` entry's `models` field. Entries keep `id`, `name`, `contextWindow`, `maxTokens`, and `defaultReasoning`; the offered levels are `low`, `medium`, `high`, `xhigh`, and `max`. Omitting `models` serves the built-in four-model catalogue (`claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`, `claude-mythos-5-1`), which is smaller than the removed list.
4. Start the profile and confirm two things: the loader reports no duplicate `cc-pool` registration, and the model selector lists exactly the catalogue the composition serves. A request without a stored `CC_POOL_API_KEY` fails with `MISSING_CREDENTIAL` instead of borrowing another provider's key.
5. To roll back, stop the Host, remove the link with `dsh plugin --profile <profile> remove @deepseek-ai/dsh-llm-cc-pool`, restore the profile patch and settings from before the migration, then run the same staging command and restart. Do not edit the linked `.build/fork-plugins/llm-cc-pool` files by hand.
