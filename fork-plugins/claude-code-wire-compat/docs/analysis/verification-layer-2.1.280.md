# Verification layer of Claude Code 2.1.280 — code-derived facts

**Source:** carved from `@anthropic-ai/claude-code-win32-x64@2.1.280`
(`claude.exe`, 226.1 MB), 2026-10-10. Everything below is read out of the
carved JavaScript. Nothing here is inferred from a capture; the captured
reference request in
[`http-headers-and-system-prompt.md`](../protocol/http-headers-and-system-prompt.md) serves
as cross-validation only.

**Scope:** the surfaces a server can use to decide whether a request really came
from the genuine client — the attribution (billing) block, the identity line,
the runtime identity headers, and the attestation-shaped headers. Transport
mechanics (TLS, header serialization) are covered by
[`../plans/2026-10-10-subscription-transport-masquerade.md`](../plans/2026-10-10-subscription-transport-masquerade.md).

## 1. The attribution block is system-prompt content, not a header

The block whose text begins `x-anthropic-billing-header:` is assembled into the
**system array**, first, with `cacheScope: null`; the identity block follows with
`cacheScope: "org"`, and the reporting-outcomes block (when present) follows
that. The system-prompt hasher filters the attribution block out by prefix, which
is only necessary because it travels as system content.

```
// shape, as read from the builder and the system-prompt assembler
ve.push({ text: <attribution block>, cacheScope: null })
ve.push({ text: <identity line>,     cacheScope: "org" })
if (<reporting block> && <attribution> && <identity>) ve.push({ text: <reporting block>, cacheScope: null })
```

Consequence: a client that emits the attribution text anywhere else — a header,
a later block, a different cache scope — diverges structurally, not merely in a
value.

## 2. The attribution block's contents and gates

```
x-anthropic-billing-header: cc_version=<VERSION>.<suffix>; cc_entrypoint=<entrypoint>;[ cch=00000;][ cc_workload=<id>;][ cc_is_subagent=true;][ cc_prev_req=<id>;][ cc_prompt_id=<uuid>;][ cc_turn_origin=<origin>;]
```

| Segment          | Gate                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `cc_version`     | always; `<VERSION>` is the build version, `<suffix>` a value the caller supplies                                   |
| `cc_entrypoint`  | `process.env.CLAUDE_CODE_ENTRYPOINT ?? "unknown"` — note **`unknown`**, while the user-agent defaults to **`cli`** |
| `cch`            | first-party provider (plus one internal predicate) **or** vertex                                                   |
| `cc_workload`    | a workload id is present                                                                                           |
| `cc_is_subagent` | the session is not the main session                                                                                |
| `cc_prev_req`    | the value matches `/^req_[A-Za-z0-9_-]{1,36}$/`, first-party                                                       |
| `cc_prompt_id`   | the value is a strict UUID, first-party                                                                            |
| `cc_turn_origin` | the value matches `/^[a-z][a-z_]{0,31}$/`, first-party                                                             |
| whole block      | omitted when `CLAUDE_CODE_ATTRIBUTION_HEADER` opts out                                                             |

## 3. The identity line is one of three literals

```
i = "You are Claude Code, Anthropic's official CLI for Claude."
u = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
f = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
```

Selection: vertex → `i`; a recorded value → that value; non-interactive →
`u` when an appended system prompt is present, otherwise `f`; all other cases →
`i`.

## 4. The CCH is a literal, sent unchanged (code-closed)

The builder inserts the literal ` cch=00000;`. **No path in the bundle rewrites
it.** This was closed by exhaustive enumeration rather than by a capture:

1. `cch=00000` occurs **exactly once** in the carved bundle — at its construction
   site. No regex, no `replace`, and no body-mutating function touches it.
2. `KP(e) = Bun.hash(JSON.stringify(e)) & 0xffffffff` exists in the same module,
   but all of its genuine call sites hash something else: attachment/part hashes,
   a feature-sampling ratio, the system/tools hash map, and cache diagnosis.
   Three further textual matches are name collisions — a UTF-8 decoder, a React
   component, and an RC2 implementation — not this function.
