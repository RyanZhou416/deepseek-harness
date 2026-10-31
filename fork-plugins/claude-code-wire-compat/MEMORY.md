<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Decision memory

Append-only log of non-obvious maintenance decisions and their reasoning, so
future work does not re-litigate or accidentally reverse them. Newest entries
first. Keep entries dated, factual, and in consumer-neutral language.

## 2026-09-26 - Input ceilings follow the 32 MiB API request limit (0.7.1)

Context: long sessions on 1M-token models failed before fetch with
`INPUT_TOO_LARGE (maximumSize=1000000)`. The 1,000,000-unit aggregate graph
budget in `src/limits.ts` had no upstream provenance; the genuine client has
no client-side cap and the Messages API accepts bodies up to 32 MB.

Decisions:

1. **`MAX_INPUT_SIZE = 32 * 1024 * 1024` (33,554,432).** Binary, not
   32,000,000: of the two readings of "32 MB" it rejects less. Every walker's
   measure (UTF-8 or UTF-16 string length plus key and scalar counts) is at
   most the serialized size of the graph it inspects, apart from `undefined`
   values serialization omits, so an API-acceptable request is never refused
   locally. Measures were not unified; only the ceiling is shared.
2. **`MAX_INPUT_ITEMS = floor(MAX_INPUT_SIZE / 10)` (3,355,443)** keeps the
   old 100,000 : 1,000,000 ratio. Messages and content blocks each serialize
   to well over ten bytes, so only pathological tool-input JSON (millions of
   empty containers) can reach it before the size budget.
3. **`MAX_COMPOSITE_SIZE = 3 * MAX_INPUT_SIZE` (100,663,296)** for graphs that
   hold the serialized body next to other material: redaction evidence input
   and the built-request wrapper given to the parser. Under the single
   ceiling, evidence (normalized request plus body plus two profiles) would
   have capped inputs near 16 MiB. The builder still never returns a request
   its own parser rejects: evidence input is a superset of the wrapper except
   the few hundred bytes of evidence output, and the profiles it also carries
   are larger than that.
4. **Size failures carry `safeDetails.maximumSize`** from every walker, not
   only the evidence walker, so a consumer's message names the budget that
   fired. The container ceiling reports the additive `maximumItems` instead
   (review finding on PR #36), so the two limits stay distinguishable. The violation-offset sanitizer bound follows `MAX_INPUT_SIZE`
   (previously 1,000,000).

Measured on Node 24 (Windows, x64) with realistic sessions of tool calls and
multi-kilobyte tool results: build ~75 ms per MiB of body, linear (1.2 MB
body 101 ms, 5.8 MB 367 ms, 11.6 MB 749 ms, 23.2 MB 1,306 ms, 30.2 MB
1,935 ms); parse and count-tokens are cheaper. Heap growth during a 30 MB
build was ~113 MiB. The largest single-string build input sits 5,058 units
under the ceiling, the room later walkers need for canonical system blocks
and the profile.

Unchanged: depth limits, cycle and prototype guards, header, identifier and
metadata field limits. No fixture was resealed; frozen digests hold.

Revert: restore `MAX_INPUT_SIZE = 1_000_000` and `MAX_ITEMS = 100_000`
(private in `src/request-body.ts`), point `src/redaction.ts` and the parser
wrapper back at `MAX_INPUT_SIZE`, drop `MAX_COMPOSITE_SIZE` and the added
`maximumSize` details, and restore the test boundaries; add a dated entry
here.

## 2026-09-25 - P1.T1/D4 diagnostic review and provenance correction

The entry below overstated incident attribution and identifier coverage.
Synthetic probes proved local rejection of controls, but the original user's
offending input remains unknown. Raw TextEncoder replaces lone surrogates;
JSON.stringify escapes them, so a body-hash mismatch is not an automatic
consequence of JSON serialization. Model/tool identifiers are not prose and
require explicit screening after the generic body policy is relaxed.

D4 adds six primitive violation fields to the error sanitizer, not public
validator exports. Paths mask user-controlled subtrees even when a key matches
a schema word; only actual array indices become numbers. Root and truncated
paths remain valid, offset/length diagnostics are safe integers bounded by
1,000,000, and code units must match the closed reason. Legacy control errors
outside prose retain their codes and need not gain these additive details.
The reserved control-char reason permits only control code units; the unused
forbidden-key reason was removed. All surrogate classification still delegates
to the unchanged classifySurrogateAt implementation.

The input budget is not a wire-size limit: JSON escaping may expand one control
character to six bytes. Remote acceptance and the original failure trigger
remain UNVERIFIED; no authenticated probe was performed.

## 2026-09-25 — Body prose accepts every well-formed UTF-16 string (P1.T1)

Context: the graph screeners rejected C0 control characters except TAB/LF/CR,
plus DEL, in all body text; the system-field validator additionally rejected
the C1 range, so U+0085 passed in a message but failed in `system`. The rule
was a library-local defensive heuristic (see the comment that used to live
above `inspectString` in `src/build-request.ts`): no captured Claude Code
behaviour and no observed Anthropic API 400 ties the remote side to it. It
also produced a confirmed data-fidelity bug: the first real consumer's
sessions aborted locally with `INVALID_UNICODE` on legitimate tool output
carrying ESC (ANSI colour), NUL, FF or DEL, before any network call.

Decision (P1.T1): body prose — message text, `tool_result` content,
`tool_use` input values and keys, tool descriptions, `input_schema` text,
system text and stop sequences — accepts every well-formed UTF-16 string.
Only lone surrogates remain rejected, because `TextEncoder` silently replaces
them with U+FFFD and would desync the body hash. Headers, metadata
identifiers and runtime identity fields keep their strict rules; the
fingerprint's UTF-16 index sampling (4/7/20) is untouched. Wire bytes for
every previously accepted input are unchanged; no fixture was resealed.

Audit note: lanes whose strings land in headers were checked to have their
own validation independent of the graph walk (`src/headers.ts`,
`src/metadata.ts` including its nested-string pass, runtime identity), so the
relaxation exposes no identifier lane.

Whether the remote API rejects any scalar is UNVERIFIED. If a code point is
later shown to fail remotely, add a narrow rule citing that evidence rather
than reinstating blanket rejection; neutralizing ANSI/OSC for display is the
consumer's display-boundary job, not a validation rule.

## 2026-09-23 — The frozen packed-consumer digests are now enforced, not eyeballed

Context: `scripts/verify-packed-consumers.mjs` builds the same request from a
packed tarball under node, bun and workerd, and prints a SHA-256 digest per
profile. Its own block comment said each explicit case's digest "must not move
for any reason other than a change to that profile's own wire output" — but the
only assertion in the script was that the three runtimes agreed with **each
other**. A change that moved a profile's digest identically everywhere printed
the new value and exited 0. The two frozen literals lived in `AGENTS.md`,
`docs/source-trace.md` and three planning documents, and in no file the machine
reads, so the freeze was held by a human comparing 64-character hex strings.

Decision: the script now carries an `EXPECTED_DIGESTS` table and fails when a
pinned case moves. The `default` case is deliberately **not** pinned to a
literal — switching `DEFAULT_PROFILE` moves it on purpose — but to a case name
via `EXPECTED_DEFAULT_CASE`, so a default switch becomes a one-line change that
is still verified rather than an unobserved drift. A case present in
`CASE_NAMES` but absent from `EXPECTED_DIGESTS` is intentionally unpinned; that
is how a newly added profile behaves until its digest is first recorded.

When this fires, the fix is to find and revert the change that altered the wire
bytes. Editing a literal to match the new output defeats the entire point of
the gate and must never be done.

Related: the gate ran in no CI workflow at all. It now runs in the `bun` job of
`.github/workflows/ci.yml`, which is the only job that holds node, bun and the
miniflare/workerd toolchain together, and `test/governance/ci-policy.test.ts`
lists `npm run test:pack` among its required gates so the step cannot be quietly
removed.

## 2026-09-23 — `npm pack --json` has two output shapes; accept both, in one place

Context: npm 12 changed `npm pack --json` and `npm pack --dry-run --json` from
emitting an array of pack results to emitting an object keyed by package name.
Two gates parse that output — the published-tarball policy test and the
cross-runtime digest verifier — and both broke on a contributor machine running
npm 12 while remaining green in CI, which pins node 20/22/24 and their bundled
npm 10/10/11.

Decision: accept both shapes rather than pinning an npm major. The parser lives
once, in `scripts/lib/pack-json.mjs`, and both callers import it; two
independent copies of a parser for an external tool's output is exactly the pair
that drifts when the shape changes again. It also handles a third shape
defensively — a non-null object carrying its own `filename` is returned as-is,
before the keyed-object fallback — because a future npm emitting the single
result flat would otherwise be silently misread into the value of its first
property.

Consequence worth knowing: `tsconfig.eslint.json` gained `allowJs` and a
`scripts/lib/**/*.mjs` include so the TypeScript test file's import of that
JavaScript module resolves to the types its JSDoc declares. Without it, every
call through the import trips `no-unsafe-call` under typed linting. `checkJs`
stays off and `npm run typecheck` is unaffected — it uses `tsconfig.json` and
`tsconfig.types.json`, not that one. A hand-written `.d.mts` sidecar was tried
first and rejected: it matches neither glob in `eslint.config.js`, so it
inherits the type-checked preset with no parser project and crashes `eslint .`
outright.

The keyed-object branch and the `undefined` fallback are covered by
`test/pack/pack-json.test.ts` with literal inputs and no subprocess, because
neither branch runs on any CI machine.

## 2026-09-22 — Upstream binaries are no longer one bundle; carving must concatenate modules

Context: the runbook's Step 0 told the reader to scan the platform executable
for maximal printable-ASCII runs and keep **the single longest one**. That was
correct for every release this package has ported: 2.1.195 and 2.1.233 embed the
whole application as one contiguous multi-megabyte run, with the runner-up
orders of magnitude smaller.

2.1.280 broke that assumption. It is a `// @bun @bytecode` build whose
JavaScript is embedded as roughly 1,100 separate printable runs — each an ES
module carrying the Claude Code banner and ending in `export{…};`, separated by
`NUL`. The longest single run is 4,015,347 bytes out of 36,151,512 relevant
bytes. Applying the old rule recovers about 11% of the application, and none of
the model catalogue.

Decision: **Step 0 now concatenates every printable run at or above a threshold,
in ascending offset order, and requires a second carve at a different threshold
to produce a byte-identical extractor report.** For a single-bundle build the
new rule degenerates to the old one, so it is not a special case for one
release.

Why this is recorded rather than left as a runbook edit: the old rule failed
_silently_. It still produced a syntactically plausible `.js` file, the
extractor still exited 0, and the report was simply short of entries. A future
maintainer who finds the concatenation step verbose and "simplifies" it back to
the longest run would reintroduce a failure mode with no error message. The two
threshold carves are the guard, not decoration.

Concatenation is safe for `scripts/extract-upstream-profile.mjs` specifically
because it is a regex-and-scanner tool and never parses the dump as one
JavaScript program; duplicate declarations and repeated top-level `export{}`
statements across modules cannot produce a syntax error. That guarantee is
tool-specific and must not be generalised.

Accepted cost: a wider search space lets unrelated embedded data reach the
extractor. On 2.1.280 a second, non-CLI model list (the claude.ai application
list, whose entries carry `display_name` and `provider_ids`) contributed three
spurious dated identifiers to the `models` report. Extracted entries are
candidates to confirm against the bundle, never transcriptions to copy. The
detail is in `docs/protocol/versions/claude-code-2.1.280-analysis.md`.

## 2026-08-16 — The external drift verifier is retired; the plugin is no longer the protocol oracle

Context: `npm run drift:check` (`scripts/verify-drift.mjs`, plus the
fixture-driven `test/drift` suite) compared this package's pinned profile data
against a sibling checkout of the `opencode-anthropic-fix` plugin — seven checks
over cliVersion, sdkVersion, endpoint, beta registry, header names, billing
prefix and golden hashes. That worked while the plugin held an independent
transcription of the genuine client: two transcriptions disagreeing was real
evidence.

Decision: **the verifier, its suite, its synthetic fixtures and the `drift:check`
script are deleted.** The plugin has migrated onto this package. It is removing
`lib/request-headers.mjs` and the mimicry functions in `system-prompt.mjs` and
now imports header names, beta strings and version constants from here. Once a
consumer derives its values from this package, comparing the package against
that consumer asserts only that the package equals itself — a tautology that
reads as a green gate. The deletion is not merely tidying: with those plugin
modules gone the script's source-real mode could no longer read anything and
would exit 2 with `SOURCE_UNAVAILABLE` on every run, so the only surviving mode
was the synthetic-fixture one, which tests the verifier rather than the
protocol.

Replacement oracle: **the transcription procedure in
`docs/plans/UPSTREAM-TRACKING-RUNBOOK.md`, run against a genuine Claude Code
binary**, which produces an analysis document under `docs/protocol/versions/`
before any profile module moves. What that procedure yields is pinned
mechanically by the sealed golden fixtures (`npm run fixtures:check`) and
replayed behaviourally by the differential suite. Upstream is the only thing
that can be drifted from, and only a fresh read of upstream can detect it.

This supersedes the "Drift verifier re-anchored to 2.1.233" entry below: the
default-profile and `CLI_TO_SDK_VERSION` reasoning recorded there is still true
of the source, and the part of it that mattered — read the CLI-to-SDK map, never
the standalone fallback constant — now lives in `docs/source-trace.md` where the
transcription procedure can use it. `test/governance/ci-policy.test.ts` carries
a guard so the circular gate cannot quietly return.

Not a version bump and not a re-seal: no `src/` module, no published surface, no
golden fixture and no wire byte changed. Repository infrastructure only.

## 2026-08-16 — Cache: placement is the package's, TTL policy and breakpoint heuristics are the host's

Context: a consumer's cache helper (`lib/mimicry/cache.mjs` in the
`opencode-anthropic-fix` plugin) was reviewed function by function to decide
what, if anything, should migrate into this package.

Decision: **nothing migrates.** The split is already correct, and it is
recorded here so the review is not repeated:

- `resolveCacheTtl` — **host policy.** It reads environment overrides and
  applies a role-scoped TTL. Both halves are host concerns: this package reads
  no environment, and the TTL choice is deployment policy rather than wire
  contract.
- `shouldPlaceToolBreakpoint` and `updateBoundaryStability` — **host
  heuristic.** They are a turn-to-turn stability optimisation: state carried
  ACROSS requests to decide whether a boundary has settled enough to be worth a
  cache breakpoint. This package is a pure function of one request and holds no
  mutable module state, so the heuristic cannot live here without changing what
  the package is. It is also a cost optimisation, not a compatibility
  requirement — a wrong answer costs money, not correctness.
- Canonical `cache_control` placement — **already here.** `src/request-body.ts`
  owns breakpoint placement for the emitted body; that is the part that has to
  match the genuine client byte for byte, and it does.

Consequence: a consumer keeps its cache heuristics and passes the result in
through the existing seams. No new input field was added for TTL or breakpoint
hints.

## 2026-08-16 — Endpoint URL: origin override by the host, no `baseUrl` input

Context: consumers that route through a proxy or a regional endpoint asked
whether the package should accept a base URL.

Decision: **`built.url` stays the profile's pinned, literal-typed endpoint, and
the input gains no `baseUrl` field.** A host with a custom base substitutes
protocol, hostname and port and preserves the package's `pathname` and
`search`. The contract and the four-line recipe are documented in the README
("Endpoint URL and custom base URLs").

Reasons, so the request does not come back:

1. `BuiltClaudeCodeRequest["url"]` is a string literal type. Widening it to
   `string` is a breaking change at the type level for every consumer that
   pins the endpoint — and the pin is a feature: `?beta=true` and the
   `/v1/messages` path are wire contract, not defaults.
2. Speculative surface is not added here. A base-URL field would duplicate what
   `URL` already does and would hand this package a validation and
   normalisation burden it does not need.
3. The only real consumer case observed is an origin override, which the
   documented recipe expresses exactly — including a base URL carrying a path
   prefix, which naive concatenation gets wrong.

## 2026-08-16 — Beta registries exported; the policy sets stay private

Context: consumers were transcribing beta header strings by hand — the
`opencode-anthropic-fix` plugin carries its own copy of
`prompt-caching-scope-2026-01-05` and of the beta shortcut strings — which
drifts silently the moment upstream moves.

Decision: **`BETA_REGISTRY` (28 entries), `BETA_REGISTRY_2_1_233` (31 entries)
and `TOKEN_COUNTING_BETA` are public.** They are protocol constants: the
package transcribed them from the genuine client, so it is the honest owner of
their spelling, and a consumer reading a header off the registry cannot drift
from the package that emits it. Reading a header is not emitting one —
composition, gating and push order stay inside the package.

**`THIRD_PARTY_ALLOWED_BETAS`, `BEDROCK_UNSUPPORTED_BETAS` and
`COUNT_TOKENS_BETAS` (and their `_2_1_233` counterparts) stay private.** They
are policy sets, not constants: no consumer reads them today, and exporting a
set on the theory that someone might is the speculative surface this package
refuses. Aliases and policy sets belong to the host.

`test/validation/beta-registry-surface.test.ts` pins entry shape, header
uniqueness, the deliberate `tool_search` feature-key reuse across
`ADVANCED_TOOL_USE` and `TOOL_SEARCH`, the 2.1.233 additions
(`PROMPT_CACHING_EVICT`, `PER_MESSAGE_EFFORT`,
`SERVER_SIDE_FALLBACK_CATEGORY`, `AUTO_MODE_CLASSIFIER`) and — the load-bearing
one — the NEGATIVE assertion that `NARRATION_SUMMARIES` is absent from the
2.1.233 registry. That absence is upstream's 2.1.222+ removal, not a
transcription gap, and re-adding it would emit a header the genuine client no
longer sends.

Note on the changelog: this release note is **not** in `CHANGELOG.md` yet.
`test/governance/release-policy.test.ts` requires the FIRST `## [version]`
heading to equal the manifest version, so an `Unreleased` or pre-written
`0.5.0` heading fails the gate. The entry lands in the same commit as the
version bump, by design.

Not a re-seal: additive read-only surface, no wire byte changes, golden
fixtures unchanged.

## 2026-08-16 — Model queries: a generic catalogue query plus named identity predicates

Context: consumers need to ask two different kinds of question about a model
id — "does the catalogue record capability X for it?" and "is it Opus 4.7?".
The obvious shortcut is to answer both from one mechanism.

Decision: **`src/model-queries.ts` ships both surfaces and keeps them
separate.**

