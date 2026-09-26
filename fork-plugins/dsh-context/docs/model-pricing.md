# Subscription model cost estimates

Context estimates API-equivalent token costs for the models below, including Agent and subagent totals. These dated vendor prices take precedence over models.dev for the listed routes and remain available when the online registry is unavailable. Other models continue using models.dev; unknown prices remain unavailable. Mixed summaries include only models with known rates.

Prices were verified on **2026-09-27**. All figures are USD per million tokens at standard speed.

| DSH route | Model | Uncached input | Cache read | Cache write | Output |
| --- | --- | ---: | ---: | ---: | ---: |
| `codex` / `openai` | `gpt-6-astra` | 10 | 1 | 12.50 | 50 |
| `codex` / `openai` | `gpt-6-sol` | 2 | 0.20 | 2.50 | 10 |
| `claude` / `anthropic` | `claude-opus-5-5` | 4 | 0.20 | 5 | 20 |
| `claude` / `anthropic` | `claude-fable-5-1` | 10 | 0.25 | 12.50 | 50 |
| `cursor` / `grok` / `xai` | `grok-4.7` | 2 | 0.50 | 2* | 6 |

Claude cache-write estimates use the 5-minute rate. Grok publishes no separate cache-write premium; any reported cache-write bucket uses its ordinary input rate, marked with an asterisk above. The estimate uses the token buckets actually recorded by the adapter and cannot recover unreported usage.

## Long context

The threshold applies to each request's complete prompt, including cached input, rather than the Session's cumulative token count. Above the threshold, the higher rate applies to that request's entire input and output.

| Model | Prompt threshold | Input | Cache read | Cache write | Output |
| --- | ---: | ---: | ---: | ---: | ---: |
| `gpt-6-astra` | >272,000 | 20 | 2 | 25 | 75 |
| `gpt-6-sol` | >272,000 | 4 | 0.40 | 5 | 15 |
| `grok-4.7` | >200,000 | 4 | 1 | 4* | 12 |

Claude Opus 5.5 and Fable 5.1 retain their standard rates throughout their supported context windows. Context preserves long-context requests in a separate derived cost bucket; merging Agents or sessions does not reclassify their requests. Projection version 21 rebuilds this classification from existing Session logs when cached summaries are read. Original Session events are unchanged.

These estimates do not calculate subscription fees, quota deductions, Fast-mode premiums, regional premiums, server-side tool charges, or one-hour Claude cache-write prices. The CNY display retains the plugin's reference conversion of 1 CNY = 0.15 USD.

Updating the reference rates reprices historical token totals for comparison. A change to a context threshold also requires a projection-version bump so historical requests are classified again.

## Sources

- [GPT-6 Astra pricing](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [GPT-6 Sol pricing](https://developers.openai.com/api/docs/models/gpt-6-sol)
- [Claude model and cache pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Grok 4.7 model pricing](https://docs.x.ai/developers/models/grok-4.7)
- [Grok 4.7 long-context rates](https://docs.x.ai/developers/release-notes)