3. Every consumer of the billing text either detects it by prefix (block
   assembly), excludes it from hashing (`!p2(...)`), or reads it verbatim to carry
   it forward. None rewrites it.
4. There is no post-serialization hook: no `.replace` on a serialized body, and
   no body-patching function in the bundle.

**Consequence:** a client that emits `cch=00000` matches the genuine client. The
older `fingerprint-extraction.md` note describing a `computeAndReplaceCCH()` step
does not apply to 2.1.280 and should be read as version-scoped.

**Residual uncertainty, stated rather than hidden:** this is an
absence-of-evidence conclusion. A rewrite confined to native code, or to a module
whose source is absent from the carve, would not have been seen. The carve
threshold was 200 bytes over the whole 226 MB artifact, so the second case is
unlikely; the first cannot be excluded from the bundle alone.

**Resolved — the gate is about the endpoint, not the account.** The condition's
second predicate reads, in full:

```
function ms(){ if (CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL) return true; return hS() }
function hS(){ let e = process.env.ANTHROPIC_BASE_URL; if (!e) return true; return yS(e) }
function yS(e){ try { return ["api.anthropic.com"].includes(new URL(e).host) } catch { return false } }
```

So `cch` is emitted when the provider is first-party **and** the request targets
the real `api.anthropic.com` host (or the assume-flag is set). Any base-URL
override — including a local test endpoint — silently removes the field. This
also explains a captured request that lacked `cch`: that capture pointed
`ANTHROPIC_BASE_URL` at localhost, which is precisely the condition that
suppresses it. Account type is not involved.

## 5. Attestation-shaped headers

| Header                              | Evidence                                                           | Reach                                                |
| ----------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| `x-cc-atis`, `x-cc-atis-current`    | a `v1.<token>.<…>` value with a refresh interval and feature gates | present when the source of the value is configured   |
| `x-anthropic-additional-protection` | set to `"true"` when an environment variable is present            | user opt-in                                          |
| `x-claude-code-signature`           | JWS with `x5c` chain validation                                    | cloud/worker paths only; not the direct Messages API |
| `metadata.user_id`                  | carries a `tk` field the client strips and re-serializes           | always, when metadata is sent                        |

## 6. Packaging caveat

The carved bundle carries a `// @bun @bytecode` marker while a `Bun.bytecode`
substring count returns zero. Some modules may therefore execute from bytecode
with their source text still embedded. Behavioural claims derived from reading
the carve are provisional until this is resolved.

## 7. The `cc_version` suffix is a deterministic sample of the first user message

```
var SALT = "59cf53e54c78";
function firstUserText(messages) {          // first non-meta user message, first text block
  let n = messages.find(s => s.type === "user" && !s.isMeta); if (!n) return "";
  let r = n.message.content;
  if (typeof r === "string") return r;
  if (Array.isArray(r)) { let s = r.find(g => g.type === "text"); if (s) return s.text }
  return ""
}
function suffix(text, buildInfo) {
  let sampled = [4,7,20].map(i => text[i] || "0").join("");   // characters 4, 7 and 20
  return sha256(`${SALT}${sampled}${buildInfo}`).digest("hex").slice(0,3)
}
```

The observed value `cc_version=2.1.280.d7b` matches the three-hex-character
shape. The suffix therefore depends on the conversation's first user message,
the salt constant, and the build-info object — all three are reproducible, and a
client that emits a fixed suffix diverges on every conversation whose first user
message differs at those three positions.

## 8. Identity configuration decision (2026-10-10)

**Decision: imitate the default CLI identity, not a different client.**

