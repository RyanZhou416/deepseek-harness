---
description: "The CC subscription pool settings page on the dsh web client: the pool credential and the model catalogue override of the llm-cc-pool entry."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-cc-pool

English | [中文](README.zh.md)

## Summary

Open **Settings** and select **CC subscription pool** to set the pool token and the model list the `cc-pool` route serves. The page stages every edit and writes it only on **Save**: the token goes to the `CC_POOL_API_KEY` credential, the model list to the `llm-cc-pool` settings section. **Sync from pool** asks the pool which models it serves and stages the merge, so the save stays the only write. The page exists while the Host serves that entry, so a deployment without the mac-pool provider shows no trace of it.

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

The token field reports whether the credential resolves and which layer supplies it, and starts blank on every visit — a stored literal is never shown, so typing a new one rotates it. The model list opens on the catalogue the route currently serves: one row per entry with its wire id, display name, context window, output cap, and default effort. **Add model** appends a row, **Remove** drops one, and **Reset to built-in** stages a return to the deployment's catalogue. A blank or repeated id, a blank display name, a capacity that is not a positive whole number, an effort outside `low`, `medium`, `high`, `xhigh`, and `max`, or an empty list blocks the save and names the offending field. The rows carry the text a save writes: ids and display names are trimmed, and a stored display name that is only whitespace falls back to its id, so a Host-valid entry with padding opens as a saveable row instead of an error the page cannot clear.

Saving is fenced to the revision the drafts started from. When another change reaches the section first, the save is refused as a conflict rather than as bad values: the drafts are kept, the page says the setting changed elsewhere, and the next save applies them against the revision it re-read. Once a write is accepted the rows show exactly what the Host stored, so trimmed text or a capacity typed with leading zeros leaves nothing to save. A credential the Host refuses reports the Host's own reason and keeps the typed key, while an accepted catalogue stays on screen.

**Sync from pool** asks the pool which models it serves and stages the result against the rows on screen. A model the table already lists keeps every field it has — the pool's display name and its own capacities never overwrite an edit — while a model only the pool lists is appended with a *From pool* marker and placeholder capacities to review (1M context, 128k output, medium effort). When the pool no longer lists a model the table holds, the page asks before dropping it: **Remove and sync** makes the list match the pool, and **Keep and sync** stages the additions and updates without deletions. Closing that prompt — its close control, **Cancel**, the backdrop, or Escape — cancels the whole sync, so neither the removals nor the additions are staged. The merge is only a draft; **Save** still writes it. A sync needs a configured token and refuses an empty, repeated, or unreadable listing with the reason, leaving the list exactly as it was; a request the pool does not answer within 20 seconds reports the timeout and changes nothing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half is an empty `apply`, present only so the package holds a Loader row the client module system serves the browser half for. The browser half binds the Host plugin's profile entry (`llm-cc-pool`) through `ctx.configForms.get`, stages rows in `CcPoolSettingsPage`, and writes the whole `models` array as one revision-fenced mutation; a staged reset writes `unset` instead, so the Host's schema default applies again. A refused catalogue write is read back before it is reported: a section revision past the staged one is a conflict, the recovered revision becomes the next fence, and the drafts stay staged. The credential is the one control outside the settings document: it is written through `ctx.remote.credentials` and its configured state, source, and writability are re-read at mount and after every credential change. A sync reads the Host's registered discovery through `ctx.remote.llm.discoverModels('llm-cc-pool', { provider: 'cc-pool' })`; `sync.ts` validates the listing and merges it by id into the edited rows, and a removal waits for the confirmation before the merge is staged. The discovery request carries this page's `AbortSignal` and a deadline, so discarding, confirming, or leaving cancels it and a late answer is dropped. The page registers into `settings.section` through `ctx.configForms.whileServed`, so it appears only while the Host serves the pool entry. Copy lives in this package's `settings.ccPool` dictionary; the `SettingsForm` frame takes its labels as props.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-settings](../ui-settings/README.md) — the shared configuration form and the served-namespace watch the page rides.
- [ui-primitives](../ui-primitives/README.md) — the settings form frame, secret field, and button the page renders.
- [llm-cc-pool](../../llm/llm-cc-pool/README.md) — the Host plugin that owns the `llm-cc-pool` entry and its catalogue rules.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface; the catalogue it edits reaches the model only through the Host plugin.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The page follows the Host namespace** — it appears only while a deployment composes `@deepseek-ai/dsh-llm-cc-pool`; a profile without that plugin has no page and no route.
- **One save performs two writes** — the credential lives in the credentials domain and the catalogue in the settings section, so a refused credential reports the Host's reason beside a catalogue that already landed; the typed key stays staged for another attempt.
- **A synced model starts from placeholder capacities** — the pool listing discloses ids and display names only, so a row the sync adds assumes 1M context, 128k output, and medium effort until someone sets its real values. The *From pool* marker stays until the save.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The catalogue contract (`CcPoolModel`, the five levels, the entry id, and the credential reference) is owned by `@deepseek-ai/dsh-llm-cc-pool`; this package restates those names in `src/client/contract.ts` because a browser bundle cannot import Host package values.

</details>
