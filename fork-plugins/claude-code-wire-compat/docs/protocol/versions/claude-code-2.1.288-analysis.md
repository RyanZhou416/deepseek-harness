<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

> **Provenance**
>
> - First-party analysis authored in this repository
> - License: `GPL-3.0-or-later`
> - Method: static extraction from the official release artifact, cross-checked
>   against the 2.1.280 artifact already pinned
>
> Scope: the **delta** between `2.1.288` and the `2.1.280` baseline this package
> pinned, and the desktop identity that makes `2.1.288` the version to claim. This
> document does not repeat the 2.1.280 analysis; it records what was re-verified and
> what changed. Every claim below carries its artefact or module, and nothing is
> reproduced from an external repository of code.

# Claude Code 2.1.288 Analysis

- **Date**: 2026-10-10
- **Target**: the release-channel artifact `2.1.288/win32-x64/claude.exe.zst`
- **Compared against**: `2.1.280`
- **Why this version**: the Windows desktop application pins it, and the CLI's own
  releases move faster than the desktop's, so a desktop session is a 2.1.288-or-later
  client while a CLI session is whatever the newest release is.

## 1. Artefacts and evidence classes

### 1.1 Hashes

| Artefact | Value |
| --- | --- |
| Compressed binary (`claude.exe.zst`) | `sha256:36aa8c97bf8665d371c5b5be82f2f1252fcc623dd323a6c7ac1fba0b09b8a35c`, `88,605,512` bytes |
| Decompressed binary (`claude.exe`) | `sha256:84304f7d4b0cd0ebcbe8318695a260151b48991a6659c3366fdd5da290c0ab91`, `249,149,600` bytes |
| Manifest | `https://downloads.claude.ai/claude-code-releases/2.1.288/manifest.json` |
| Commit | `17fe1eb736e5b1433d6ca86a1db334cec8520450` |
| Build date | `2026-10-02T17:00:28Z` |

Two manifests describe this release and they checksum **different** artefacts: the
desktop application's baked manifest checksums the compressed file, and the channel
manifest checksums the decompressed one. Both were verified; a reader comparing a
download against the wrong manifest would conclude, wrongly, that the artifact is not
authentic.

### 1.2 Evidence classes

- **Artefact-verified**: read from the binary or a manifest, listed above.
- **Cross-build uniform**: read in 2.1.280, 2.1.288 and 2.1.296 with identical results.
- **Unverified**: stated as such, with what would settle it.

Nothing in this document is class **capture**; where a captured value is known to have
been wrong for this release it is named, because that is how the OAuth hosts came to be
mis-pinned.

## 2. What moves on the wire

### 2.1 The beta set

The set moves once between 2.1.280 and this release, and not again through 2.1.296:

| Change | Identifier | Where it appears |
| --- | --- | --- |
| added | `cache-keepalive-2026-09-03` | registry entry `cache_keepalive`, between `prompt_caching_evict` and `extended_cache_ttl` |
| removed | `compact-2026-01-12` | not on this package's emission path |
| removed | `skills-2025-10-02` | not on this package's emission path |
| removed | `user-profiles-2026-03-24` | belongs to `/v1/user_profiles`, not Messages |

`user-profiles-2026-08-18` is added in the same range but is **not** a Messages beta: it
travels on `POST /v1/user_profiles?beta=true`.

### 2.2 The model catalogue

Extracted from the catalogue module and compared entry by entry:

- **One model added**: `claude-sonnet-5-5`. Its catalogue strings
  `silent_turn_reminder` and `org_locked_thinking` are not wire fields — the first names
  a prompt render point, the second gates an organisation-change warning — so this
  package does not model them.
- **No capability is added or removed on any shared model.**
- **One context flag is dropped**: `claude-sonnet-5` no longer declares `native_1m_3p`,
  which is a third-party-provider flag and is not modelled here.

At **2.1.296** the catalogue changes materially: `mid_conv_system` disappears from every
model that carried it, and `claude-haiku-5-5` and `claude-sonnet-5-5` are added. This is
recorded because it decides the anchor: on 2.1.296 the `mid-conversation-system` beta is
no longer sent by any model, while on this release it is sent by eight.

