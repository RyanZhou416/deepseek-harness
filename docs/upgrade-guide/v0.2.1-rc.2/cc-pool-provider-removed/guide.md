---
kind: upgrade-guide
description: "The base bundle no longer declares a cc-pool provider or its models; install the llm-cc-pool plugin and move custom models to its entry."
---

# The base `cc-pool` provider and models moved into `@deepseek-ai/dsh-llm-cc-pool`

English | [中文](guide.zh.md)

## Change

The base bundle's `llm-pi-ai` row no longer ships a `cc-pool` provider block or its nine models. The mac-pool route is now owned solely by the `@deepseek-ai/dsh-llm-cc-pool` plugin bundle: its endpoint, credential reference, headers, retry policy, and default four-model catalogue live in that package. A profile that still declares `providers.cc-pool` under `llm-pi-ai` — in a profile patch, an overlay, or stored settings — fails to load once the plugin is installed, because both adapters would claim the `cc-pool` route; a profile that relied on the base declaration loses the route entirely.

## Migration

1. Add the plugin to each profile that serves the pool: `dsh plugin --profile <profile> add @deepseek-ai/dsh-llm-cc-pool`. Its bundle patch mounts the `llm-cc-pool` entry.
2. Remove every `llm-pi-ai` `config.providers.cc-pool` block, including its `models` list, from that profile's patch, overlays, and settings document. Keep `CC_POOL_API_KEY` where it is: the plugin reads the same credential reference.
3. Move a custom model list to the `llm-cc-pool` entry's `models` field. Entries keep `id`, `name`, `contextWindow`, `maxTokens`, and `defaultReasoning`; the offered levels are `low`, `medium`, `high`, `xhigh`, and `max`. Omitting `models` serves the built-in four-model catalogue (`claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`, `claude-mythos-5-1`), which is smaller than the removed list.
4. Start the profile and confirm two things: the loader reports no duplicate `cc-pool` registration, and the model selector lists exactly the catalogue the composition serves. A request without a stored `CC_POOL_API_KEY` fails with `MISSING_CREDENTIAL` instead of borrowing another provider's key.