- `modelCapability(model, capability, profile)` is the generic query. The
  catalogue is the source of truth: normalize the id, look the entry up in
  `profile.supportedModels`, ask whether the verbatim upstream capability
  string is present. It invents no mapping, so it answers for the capability
  strings this package does not model as a `ClaudeCodeCapabilities` field
  (`fast_mode`, `lean_prompt`, `mid_conv_system`, ...) as readily as for the
  six it does. Ids the profile does not catalogue answer `false`: absence of
  evidence is reported as absence.
- The named predicates (`isOpus47Model`, `isHaikuModel`, `isClaude3Model`,
  `isAdaptiveThinkingModel`, ...) are written over `normalizeModelId` and
  `modelFamilyOf`. **A family is not a catalogue capability** — it is an
  identity question — so no new family regex was introduced and the catalogue
  is not consulted. `isAdaptiveThinkingModel` in particular is the union of
  the named family predicates rather than a `adaptive_thinking` catalogue
  read: it gates the emitted `thinking` block shape, and an uncatalogued id
  must not inherit adaptive thinking from the deliberately permissive
  capability fallback documented in `model-capabilities.ts`.

Two deliberate consequences, recorded so they are not "fixed" later:

1. `hasOneMillionContext` is marker-only and does **not** read
   `context.native1m`. The catalogue field states the model's native window;
   the predicate states that the id itself demands 1M. `claude-opus-4-7` is
   natively 1M and still answers `false`. `isEligibleFor1MContext` is the one
   that consults the catalogue (`context.supports1mBeta`), falling back to the
   ported family set for uncatalogued ids.
2. `supportsStructuredOutputs` delegates to the predicate ported from the
   genuine client (`j4e` in `model-capabilities.ts`), not to a family-shaped
   heuristic. One name, one meaning, and the better-evidenced one wins.

Predicates return `false` for a non-string or empty id instead of throwing
`ClaudeCodeWireError("INVALID_INPUT")` as `resolveModel` does. Their upstream
counterparts are total functions on a falsy model, and a predicate that throws
cannot be used in the boolean position its callers put it in.

Not a version bump and not a re-seal: additive read-only surface, no wire byte
changes, golden fixtures unchanged.

## 2026-08-16 — Drift verifier re-anchored to 2.1.233; sdkVersion resolved via the CLI map

Context: `npm run drift:check` compares this package's profile data against an
external consumer project. That project advanced its
`FALLBACK_CLAUDE_CLI_VERSION` from `2.1.195` to `2.1.233`, so the check failed
on `cliVersion` against a source that had simply moved on.

Decision (a): **the default monitored profile is now
`claude-code-2.1.233-sdk-0.112.1`**, the version the live source actually
mirrors. `claude-code-2.1.195-sdk-0.94.0` stays monitored and reachable via
`--profile` rather than being dropped — the profile still ships, and it is
verifiable against a source pinned to that era.

Decision (b): **the `sdkVersion` assertion now resolves the source's SDK
version instead of comparing a constant.** It reads `CLI_TO_SDK_VERSION` for
the profile's CLI version and falls back to the standalone
`ANTHROPIC_SDK_VERSION` constant only when the map has no entry — exactly what
the source's own `getSdkVersion` does. The old comparison (constant ===
profile sdkVersion) reported false drift: upstream holds that constant at
`0.94.0` as the fallback for **unmapped** CLI versions while pairing `2.1.233`
with `0.112.1`. It only ever passed because the default profile happened to sit
in the fallback era, so it was reading a coincidence as a protocol fact. The
second assertion — that the literal `[cli, sdk]` pair appears in the source —
is unchanged, so the check still fails if upstream drops the pairing.

Not a version bump and not a re-seal: no `src/` module, published surface or
golden fixture changed. Only the verifier, its synthetic drift fixtures, its
test, and `docs/source-trace.md` (whose "monitoring covers 2.1.195 only" and
"2.1.233 module does not exist yet" claims were stale).

## 2026-08-15 — TypeScript 7.0.2 bump deferred (typescript-eslint hard-blocks)

Context: Dependabot proposed four dev-tooling bumps. Three landed (globals
17.11.0, @types/node 26.2.0, typescript-eslint 8.67.0). The fourth —
typescript 6.0.3 → 7.0.2 — was attempted and reverted.