### 2.3 What does not move

Verified identical in 2.1.280, 2.1.288 and 2.1.296: all three identity literals, the
reporting text (still occurring exactly once, at its definition), `cc_turn_origin`,
`cc_entrypoint`, `cch=00000`, the billing header, the refusal-fallback pair, the
usage-limit header, the atis pair, the caching-scope beta, extended-cache-ttl,
redact-thinking and the thinking-binding-controls landmarks.

## 3. Version-bearing fields

| Field | Value | Source |
| --- | --- | --- |
| `cliVersion` | `2.1.288` | the release channel manifest |
| `sdkVersion` | `0.128.0` | the SDK runtime module's version constant, the same constant the `X-Stainless-Package-Version` header is built from |
| User agent | `claude-cli/2.1.288 (external, claude-desktop)` | composed from the version and the entrypoint the desktop sets |

The SDK version is **not** inferred from the CLI version: at 2.1.280 the constant is
`0.112.1` and at 2.1.288 it is `0.128.0`, and each was read from the module that feeds the
header. The 2.1.280 profile's `0.112.1` is therefore correct, and the open question the
audit raised about it is closed with a positive result.

## 4. The desktop identity

Read verbatim from the Windows desktop application's own code (build `2.19675.1`):

- `CLAUDE_CODE_ENTRYPOINT` is `claude-desktop` (`claude-desktop-3p` for third-party
  accounts), via `oOr`.
- `CLAUDE_CODE_DESKTOP_APP_VERSION` is the application's own version.
- Five client headers travel through `ANTHROPIC_CUSTOM_HEADERS`:
  `anthropic-client-platform: desktop_app`,
  `anthropic-client-app: com.anthropic.claudefordesktop`, the client version, a device
  class bucketed from physical memory (`le4` / `8` / `16` / `gt16`), and total memory in
  gigabytes.
- `x-app` remains `cli`, because the desktop **spawns this same client**; a desktop
  session and a CLI session differ by the entrypoint and those headers, not by the
  request's shape.
- The agent-SDK chunk builds no messages request at all: it has no messages path, no beta
  header and no API key handling. It supervises the client process. So there is no second
  request shape to reproduce.

## 5. Open items

- **The desktop's forward update source is unverified.** The application pins this
  version, downloads other versions, retains only those at or above the pin, and records a
  monotonic high-water mark — all read from its code. **Which source names a newer target
  was not found**, so "a desktop user runs 2.1.296" is an inference, not a finding. This
  is why the pin here is 2.1.288.
- **The prompt boundary separator's dynamic side** belongs to the client's own prompt
  bundle, split out by a function in the module that also holds the fingerprint salt. A
  caller with a different prompt cannot reproduce the genuine division, so the
  library-side layout stays inert until that content is known.

## 6. Where the service publishes its own version floor

The client does not decide what is too old. A signed document carries, per model, the
minimum client version allowed to use it:

| Field | Value at the time of writing |
| --- | --- |
| URL | `https://downloads.claude.ai/model-catalog/v1/catalog.json` |
| Catalogue version / issue | `1958`, `2026-10-10T01:05:10Z`, expiring one week later |
| Entries / models | 460 entries over 14 models |
| `min_claude_code_version` values | `2.1.251` and `2.1.280` |

The desktop application verifies this document against a key built into it and falls back
to a bundled copy until one has been fetched, which is why the same two values are also
present in the bundle. Two consequences matter here: the floor is a published, checkable
fact rather than an inference, and this profile's claimed `2.1.288` is above the highest
floor published today.

The one hard refusal a client can hit is `requiredMinimumVersion`, documented as enforced
only from managed (policy) settings and naming "your organization" in its message. The
managed-settings sources rank a server-managed source highest, so an organisation's
administrator can set a floor the server delivers; an individual account has no
organisation for that mechanism to attach to. No hardcoded minimum exists in the client
itself.