| Item                     | Chosen value                                    | Evidence                                                                                                                                                  |
| ------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_ENTRYPOINT` | **`cli`** (the default)                         | `JM()` composes the user-agent as `claude-cli/<VERSION> (external, ${ENTRYPOINT ?? "cli"})`; `cli` is therefore the most common identity by construction  |
| `x-app`                  | `cli` — **not adjustable**                      | the request-header object sets `"x-app": Tt() ? "cli-bg" : "cli"` unconditionally; only those two values exist                                            |
| `x-stainless-runtime`    | `node` — **not adjustable**                     | the SDK's identity function returns the literal `"node"`                                                                                                  |
| identity line            | **headless form required (open action)**        | `YAn()` selects: vertex → `i`; recorded → recorded; non-interactive → `u` when an appended system prompt is present, otherwise `f`; all other cases → `i` |
| `x-client-request-id`    | **remove from the Messages path (open action)** | absent from the genuine request-header object; the name appears on the response side and in the bundled local proxy                                       |
| transport                | **Bun-side request issuance**                   | undici/Node cannot reproduce the ClientHello, the runtime version self-report, or the header canonicalization the genuine client produces                 |

**Why not a "more human" entrypoint.** The recognized values include
`claude-desktop`, `claude-desktop-3p`, `local-agent`, `claude-vscode`, the IDE and
CI variants, and the `sdk-*` family. Choosing one of them would not make the
traffic more human-like, and it would introduce an internal contradiction: every
request carries `x-app: cli`, so a desktop or IDE user-agent would appear beside a
CLI app marker in the same request. Interactivity is not observable by the API at
all — `is_interactive` exists only in the telemetry event schema and in launch
options, never in a Messages request. Human-likeness is therefore a property of
behaviour (cadence, session continuity, absence of bursts), not of the entrypoint.

**Why the desktop path was rejected on surface area.** The entrypoint gates
(`mc`, `gDe`, `hDe`, `srn`) were traced: they govern host management, managed
settings, permission handling, and one telemetry attribute — none of them touches
the request body, the system blocks, or the beta set. Claiming a desktop identity
would add two wire fields (`anthropic-client-platform: desktop_app` and
`anthropic-client-version`) that must then be filled plausibly, for no gain.

**Open actions, in order:**

1. `src/system-prompt.ts` carries a single hardcoded identity line
   (`You are Claude Code, Anthropic's official CLI for Claude.`, the `i` form).
   It must carry all three literals and select by invocation mode, so a headless
   caller sends `f` (or `u` when an appended system prompt is present). Today a
   headless caller sends the interactive form.
2. The plugin must drop `x-client-request-id` from the Messages path.
3. The transport moves to the Bun-side bridge; nothing in this section changes
   because of it.

## 9. Exposure audit, verified gaps, and fixes (2026-10-10)

Everything below is derived from the carve index. Each gap carries the evidence
that establishes it and the fix that closes it. Nothing here is a capture-derived
inference.

### 9.1 Proven gaps

| #   | Gap                                                                                                                             | Evidence                                                                                                                                                                                                                       | Fix                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1  | **Transport stack** — Node/undici TLS and `x-stainless-runtime-version` reporting the host Node version                         | the Stainless identity function returns `globalThis.process.version`; the golden fixture carries `v24.15.0` where the genuine client carries Bun's `v26.3.0`; the ClientHello differs                                          | issue the request from Bun's `fetch` (the Bun-side bridge). One change aligns TLS, header canonicalization, connection behaviour and the runtime self-report |
| G2  | **Identity line is the interactive form** — a headless caller sends `You are Claude Code, Anthropic's official CLI for Claude.` | `YAn()` selects: vertex → `i`; recorded → recorded; non-interactive → `u` when an appended system prompt is present, otherwise `f`; other → `i`. `src/system-prompt.ts` hardcodes `i`                                          | carry all three literals and select by invocation mode; headless sends `f` (`u` with an appended system prompt)                                              |
| G3  | **`x-client-request-id` is sent on Messages requests**                                                                          | absent from the genuine request-header object; the name appears on the response side (reading it off an API error) and in the bundled local proxy                                                                              | drop it from the Messages path                                                                                                                               |
| G4  | **Reporting block missing from the system array**                                                                               | `IQe` (`# Reporting outcomes …`) lives in the same standard-prompt module as the three identity literals; the system assembler gives it a dedicated slot and emits it whenever the attribution and identity blocks are present | emit the block between the identity block and the host prompt, without a cache breakpoint                                                                    |

### 9.2 Verified as already correct

- **`cch=00000`** — no rewrite path exists; the gate (`firstParty && ms()`, or
  vertex) is about the endpoint, not the account.
- **Attribution block placement** — first system block, no cache breakpoint,
  followed by the identity block.