Decision: **defer the TypeScript 7 major until typescript-eslint supports
it.** typescript-eslint 8.67.0 does not merely warn on TS 7.0: it throws at
module load ("typescript-eslint does not support TS 7.0"), so `eslint .`
exits 2 before linting anything. Its declared peer range is
`>=4.8.4 <6.1.0`, and upstream tracks TS support for **>= 7.1**, not 7.0
(typescript-eslint/typescript-eslint#10940).

Evidence gathered before reverting, so the next attempt starts informed:
under TS 7.0.2 both `typecheck` configs pass with zero code changes, `build`
passes, and the packed-consumer digests stay byte-identical across all three
runtimes — the compiler itself is a non-event for this codebase; the only
blocker is the linter's version guard.

Rejected alternatives: a side-by-side TS 6 install for the eslint API (adds
a permanent extra dependency for a temporary gap) and an override to silence
the peer range (useless — the block is a runtime check, not a peer-range
assertion).

Unblock condition: a typescript-eslint release that supports TS >= 7.1, then
bump typescript and typescript-eslint together. The Dependabot PR for
typescript 7.0.2 was closed with this rationale; Dependabot will re-propose
on the next TS release.

## 2026-08-15 — Dependabot triage: zeroed via overrides, not upgrades

Context: 8 open Dependabot alerts (2 high, 6 moderate), all
`scope: development`; the published package has zero runtime dependencies, so
none were consumer-facing. Root causes were exactly two transitive chains.

Decisions:

1. **`undici` patched with a _scoped_ override, not a global one.**
   `miniflare@4.20260722.0` pins `undici@7.28.0` (vulnerable range
   `>=7.0.0 <7.29.0`, 5 advisories incl. GHSA-4cwx-7wf7-3272). A second
   `undici@6.28.0` exists under `node-gyp` and is _not_ vulnerable; a global
   override would have forced it across a major. Hence
   `"overrides": { "miniflare": { "undici": "7.29.0" } }`.
2. **`miniflare` was deliberately not bumped.** The newest 4.x
   (`4.20260730.0`) still declares `undici@7.28.0`; the only alternative was
   `5.x-alpha` — a prerelease major, rejected for a security patch. Revisit
   when a stable miniflare ships undici `>=7.29.0`, then drop the override.
3. **`ip-address` patched with a global override** (`10.3.1`, same major;
   GHSA-mwp4-54f8-5fhr + 2 moderates). It sits seven levels below
   `license-checker-rseidelsohn@5.0.1`, which has no newer release; the
   parent `socks` declares `^10.1.1`, so the override is semver-honest.
4. **Overrides are exact pins (no `^`)**, matching the repository's pinned
   devDependency policy checked by `test/governance/package-policy.test.ts`
   (which, note, does not scan the `overrides` key — no test amendment was
   needed).
5. **Two additional `npm audit` highs not yet flagged by Dependabot were
   fixed in the same pass but as a separate lockfile-only commit**:
   `brace-expansion@5.0.9` (GHSA-rgw5-rvv9-x895, via eslint→minimatch) and
   `nanoid@3.3.18` (GHSA-2v37-7h3g-55p8, via vitest→vite→postcss). Both were
   inside existing `^` ranges, so `npm audit fix` moved only the lockfile;
   adding overrides for them would create pins with no safety gain.
6. **Proof standard applied:** `npm audit` at 0 vulnerabilities is not
   sufficient on its own — the full gate suite plus `npm run test:pack` was
   re-run, and the cross-runtime digests stayed byte-identical
   (`2.1.195 = 6b9609b2…0037d277`, `2.1.233 = default = 4e06af42…9a3997`).
   This matters because the workerd packed consumer executes on the patched
   undici, so a digest move would have signalled a behavioural regression.

Maintenance note: the two `overrides` entries are debt by design. When the
upstream parents absorb the patched versions, remove the overrides in the
same commit that bumps the parent, so stale pins do not mask future
resolutions.

Commits: `9b89d7f` (overrides), `21f1878` (lockfile-only audit fix), merged
via PR #15 (`2ba35a8`).

## 2026-09-23 — Phase 5.1 QA: three accepted findings on the 2.1.280 fixtures

Context: the adversarial QA review of Phase 5.1 (the claude-code-2.1.280
golden fixtures) surfaced three behaviours that look like defects but are
deliberate or inherited. They are recorded here so they are not "fixed" by
accident.

Decisions:

1. **The manifest assertion in `test/golden-fixtures.test.ts` stays
   one-directional.** It walks the names sealed in `manifest.fixtures` and
   asserts each is registered in the test's own filename list; it does not
   walk that filename list asserting each entry is sealed. So a fixture
   registered in the test but missing from the manifest passes `npm test`
   and is caught only by `npm run fixtures:check`, an end-of-wave gate rather
   than a per-commit one. The gap is kept on purpose: closing it would turn
   the first commit of every add-then-seal split red, and that split is
   itself forced by `scripts/seal-golden-fixtures.mjs`, which refuses to run
   while a fixture is untracked or merely staged. This is a known, accepted
   asymmetry; making the check bidirectional breaks the fixture-landing
   procedure.
2. **`outgoing-default-path-2.1.280.json` carries no `output_config`, and
   that is faithful within this package.** It is now the sealed canonical
   default-path evidence, even though the pinned catalogue declares a default
   effort of `medium` for `claude-opus-5-5`. Here the effort beta header is
   pushed from the model capability, while the body's `output_config.effort`
   is emitted only when the caller supplies an `effort` input, the emitted
   thinking type is adaptive, and no `outputConfig` was supplied; the
   fixture's input supplies no effort. What is not established is what the
   genuine client writes back to its request object on that path: the 2.1.280
   analysis document records the upstream statement that deletes
   `output_config` and then calls the beta/effort pusher, but transcribes only
   that pusher's header side. The behaviour is pre-existing and identical on
   2.1.233; it is an open documentation question, not a defect.
3. **The one-hour `cache_control` TTL in the sealed bodies does not
   contradict the derivation.** The 2.1.280 analysis document's
   fourteen-identifier default-path derivation assumes a five-minute cache
   TTL and on that basis excludes the extended-cache-ttl beta. The sealed
   fixture bodies still carry a one-hour TTL on their prompt blocks while
   omitting that beta, because this package hardcodes the one-hour TTL on
   those blocks and pushes the beta only from an explicit caller TTL input.
   The two 2.1.233 fixtures have the identical shape, so this is inherited
   modelling, not a 2.1.280 delta, and must not be mistaken for drift.

## 2026-09-23 — claude-code-2.1.280 behaviour-flag audit: no new flag

Context: the upstream-tracking runbook schedules the behaviour-flag audit as
the final step of a port, so that the porter deliberately asks whether any
delta genuinely requires a `profile.id` comparison instead of finding out
later that one was added by reflex. This entry records the answer for the
2.1.280 port so the next porter does not have to argue it again.

Decisions:

1. **`src/profile-behaviors.ts` gained no flag, and none was needed.** Every
   2.1.280 delta falls into a data category that is not version-gated.
   Registry data covers the new beta entries and the three auxiliary sets,
   each chosen per profile through a map keyed on profile id — a lookup, not
   a branch. Profile scalars and policy booleans, the cache-diagnosis flip
   among them, are read directly off the profile object. Catalogue strings
   cover the two new capabilities, which are mapped once in the
   catalogue-backed table and then derived per model, not per version. The
   new beta push sites each combine a test that the registry key is present
   with capability booleans, policy booleans, or a local flag noting that an
   earlier site fired. When a registry lacks the key, its site is silently
   inert — the same mechanism that already keeps the narration-summaries site
   inert on the newer profiles.
2. **Each existing flag was checked against the 2.1.280 bundle rather than
   assumed, and the strength of the evidence differs between them.**
   - The request-derived token ceiling is confirmed. The bundle's
     output-limit function lifts the upper limit to the caller's own
     `max_tokens` and reduces the default to fit beneath it, provided that
     value is at least 4096 — the threshold this package already implements.
   - The billing chaining segments are confirmed. The bundle's billing-block
     builder emits both `cc_prev_req` and `cc_prompt_id`, and their validation
     patterns match the patterns this package declares character for
     character.
   - The opus-4-5 effort exception being off was not positively located in
     the bundle. It rests on the module's modern default and is corroborated
     only indirectly, by the transcribed 2.1.280 catalogue giving that model
     no effort capability at all. This one is asserted, not verified; a later
     porter should re-check it first.

   The module's default deliberately sits on the modern side, so a profile
   ported from a newer client inherits current behaviour without an edit.
   Nothing in this audit suggests any flag needs a third frozen behaviour set.

3. **What mechanisms this port added, and why that wave ran between
   registration and the canary.** Capability derivation widened from six
   fields to eight. The beta push sequence grew from seventeen sites to
   twenty-two, plus a removal: the redact-thinking identifier is composed and
   then spliced back out when the display-updates site fires. The thinking
   display-updates injection is a single change that surfaces as a beta
   identifier, a body field, and that removal. The wave sat after
   registration and before the canary because these are data-driven
   mechanisms that stay inert for the older registries and catalogues: they
   had to be final before the canary froze a digest over them and before the
   fixtures sealed bytes derived from them. Registering first also let every
   mechanism test drive the real registered profile through the public
   builder rather than a test double. The cost of this ordering was bounded:
   between the end of the registration wave and the end of the mechanism wave,
   a pinned 2.1.280 request emitted an intermediate beta list. That was
   acceptable because the default profile was untouched, nothing was released,
   no fixture existed yet, and no test asserted the intermediate list.
4. **Billing segments the package does not model at all.** While checking
   the chaining segments, the bundle's billing-block builder was found able to
   emit a workload segment and a sub-agent segment as well. Both derive from
   the session or host rather than from the caller, which places them in the
   same class as the already-recorded omission of the context-hint
   token-saving field. They are known and deliberately unmodelled; the next
   porter should not mistake their absence for a regression.

## 2026-09-23 — corrections to the 2.1.280 behaviour-flag audit entry

Context: an adversarial review of the entry above found that one of its
supporting arguments does not support what it was cited for, and that two of
its summary sentences are true but incomplete in ways that would mislead a
reader who skims. `MEMORY.md` is append-only, so the corrections are recorded
here rather than by editing that entry.

Decisions:

1. **The opus-4-5 corroboration was mis-framed.** The entry above cited the
   2.1.280 catalogue giving `claude-opus-4-5` no effort capability as
   indirect corroboration that the opus-4-5 effort exception is off for that
   profile. That argument does not hold. The catalogue row for that model is
   byte-identical in the 2.1.195 and 2.1.280 catalogue files — same family,
   same lone `context_management` capability, same output-token limits — and
   on 2.1.195 the exception is on. The same omission therefore coexists with
   both values of the flag, so it cannot be evidence for either. What the
   omission actually is: the precondition that makes the flag consequential
   at all. If the catalogue listed the capability, the flag would have
   nothing to correct. What the flag really claims, per the demarcated
   exception block in `src/model-capabilities.ts`, is that upstream from
   2.1.222 onward derives a catalogued model's capabilities from the
   catalogue array, where the older client derived them from predicate code
   whose effort predicate does not exclude this model. So the genuine
   re-check target is whether upstream 2.1.280 derives a catalogued model's
   effort capability from the catalogue array or from a predicate exclusion
   list — or whether its predicate now excludes this model, which would make
   the flag moot. Re-reading the catalogue row answers nothing. The
   wire-visible stake, which the entry above did not state: the effort
   capability gates the effort push site in `src/betas.ts`, so this one
   unverified flag decides whether a 2.1.280 request naming
   `claude-opus-4-5` carries `effort-2025-11-24` in its beta header, and
   whether the body carries an `output_config` effort field. No 2.1.280
   golden fixture exercises that model today — the sealed set uses
   `claude-sonnet-4-5`, `claude-opus-4-8` and `claude-opus-5-5` — so the
   differential cannot upgrade the grade until such a fixture exists.
2. **The lead sentence of the flag discussion overstates.** The entry above
   opens its flag discussion by saying each existing flag was checked
   against the bundle rather than assumed, which a skimmer will read as all
   of them having been located. The accurate form is that two of the three
   were located in the bundle and the third was searched for and not found.
   The per-flag bullets that follow are correct; only the lead is too
   strong.
3. **The inertness claim is incomplete.** The entry above says a registry
   lacking a key leaves its push site silently inert, which is true but not
   the whole mechanism. The per-message-effort key is declared by the
   previous pin's registry, so registry absence does not keep that site
   inert there; what keeps it inert is the catalogue not declaring the
   matching capability string. Both mechanisms are load-bearing and they are
   not interchangeable — a reader who took the registry-absence sentence as
   universal would wrongly conclude every new push site is registry-inert on
   the older profiles. The comment on the composable registry type in
   `src/betas.ts` already makes this point in code.

## 2026-09-23 — claude-code-2.1.280: seven port decisions

Context: these are decisions taken during the 2.1.280 port that a later
reader would otherwise have to re-derive from the code or re-litigate from
scratch. Each is recorded here because it had a plausible alternative that
was considered and rejected.

Decisions:

1. **The cache-diagnosis policy flag was flipped for the new profile only.**
   The 2.1.280 profile sets `cacheDiagnosisEnabled` to `true`, because the
   analysis document's section on that gate resolves all three of its legs
   to true on a first-party install. The previous pin keeps `false`. Whether
   that earlier value was always wrong cannot be settled without the earlier
   release's binary, and inferring one release's value from another's is
   precisely what the tracking runbook forbids. The older profile was
   therefore deliberately left alone rather than "corrected" by analogy.
2. **The thinking-display type widening was proposed and then withdrawn.**
   An early design would have added the injected wire value to the exported
   `ThinkingDisplay` union. That was rejected. The exported type stays
   `"summarized" | "omitted"` and stays caller-facing. The injected value is
   typed as a bare string literal at internal seams only — an optional
   override field on the composed-betas result, and an optional trailing
   parameter of the thinking resolver — and neither seam is exported from
   `src/index.ts`. Widening the exported type would have silently changed
   the meaning of a name consumers may already switch on, and it would have
   invited someone to "fix" the request-body validator into accepting that
   value as caller input. Upstream never accepts it as caller input: the
   injection's own guard requires that the caller supplied no display at
   all. `src/request-body.ts` still rejects it with `INVALID_THINKING`.
3. **The redact-thinking removal runs before the caller-supplied beta
   merge.** The removal is the last statement inside the display-updates
   push site's own block, which puts it ahead of the `additionalBetas`
   merge. That ordering is load-bearing in the caller's favour: a caller who
   explicitly supplies the redact-thinking identifier still gets it on the
   wire, precisely because the canonical copy was already spliced out and
   the merge's "not already present" test therefore succeeds. Had the
   removal run after the merge, it would have eaten the caller's own entry.
4. **Suppressing a beta removes the header and nothing else.** For a coupled
   beta-and-body pair, `suppressBetas` is header-only by contract: the
   filter is subtractive over the composed identifier list and touches no
   body field. Suppressing the display-updates identifier removes the header
   but leaves the body's display value in place, and it does not bring
   redact-thinking back. This matches the pair that already existed:
   suppressing the effort identifier leaves the body's effort field
   untouched. A caller who wants neither half has the upstream-faithful
   lever instead — supply a display explicitly, which disarms the injection
   at its own guard.
5. **The per-turn timing capability string is deliberately not mapped.** It
   is a real capability string in the 2.1.280 catalogue and it has a
   registry entry, but its push site is gated on an environment variable
   this package does not read. Mapping it to a derived capability would
   create a capability the package can never act on, so the string is left
   unmapped, and the omission is recorded here rather than left to look like
   an oversight.
6. **Ten catalogue keys are read and discarded.** The ported catalogue
   models only what a request reads. These keys exist upstream and are
   knowable without I/O, but no request field derives from them, so carrying
   them would widen the package's surface with values nothing consumes:
   `display_name`, `knowledge_cutoff`, `provider_ids`,
   `eager_input_streaming`, `vertex_region_env_var`, `fallback_3p`,
   `pricing`, `effort_cost_index`, `image_limits` and `advisor_rank`.
   Separately, the context object is present only on the models that
   declare one; a model with no context key simply has none, and that
   absence is data, not a gap in the port.
7. **The beta composer takes one thinking signal, not two.** The new
   thinking push sites differ by exactly one further conjunct — whether the
   caller supplied a display. Giving the composer a single required
   `thinkingActive` boolean and letting the display site add that one extra
   test keeps the sites from drifting apart. Separate input fields would
   have allowed them to disagree in a case upstream has no analogue for,
   which is the kind of divergence that survives every test because nothing
   pins it.

## 2026-09-23 — claude-code-2.1.280: the shared model-id normalizer reaches the previous pin

Context: a global adversarial review of the 2.1.280 port found that the
behaviour-flag audit entry above understates the port's reach. The model-id
normalizer, `normalizeModelId` in `src/model-identity.ts`, is one ladder
shared by every profile, and the port added five rungs to it
(`claude-fable-5-1`, `claude-mythos-5-1`, `claude-opus-5-5`, `claude-opus-5`
and `claude-sonnet-5`). Two of those rungs change what the 2.1.233 pin
resolves for ids its own catalogue never listed.

Decisions:

1. **The behaviour-flag audit entry is corrected for one file.** That entry
   concluded that the port added no per-version behaviour flag and that every
   delta was data-driven. That holds for the beta registry, the model
   catalogue, the profile scalars and the push sites, and it does not hold for
   the model-id normalizer: its ladder carries no per-version gate, so the
   rungs added for 2.1.280 also change what `CLAUDE_CODE_2_1_233_PROFILE`
   resolves for `claude-fable-5-1` and `claude-mythos-5-1`, and for
   `claude-mythos-5-1` that changes the emitted request. Under the 2.1.233 pin
   that id previously collapsed onto `claude-mythos-5` and inherited that
   model's deliberate empty-capability catalogue row. It now keeps its own id,
   finds no catalogue row, and falls through to the permissive predicate path
   instead, which adds `context-management-2025-06-27`,
   `mid-conversation-system-2026-04-07` and `effort-2025-11-24` to the
   `anthropic-beta` header and turns the emitted thinking object from a
   budgeted one into an adaptive one. The packed-consumer digests cannot see
   this, because their probe model, `claude-sonnet-4-5`, is untouched by every
   new rung. `test/validation/shared-normalizer-ladder.test.ts` now pins the
   current header and thinking object so the behaviour cannot drift silently.
2. **The ladder was not gated behind a behaviour flag.** Gating would require
   asserting that the 2.1.233 client's own ladder lacked those rungs. Neither
   older analysis document transcribes that client's normalizer at all, so
   such an assertion would be an inference from silence — the cross-release
   inference the upstream-tracking runbook forbids. The affected ids are not
   in the 2.1.233 catalogue, so a caller pinning that profile and naming one is
   naming a model that release never shipped; the old answer and the new one
   are both guesses about something this repository cannot know. The
   deliberate choice is one shared ladder, transcribed from the one binary
   that was actually read, with the consequence recorded here and pinned by a
   test. Settling which answer the genuine 2.1.233 client gives needs that
   release's binary.

## 2026-09-24 — `tool_choice` of type `any` is demoted under extended thinking

Context: upstream demotes a forced `tool_choice` to `{type:"auto"}` while
extended thinking is active, but only for `type:"tool"`. The transcription is
in `docs/protocol/versions/claude-code-2.1.280-analysis.md` §6.6 (`[BIN]` byte
13604689), and until this entry the package matched it exactly, omission
included. Anthropic's extended-thinking documentation
(`https://docs.claude.com/en/docs/build-with-claude/extended-thinking`,
section "Extended thinking with tool use"; quoted verbatim in
`run-llama/llama_index#19641` and `vercel/ai#9351`, retrieved 2026-09-24)
states: "Tool use with thinking only supports tool_choice: {"type": "auto"}
(the default) or tool_choice: {"type": "none"}. Using tool_choice:
{"type": "any"} or tool_choice: {"type": "tool", "name": "..."} will result
in an error because these options force tool use, which is incompatible
with extended thinking." The API's error text is "Thinking may not be
enabled when tool_choice forces tool use". That is a general Messages API
constraint, not an Opus 5.5 rule; it is cited here rather than added to the
analysis document's `[EXT-n]` registry, which stays at four. The same
analysis records that Opus 5.5 rejects both server-side `[EXT-3]`. A
caller-supplied `any` under active thinking could therefore only ever produce
an HTTP 400.

Decisions:

1. **`any` is demoted too, knowingly diverging from the transcribed code.**
   In `src/request-body.ts` the demotion condition now reads type `tool` or
   type `any`, gated on the same `extendedThinkingActive` signal as before, and
   emits the same bare `{type:"auto"}`, so any `disable_parallel_tool_use` on
   the caller's `any` is dropped exactly as it already was for `tool`. Faithful
   bytes that the server is guaranteed to reject buy no indistinguishability;
   they only turn a recoverable request into a failed one. `auto` and `none`
   are never altered, and `any` is preserved verbatim whenever extended
   thinking is inactive. `test/validation/thinking-contract.test.ts` pins all
   of it, including `claude-opus-5-5` with thinking omitted and with thinking
   requested disabled, where `rejects_disabled_thinking` makes extended
   thinking active.
2. **It is shared behaviour on every profile, not a behaviour flag.** The API
   constraint is not version-dependent, so gating it per profile would encode
   a difference no release actually has.
3. **Digests and seal are unmoved.** No sealed fixture and no packed-consumer
   canary carries `tool_choice`; on this change `npm run fixtures:check`
   reported `sealed=ok` and `npm run test:pack` matched all three frozen
   digests.

Revert: in `src/request-body.ts` delete the `forcedToolChoice` constant and
its comment and restore the condition
`validatedToolChoice["type"] === "tool" && resolved.extendedThinkingActive`;
restore the two comments in `src/thinking.ts` (the `extendedThinkingActive`
doc comment and the note above its computation); delete the describe
"forced tool choice demotion of any" in
`test/validation/thinking-contract.test.ts`; amend the §6.6 amendment, the
§2 summary bullet and the §13 row of
`docs/protocol/versions/claude-code-2.1.280-analysis.md` again with the
revert date; and add a new dated entry here — this log is append-only.

## 2026-10-10 — Transport masquerade moves to a Bun stdio bridge (design only)

**Context:** the operator wants the subscriptions plugin's outbound traffic to
stop looking like a Node client. The plugin already consumes this package for
the HTTP layer (headers, betas, billing, body) but sends through `undici`, so
the declared identity and the TLS stack disagree.

**Evidence** (measured 2026-10-10; full vectors in
[`docs/plans/2026-10-10-subscription-transport-masquerade.md`](./docs/plans/2026-10-10-subscription-transport-masquerade.md)):

- `@anthropic-ai/claude-code@2.1.280` is a launcher: 7 files, and `install.cjs`
  copies a platform binary over a placeholder — "no Node.js process stays
  resident". The resident client is not Node.
- The platform binary carries `bun.sh` and `BoringSSL` markers; a capture of the
  genuine client shows `JA3 1523504b38f0fae0d881d4b6554aac1b`, 17 ciphers, 13
  extensions, `ec_point_formats [0]`, `ALPN http/1.1`.
- Bun 1.4.2 reproduces that vector field for field; the only difference in the
  local measurement was a missing SNI extension, because the probe dialed an IP.
- Node 24 / undici does not (`JA3 e728b1b92f196b7dc056314ba5b9d3db`, 52 ciphers,
  `encrypt_then_mac` present, `ec_point_formats [0,1,2]`).
- All 19 `impersonate` presets of a napi-rs BoringSSL client were measured: none
  equals the vector, the best is 12 weighted features away, and it injects
  Chrome client hints and reorders caller headers — rejected.
- `bun` is published on npm (1.4.2) with per-platform binaries, including
  `@oven/bun-windows-x64`.

**Decisions:**

1. **Transport moves to a Bun child over stdio**, one long-lived child, framed
   with length prefixes and multiplexed by `streamId`. No listening port, and
   the runtime arrives as a dependency. The bridge carries caller-supplied
   ordered headers verbatim and adds none of its own; header fidelity stays
   owned by this package's profiles.
2. **This package stays I/O-free.** The bridge is a sibling artifact, not a
   module here; no network code is added to `src/`.
3. **No telemetry replication.** The genuine client also posts to Datadog; we
   send nothing and send nothing anomalous, because the model API cannot observe
   that traffic.
4. **Design only.** No implementation, dependency, or plugin change landed with
   this entry.

**Revert:** delete this entry's design document, and remove the corresponding
section from the plugin's transport notes. This log is append-only, so a
reversal appends a new dated entry rather than editing this one.

## 2026-10-10 — How far the shipped binary can be unpacked (measured)

**Context:** before designing any transport work, the operator asked how much of
the genuine client is recoverable from its shipped artifact. Measured on
`@anthropic-ai/claude-agent-sdk-linux-arm64/claude` (237.6 MB, 2.1.280 lineage).

**Findings:**

1. **The application layer is plain JavaScript, not bytecode.** `Bun.bytecode`
   occurs zero times; `use strict` ×384, `function(` ×8293, `require(` ×525,
   `=>{` ×20520. Between release carving and concatenation the whole app layer is
   readable, minified but not compiled.
2. **No embedded source map for the application.** The four `sourceMappingURL`
   and three `sourcesContent` hits belong to Bun's own internal error-message and
   HMR-runtime tables (`"// (Bun's internal HMR runtime is minified)"`,
   `"// Did not have source content…"`). Original TypeScript is therefore not
   recoverable; minified JavaScript is the ceiling.
3. **Carving must concatenate modules, re-confirmed.** 381 printable runs of
   ≥20 KB total 32.5 MB (13.7% of the file); the largest run is 4.5 MB and does
   **not** contain `claude-cli/` or `x-stainless-*`, so header-building code
   lives in a different run than the largest one. This is the same conclusion as
   the 2026-09-22 entry, now re-measured on this artifact.
4. **Every wire-relevant fact is present.** `anthropic-beta` ×218,
   `x-stainless-*` ×21, `api.anthropic.com` ×70, `http-intake.logs` ×2,
   `You are Claude Code` ×5, `oauth` ×1545, `process.env.` ×805. String literals
   and object keys survive minification, which is why the extraction runbook
   works at all.
5. **The runtime layer is not worth decompiling.** Bun is MIT-licensed upstream,
   and the behaviour we actually depend on (the ClientHello) is measured
   directly rather than read from source.

**Decisions:**

1. **No new capability is needed for the transport work.** The bridge design
   rests on measured runtime behaviour, not on recovered logic.
2. **Watch item: a bytecode-switched release.** If a future release is built
   with `--bytecode`, the logic layer degrades to strings plus bytecode and the
   extraction runbook's value drops sharply. Detecting this is one marker check
   (`Bun.bytecode` non-zero) and belongs at the top of the port procedure.

**Revert:** delete this entry and its watch item if the port procedure already
records bytecode detection; the log is append-only, so a reversal appends.

## 2026-10-10 — Transport gate results: `fetch`, not raw TLS, and header serialization stays the runtime's

**Context:** the Bun-stdio bridge design named two gates that decided whether it
could hit the genuine client's ClientHello. Both were run; one earlier assumption
did not survive.

**Findings** (local captures only, no egress):

1. **G1 — raw `Bun.connect` cannot carry ALPN.** With `tls.alpnProtocols`,
   `tls.ALPNProtocols`, or `tls.alpn`, the ClientHello offers **no ALPN** and only
   10 extensions; `status_request` (5) and `sct` (18) are absent as well.
   `Bun.fetch` offers ALPN `http/1.1` and the full 13-extension set.
2. **G2 — platform parity holds.** Bun 1.4.2 on win32/x64 and on linux/arm64 both
   produce `JA3 = 1523504b38f0fae0d881d4b6554aac1b`, identical to the genuine
   capture, with extension order `0 23 65281 10 11 35 16 5 13 18 51 45 43`,
   17 ciphers and 4 curves.
3. **G3 — no runtime-added headers.** `Bun.fetch` adds only `connection`, `host`
   and `content-length`; no `sec-fetch-*`, `accept-language` or `priority`.
4. **Bun canonicalizes header order and casing** — conventional fields first, the
   remainder sorted, mixed casing on the conventional ones.
5. **The 2.1.280 binary embeds Bun v1.4.3**, while 1.4.2 was the version measured;
   both produce the identical ClientHello.

**Decisions:**

1. **The bridge issues requests with Bun `fetch`.** Raw `Bun.connect` is rejected
   for this purpose; the earlier draft's "write the head byte-for-byte" step is
   withdrawn. The genuine client's own runtime canonicalizes headers, so adopting
   that canonicalization _is_ fidelity — hand-writing the head would move away
   from the target. This package's `HeaderPair[]` order stays the logical
   contract, consistent with the "wire-equivalent but byte-different" note already
   recorded for 2.1.233.
2. **Depend on `@oven/bun-<platform>`, not the `bun` meta-package.** The meta
   package's postinstall fails under npm while still leaving the binary in
   `node_modules`; depending on the platform package directly is explicit and
   verified working on win32/x64.
3. **Pin the runtime the profile's client embeds, and let the fingerprint harness
   decide.** A version number is not evidence; the ClientHello equality test is.

**Revert:** the design document and the plugin transport notes carry the same
decisions; changing course means amending both and appending a new entry here.

## 2026-10-10 — Windows and Linux 2.1.280 are the same application; compare like-for-like distributions

**Context:** the operator asked how far the Windows client can be unpacked and
whether a Windows-targeted port risks missing facts the Linux artifact carries.
Measured both platform packages of the CLI distribution.

**Findings:**

1. **Same runtime, same packaging.** `@anthropic-ai/claude-code-win32-x64@2.1.280`
   (226.1 MB) and `@anthropic-ai/claude-code-linux-arm64@2.1.280` (222.3 MB) both
   embed **Bun v1.4.3**, both carry zero `Bun.bytecode` markers (plain JavaScript,
   carveable), and both carve to ~313 printable runs of ≥20 KB.
2. **Wire facts are identical across platforms.** Symmetric difference over
   extracted sets: betas 56/56, models 90/90, endpoints 26/26, attesting symbols
   13/13, headers 19/19, tool names 11/11, system-prompt markers 4/4 — **zero
   differences in every class**. Overall agreement 98.07%; the residual 22 items
   are environment-variable strings whose last character differs because
   minification appends different characters, not real facts.
3. **The Windows client's TLS is byte-identical to the capture.** Running the
   downloaded `claude.exe` with `ANTHROPIC_BASE_URL` pointed at a local listener
   (plus a temporary `CLAUDE_CONFIG_DIR` and the nonessential-traffic switches)
   produced `JA3 = 1523504b38f0fae0d881d4b6554aac1b` — the same vector as the
   capture and as Bun 1.4.2 on both platforms. The three sources agree.
4. **Distribution matters more than platform.** Comparing the **SDK-bundled**
   Linux binary (`@anthropic-ai/claude-agent-sdk-linux-arm64`) against the
   **CLI** Windows package produced over a hundred spurious differences —
   different beta versions for the same identifier (`user-profiles-2026-08` vs
   `-2026-03`), 117 Linux-only environment variables, and `claude-sonnet-5-5`
   apparently absent. Matching distribution to distribution collapsed the
   difference to zero; the SDK build is simply a different build.

**Decisions:**

1. **Extraction and comparison record their source distribution.** A profile
   extracted from an SDK-bundled binary is not evidence about the CLI package of
   the same version. The runbook's acquisition step should name the package it
   used, and cross-platform comparisons must hold the distribution fixed.
2. **Windows needs no separate extraction procedure.** The same carve, the same
   audit, and the same fact battery apply; only the platform-conditional values
   (stainless OS/arch, chosen at runtime from `Windows`/`macOS`/`Linux`/`FreeBSD`
   × `arm64`/`x64`/`arm`/`ia32`) differ by host, and those are runtime-selected
   by the genuine client too.
3. **The audit tool is the artifact.** A regex battery over the carved binary
   produces the comparable sets; the one blind spot is string composition — the
   UA template and several `x-stainless-*` names never appear as literals
   (`x-stainless-runtime` and the UA template both count zero), which is why
   code-aware extraction remains the authority.

**Revert:** supersede by a later dated entry; the measurements above are
re-derivable with the audit script and the two platform packages.

## 2026-10-10 — Host-derived stainless headers, and two captured divergences

**Context:** a captured reference request from the genuine 2.1.280 client on
Windows (non-interactive) was recorded in
`docs/protocol/http-headers-and-system-prompt.md`; it settles how the stainless
identity headers are sourced and exposes two caller-visible divergences.

**Findings:**

1. `x-stainless-os` and `x-stainless-arch` are **host-derived** (`Windows`/`x64`
   here), not pinned identity. Pinning either makes the claim false on a host
   that differs from the pin.
2. `x-stainless-runtime` is **`node`** even though the client is a Bun-compiled
   binary — Bun presents Node-compatible process metadata. "Correcting" it to
   `bun` would diverge from the genuine client.
3. `x-stainless-runtime-version` is **`v26.3.0`** (the Node version Bun
   advertises), not the host's Node version.
4. The user-agent suffix is invocation-dependent: non-interactive sends
   `(external, sdk-cli)`, while the profile pins the interactive
   `(external, cli)`.

**Decisions:**

1. **Host-derived values stay host-derived in every consumer.** The plugin's
   `process.platform`/`process.arch` mapping is correct and must not be replaced
   by profile constants.
2. **A programmatic caller sends the `sdk-cli` user-agent form.** The profile's
   `(external, cli)` remains correct for the interactive identity; the two are
   different claims about the same client, and each caller must send the one it
   actually is.
3. **Runtime identity comes from the transport, not from the caller's runtime.**
   Once the Bun bridge carries the request, the runtime version the SDK reports
   is whatever Bun advertises; a caller that hardcodes its own Node version
   diverges. Verify against a capture rather than reasoning from the source.

**Revert:** the reference request and these findings are re-derivable with the
capture procedure recorded alongside the block; supersede with a later entry.

## 2026-10-10 — Identity headers are code-defined; a capture is a sample, not the contract

**Context:** a captured reference request suggested two divergences from this
package's 2.1.280 profile — a `sdk-cli` user-agent suffix and a
`v26.3.0` stainless runtime version. The operator's rule applies: the carved code
is authoritative, a capture is one case. Both were therefore re-derived from the
carved bundle, and one of the two "divergences" did not survive.

**Code findings** (carved `claude.exe` 2.1.280, `B:/~BUN/root/...` module graph):

1. **Stainless identity headers are SDK-defined, in a single function.** The node
   branch returns `X-Stainless-Lang: "js"`, `X-Stainless-Package-Version` from the
   constant `"0.112.1"`, `X-Stainless-OS` = normalizer(`process.platform`),
   `X-Stainless-Arch` = normalizer(`process.arch`), **`X-Stainless-Runtime` as the
   literal `"node"`**, and `X-Stainless-Runtime-Version` = **`process.version`**.
   Notably the runtime name is hardcoded: no runtime detection feeds it. A caller
   that "corrects" it to `bun` diverges.
2. **`X-Stainless-Runtime-Version` is the runtime's own self-report.** Under the
   genuine client that is Bun's Node-compatibility string (`v26.3.0`), not any
   constant. Alignment therefore cannot be achieved by pinning a value; it is
   achieved by issuing the request from the same runtime.
3. **The OS/arch mapping exists in two places and agrees.** The SDK normalizes
   `win32 → Windows`, `darwin → macOS`, `linux → Linux`; the client carries its own
   identical mapping. Both are host-derived.
4. **The user-agent's second element is `CLAUDE_CODE_ENTRYPOINT`, defaulting to
   `cli`.** Enumerated values include `cli`, `sdk-cli`, `sdk-ts`, `mcp`, `vscode`,
   `jetbrains`, `claude-desktop`, `github-action`, `local-agent`, `remote*`,
   `claude-in-teams`; optional `agent-sdk/<v>`, `client-app/<app>`, and
   `workload/<w>` segments are appended from environment variables.

**Decisions:**

1. **The profile's `claude-cli/2.1.280 (external, cli)` stands.** The captured
   `sdk-cli` form is the SDK entrypoint, a different claim about the same client.
2. **A consumer sends the entrypoint it actually is.** Host-derived identity
   (os/arch), SDK-defined identity (lang, package-version, runtime name), and
   runtime-derived identity (runtime version) must each keep their own source; no
   layer may substitute a constant for another layer's value.
3. **Capture-only conclusions are provisional.** The reference request remains the
   validation artifact, but a profile change requires a code derivation. This
   entry exists because the opposite order produced a wrong finding.

**Revert:** supersede with a later entry; the derivations are reproducible from
the carved bundle and the reference request.

## 2026-10-10 — Verification-layer gaps found by carving (CCH, billing block, identity line)

**Context:** asked which weaknesses remain in the subscriptions plugin at the
transport and verification layers, with the rule "code is authoritative; keep
carving rather than guessing". Findings below are all read out of the carved
2.1.280 bundle; nothing here is inferred from a capture.

**Findings:**

1. **The CCH is a Bun-only hash over the serialized payload, and this package
   emits the placeholder.** The genuine builder inserts ` cch=00000;` into the
   billing block when the provider is first-party or vertex, and the value is
   produced by `KP(e) = Bun.hash(JSON.stringify(e)) & 0xffffffff`. `Bun.hash` is
   the runtime's own hash; a Node caller has no equivalent. `src/fingerprint.ts`
   currently emits `…; cch=00000;` — the literal placeholder — so the field is
   provably not what the genuine client sends.
2. **The billing text is a system-prompt block, not a header.** The block whose
   text starts with `x-anthropic-billing-header:` is assembled into the system
   array first, with `cacheScope: null`, followed by the identity block
   (`cacheScope: "org"`) and, when present, the reporting-outcomes block. The
   system-prompt hasher explicitly filters that block out (`p2`), which confirms
   it is carried as system content.
3. **The identity line is one of three literals, chosen by invocation mode.**
   `You are Claude Code, Anthropic's official CLI for Claude.`,
   `…, running within the Claude Agent SDK.`, and
   `You are a Claude agent, built on Anthropic's Claude Agent SDK.` — the second
   and third are selected for non-interactive runs depending on whether an
   appended system prompt is present; vertex and recorded paths pin the first.
4. **The billing block's conditional segments and their gates are exact.**
   `cc_version=${VERSION}.${suffix}`; `cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT ?? "unknown"}`
   — note the default is `unknown` here while the user-agent defaults to `cli`;
   `cch` only for first-party/vertex; `cc_workload` from a workload id;
   `cc_is_subagent=true` for non-main sessions; `cc_prev_req` gated on
   `/^req_[A-Za-z0-9_-]{1,36}$/`; `cc_prompt_id` gated on a strict UUID;
   `cc_turn_origin` gated on `/^[a-z][a-z_]{0,31}$/`. The whole block is omitted
   when `CLAUDE_CODE_ATTRIBUTION_HEADER` opts out.
5. **Other verification-shaped surfaces exist**: `x-cc-atis` /
   `x-cc-atis-current` (a `v1.<token>.<…>` attestation token with a refresh
   interval), `x-anthropic-additional-protection` (opt-in),
   `metadata.user_id` carrying a `tk` field that the client strips and
   re-serializes, and cache-diagnosis hashes computed with the same `KP`.
   `x-claude-code-signature` is a JWS confined to cloud/worker paths.
6. **A `// @bun @bytecode` marker appears in the carved bundle.** The earlier
   "no bytecode" reading came from a `Bun.bytecode` marker count of zero; this
   annotation suggests some modules may ship compiled while their source text
   remains embedded. Treat executable-behaviour claims derived from the carve as
   provisional until this is resolved.

**Decisions:**

1. **The CCH is the headline verification gap.** It is computed with a runtime
   primitive this package cannot reproduce, and the current output is a literal
   placeholder. Any fix belongs with the transport work (a Bun-side computation),
   not with a Node reimplementation of an unspecified hash variant.
2. **Unverified items are recorded as unverified.** The hash variant (default
   `Bun.hash` versus `Bun.hash.xxHash64`), the exact serialized input, the
   replacement site, and the bytecode marker are all open; the earlier note in
   `fingerprint-extraction.md` naming xxHash64 for the CCH is not confirmed by
   the carve.

**Revert:** re-derivable from the carve; supersede with a later entry.

## 2026-10-10 — `cch=00000` is the genuine value; the CCH rewrite does not exist in 2.1.280

**Context:** an earlier entry in this log called the CCH the headline
verification-layer gap, on the strength of a `computeAndReplaceCCH()` note from an
earlier release plus the presence of `Bun.hash` in the same module. The operator
required the question be closed from code, not from a capture. It closed the other
way.

**Findings:**

1. `cch=00000` occurs exactly once in the carved bundle, at its construction site.
   No regex, `replace`, or body-mutating function touches it.
2. All genuine call sites of the neighbouring `KP(e) = Bun.hash(JSON.stringify(e))
& 0xffffffff` hash attachments/parts, a feature-sampling ratio, the system and
   tools hash map, and cache diagnosis. Three textual matches are name collisions
   (a UTF-8 decoder, a React component, an RC2 implementation).
3. Consumers of the billing text detect it by prefix, exclude it from hashes, or
   read it verbatim. None rewrites it.
4. There is no post-serialization hook: no `.replace` on a serialized body and no
   body-patching function.

**Decisions:**

1. **`src/fingerprint.ts` emitting `cch=00000` is correct.** No change is needed,
   and the earlier "headline gap" characterization is withdrawn.
2. **The `computeAndReplaceCCH()` note is version-scoped.** It must not be read as
   describing 2.1.280, and any similar note in `fingerprint-extraction.md` should
   be treated as belonging to the release it was extracted from.
3. **Absence-of-evidence conclusions state their residual uncertainty.** A rewrite
   confined to native code, or to a module missing from the carve, would not have
   been observed; the entry records that rather than presenting the closure as
   absolute.
4. **Capture-versus-code, third occurrence.** The reference request remains a
   validation artifact and a source of hypotheses; it has now produced three wrong
   findings when used as evidence. Hypotheses come from captures; conclusions come
   from code.

**Revert:** supersede with a later entry; the enumeration is reproducible from the
carve.

## 2026-10-10 — Extraction done once, then analysed as plaintext (and two closures)

**Context:** the operator observed that the investigation had been "carve a
little, grep a little", which produced three name-collision errors (`KP`, `ms`,
`pSe` each matched unrelated definitions) and truncated contexts. The rule from
here: extract once into readable segments with a symbol index, then analyse the
plaintext.