- **`cc_version` sampling** — `sha256(SALT + text[4] + text[7] + text[20] + buildInfo).slice(0,3)`,
  already implemented by the plugin.
- **`metadata.user_id` base shape** — `{device_id, account_uuid, session_id}` is the
  genuine base case; `parent_session_id` is added only when a parent session exists
  (`vv()` resolves to the parent session id).
- **Beta registry** — entries are `{name, header}` pairs: `claude_code` →
  `claude-code-20250219`, `oauth_auth` → `oauth-2025-04-20`,
  `interleaved_thinking`, `long_context` → `context-1m-2025-08-07`,
  `context_management` → `context-management-2025-06-27`, `structured_outputs`,
  `web_search` and others. The plugin's emitted list matches on the entries checked.
- **ATIS is off by default** — `x-cc-atis-current` is a **response** header the
  client reads to refresh an attestation; the whole path is gated by the
  `tengu_expressive_whistle` flag, whose default is false. Absence is correct.
- **Gateway-hint, remote-container/session, client-app, additional-protection**
  headers — conditional, correctly absent by default.

### 9.3 Unaddressed surface: tool catalogue fidelity

The genuine client ships a built-in tool catalogue — `Bash`, `Read`, `Write`,
`Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`, `List`, `NotebookEdit`, `Task`,
`TodoWrite`, `WebFetch`, `WebSearch`, `AskUserQuestion`, `ExitPlanMode`,
`BashOutput`, `KillShell`, `Skill`, `Memory`, `SendMessage`, `TeamCreate` — with
fixed names, descriptions and input schemas. The plugin forwards the host's own
tools instead, so an observer comparing the catalogue against a known client sees
a different set, and the default-path fixture sends no `tools` key at all.

This is the largest remaining difference and it is **not** a transport or
verification-layer defect; it is a product-surface decision:

1. **Accept it.** Cheapest; leaves the strongest body-level signal in place.
2. **Envelope mimicry (recommended).** For tools with genuine equivalents, send
   the Claude Code name, description and input schema, and translate the model's
   call back to the host tool. Tools with no equivalent stay host-defined.
   The wire then presents a Claude Code-shaped catalogue while execution remains
   the host's.
3. **Full catalogue emulation.** Send all entries; tools the host cannot execute
   would be advertised and then fail.

### 9.4 Still open

- The source of the `ti` field in `metadata.user_id`.
- The per-model and per-path gates that select which betas are emitted (the
  registry is known; the selection was not traced gate by gate).
- The insertion statement for the reporting block (its constant, its dedicated
  slot in the assembler, and its presence in the standard prompt module are all
  established; the exact push was not traced).

### 9.5 How non-exposure becomes provable

1. **Transport equality** — the plugin's ClientHello fingerprint must equal the
   genuine client's on the same host, measured by the existing probe.
2. **Structural equality** — replay a plugin-built request against the local
   listener and diff headers, block sequence, block count and cache-breakpoint
   positions against the genuine structure recorded here.
3. **Catalogue equality** — diff the emitted tool array against the built-in
   catalogue once 9.3 is decided.

### 9.6 Decision: the tool catalogue stays the host's

Audited option 1 is chosen: the plugin keeps sending the host's own tool
definitions and does not adopt the Claude Code catalogue (option 2) or emulate it
wholesale (option 3). The consequence is accepted explicitly — the tool array
remains the strongest body-level difference from a genuine client — and it is
recorded here so a later review reads it as a decision rather than a missed fix.
Implementation plan: [`../plans/2026-10-10-claude-part-implementation.md`](../plans/2026-10-10-claude-part-implementation.md).

## 10. Correction: `x-client-request-id` is genuine (G3 withdrawn)

Section 9.1 listed this header as a gap, on the strength of the request-header
assembly object and a capture. Both readings missed a layer.

The client's **fetch wrapper** — the closure that wraps the global fetch, one
level below the assembly — reads the header, and when the resolved provider
targets the first-party host it sets `x-client-request-id` on any request that
lacks one. The dispatcher additionally passes one per request alongside its beta
override. The header is therefore part of the genuine wire, and this package's
emission of it is correct.

The capture disagreed for a reason the code states: pointing the client at a local
endpoint makes the wrapper's first-party host gate false, so the header is never
added. The same gate suppressed `cch` in the same capture, which is why that field
was also absent.