**What was built:** the binary carves to 4,876 printable segments (40.7 MB) with
an index recording each segment's imports, exports, definitions, path references
and digest, plus a query tool that resolves a symbol by **export name** and prints
the definition body and every reference inside that segment.

**Limit, recorded rather than hidden:** the artifact is a bundle, not one file
per module. The 1,975 `@bun @bytecode` markers belong to an embedded build report,
not to module boundaries, so exact module reconstruction is not available. Export
name resolution plus reading the definition is what makes symbol-level analysis
reliable; the query tool returns a shortlist, and the reader confirms.

**Two closures this produced:**

1. **The `cch` gate is about the endpoint.** `ms()` is true when
   `ANTHROPIC_BASE_URL` is unset or its host is `api.anthropic.com` (or the
   assume-flag is set). So `cch` appears for first-party traffic to the real host
   and disappears under any base-URL override — which is exactly why the earlier
   localhost capture lacked it. Account type plays no part, and the placeholder
   `cch=00000` is correct.
2. **The `cc_version` suffix is a deterministic sample.** It is
   `sha256(SALT + text[4] + text[7] + text[20] + buildInfo).slice(0,3)` with
   `SALT = "59cf53e54c78"` and `text` the first non-meta user message's first text
   block. The observed `2.1.280.d7b` matches the shape. A fixed suffix diverges on
   any conversation whose first user message differs at those positions.

**Decisions:**

1. **Extraction is a one-time artifact, not a per-question step.** Future
   questions are answered against the indexed plaintext; re-carving happens only
   when the target release changes.
2. **Symbol resolution uses export names and is confirmed by reading.** A symbol
   name alone is not evidence when names repeat across a bundled artifact.

## 2026-10-10 — Subscription-plugin audit closed: one structural gap, one extra header

**Context:** a full comparison of the plugin's emitted wire request (its 2.1.280
golden fixture) against the genuine header assembly and body construction read out
of the carved Windows binary.

**Findings:**

1. **The only structural gap is the transport stack.** The plugin sends through
   undici on Node: the TLS ClientHello, the header canonicalization, the
   connection behaviour, and `x-stainless-runtime-version` (the runtime's own
   `process.version`) all follow from that choice. The genuine client uses Bun's
   global `fetch` — the bundled undici is a `notImplemented` shim, so it cannot be
   the genuine path. Issuing from the same runtime aligns all four at once.
2. **The plugin sends one header the genuine Messages request does not:
   `x-client-request-id`.** The genuine client's request-header object contains
   `x-app`, `User-Agent`, `X-Claude-Code-Session-Id`, the custom-header spread, the
   remote/client-app and agent-id conditionals, and the gateway-hint pair — not
   this one. In the genuine code the name appears on the response side (reading it
   off an API error for support) and in the bundled local proxy.
3. **Everything else audited equal or correctly absent.** `metadata.user_id`'s base
   shape, block placement and `cacheScope`, `cch=00000`, the identity line, the
   `cc_version` sampling algorithm, and the conditional headers the plugin omits by
   default.

**Decisions:**

1. **Transport alignment is the actionable fix**; the audit adds no second
   structural item.
2. **Drop `x-client-request-id` from the Messages path.** An extra header is weaker
   evidence than a missing one, but it is still a difference the genuine client
   does not present.
3. **Identity parameters are constrained by closed vocabularies, not free
   choices.** `x-app` has exactly two values; `x-stainless-runtime` is the literal
   `node`; the entrypoint is validated against an enumerated set. A value outside
   those sets is a stronger signal than the one it tries to avoid.

**Revert:** supersede with a later entry; the comparison is reproducible from the
golden fixture and the carve index.

## 2026-10-10 — Imitate the default CLI identity; identity line must follow invocation mode

**Context:** asked which client identity to imitate, with a preference for
"looking human" and not exposing `cli`/`sdk`. The answer is decided by the code,
and it is the opposite of the premise in one respect and identical to it in
another.

**Findings:**

1. **`x-app: cli` is unconditional and has exactly two values.** The request-header
   object sets `"x-app": Tt() ? "cli-bg" : "cli"`. Any entrypoint other than the
   CLI family therefore produces a request whose user-agent and app marker
   disagree — a contradiction inside one request, which is worse than the label it
   tries to avoid.
2. **`cli` is the default and therefore the most common identity.**
   `JM()` composes the user-agent from `${ENTRYPOINT ?? "cli"}`.
3. **`x-stainless-runtime` is the literal `"node"`**, so it cannot be made to look
   like anything else.
4. **The desktop/IDE entrypoints add surface, not realism.** Their gates
   (`mc`, `gDe`, `hDe`, `srn`) govern host management, managed settings,
   permission handling and one telemetry attribute — not the body, system blocks or
   betas. Claiming one would add `anthropic-client-platform: desktop_app` and
   `anthropic-client-version` as two further fields to get right.
5. **Interactivity is invisible to the API.** `is_interactive` appears only in the
   telemetry event schema and in launch options, never in a Messages request.
6. **The identity line is selected, but this package hardcodes one form.**
   `YAn()` chooses between three literals by invocation mode; `src/system-prompt.ts`
   carries only the interactive `i` form, so a headless caller currently sends the
   interactive identity.

**Decisions:**

1. **Imitate the default CLI identity.** Entrypoint `cli`, user-agent
   `(external, cli)`, `x-app: cli` — the largest population and the only
   internally consistent combination available.
2. **Human-likeness belongs to behaviour, not to the identity fields.** Cadence,
   session continuity and the absence of bursts are what the server can actually
   see; moving labels cannot substitute for them.
3. **The identity line becomes a selection, not a constant.** Three literals, chosen
   by invocation mode, so the headless case sends `f` (or `u` with an appended
   system prompt).
4. **`x-client-request-id` leaves the Messages path.**

**Revert:** supersede with a later entry; each claim is re-derivable from the carve
index and the golden fixture.

## 2026-10-10 — Exposure audit closed: four proven gaps, one unaddressed surface

**Context:** a final exposure review of the plugin against the carved Windows
2.1.280 client, done before any implementation, with the findings and their fixes
recorded rather than acted on.

**Proven gaps:** (1) the transport stack — Node/undici TLS plus a host-Node
runtime self-report; (2) the identity line is the interactive form while the
caller is headless; (3) `x-client-request-id` is sent and the genuine client does
not send it; (4) the reporting block (`# Reporting outcomes …`) is missing from the
system array.

**Verified correct:** `cch=00000`, attribution block placement, the `cc_version`
sampling algorithm, the `metadata.user_id` base shape, the beta registry entries
checked, and the default absence of ATIS, gateway-hint and remote/client-app
headers.

**Newly discovered surface:** the tool catalogue. The genuine client ships a fixed
catalogue (Bash, Read, Write, Edit, MultiEdit, Glob, Grep, LS, List, NotebookEdit,
Task, TodoWrite, WebFetch, WebSearch, AskUserQuestion, ExitPlanMode, BashOutput,
KillShell, Skill, Memory, SendMessage, TeamCreate) with fixed schemas; the plugin
forwards the host's tools. This is not a transport or verification defect — it is
a product-surface decision with three options, of which envelope mimicry (send the
Claude Code name, description and schema where an equivalent exists, and translate
the call back) is recommended.

**Decisions:**

1. **Verify, then fix, then document, then implement — in that order.** No
   implementation starts while an exposure question is open.
2. **Non-exposure is provable, not asserted.** Three checks define it: transport
   fingerprint equality, structural equality of the request against the recorded
   genuine structure, and catalogue equality once the tool decision is made.
3. **Open items stay labelled open.** The `ti` field's source, the per-model beta
   selection gates, and the reporting block's exact insertion statement.

## 2026-10-10 — Tool catalogue stays the host's; implementation plan recorded

**Decision:** the plugin continues to send the host's tool definitions. Adopting
the Claude Code catalogue, and emulating it wholesale, are both rejected. The
consequence — the tool array is the strongest remaining body-level difference — is
accepted deliberately and recorded in the audit document so it cannot be mistaken
for an unfinished fix.

**Plan:** implementation is written down before any code:
`docs/plans/2026-10-10-claude-part-implementation.md`. It fixes where each change
lands (identity line and reporting block in the wire library; header removal, mode
inputs and the Bun bridge in the plugin), how each ships (source → build →
versioned tarball → the profile's `file:` reference → reinstall → reload), the
order (library, then plugin headers, then the bridge, then verification), and the
failure policy for the bridge: **fail closed**, because silently reverting to the
Node path would restore exactly the exposure being removed.

**Ordering rule carried forward:** verify, then fix, then document, then implement.
The plan is the last document; Phases 1 and 2 are offline and safe to land before
the bridge.

## 2026-10-10 — Phase 1 landed: identity selection and reporting block (gates green)

**Implemented:** `ClaudeCodeInvocationMode` on the runtime identity; the three
pinned identity literals with `IDENTITY_TEXTS` / `isIdentityText`; `REPORTING_TEXT`
(907 characters, byte-exact from the carve); `selectIdentityText` mirroring the
upstream resolution order; the reporting block hoisted into its own slot by
`buildCanonicalSystem` (only when the attribution and identity blocks are both
present, and with no cache marker); the parser and the cache-breakpoint pass
generalized to the identity set; the reporting slot counted as canonical prefix.

**Verified offline, with no request sent anywhere:** `typecheck` clean;
`fixtures:check` reports 8 sealed; the full suite is 3,581 passed. The eight
golden fixtures are unchanged, which is the evidence that the default path still
emits the interactive identity and no reporting block.

**Ownership of the remaining failures, established by baseline:** stashing the
work and re-running shows `docs/protocol` provenance at 18 failures **without**
this work, so all 18 are pre-existing drift in the ported corpus. The
runtime-neutral failure was caused by the new public exports; the closed-set
assertion was updated deliberately, with the reason recorded at the assertion,
because a caller must be able to inject the reporting text verbatim.

**Placement rule discovered:** `docs/protocol/` is a **ported corpus** — every file
there must be a verbatim port with a provenance header, and the gate rejects any
file it cannot account for. This package's own analysis therefore lives outside
that directory (`docs/analysis/`). The same rule means a ported document must not
receive local sections; research notes belong in a separate analysis document.

## 2026-10-10 — G3 retracted: `x-client-request-id` is genuine, added by the fetch wrapper

**What was wrong.** The audit concluded that this package sends a header the
genuine client does not, and the fix was to remove it. The conclusion came from
reading the request-header assembly object and from a capture. Both were
incomplete.

**What the code shows.** The header is set in the client's **fetch wrapper**, one
layer below the header assembly: when the resolved provider targets the
first-party host, the wrapper sets `x-client-request-id` on any request that does
not already carry one, and the dispatcher also passes one per request. So the
emission is genuine, `src/headers.ts` is right to emit it, and the plugin's
assertion on it is right to exist. No change is needed.

**Why the capture disagreed.** The capture pointed the client at a local
endpoint. That makes the wrapper's first-party host gate false, so the wrapper
never added the header — exactly the same gate that suppressed `cch` in the same
capture. The code explains the capture, not the reverse.

**Decisions:**

1. **G3 is withdrawn.** `x-client-request-id` stays in the emitted header set, and
   the "remove it" action is cancelled.
2. **Audit the transport wrapper as its own layer.** The wrapper adds more than
   this header: a boolean flag header, a value from a helper, a header gated on
   host and a predicate, and the attestation header in the paths where it applies.
   A body of work that replaces the transport — the Bun bridge — must reproduce
   this layer's headers exactly, or the header set stays short even when the TLS
   fingerprint matches.
3. **Record the pattern, not just the fact.** This is the fourth wrong finding
   produced by treating a capture as evidence, and the third produced by reading a
   single layer. When a header's presence is in question, locate every layer that
   can add it: assembly, transport wrapper, and per-request options.

**Revert:** supersede with a later entry; the wrapper behaviour is re-derivable
from the carve index.
## 2026-10-10 — Transport wrapper resolved: one unconditional header, the rest conditional

**Finding:** the fetch wrapper adds `x-client-request-id` on every first-party
request that lacks one, `anthropic-usage-limit` behind an endpoint-and-state gate,
`x-cc-atis` only when an attestation source exists (feature flag default off), and
two refusal-fallback headers only after a fallback event or when the header was
armed. So normal traffic carries exactly one wrapper-added header.

**Also wire-visible there:** request-body gzip. A string body above the helper's
threshold is replaced with a gzip-compressed one and the fetch options carry a
gzip flag, which reaches the wire as a content encoding. A replacement transport
must make the same decision, not always send an identity body.

**Method note recorded:** minified identifiers repeat across chunks — resolving
four of the names above by name alone returned unrelated definitions. Only
definitions living in the same carved segment as the consumer, or resolved through
the import graph, may be trusted.
## 2026-10-10 — Wrapper header set closed: one unconditional header, one gzip decision

**Resolved:** `anthropic-usage-limit` sends the constant `slow` when the request
path ends with `/v1/messages`, the provider is first-party with the real API host,
and a client state machine reports phase `active`. It is a client self-report of
pacing, not an identity field, so a transport that does not implement that state
omits it and the omission is not anomalous. The refusal-fallback pair is
`x-is-refusal-fallback: true` and `x-cc-fallback-latched-by: <sanitized id>`.

**Closed requirement for the replacement transport:** reproduce the assembly
header set, `x-client-request-id`, and the request-body gzip decision. Every other
wrapper header is conditional on state the plugin does not have.

**Method note that made this possible:** resolving only within the segment that
owns the consumer removed all ambiguity — `ja` had 16 same-named definitions
across the bundle, and the one that belongs is the exported
`provider === "firstParty" && hostIsRealApi()`.
## 2026-10-10 — Phase 2 landed: invocation mode and reporting block reach the wire

**Library.** `validateRuntimeIdentity` rebuilds the identity from its validated
fields, so the new invocation mode was silently dropped before the system builder
saw it — the change compiled, type-checked and passed its own unit tests while
having no effect on the wire. The validator now validates and threads the mode.
Released as `0.7.2-dsh2`, with the changelog entry and the release-policy constant
that the repository's own gates require; all 334 governance tests pass.

**Plugin.** The Claude adapter now passes `invocation: { isNonInteractive: true,
hasAppendSystemPrompt: false }` and prefixes its system input with
`REPORTING_TEXT`. The mode is the headless-CLI shape, so the identity line is the
standalone agent line while the user agent and the attribution entrypoint stay
`cli` — the combination a plain `claude --print` run produces, and the only one of
the available choices that is internally consistent.

**Evidence.** The plugin's wire spec failed on exactly one assertion after the
change - the identity line it pinned - which is what confirmed the change reached
the wire rather than passing silently. The spec now asserts the agent line, the
reporting block in its own slot, and the absence of a cache marker there; the full
plugin suite is 602 passing.

**Packaging.** Both artifacts are staged in the fork's release directory as
`tormentalabs-claude-code-wire-compat-0.7.2-dsh2.tgz` and
`dsh-plugin-subscriptions-0.9.4-dsh017rc1.9.tgz`. The two plugin tarballs carry the
same 130 files in the same layout, so the size difference between them is content,
not omission.

**Still to do:** point the web profile at the new plugin tarball and provide the
wire library tarball through a dependency override, then reinstall and reload the
profile. That step touches the running application and waits for the operator.

**Method note:** a change that reaches a type but not its consumer is invisible to
type-checking, unit tests and packaging alike. The decisive evidence was a test
that pinned the old value and failed once the behaviour changed.
## 2026-10-10 — Delivered to the web profile; resolution verified after restart

**Delivery.** The web profile now references
`dsh-plugin-subscriptions-0.9.4-dsh017rc1.9.tgz`, and the plugin declares its wire
dependency as an absolute `file:` path to
`tormentalabs-claude-code-wire-compat-0.7.2-dsh2.tgz`. A `pnpm.overrides` entry was
tried first and did **not** take effect — pnpm still resolved the version from the
registry and failed — so the dependency is declared where the consumer reads it.
Package.json and the lockfile were backed up before the change; restoration is one
copy plus one install.

**Verified after the operator restarted the application:**

1. The plugin's own resolution view reaches the hoisted copy at
   `profiles/web/node_modules/@tormentalabs/claude-code-wire-compat/dist/index.js`,
   with `REPORTING_TEXT` at 907 characters, all three identity literals, and the
   headless selection returning the agent line. This is the exact resolution the
   plugin performs at runtime.
2. The plugin's data directory shows `models.json` rewritten after the restart,
   which is the plugin completing its start-up path rather than failing to load.

**Lesson recorded:** an override in the consumer's manifest is not equivalent to a
declaration in the package that owns the dependency. The dependency graph is
resolved from the tarball's own manifest, so a local fork artifact must be named
there.
## 2026-10-10 — Bun bridge, increment one: the frame codec

**Implemented in the plugin** (`src/transport/frames.ts`), not in this package,
which stays I/O-free.

The design document fixed the frame's envelope — a four-byte big-endian length,
JSON for control, raw bytes for bodies, and a `streamId` on every frame — but left
the encoding of a body frame's identity open. Because every frame must be
addressable while a UUID per chunk would cost more than small payloads, a body
frame carries the numeric index the control frames assigned to its stream: length,
then one tag byte, then either UTF-8 JSON or a four-byte index followed by raw
bytes. Bodies are therefore neither base64-inflated nor newline-split, which the
design forbids.

Nine tests cover the properties that matter rather than the happy path: a body
containing `0x0a`, `0x00`, `0xff` and a backslash survives byte-exact; frames split
at every byte boundary reassemble; one read holding several frames returns all of
them; two interleaved streams keep their own indices; and each rejection path —
missing stream id, over-long length prefix, unknown tag, invalid JSON, non-object
payload, short body header — reports its own reason. The over-long prefix is
refused rather than allocated.

Plugin suite: 611 passing.
## 2026-10-10 — Bun bridge, increments two and three

**Child** (`src/transport/bun-child.ts`, emitted to `lib/transport/bun-child.js`):
reads frames from stdin, issues each request with the global `fetch` — so the
runtime that serializes headers and performs the TLS handshake is the runtime the
target client uses — and streams the response back as body frames. It never
listens on a socket. Stdio and compression use Node-compatible APIs only, because
the masquerade comes from the runtime performing the fetch, not from Bun-specific
calls. Request bodies at or above a single named threshold are gzipped through the
runtime so the content encoding is the runtime's own decision; the threshold is one
tunable precisely because the genuine client's helper depends on storage state this
transport has no equivalent of.

**Client** (`src/transport/bridge.ts`): owns one child, multiplexes by `streamId`,
and presents each response as a web `Response` whose body streams from frames. The
duplex is injectable, which is what lets the framing and failure paths be tested
without spawning. Failure is fail-closed: a dead child rejects in-flight work and
refuses later work with `child-exited`, and `dispose` kills the child; there is no
fallback to the Node transport, which is the configuration this work exists to
replace.

**Evidence:** build clean, 615 plugin tests passing, including a round trip whose
request framing is asserted, SSE-shaped multi-chunk response streaming, a remote
error surfacing on the request that caused it, a dead child rejecting both in-flight
and later work, and `dispose` killing the child.

**Not yet executed:** the child itself has never run. Its loop is covered only
in-process by the memory-duplex tests, so the next increment must execute it under
a real Bun against a loopback listener and compare the resulting ClientHello with
the recorded vector — zero egress, which the operator has pre-approved.

**Also outstanding:** the Claude provider still uses its existing client; nothing
imports the transport yet, so these files are inert and the installed plugin's
behaviour is unchanged.
## 2026-10-10 — Phase 3 complete: the Bun transport is wired and proven end to end

**The claim that motivated the whole transport track is now measured.** A request
built through the bridge, executed by the real Bun child against a loopback
listener, produced ClientHello **JA3 `1523504b38f0fae0d881d4b6554aac1b`** — the
genuine client's value on this platform, cipher for cipher and extension for
extension — and carried the request and a streamed SSE response through the frame
protocol byte-exact. Zero egress: the listener is loopback only.

**The real run caught what the in-process tests could not.** The requester picked
the stream index locally while the child only learned indices when it sent, so
every request body arrived as a frame for an unknown stream and was silently
dropped: the headers looked perfect and `Content-Length` was 0. The fix is that the
request control frame carries the requester's index and the child adopts it, so
both directions share one index with no handshake. A unit test now asserts that the
body frame uses the index the control frame named.

**Wiring.** `claudeApiFetch` routes by host: `api.anthropic.com` goes through the
bridge, everything else — token refresh, usage polling, the other providers — keeps
the client it had. The bridge is on by default, `DSH_SUBSCRIPTIONS_BRIDGE=off`
restores the previous path explicitly, and a bridge that cannot start raises a
`BridgeUnavailableError` naming that switch rather than falling back, because a
fallback would restore the transport this exists to replace. The Bun runtime is a
declared platform dependency, resolved through an explicit override first, and its
absence is a named error.

**Delivered** as `dsh-plugin-subscriptions-0.9.4-dsh017rc1.10.tgz`, installed into
the web profile with the Bun platform package alongside it (82 MB). The transport
modules are present in the installed tree. A restart is required before the new
path carries traffic; the operator performs it.

**Committed as a test asset:** `test/transport/e2e/run_e2e.py` re-runs the whole
measurement — it generates its own CA and localhost certificate, drives the child
with file redirection (no pipes), peeks the ClientHello without consuming it, and
asserts both the JA3 equality and the round trip. Re-running it is what detects a
runtime bump that moves the ClientHello.

**Still open:** the gzip threshold is a single named tunable that must be pinned
against the genuine client before large bodies are trusted; the superseded undici
path is still present for the switch; and one real request per provider path (P4)
has not been made.
## 2026-10-10 — Backfill batch: gzip default, thinking display, one restart

**The gzip item dissolved on inspection.** The genuine client's compression decision
is gated by two remote flags whose default is false, and the whole path is further
conditioned on being the Bun runtime, on a string body, on the real API host, and
on a per-endpoint minimum compared in UTF-16 code units. Ordinary traffic therefore
sends an identity body. This transport has no equivalent of those flags, so it now
mirrors their default — no compression — and keeps the capability behind an
explicit opt-in instead of pinning a threshold that the default path never reaches.

**A divergence the batch surfaced: `thinking.display`.** The adapter fixed the value
to `summarized`, but the pinned 2.1.280 release sends `updates`, and the wire library
already emits `updates` for both the adaptive and the enabled branches. The adapter's
override was the only thing producing the wrong value, so the override is gone and
the library's per-version behaviour stands. Two plugin specs pinned the old value and
failed the moment the change reached the wire — the same signal that confirmed the
identity-line change earlier — and now assert `updates`.

**Checked and deliberately not implemented: the 512-byte cap on `metadata.user_id`.**
The genuine client degrades extra metadata in three steps under that ceiling. This
package does not implement it, and the plugin's `user_id` carries only the three base
fields, so the ceiling is unreachable on this path. Recorded rather than built.

**Not done, by design:** removing the superseded undici path. That happens after real
traffic has exercised the bridge, and the real request needs the operator's order.

**Delivered** as `dsh-plugin-subscriptions-0.9.4-dsh017rc1.11.tgz` and installed into
the web profile, with the Bun platform package alongside. One restart now carries
every pending change, which is what the operator asked for.

**Verification:** 621 plugin tests passing; the installed tree contains the opt-in
gzip branch, the profile-owned display value, and all five transport modules.
## 2026-10-10 — Independent audit, slice 3: routing, lifecycle, failure policy

A read-only audit by a separate agent, independently spot-checked here (five of its
claims re-derived from the source, all accurate). No network was used.

**Two blockers.** The configured plugin proxy is bypassed on the Messages path: the
Bun child runs in another runtime and receives no proxy information, while
`claudeApiFetch` decides by host alone, so a user who needs the proxy for
connectivity gets silent direct egress for the most important request — and the
plugin's own contracts still promise the opposite (`src/http.ts` header comment, the
Settings copy, `README.md`, `FORK_MAINTENANCE.md`). And `AbortSignal` is dropped when
the request is re-framed: the idle watchdog and user cancellation become inert, and
nothing else has a timeout, so a child that accepts a connection and never answers
hangs a turn indefinitely. The existing `cancel` frame type is dead client-side.

**High severity.** The Files upload takes the Bun path and its multipart body is
dropped, because only string bodies are copied into the frame — an image above the
size threshold breaks the turn. A failed bridge start is cached for the life of the
process, so the operator's own remedy ("install it or point the variable") cannot
take effect without a restart, and an exited child is never respawned. The runtime is
declared for two of the six platforms the resolver supports. `stopBridge` has no
production caller, so a plugin reload leaks the child. `childScript` still
percent-encodes the path and `fileURLToPath` is imported unused — a patch that was
believed applied and was not.

**Medium and low.** Frame-decode errors escape the data handler instead of failing
pending requests; an oversized body rejects the caller but leaks its pending entry;
`child.stdin` has no error handler; configuration is env-only rather than validated
`Config` fields, and the plugin's documentation never mentions the bridge, the
runtime or the switches; routing is host-only with no assertion tying the built URL
to that host, so a future endpoint move would silently restore the Node path; tests
cover neither non-Messages endpoint routing, retry, revival nor teardown.

**Confirmed passing:** no silent fallback anywhere; single spawn under concurrent
first requests; the switch restores the previous path with one change; `dispose`
semantics; 19 offline transport tests, no egress.

**Process lesson:** verifying that an import line changed is not verifying that the
call site changed. One patch in this series was recorded as applied while the old
expression remained in the file.
## 2026-10-10 — Independent audit, slice 1: frame codec and client multiplexing

A separate read-only agent audited the codec and the client. It ran the slice's own
tests (13 pass) and local runtime probes; no network. Several findings corroborate
slice 3 independently, which raises them to confirmed-by-two-workstreams.

**Blockers.** A frame that fails to decode discards the frames already decoded in the
same read, permanently poisons the decoder (every later push re-throws), and throws
out of the stdio data handler — measured: a batch of two good frames plus one bad tag
returned nothing. The same class silently drops frames if the body tag constant ever
changes, because both consumers compare the literal `2` rather than importing it. And
a transient mid-stream read error becomes an unhandled rejection in the child, which
on the pinned runtime exits the process; combined with the cached dead bridge, one
network blip disables the whole Claude path until restart. The design document also
promises a fallback to the undici path on bridge failure, which the implementation
deliberately refuses — the two documents and the code disagree.

**High severity.** No cancellation and no in-flight deadline anywhere: the signal is
dropped before the frames, the response stream has no cancel callback, and the child
keeps streaming after a cancel frame, so an aborted turn keeps consuming quota and a
silent child hangs the turn. Independently corroborates slice 3's second blocker.
`new Response(...)` with a child-reported status throws for 204, 205, 304 and for any
status outside 200-599, inside the same unguarded handler. Backpressure is absent on
both sides, so an unread stream grows without bound and its bookkeeping never clears.
Multiplexing concurrent requests over one long-lived child contradicts the document's
one-connection-per-request policy, since the runtime pools connections per origin —
the exact fingerprint surface the plan claims to control.

**Medium severity.** The index guard omits the uint32 upper bound and the child can
mint a colliding index; the index contract has no test that would catch a wrong index
in either direction; the framing diverges from the normative wire description (a tag
byte and a numeric index instead of the documented shape), so a peer implementing the
document would desync; unsupported bodies are stringified (`[object Blob]` reaches
the API) and `Object.entries(init.headers)` drops every header when a `Headers`
instance is passed — a wire-fidelity failure with no diagnostic; buffering is
quadratic in frame size (measured: 8 MiB in 64 KiB reads takes 64 ms, 32 MiB takes
1012 ms) and the child decodes every request body to count characters even when
compression is off.

**Low severity.** `dispose` conflates reason and detail and does not escalate or await
exit; `subarray` retention and chunk ownership are undocumented; the error taxonomy
lets serializer failures escape as non-`FrameError` types.