### Consequence for transport work

The wrapper adds more than this one header. In the first-party path it also sets

- a boolean-valued flag header,
- a header whose value comes from an attestation helper,
- a header gated on host and a runtime predicate, and
- the attestation header itself where its source exists.

A replacement transport — the Bun-side bridge — bypasses this wrapper, so it must
reproduce the wrapper's header additions exactly. Matching the TLS fingerprint
while dropping these headers leaves the request short in a different way.

### Audit rule adopted

When the presence of a header is in question, locate **every** layer that can add
it: the header assembly, the transport wrapper, and the per-request options. A
single layer is not evidence of absence.
## 11. The transport wrapper's header additions, resolved

The wrapper that surrounds the global fetch adds headers the assembly layer never
sees. Resolving them from the carve gives a short list, and the list is almost
entirely conditional:

| Header | Gate | Resolved as |
| --- | --- | --- |
| `x-client-request-id` | first-party host, when the request does not already carry one | the identifier resolves to this literal in the same module as the wrapper, so the binding is not a name collision |
| `anthropic-usage-limit` | endpoint predicate **and** first-party **and** a third predicate | the value is a constant of the wrapper's own module; the value expression and the predicates are unresolved |
| `x-cc-atis` | attestation source exists (feature flag default off) | the value comes from an attestation accessor |
| two refusal-fallback headers | a model-refusal fallback occurred, or its header was armed | the gates resolve to the model-selection state accessors, so these appear only after a fallback event |

**Conclusion for a replacement transport.** On the ordinary path the wrapper adds
exactly one header, `x-client-request-id`; everything else is conditional on a
refusal fallback, a usage-limit state, or a disabled feature flag. A bridge that
reproduces the header assembly plus `x-client-request-id` therefore matches the
genuine header set for normal traffic, and the conditional headers may be treated
as "absent unless the condition holds".

**Also wire-visible in the same wrapper:** request-body gzip. When the body is a
string and the compression helper returns a positive decision, the wrapper sets a
gzip flag on the fetch options and replaces the body with a compressed one, which
reaches the wire as a content-encoding. A replacement transport must decide this
the same way rather than always sending an identity body.

**Method note.** Minified names repeat across chunks, so resolving an identifier by
name alone produced unrelated definitions for four of the identifiers above. Only
identifiers whose definition sits in the same carved segment as the wrapper are
trustworthy without import-graph resolution.
## 12. The usage-limit header, resolved

The two values left open in section 11 are now read out of the wrapper's own
segment, so neither depends on cross-chunk name resolution:

```
var USAGE_LIMIT_HEADER = "anthropic-usage-limit", USAGE_LIMIT_VALUE = "slow";

function isMessagesEndpoint(e) { try { return new URL(e).pathname.endsWith("/v1/messages") } catch { return false } }
function isFirstPartyRealHost() { return provider() === "firstParty" && hostIsRealApi() }
function isPacingActive(e = Date.now()) { try { touch(e); return state().state.phase === "active" } catch { return false } }
```

Emission therefore requires all three: the request path ends with `/v1/messages`,
the provider is first-party and the host is the real API host, and a client-side
state machine reports phase `active`. The value is the fixed string `slow`.

**Reading:** the header is a client self-report that it is currently pacing
itself, not an identity or attestation field. A client that does not implement
that state omits it, and omission is not an anomaly — the server reads it as "this
client is not asking to be slowed".

The two refusal-fallback headers the same wrapper sets are
`x-is-refusal-fallback` with the literal `true`, and `x-cc-fallback-latched-by`
with a sanitized request id (printable ASCII, at most 255 characters). Both appear
only after a fallback event or when the header was armed.

**Final wrapper table:** `x-client-request-id` is the only unconditional addition;
`x-is-refusal-fallback`, `x-cc-fallback-latched-by`, `anthropic-usage-limit` and
`x-cc-atis` are all conditional, and three of the four are conditional on states a
replacement transport does not have. A bridge that reproduces the assembly headers
plus `x-client-request-id`, and makes the same request-body gzip decision, matches
the genuine header set for ordinary traffic.