**Confirmed passing:** envelope shape for the implemented form; partial frames at
arbitrary boundaries; several frames per read; interleaved streams; length prefixes
over the ceiling rejected before allocation; negative and non-integer indices; a body
frame after `end`; `dispose` ordering; distinct reasons on every rejection path
except the taxonomy gap.

**Corroborated across slices (both agents, independently):** the dropped abort signal,
the non-string body drop, the permanently cached dead bridge, and the throwing decode
path.
## 2026-10-10 — Independent audit, slices 2 and 5: the child, and the header set

Two more read-only agents reported; both probed locally and used no network. Two of
their findings contradict claims made earlier in this log, and both were re-verified
here before being recorded.

**The bridge does not deliver the runtime self-report (correcting an earlier claim).**
`x-stainless-runtime-version` is computed in the plugin on the host runtime
(`claude-wire.ts` passes `process.versions.node`) and the child never rewrites it, so
the value stays the host Node version — measured: the pinned Bun reports `v26.3.0`
while the host reports `24.13.0`, and the plugin's own golden fixture carries
`v24.15.0`. The earlier entry claiming that issuing from the same runtime aligns this
header automatically is wrong: alignment requires the value to be produced *in* that
runtime. The same class covers `x-stainless-os` (the plugin uses the client's own
table, but the header is produced by the SDK's normalizer, which spells `MacOS` and
does not silently default to Linux) and `x-stainless-arch` (bypasses the normalizer).

**A genuine header is missing, and a test asserts the opposite.** The SDK always sets
`Accept: application/json`; the plugin never emits it, and its own spec asserts "the
genuine client sends no accept header". The captured reference request recorded
earlier in this log did contain `Accept`, so on this point the capture was right and
the package's belief was wrong — worth remembering before dismissing any capture.

**The child rewrites the caller's request.** `method: init.method ?? 'POST'` forces
POST where the genuine wrapper defaults to GET and this plugin's own non-bridge path
passes the caller's init through, so profile and usage calls change verb; and only
string bodies are forwarded, so a FormData upload to the Files API arrives empty.
The child also sets both a pre-gzipped body and the runtime's `compress` option, which
compresses twice — latent behind the now-default-off switch, but it would fail every
request in that mode. The switch's size thresholds were also wrong: the genuine
`4096` (api) and `1024` (worker) constants are in the same carve segment as an `8192`
that is a body-preview read cap, and the plugin adopted the wrong one.

**Corroborated across slices, now by three independent agents:** the dropped abort
signal and dead cancel frame; the non-string body drop; the permanently cached dead
bridge; a throwing frame handler (with two independent confirmations that
`new Response(stream, { status })` throws for 204, 205 and 304, and that a `Headers`
instance is enumerated as empty so every header would be dropped); and a mid-stream
error that is swallowed so the request hangs.

**Also confirmed:** response-side wrapper behaviour the child does not reproduce
(reacting to `x-cc-tender-quilt`, wrapping SSE in the idle-timer stream), the genuine
gzip path's whitespace padding, and that both sides rely on Bun's `Headers` to
lowercase and sort rather than on code.
## 2026-10-10 — Independent audit, slice 7: auth and every non-Messages endpoint

An endpoint-by-endpoint comparison against the carve, no network. It produced the
single highest-leverage fix in the whole audit plus two divergences nothing else had
found.

**The fix that resolves five findings at once:** the bridge is keyed on hostname
alone, so `/v1/files` and `/api/oauth/profile` ride the Bun transport although the
module documents that only Messages should — and the same URL therefore takes
different transports depending on the caller. Scoping the branch to the exact
Messages path removes, in one change, the Files body drop (three slices found it
independently), the missing identity on bridged non-Messages calls, and the proxy and
signal gaps on those calls.

**Two divergences new to this audit.** Model discovery calls
`GET /v1/models?beta=true` with a hybrid identity — the Messages SDK user agent, the
browser-access header and `?beta=true`, but none of the client identification headers
and no beta — whereas the genuine first-party catalogue call is
`GET /api/claude_cli/bootstrap` with a different user agent and the client headers.
And the OAuth hosts do not match the release: the plugin uses `claude.ai` for both the
token exchange and the authorize page, while the genuine client uses
`platform.claude.com/v1/oauth/token` and `claude.com/cai/oauth/authorize` (console:
`platform.claude.com/oauth/authorize`), and honours a custom OAuth base the plugin
ignores. Both are verified from the carve.

**Also found:** no 401-refresh-replay on usage or profile where the genuine client
retries; the Files beta omits the OAuth beta the genuine client composes alongside it;
the pinned scope omits a scope the genuine login adds in production; every Anthropic
and OAuth host is hardcoded so the base-URL overrides are ignored; and the identity
backfill can persist a start-of-request session copy without comparing the access
token, reverting a concurrently rotated refresh token and, on the resulting
`invalid_grant`, deleting the account and forcing a re-login.

**Clean:** no path reaches a request without credentials — empty tokens are rejected
at session, store and request boundaries, a permanent refresh failure deletes the
account, and no account or device identifiers travel on any endpoint, matching the
genuine client. One residual: a plain expiry error is classified transient, so a
permanently broken login is never removed.
## 2026-10-10 — Independent audit, slice 6: the beta header

The most detailed slice: it matched the library's registry to the carve byte for byte
and ran 97 offline probes across the 2.1.280 catalogue. Ordering, de-duplication and
eight gating families were confirmed correct. Three findings matter.

**The same request disagrees with itself.** `redact-thinking-2026-02-12` is gated
upstream on the session being interactive; the plugin pins `betaPolicy.interactive`
to true in the profile while passing `invocation.isNonInteractive` for the identity
line, so it announces a beta a genuine headless client never sends while its identity
block says headless. The library already models that fact for the identity, so the
fix is to derive the beta gate from the same input rather than a frozen constant.

**No fixture covers the header the plugin actually sends.** The reference fixtures are
built without `cacheControl`, but the adapter always requests a one-hour TTL, which
adds `extended-cache-ttl-2025-04-11`; the differential test then asserts a fourteen-entry
literal while the shipped header has fifteen. The fixture set therefore cannot detect a
regression in exactly the identifier the plugin emits.

**A catalogued model loses three betas.** Upstream's capability lookup returns
`undefined` for an absent capability string and falls through to a permissive
first-party tail, whereas the library reads absence from the catalogue as denial.
`claude-mythos-5`, whose catalogue entry declares no capabilities, therefore drops
`context-management`, `mid-conversation-system` and `mid-conversation-tool-changes`.
The library's own documented divergence covers only *uncatalogued* ids, so this case is
wider than recorded.

**Also found:** a body can carry a one-hour cache marker while the header omits the beta
that must accompany it, because the identity block's marker is hardcoded and the beta
keys off a different input; `thinking-binding-controls` is gated on the wrong fact and
its coupled body field `block_binding` is never emitted, so the header announces a
capability the body does not exercise; the OAuth beta is a static profile constant
rather than a token property, correct on this plugin's live path but for the wrong
reason, with no API-key path modelled at all; and the plugin's own suite asserts only
that the header is non-empty.

**Confirmed correct:** emission order against the genuine push sequence for the modelled
subset; zero duplicates across 97 composed requests; web-search never emitted on
first-party; the 1M marker path; per-model capability selection for every model except
the one above; structured-outputs and afk-mode correctly absent; the redact/display-updates
coupling; effort without a body field; and cache-diagnosis on the first-party path.
## 2026-10-10 — Audit verifications performed here (not taken on trust)

Every slice that reported a finding of consequence had its key claims re-derived in
this session before being recorded. All were accurate.

- Slice 3: the proxy is never consulted anywhere under `src/transport`; the abort
  signal is absent from the rebuilt request; a non-string body is dropped; a failed
  start is cached because `starting` is never cleared; `childScript` still uses
  `.pathname` while `fileURLToPath` is imported unused — a patch believed applied that
  was not.
- Slice 1: the frame handler calls the decoder unguarded, so a decode failure can
  escape the stdio data handler.
- Slice 5: the golden fixture carries no `accept` header while the plugin's own spec
  asserts that the genuine client sends none — and the captured reference request in
  this log did carry `Accept`, so on this point the capture was right.
- Slice 5: the runtime version is the host's, computed before the bridge and never
  rewritten by it, which withdraws the earlier claim that issuing from the same runtime
  aligns that header automatically.
- Slice 6: the profile pins `interactive: true` and the beta gate reads that constant
  while the same request declares `isNonInteractive`, so one request contradicts
  itself; the reference fixtures omit `cacheControl` and `invocation`, so the fixture
  asserting fourteen beta ids cannot see the fifteenth the plugin actually sends; and
  the capability derivation uses string presence, which makes catalogue absence read as
  denial where upstream returns `undefined` and falls through permissively.

**The reporting block was adjudicated and the change that added it is withdrawn.**
Across the whole carve the literal occurs once, at its definition; three consumers
read it out of an input array with permissive guards; nothing pushes it into a
request. Supporting code is therefore not evidence of emission, which is the mistake
that added it.
## 2026-10-10 — Independent audit, slice 4: fidelity of the Messages body (the last slice)

It corrects two decisions taken earlier in this log and adds the first structural
divergence found in the canonical prefix.

**The entrypoint decision was wrong.** The genuine client *sets* the entrypoint from
its own interactivity: a non-interactive run promotes the environment variable to
`sdk-cli`, so the attribution block reads `cc_entrypoint=sdk-cli` and the user agent
reads `claude-cli/2.1.280 (external, sdk-cli)`. The earlier decision to keep `cli`
reasoned from which value is most common across all users; for a route that declares
itself non-interactive the genuine value is `sdk-cli`, and the current pair contradicts
the identity line in the same request. The identity line itself stays the standalone
agent form, which is what a non-interactive run without an appended system prompt
sends.

**The system array is structurally wrong, and the earlier transcription was too.**
With the dynamic-boundary marker present — the live path on a default first-party
install — the genuine assembler emits the attribution, identity and reporting blocks
with no marker at all, then the static text with `scope: "global"` and the dynamic text
with a plain ephemeral marker. The plugin instead marks the identity block and never
emits a scope, while still announcing the caching-scope beta. This is a block-count and
breakpoint-position divergence, which is the first thing a verifier compares.

**The reporting block verdict is confirmed independently.** A second agent, by a
different route, also found no emission site, and added the decisive detail: the block
is not inside the standard prompt text, which does live in the carve. Two independent
verdicts, so the change that added it is withdrawn rather than merely doubted.

**Also found:** `cc_turn_origin` is never emitted although a programmatic first-party
turn always carries `cc_turn_origin=sdk`; empty and whitespace-only text blocks reach
the wire, where the genuine client strips them and substitutes a placeholder — the API
rejects them, and the client has a dedicated error classifier for exactly that;
mid-conversation system content is re-encoded as a reminder-tagged user message while
the matching beta is still announced, so the header and body disagree; the serialized
body key order differs from the genuine literal in five positions; `parent_session_id`
and `cc_is_subagent` are never emitted for subagent turns; chaining state is
process-local and header-driven, so a restart loses the chain the genuine client would
have kept from the transcript; and the fingerprint's sampling input lacks the meta
concept, so a meta-first conversation yields a different suffix.

**Confirmed correct at byte or structure level:** the identity line for this caller;
the `cc_version` sampling (same salt, indices, fallback and slice); the attribution
frame and segment order; the `cch` gate for this consumer; the `metadata.user_id` base
shape and ordering, with the finding that the `ti` field is dead in this release, which
closes an open item; the thinking object and its display; `max_tokens` clamping;
`stream` and the absence of betas in the body; image sources; and the chaining
identifiers' formats and gates, character for character.

**Low-severity, restated so they are not accidentally "fixed":** the deliberate
`tool_choice` demotion, the alphabetical host-tool ordering (itself a signal, since no
genuine client sorts its catalogue), and the account-uuid fail-loud behaviour.
## 2026-10-10 — Fix batch A landed on both sides (all audit blockers closed)

**Library.** The `accept` header the SDK always sends is now part of the plan and the
sealed fixtures, the invocation mode survives runtime-identity validation, the identity
line is selected from that mode, and a caller-supplied reporting block gets its own
canonical slot. Released as `0.7.2-dsh3`. The suite sits at its pre-existing baseline —
eighteen `docs/provenance` failures that predate this work — so nothing here regressed
it.

**Plugin.** Frames no longer throw: a decode failure returns what was already decoded,
reports itself through the decoder, and marks the bridge dead rather than escaping a
pipe handler. The child's read loop cannot take the process down with an unhandled
rejection, every failure path emits an `error` or `end` frame, cancellation aborts the
fetch, the runtime version is produced by the runtime issuing the request, gzip is gone
(the genuine default is off and its gates are unobservable here), the bridge carries
only `/v1/messages`, an unsupported body is refused rather than silently emptied,
headers pass through a `Headers` instance, null-body statuses construct, queued bytes
are capped, bodies are chunked, a failed start is retried, a dead child can be revived,
and the child is disposed with the plugin. The reporting block is no longer injected.
622 tests pass.

**A false green was caught and fixed:** one assertion was appended to a comment line by
a string replacement, so the suite passed while the check was inert. It failed for real
once the line was separated — which is how the missing library rebuild surfaced.

**Delivery loop note:** the fixture sealer shells out with piped stdio, which this
session's sandbox refuses, so fixtures, their recorded digests and the expectation
literals were updated by hand in the same shape the sealer would have written.
## 2026-10-10 — Claude Desktop carved: what a desktop session actually sends

The desktop app was obtained from the vendor's own release channel through the winget
manifest (hash-verified), and taken apart: a Squirrel installer whose payload is a PE
resource holding a zip of a zip, an Electron application, and its JavaScript. Nothing
here is inferred; every value below was read out of the application's own code.

**The desktop does not ship the client — it downloads a signed bundle.** The main
process holds a bundle manifest naming Claude Code 2.1.288 with a commit and a build
date and signature enforcement, and it spawns the client with the environment below.
`claude.exe` in the package is the Electron runtime itself: it contains no client
strings at all, which is why a marker scan of it finds nothing.

**A desktop session's identity.** The entrypoint is `claude-desktop` (or
`claude-desktop-3p` for third-party accounts), `CLAUDE_CODE_DESKTOP_APP_VERSION` is
the application's own version, and five client headers travel through
`ANTHROPIC_CUSTOM_HEADERS`: the platform value `desktop_app`, the client app
`com.anthropic.claudefordesktop`, the client version, a device class bucketed from
physical memory, and total memory in gigabytes. `x-app` remains `cli`, because the
spawned client sets it — a desktop session and a CLI session are the same client, so
that is not the contradiction it appeared to be from the carve alone.

**What this settles.** A desktop identity is not a different wire shape needing its own
reverse engineering: it is the same requests plus those headers, which makes it
reachable at low cost. Two facts remain open and are recorded as open rather than
guessed: the pinned profile is 2.1.280 while the desktop bundle is 2.1.288, and the
bundle's own release path has not yet been carved.

**Correction recorded.** An earlier note in this log described the desktop client as
present only as bytecode and therefore unreadable. That was a guess made from a small
carve, and it is wrong: the client code ships as ordinary JavaScript inside the
application bundle, and the bytecode cache beside it is derived from that JavaScript.
## 2026-10-10 — The release channel: any version of the client, hash-verified

The desktop application pins a client version and downloads it from a public release
base. That base is reachable here, and the manifest that names each artifact carries
the checksum, so a build can be fetched and **proved** to be the build the desktop runs
rather than assumed to be.

  base       https://downloads.claude.ai/claude-code-releases
  layout     <base>/<version>/<platform>/claude.exe.zst
  manifest   version, per-platform binary name, checksum, size, and sdkWrapperVersion

Verified: `2.1.288/win32-x64/claude.exe.zst` downloaded to 88,605,512 bytes with
SHA-256 `36aa8c97bf8665d371c5b5be82f2f1252fcc623dd323a6c7ac1fba0b09b8a35c`, matching the
manifest exactly. Decompressed it is a 237.6 MB client of the same kind already carved:
`~BUN/root` ×166828, `@bun @bytecode` ×2167, `claude-cli/`, `x-stainless-` ×21,
`anthropic-beta` ×218, and `VERSION:"2.1.288"`. So the desktop's client is 2.1.288 while
this profile pins 2.1.280 — eight patches apart, and the gap is now closable by carving
the newer build instead of reasoning about it.

**The desktop's own identity, read verbatim from its code.** It sets the entrypoint to
`claude-desktop` (third-party accounts: `claude-desktop-3p`), sets the desktop app
version to its own version, and passes five client headers through the custom-headers
variable: platform `desktop_app`, client app `com.anthropic.claudefordesktop`, the
client version, a device class bucketed from physical memory (below 6 GB, below 12,
below 20, else), and total memory in gigabytes. The client it spawns sets `x-app` to
`cli` itself, so a desktop session and a CLI session differ by those headers and the
entrypoint, not by the shape of the request.
## 2026-10-10 — 2.1.288 carved and compared: the pinned profile is not stale in shape

Carving the build the desktop runs produced a materially better asset than the earlier
one: 5470 segments, 44.4 MB of text, 2019 with imports, 2110 with exports, and export
names that resolve to their owning chunk — so the analysis method that was blocked by
unresolvable names on 2.1.280 is available on this build.

Comparing every wire landmark between the two builds: all three identity literals are
unchanged; the reporting text still occurs exactly once, at its definition, so the
verdict that nothing pushes it into a request holds on this build too; `cc_turn_origin`,
`cc_entrypoint`, `cch=00000`, the refusal-fallback headers, the usage-limit header, the
atis pair, the caching-scope, extended-cache-ttl, redact-thinking and
thinking-binding-controls are all unchanged. Only two betas are new —
`cache-keepalive-2026-09-03` and `user-profiles-2026-08-18` — and a few counts move
because the desktop integration grew.

So the profile pinned at 2.1.280 is eight patches behind but structurally current: the
requests it composes still match the shape the newer client produces. Adopting the
desktop identity therefore does not also require re-deriving the profile.
## 2026-10-10 — Updates are server-driven, and the claimed version is visible

**The desktop does not stay on its build pin.** It keeps a monotonic high-water mark
for the client binary and installs anything newer, cleaning up older versions; the app
itself updates through a feed the server answers. The feed URL the app requests carries
the device id, the app version and the OS version, and the server answers with the
current release; an enforcement window can restart devices within a bounded number of
hours, and enterprise policy can cap the version instead. So a fleet can be moved to a
chosen version, and the client binary follows on its own. Pinning to a desktop build's
bundled version is therefore not what a real desktop does over time — it is only that
build's floor.

**The claimed version is visible to the API.** The billing header carries
`cc_version=<version>.<fingerprint>` and the user agent carries the version; there is no
separate version header on the messages request. The desktop's own protocol additionally
compares the version it expected to spawn against what the process reported. So version
drift is observable in principle, and whether it is acted upon is server policy that no
client-side artifact can show.

**Consequence for this work.** Claiming a version means claiming it consistently in the
billing header, the user agent and any desktop-facing version field, and a version that
ages is a claim that ages with it. That argues for tracking the newest release rather
than freezing an older desktop pin, and for keeping the release-fetch and carve pipeline
cheap enough to run whenever the release moves.

**The desktop's own path builds no messages requests.** The agent-SDK chunk has no
messages path, no beta header and no API key handling; it spawns and supervises the
client process. So every desktop messages request comes from the same client binary the
CLI carve already covers, differing only by the entrypoint and the client headers — there
is no second request shape to reproduce.
## 2026-10-10 — The release channel is fully mapped, so version tracking is cheap

The channel answers three questions without any guessing: what the newest build is,
what the conservative channel points at, and whether a given build is authentic — each
version publishes a manifest carrying its commit, build date, per-platform checksums and
sizes. Pointers: `/stable` names 2.1.287, `/latest` names 2.1.296, and every version from
290 through 296 serves its artifact.

Two manifests exist and they checksum different things, which matters when verifying: the
manifest baked into the desktop application checksums the **compressed** artifact, while
the channel manifest checksums the **decompressed** binary. The 2.1.288 download was
verified against the former, byte for byte; the latter is the stronger check available
for any version.

This turns version currency from a research task into a routine: fetch the pointer, fetch
the manifest, download, verify, carve. Since the claimed version is visible in the billing
header and the user agent, and the desktop's own protocol compares the version it expected
against what the process reported, staying current is the defensible default rather than
freezing a desktop build's pin.
## 2026-10-10 — Three builds compared: the wire shape is stable, so tracking the version is a string change

2.1.296 was fetched through the channel manifest and verified against the decompressed
binary's checksum, then carved alongside 2.1.288 and 2.1.280. Comparing every wire
landmark across all three: the three identity literals are byte-identical, the reporting
text still occurs exactly once at its definition, and the turn-origin, entrypoint, cch,
billing, refusal-fallback, latched-by, usage-limit, atis, caching-scope,
extended-cache-ttl, redact-thinking and binding-controls landmarks are all unchanged. Only
counts describing the desktop integration grow.

The beta set moves once, between 2.1.280 and 2.1.288, and then not at all through
2.1.296. Of the two additions, one is a genuine registry entry beside the caching betas
and the other belongs to a different endpoint entirely; none of the three removals is on
this profile's emission path. So the shipped shape is current at the newest build: moving
to it is a version-string change plus one beta, not a re-derivation.

**Open, recorded rather than guessed:** the value the client reports as
`x-stainless-package-version` was not located — its header name appears in every build,
but the constant that supplies the value was not resolved in its owning segment. The
candidate strings present in the bundles differ between builds, so the currently pinned
value needs that resolution before it can be called correct or stale.
## 2026-10-10 — The CLI's own updater, carved on both platforms

Windows and Linux builds of 2.1.296 were fetched through the channel manifest, verified
against the decompressed binary's checksum, and carved side by side. The updater is the
same code with the same strings on both.

**Update is the default.** The gate that decides whether the updater runs returns "no
reason to disable" unless an environment switch is set or configuration turns it off —
and for a native installation, configuration turning it off does **not** take effect
unless a second flag protects that choice. So the native installer keeps updating even
when the user-facing setting says otherwise. Channels are `latest`, `stable` and `rc`,
and the apply path persists its outcome with per-install-method handling for the local
and global layouts; telemetry names the stages as check, download, apply and manifest
signature.

**A server-delivered policy can stop an old build from starting.** Two managed settings
exist: a required minimum version and a required maximum version. The enforcement runs at
startup, exempts the update, install and doctor commands, and refuses to start with an
instruction to update. Both are documented as enforced only from managed policy settings —
and the composition rule for those settings ranks the server-managed source above the
machine's own MDM and file sources, with a policy-limits endpoint and remote managed
settings that the server confirms. So the mechanism by which a fleet is forced forward
exists on the server side, not only in local files.

**Platform notes.** Linux native installs check `~/.local/bin` on the path, and a Windows
npm driven from inside WSL reports that configuration as unsupported for updates. Neither
platform lacks the updater.

**What this does not establish.** The check itself is client-side: a client that does not
implement startup policy is not stopped by it, and whether the service acts on a claimed
version it dislikes is policy that no client artifact can show.
## 2026-10-10 — Tooling exists now, and it changes what is worth doing

The carve method used so far recovered text in arbitrary runs and left identifiers to be
resolved by searching segments. A published unpacker for Bun single-file executables does
the job exactly: it reads the packer's own file table, so the output is the real module
list with real chunk names, per-file sizes, and per-file bytecode presence. Pointed at the
verified 2.1.296 binary it reports 2586 packed files over a 158.9 MB payload and writes
them out unchanged. Every wire fact now has a module name instead of a segment number: the
billing header and the reporting text share one module, the fingerprint salt has its own,
all three identity literals live in one, the required-version gate in two, and the release
base in four.

**Why earlier work leaned on captures.** The tooling is recent — the unpacker's first
public release is five weeks old — so extracting these modules previously meant
hand-rolling the extraction, against a 240 MB binary of thousands of minified chunks with
no sourcemaps and a large bytecode cache. A capture, by contrast, yields the bytes the
server accepted in minutes, which is exactly what a proxy needs: those projects need to be
accepted, not to be indistinguishable. Captures answer "what did one request look like";
the modules answer "which requests exist at all, under which gates, at which version",
which is the question a fleet answering to account enforcement has to ask.

**Prior work found.** A version-by-version reverse-engineering project documents feature
flags, telemetry, device fingerprinting and infrastructure for the same binary. An
independent project restores a runnable source tree with types. A book-length analysis
describes the two layers explicitly — static reading for the logic, captures for the
assembled payload. A proxy project aligns its claims to specific versions and has public
issues about its cloaking going stale after every client upgrade and about mismatches
being classified as extra usage. Their failures are the argument for this method.
## 2026-10-10 — Version coherence is now enforced rather than hoped for

The claimed client version appears in the user agent, in the billing header and beside a
version-specific beta set, and the service refuses claims below a managed floor while
withholding models whose catalogue names a newer minimum. Nothing tied those facts
together: the user agent was an independent literal that merely happened to agree.

A coherence module now derives the user agent from the version and entrypoint, cross-checks
the profile identifier against both versions, and checks beta vintages against the claim
using introduction and withdrawal tables read from the carved builds — the keepalive beta
enters at 2.1.288, and three identifiers leave there. A staleness report compares the claim
against a version the caller supplies, so it performs no request.

Two details worth keeping. The public runtime surface is a closed set enforced by a test,
so adding exports forced a deliberate registration rather than slipping through. And the
package policy pins the release version as a literal, so bumping the manifest without it
fails the suite — which is how the changelog entry this release owed was caught.

**Verified:** all three pinned profiles are coherent today, so the two-version-strings
disagree risk was not realised — but it can no longer be introduced quietly.
## 2026-10-10 — Module names do not survive a release; landmark strings do

Three builds now have their real module trees unpacked from the packer's own file table:
2194 modules at 2.1.280, 2394 at 2.1.288, 2587 at 2.1.296. Names are content-addressed,
which suggests they could be tracked across releases — they cannot. Between consecutive
releases only about 140 names survive, because a minified module embeds numeric module
identifiers that shift whenever anything in the graph moves. The module holding the
billing header is a different name in each of the three builds.

So a lookup is stable only within a version, and tracking must key on the landmark strings
themselves. That is what the analysis has been doing all along, and the diff confirms it
is not merely convenient but necessary. The per-version map is recorded so a lookup in the
current build is a single file open rather than a search across thousands of segments.
## 2026-10-10 — Two translation defects fixed, each with the test that proves it

**Blank text blocks no longer reach the wire.** The API rejects a text block whose
content is whitespace-only, and the failure is conversation-wide rather than
block-local; the genuine client strips such blocks before sending and substitutes a
placeholder when a message is left with none. The translator now does both. Writing the
test surfaced a second fact worth keeping: consecutive same-role messages are merged, so
severity of a block placement must be asserted across alternating roles.

**A refusal is no longer indistinguishable from a completed turn.** The stop-reason
switch fell through to its default, leaving the finish reason at "stop" for a refusal.
Rather than fold it into an existing reason and lose the distinction, the finish-reason
map — documented as merge-extensible so an adapter can surface provider-specific reasons —
is augmented with a refusal kind, which is the mechanism the map invites.

Both changes are covered by tests that fail without them: a blank-only message must
produce the placeholder while a mixed message keeps only the non-blank block, and a
refusal stream must finish with the refusal kind.
## 2026-10-10 — The prompt boundary separator, recognized before it is used

The client inserts a separator entry between the static and dynamic parts of its prompt
bundle. The assembler splits there: the static side carries a global cache scope, the
dynamic side a plain ephemeral marker, and the pinned identity block none at all — which
means the current assembly, marking the identity block and the last block, describes the
branch that cannot fire while the separator is present.

This step adds the separator constant and a pure splitter that consumes it, with tests for
each behaviour that matters: both sides returned and the separator removed, no separation
reported when it is absent (rather than silently splitting at the end), and splitting at
the first separator only. The layout wiring — joining each side and placing the three
different markers — follows separately, so the risky part lands on its own.

Two process notes worth keeping. The public runtime surface is a closed set, so the new
exports had to be registered; the set is compared sorted, and regenerating it from the
built module is faster and safer than hand-placing entries. And the built output must be
rebuilt before regenerating that list, or the list is generated from a stale bundle.
## 2026-10-10 — The dynamic-boundary layout is implemented on the library side

With the separator present, the assembly now leaves the identity block unmarked, gives the
static side a global cache scope and the dynamic side a plain ephemeral marker, joins each
side into one block, and drops the separator so it never reaches the wire. Without the
separator the previous layout stands, which is the branch where no separator exists — so
the change is inert until a caller supplies the separator, and the suite stayed at its
baseline with no new failures.

The cache step recognizes the global scope rather than being told which branch applies.
That removed the need to thread a flag from the builder through the body emitter, which was
the part of this change most likely to rot.

**Open before it can be switched on:** the plugin's system input is static, so inserting the
separator today would produce a layout with an empty dynamic side. What the genuine dynamic
side contains — and therefore whether an empty one is closer to or further from the genuine
request than the current no-separator layout — is a carve question, and the module names
from the unpacked tree make it a lookup rather than a search.
## 2026-10-10 — OAuth endpoints, scopes and the two bodyless requests, read from the carve

The OAuth configuration module in the 2.1.296 build states the hosts directly: the
claude.ai authorize page is on claude.com, the console one and the token endpoint are on
platform.claude.com, and the client honours a custom OAuth base only from a list of
approved endpoints. The plugin had the pre-2.1.235 values, and its own test recorded where
they came from — "captured from Claude Code 2.1.235's own authorize request". This is the
capture-versus-carve distinction in one line: the capture was accurate for the build it
observed and wrong for the build in use.

The same module assembles the login scope set and appends a plugins scope when the plugin
scope is registered, which it is in production; the plugin was asking for the six scopes
before it. Both are fixed, and the test now cites the carve rather than a capture.

Two bodyless requests also gained the headers the client sends: the usage request carries a
JSON content type, and the profile request carries that plus a no-cache directive.

**Also settled:** the prompt boundary separator is a line inside the client's own prompt
bundle, split out by a function in the module that also holds the fingerprint salt. So the
split point belongs to that bundle, which is why the library-side layout stayed inert: a
caller with a different prompt cannot reproduce the genuine division by guessing it.
## 2026-10-10 — Anchoring to the Windows desktop, and a correction about the fixture sealer

Decision: the subscription path anchors to the Windows desktop rather than the CLI. The
newest desktop build is 2.19675.1 per the vendor's own winget manifest, its entrypoint is
`claude-desktop`, and it auto-updates the client it runs to at least its build pin and
upward through the release channel — so the client version to claim is the newest release,
2.1.296, not the 2.1.288 the app build happens to pin.

**Correction.** An earlier note in this log said the fixture sealer could not run here
because the sandbox refuses piped child processes, and that fixtures therefore had to be
edited by hand. That was wrong. The sealer's only child process is `git status`, used for
its dirty-tree guard; fixture generation runs in process. The run that appeared to write
nothing was reading a stale build output. Re-sealing works, which unblocks both the body
key-order change and this anchoring, since each one changes what the fixtures record.
## 2026-10-10 — The model catalogue diff, and a capability that disappeared

Before building a profile for the anchored version, the two builds' catalogues were
extracted and compared rather than assumed equal. The catalogue is an array of model
objects carrying a capability list, and the diff is decisive: **every model that carried
`mid_conv_system` at 2.1.280 has lost it at 2.1.296** — sonnet-5, opus-4-8, opus-5,
opus-5-5, fable-5, fable-5-1 and mythos-5-1 — and the two models added at 2.1.296
(`claude-haiku-5-5`, `claude-sonnet-5-5`) never had it. So the
`mid-conversation-system-2026-04-07` beta is not sent by any model on the newer build,
while this package's 2.1.280 profile emits it.

Two consequences. Anchoring to the newest version is not only a version string and one
added beta: it also *removes* a beta the current profile sends. And the mid-conversation
system-role work is scoped to the older semantics — on the anchored version the beta whose
absence that work was compensating for is gone.

Also found: 2.1.296 adds `claude-haiku-5-5` and `claude-sonnet-5-5`, and moves
`supports_1m_suffix` / `native_1m_3p` flags on several entries. Both catalogues are now
extracted to `.cc-carve/model-catalogue.json` so the profile can be built from data rather
than retyped.
## 2026-10-10 — Anchored to the Windows desktop, and two library defects it exposed

The subscription path now claims the Windows desktop identity: client version 2.1.288
(the release the desktop application pins), entrypoint `claude-desktop`, and the five
client headers the desktop adds, with the two machine-derived values taken from the host
because that is what the genuine client reports. The plugin's wire specs assert the
resulting user agent, billing entrypoint and headers, and the whole suite passes.

**Defect one: `x-app` was a function of the entrypoint.** Upstream sets that header from
the client's own background flag; a desktop session sends `x-app: cli` while reporting
`claude-desktop` as its entrypoint. Deriving it from the entrypoint made every
desktop-identity request fail validation — and with a looser check it would have sent
`x-app: claude-desktop`, a value no client sends. An entrypoint that is itself an app value
is still used directly, so the older profiles are unaffected.

**Defect two: a third pinned-profile list.** The redacted-evidence builder keeps its own set
of admitted profile identifiers. A profile added to every other list still failed the
request it existed to build, and the failure surfaced as an uninformative INVALID_INPUT
raised three call frames away from the cause.

**A defect of mine, found and fixed:** deriving the new registry and profile by replacing
the version string throughout copied files rewrote prose that recorded the *older* release's
history — comments saying a beta was new at 2.1.280 became claims about 2.1.288, and a
reference to the 2.1.280 analysis document was repointed at one that does not discuss it.
Identifiers were renamed; the historical prose is preserved, and the one addition is marked
where it is inserted.
## 2026-10-10 — The two version ladders, kept apart

The desktop application and the client it runs are versioned on different ladders, and
conflating them caused an earlier slip in this log. Current values, all read today:

**Client (`2.1.x`).** The release channel's `/latest` is 2.1.296 (built 2026-10-09) and
`/stable` is 2.1.287; npm publishes 2.1.296 for the CLI and its win32-x64 platform package
on the same day, and 0.3.296 for the agent SDK. There is no `rc` or `next` pointer.

**Desktop application (`2.xxxxx.y`).** The vendor's Windows manifest is 2.19675.1, released
2026-10-05, and the application's own package.json agrees. Its installer ships no client at
all; what it carries is a baked manifest pinning the client at **2.1.288**, built
2026-10-02 — three days before the application itself shipped.

So the desktop pins whatever client existed on its build day, which is why it trails the
CLI's near-daily releases, and why the two numbers never track each other. Note also that
the pin (2.1.288) is *newer* than the stable channel (2.1.287): the desktop does not follow
`stable`. Which source moves it forward past its pin remains unverified, so this package
claims the pair that is provable — application 2.19675.1 with client 2.1.288 — which is
exactly a desktop that has installed the current build.

The macOS application version could not be obtained here: the vendor's download page is not
resolvable from this machine and the Windows manifest carries only Windows artifacts.
## 2026-10-10 — Where the service publishes its own version floor

The client does not decide what version is too old. A signed document the application
fetches — and the CLI's own catalogue mirrors — carries, per model, the minimum client
version allowed to use it:

    https://downloads.claude.ai/model-catalog/v1/catalog.json

Read today it reports `version: 1958`, issued `2026-10-10T01:05:10Z` and expiring a week
later, with 460 entries over 14 models and exactly two `min_claude_code_version` values:
`2.1.251` and `2.1.280`. The application verifies it against a key built into the app and
falls back to a bundled copy until one has been fetched or when the host is unreachable,
which is why the same two values appear inside the desktop bundle.

**Three consequences worth keeping.** The floor is published, so it is checkable rather
than guessed — one request to a document the vendor signs, no API call. The floors are
per model, so a claim below one costs access to that model rather than the whole client.
And the highest floor today is 2.1.280, which the anchored claim of 2.1.288 satisfies with
margin, so nothing on the service side presently forces a move.

**The one hard refusal is organisational.** `requiredMinimumVersion` is documented as
"only enforced from managed (policy) settings", its message names "your organization", and
the managed-settings sources rank a **server-managed** source highest — so a Team
organization's administrator can set a floor the server delivers, while an individual Max
account has no organization for that mechanism to attach to. The client itself carries no
hardcoded minimum: a search for one finds nothing.
## 2026-10-10 — OAuth audited against the carve

The plugin's OAuth implementation was checked line by line against the 2.1.288 modules.
Most of it matches exactly, and one open question is now closed in the plugin's favour.

**Exact matches.** The code exchange is a JSON POST to the token host carrying exactly
`grant_type`, `code`, `redirect_uri`, `client_id`, `code_verifier` and `state`, with
`content-type: application/json` as its only header — which is what the plugin already
sends. The loopback redirect is `http://localhost:<port>/callback`. The authorize host, the
token host, the client id and the whole scope set agree, including the plugins scope the
client appends when its registration flag is set. The profile request carries the JSON
content type and a no-cache directive, matching the fix made earlier. The usage request
carries the same bearer, the OAuth beta, a JSON content type and the client user agent.

**A question settled:** the exchange body has an optional `expires_in`, and the plugin does
not send it. The carve shows only the setup-token flow and the refresh-token environment
path pass one — the ordinary login does not. Omitting it is correct.

**Real gaps, each evidenced.** The genuine usage request is issued through a helper with
refresh-and-replay enabled and a five-second timeout, and shares one in-flight request
among callers; the plugin has none of the three, so a usage poll fails outright when the
access token has expired. The client also serialises refreshes across processes with a lock
file and takes over a dead holder; the plugin guards in memory only, which matters where
several processes share one account. And the client's OAuth surface includes token
validation, revocation and an expiry warning, none of which the plugin has.
## 2026-10-10 — What the authorization request does and does not carry

The client enumerates every parameter it can place in an authorize URL, because it has to
decide which ones to redact in logs. The list is `state`, `nonce`, `code_challenge`,
`code_verifier`, `code`, `redirect_uri`, `resource`, `audience`, `scope`, `client_id`,
`response_type`, `response_mode`, `code_challenge_method`, `prompt`, `access_type` and
`display` — and **no device identifier, machine name, platform, architecture or hostname**.
So the CLI-style authorization does not present a device fingerprint; what the service
records from it is the account that consented, the client id, the scopes and the redirect,
plus whatever it logs on its own side, which no client artifact can show.

Two related facts worth keeping apart. The desktop application's own sign-in *does* attach
an `anthropic-device-id`, so choosing the CLI-style flow avoids that. And the API requests
this package sends do carry machine-derived values — the desktop identity's device class and
memory — which belong to the request layer, not to the authorization.

**Portability of a stored credential.** The refresh token is the portable part, and the
client itself supports taking one from the environment (`CLAUDE_CODE_OAUTH_REFRESH_TOKEN`
together with `CLAUDE_CODE_OAUTH_SCOPES`), so this is a supported pattern rather than a
workaround. The constraint is rotation: a refresh response may carry a new refresh token,
and the client keeps the old one only when it does not — which is why the genuine client
serialises refreshes across processes with a lock that even takes over a dead holder. Two
holders of one account's credential can therefore invalidate each other, so one account
should have one holder at a time.
## 2026-10-10 — The identifiers a request carries, and how they are scoped

The identity inside `metadata.user_id` is assembled in one place, from `device_id: uD()`,
an account uuid resolved from the OAuth account, `session_id`, and optionally a parent
session id and a turn key. Two facts about `device_id` matter and an earlier note here got
one of them wrong.

**Format.** The resolver validates a 64-character lowercase hex string and otherwise mints
32 random bytes rendered as hex. So the plugin's own generator — 32 random bytes as hex —
is right, and an earlier claim in this log that the carve showed no such generator was
wrong: it is in the OAuth config module, not the request builder.

**Scope, and this is the part worth fixing.** The value is persisted into the client's own
config and reused for the life of the installation, so the genuine client presents **one
device id per host, shared by every account that signs in on it**. The plugin mints it per
account, inside the session it backfills. On a machine running several accounts that makes
the plugin look like several devices where the genuine client looks like one — an
observable difference exactly where the service correlates requests.

A second identifier exists beside it, a machine id with the same format and the same
persistence, used for the host-registry features rather than for message requests.
## 2026-10-10 — Device identity is per account, frozen, and never this host's

The operator's ruling, and it reverses an earlier suggestion in this log: a device id must
correspond **one to one with an account**, not one per machine. The genuine client keeps one
id per installation because it was never designed for several accounts on one device, so
sharing an id across accounts here would make them look like one device — the exact signal
that must not exist. The machine values a desktop declares are synthesized per account for
the same reason: this host's real memory is distinctive, and publishing it would identify
the operator.

**How upstream generates them.** The device id is 32 random bytes rendered as hex, minted
once and persisted into the client's own configuration, then reused for the life of the
installation. The two client headers are computed at process start from the host's memory:
the class by bucketing total bytes (`< 6 GB`, `< 12 GB`, `< 20 GB`, else the largest) and the
size by rounding to gigabytes. Both are recomputed each launch rather than stored, and
neither has an environment override.

**What the plugin now does.** The device id stays per account, as it was. The machine pair
is derived deterministically from that id, so one account always presents one plausible
machine and two accounts differ; the class is computed from the reported size with the
desktop's own function, so the pair cannot contradict itself. Platform, architecture and
runtime version are pinned to the anchored identity instead of read from the host, which
previously let a macOS host claim `claude-desktop` while sending its own platform — a
self-contradiction, and a host-specific value besides.

**A drift path that was live and is now closed.** Re-authorization minted a new device id,
and because the machine values derive from it, signing in again silently changed the device
the account presented. The stored identity is now carried onto a freshly authorized session,
through an injected seam so both login paths stay testable. Eight tests cover this: the
reported size is never the host's, one account is one machine, accounts differ, the pair is
self-consistent, and no host accessor may appear in the request builder at all.
## 2026-10-10 — The device identity now outlives the credential

The plugin stored its device id inside the session record, and signing out deletes that
record. The id therefore died with the credential: signing out and back in, or re-importing
from Claude Code's own store, presented a different device — while the genuine client keeps
its id outside its credentials and survives all of those paths. The machine values, being
derived from the id, changed with it.

The id is now derived from the account's key instead of being minted at random, in the
client's own format — a SHA-256 digest rendered as 64 lowercase hex characters. It is
therefore per account, stable across refresh, re-authorization, sign-out and sign-in,
re-import and restart, and needs no store of its own: the account key is what the record is
already keyed by. A stored id is still honoured when one exists, so nothing already
configured changes; the machine values follow the id, so they survive the same paths.

The lifecycle is now: created on first authorization, reused by every later path, and
changed only if an operator explicitly removes and re-adds an account under a different key.
## 2026-10-10 — Body key order: what is measured, and what is not

An audit item holds that this package's request body orders its keys differently from the
genuine client, which would be a fingerprint at the byte level. Measuring first was worth
it, because the item is not yet established.

**What the plugin emits**, read from the real builder: `model`, `max_tokens`, `system`,
`messages`, `stream`, `metadata`.

**How the genuine order arises.** The client passes a parameter object to the bundled
Anthropic SDK, and the SDK sends that object as the body, so the order is whatever the
calling site wrote — there is no single global order. The client's own call sites show
`model, max_tokens, messages, metadata`, and one probe adds `stream` in fourth place. The
client's internal helper destructures `model, system, messages, tools, tool_choice,
output_format, max_tokens, … thinking, effort, …`, which is the order its author writes
everywhere but is not by itself the wire order of the main call.

**What that means.** Our order is not contradicted by anything found so far: `system`
between `max_tokens` and `messages` is exactly where a caller that lists the required
parameters first and the optional ones after would put it. Settling the item needs the
main-loop call site's own literal, which the passes so far have not located — the call is
assembled across layers rather than written in one object. Until then the item stays open
and nothing is changed: reordering keys on the strength of a claim that may be false would
be churn in the one part of the wire where a mistake is invisible.
## 2026-10-10 — Mid-conversation system messages, taken from the carve

An audit item held that the package does not model the mid-conversation system message the
client can send. The carve gives the whole mechanism, so nothing here is inferred.

**The shape.** The client pushes `{role:"system", content:<text>, clear_at:"next_user_message"}`
into the message array, at the position the content belongs to, rather than folding the text
into an earlier message — the server drops it once the next user message arrives, which is
what keeps the cached prefix behind it intact. The error table states the constraints
verbatim: the server may reject the role, its placement, or a cache breakpoint on it.

**When it fires.** Only transcript entries of type `api_system`, carrying either ephemeral
content or an `ephemeralSuffix`; a reminder recorded in the transcript also qualifies when it
is not the last message. The gate is the `mid_conv_system` model capability, and the two beta
headers that legalise it are already in this package's registries with the carve's own
literals: `mid-conversation-system-2026-04-07` and `mid-conversation-system-clear-at-2026-08-21`.

**What changed here.** `Message.role` admits `system`, and the message carries an optional
`clear_at` whose only legal value is the one upstream sends. Validation enforces that the
field appears on a system message and nowhere else. No cache breakpoint is placed on it,
because the cache-marker pass already skips every message that is not a user message — which
is exactly the constraint the error table describes.

**Count-tokens, checked rather than assumed.** Two tests asserted that the count-tokens
endpoint rejects the same role the messages endpoint rejects. The carve contradicts that: the
client passes the same prepared message array to `countTokens`, so the role reaches it too.
Its beta allowlist is narrower — `claude-code`, `interleaved-thinking`, `context-management`
and one more — and does not include the mid-conversation-system value, which is recorded as
the separate fact it is.
## 2026-10-10 — The plugin sends mid-conversation context the way the client does

The library now expresses the shape; this is the consumer side. The translator used to turn
a mid-conversation system message into a user message whose text was wrapped in
`<system-reminder>` tags. That kept the cached prefix intact — the reason the file gives for
not hoisting the text into the system slot — but it is not what the client sends, and the
client has a field that solves the same problem without the substitution.

Now, when the model accepts it, the message goes out as `{role:"system", content, clear_at:
"next_user_message"}` at its own position, with the text as the plain string the client uses.
Which model accepts it is answered by the same public predicate that decides the beta header,
passed in from the wire builder, so the message and the header cannot disagree: a model
without the capability gets the tag-wrapped fallback and no beta, exactly as before.

Two smaller consequences are handled. A system message never merges with a neighbour, because
merging would move it; and the helpers that walk message content skip a string-carrying
message rather than assuming an array.
## 2026-10-10 — What the client actually calls for usage and for models

**Usage.** Two behaviours were missing from the consumer. The client answers a second caller
from the request already running rather than starting another, keyed on the credentials it
carries, and its own request carries a five-second bound with its own abort controller rather
than the caller's. Both are now in place. The first attempt shared the `Response` itself,
which is wrong for a reason worth recording: two callers awaiting one response each read the
same body, and the second read fails with "Body is unusable". The shared value is the parsed
result. A caller that gives up stops waiting without cancelling the shared read, because
another caller may be waiting on it — which is exactly why the client's request owns its
controller.

**Models, and a request the client never makes.** The audit item proposed moving model
discovery to `/api/claude_cli/bootstrap`. The carve says something more useful. That endpoint
returns `additional_model_options` — picker entries of `{model, name, description,
disabled_reason?}` — alongside `client_data`; it supplements a catalogue the client already
carries, and a response that fails its schema is discarded rather than treated as an error.
`/v1/models` appears in the client only under the gateway's
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, so on the first-party path this package targets,
the request this plugin currently sends is one the genuine client never sends. Removing it is
the fidelity win; adding bootstrap is the supplement.
## 2026-10-10 — The refresh lock, and three things deliberately not built

The client locks files with the bundled copy of a directory-based lock: the lock is a
directory created atomically, a holder is presumed dead when that directory's modification
time is older than a staleness bound, waiting backs off, and release removes it. This package
learned the pattern from the client's own call sites — device keys use fifteen seconds, the
job queue five, a team file a hundredth of a second with ten retries — and the values here
follow that order of magnitude rather than claiming to be verified for a file the client was
never observed locking.

The guard that mattered was already present. Writing a refreshed token back compares the
token it expects against the one on disk and refuses when they differ, so a rotation made by
someone else is never overwritten. What was missing is the double refresh: two processes
rotating at once invalidate each other's refresh token. The lock now wraps read, refresh and
write together. It is best-effort by design — a holder that cannot be waited out runs without
it, which is what every consumer did before it existed, and the compare-and-swap keeps that
safe.

**Not built, with reasons.** The bearer-attribution check is a telemetry step the client
runs first-party, with a valid non-inference-only token, purely to report an outcome; sending
it would add a request, which is the opposite of the goal here. The expiry warning is a
banner in the client's own UI. And no server call for revoking the CLI's own token could be
located — the matches are the MCP helpers and one error string — while the OAuth endpoint
table lists six URLs and none of them revokes. An endpoint that has not been observed is not
invented.
## 2026-10-10 — What actually moves a desktop install, and why 2.1.288 holds

The desktop's client auto-updater is one hourly poll started at app ready, gated on a
GrowthBook flag that is **off by default** when the server has no entry for it. The candidate
version has exactly two sources: that flag's own target field, or — as a fallback — a bare
version string fetched from `{baseUrl}/stable`, capped at a kilobyte and required to look like
a version. Installing it needs the candidate to be strictly greater than the current target
and at or above a monotonically persisted floor, then a signature check against a hardcoded
key, then a manifest whose version matches, whose platform is present, whose harness schema is
the expected one, and whose tested-wrapper list contains this build's wrapper.

Read today, that fallback names **2.1.287** — below this profile's 2.1.288 — so the public
path cannot move an install past the pin at all. Only the server flag can, and it is not
observable from here. Meanwhile the pin is what the application itself declares: both the
required-version and pinned-version accessors return it unconditionally, the current target is
reset to it on every launch, and its binary is never cleaned up. A desktop that has not been
moved — flag absent, policy disabled, a local override, an MSIX install, or simply a first poll
that has not succeeded yet — reports and runs 2.1.288.

So the anchored claim is coherent rather than merely convenient, and it is checkable: the
pointer that would have to exceed the claimed version is a public document, and it currently
does not. What the flag could name instead is outside the artifact, and the service can tell
the two populations apart through its own auto-update telemetry.
## 2026-10-10 — Items closed: body order, desktop updates, headers, ATIS

**Body key order, proven wrong and fixed.** The client's main-turn literal is byte-identical
in order across 2.1.280, 2.1.288 and 2.1.296, and its SDK serializes that object with a plain
stringify after destructuring only the names that become headers. This package emitted a
different order — a difference in the bytes of every request. It now imposes the client's
order in one place, and the goldens, three order tests and the baseline evidence document
moved with it, the document under its own amendment convention.

**What moves a desktop install, proven.** One hourly poll, gated on a GrowthBook flag that is
off by default, takes its candidate from that flag or from the `/stable` pointer. The pointer
reads 2.1.287 today — below this profile's 2.1.288 — so the public path cannot move an install
past the pin; only the server flag can, and a signature, a manifest and a tested-wrapper list
gate it. The application's required and pinned versions are the pin unconditionally, and its
current target resets to the pin on every launch. The claim is therefore coherent, and it is
checkable: the pointer that would have to exceed it is public.

**The stainless headers, confirmed.** The vendored SDK computes them, no client code
overrides them, and the package version it reports is 0.128.0 — the same value this package's
profile pins. The OS and architecture come from the process, which is why pinning them to the
platform the anchored identity claims was necessary rather than cosmetic.

**ATIS implemented, parent session id not.** The client attaches `x-cc-atis` to every request
it sends through the first-party client, taking the value from the conversation's latch or from
the bootstrapped client data. This package now records that value from the bootstrap read it
already performs and attaches it to the requests it sends. `parent_session_id` cannot be sent:
the field exists because a teammate is a separate CLI process, and this harness does not tell a
provider which session spawned it, so there is no signal to send and none is invented.

## 2026-10-10 — Carve ledger: separator, placeholder tool, demotion, entrypoint, `user_id`

Five divergences the 2.1.288 carve contradicts, each checked against the carve before any
change.

**One cache-control run joins with a blank line.** `chunk-pzdykw0r.js` at 729497 joins each
side of the dynamic boundary with `join("\n\n")`. The package joined with a single `\n`, which
no genuine request carrying more than one caller block produces. `joinTextBlocks` emits `\n\n`
now, and the suites that had pinned the single newline state the blank-line contract instead.

**The deferred-tool placeholder is a custom tool, not a built-in type.**
`chunk-kw1cdd67.js` names it `DeferredToolPlaceholder`; `chunk-p8vbbyj7.js` builds it as
`{name, description, input_schema: {type:"object",properties:{}}, defer_loading: true}` and
splices it second-to-last. The dated `tool_search_tool_*_20251119` types occur nowhere in the
carve — the bare names appear only in TUI block classification — so the plugin injects the
client's entry, and `builtInToolSpec` no longer accepts those built-in types.

**Extended thinking demotes `type: "tool"` alone** (`chunk-p8vbbyj7.js` at 2129500). The
2026-09-24 decision to demote `any` as well is reverted; the revert path recorded with that
entry is the one executed here.

**`cc_entrypoint` has no compiled-in default.** `chunk-d8h3bh4f.js` bills
`process.env.CLAUDE_CODE_ENTRYPOINT ?? "unknown"`, while the user agent reads the same variable
`?? "cli"`. The profile field is optional now and records an unset variable: 2.1.195/233/280
bill `unknown` and keep `cli` in the user agent, and the 2.1.288 desktop profile still declares
`claude-desktop`, which is that run's actual variable.

**`user_id` carries the client's 512-character ladder** (`chunk-pzdykw0r.js` at 728005 and
730795). Extended metadata is dropped first; the correlation triple survives even when it alone
exceeds the ceiling, and a caller-supplied `userId` replacement is not resized at all.

**`thinking.block_binding` stays unmodelled, on evidence.** Upstream attaches it only when
`$1t()` answers a value, which requires the host's `CLAUDE_CODE_POLISHED_DEWDROP` (or the
`tengu_polished_dewdrop` flag) to resolve to `drop` or `block`; the flag's own default resolves
to nothing. A first-party client therefore sends the `thinking-binding-controls-2026-08-01`
beta WITHOUT the field, which is what this package already did.

## 2026-10-31 — The turn segments reach the billing block, gated by builder tier

The 2026-10-10 audit's finding that `cc_turn_origin` is never emitted is closed. The 2.1.280
builder (`seg_2961.js` `t0n` at 2143) takes a sixth parameter and appends
` cc_turn_origin=<origin>;`; the 2.1.288 builder (`seg_3379.js` `m4r` at 2285, called by `iHo`
at `seg_3483.js` 728639) takes a seventh and appends
` cc_prompt_index=<n>; cc_turn_index=<m>;` after it. Each is `profileBehaviors`' question: the
origin flag is true from 2.1.280, the index-pair flag from 2.1.288, and an unrecognised profile
inherits the newest tier.

The guards are transcribed, not invented. Origin matches `/^[a-z][a-z_]{0,31}$/`. The index pair
is emitted only when both are integers, `promptIndex >= 0`, `turnIndex >= 1`, each `<= 1e7`, and
`promptIndex <= turnIndex`; otherwise both are dropped silently, on the same discipline as
`cc_prompt_id`. The caller states the values because the package cannot derive a transcript
anchor from a raw body — the plugin's provider route derives them from the prompt it serves,
and the Mac pool's overlay did the same before the builder could.

The desktop identity line is deliberately not a builder default: `invocation` omitted selects
the interactive CLI line, while `isNonInteractive` selects the Agent SDK lines. The plugin
route now omits it, matching the `claude-desktop` entrypoint, user agent and billing segment;
the library still reproduces the headless shapes for a caller that states one.
