# Subscription transport masquerade — Bun stdio bridge (design)

**Status:** design only. This document records the design and its evidence; it
implements nothing. No code, no dependency, and no plugin change accompanies it.

**Goal:** make the `dsh-plugin-subscriptions` outbound HTTPS indistinguishable
from the genuine Claude Code 2.1.280 client at the _transport_ layer — TLS
ClientHello, HTTP/1.1 request bytes, and connection lifecycle — under two
operator-fixed constraints:

1. **No listening port.** The DSH host must not gain another local server.
2. **Dependency-installable.** The mechanism must arrive as an installable
   dependency, not as a hand-built artifact the operator must maintain per host.

**Non-goals (decided, with rationale):**

- **No telemetry replication.** The genuine client also posts to
  `http-intake.logs.us5.datadoghq.com` (E3). We do not replicate it. Rationale:
  the model API observes only its own endpoint, so the absence of Datadog
  traffic is invisible to the party that would act on it; only an on-path
  observer of the host's egress could see it, and that observer already sees the
  host's IP, OS, and traffic mix. The chosen posture is "send nothing, and send
  nothing anomalous" — that is, we must not emit requests the genuine client
  never emits, and we must not omit anything the API itself expects.
- **No browser impersonation.** A browser-profile TLS stack was measured and
  rejected (E7).
- **The HTTP/body layer is out of scope.** Headers, betas, billing headers, and
  the system prompt are already built by this package's profiles; the plugin
  consumes them today.
- **The mac-pool is a separate system.** It runs the genuine client inside VMs
  and shares no code or transport with the plugin; nothing here changes it.

**Architecture constraint inherited from this repository:** this package is a
pure, I/O-free library. The transport therefore does **not** belong inside it.
The bridge is proposed as a sibling artifact consumed by the plugin; this
package keeps supplying the ordered header block and body bytes it already
produces.

---

## Evidence (normative for this design)

Every claim below was measured on 2026-10-10; the raw vectors are reproduced so a
later reviewer can re-derive them without repeating the captures.

**E1 — the 2.1.280 install is a launcher, not the client.**
`npm pack @anthropic-ai/claude-code@2.1.280` yields 7 files; `bin/claude.exe` is
a 0.5 KB placeholder and `install.cjs` copies a platform binary over it:
"After this runs, `claude` execs the native binary directly — no Node.js process
stays resident." The resident client is therefore **not** a Node process, and
`engines.node` governs only the postinstall step.

**E2 — the resident binary is Bun on BoringSSL.**
The platform binary carries `bun.sh` and `BoringSSL` markers.

**E3 — capture vector (`cc-wire.pcap`, 537 packets, 22 TCP directions).**
SNI set: `api.anthropic.com` ×9, `mcp-proxy.anthropic.com` ×1,
`http-intake.logs.us5.datadoghq.com` ×1. ALPN: `http/1.1` (not `h2`).

```
JA3 = 1523504b38f0fae0d881d4b6554aac1b
ciphers (17): 1301 1302 1303 c02b c02f c02c c030 cca9 cca8 c009 c013 c00a c014 9c 9d 2f 35
extensions (13, in order): 0 23 65281 10 11 35 16 5 13 18 51 45 43
curves: x25519mlkem768, x25519, secp256r1, secp384r1
ec_point_formats: [0]   supported_versions: 3.4, 3.3
```

**E4 — Bun reproduces E3.**
Bun 1.4.2, local capture against a 127.0.0.1 listener: the same 17 ciphers in
the same order, the same 4 curves, `ec_point_formats [0]`, `ALPN http/1.1`,
`supported_versions 3.4, 3.3`. The single difference was the absent SNI
extension, because that probe dialed an IP literal rather than a hostname.

**E5 — the current transport does not reproduce E3.**
Node 24.13.0 / undici: `JA3 = e728b1b92f196b7dc056314ba5b9d3db`, 52 ciphers,
`encrypt_then_mac` present, `ec_point_formats [0,1,2]`, 8 curves. This is an
OpenSSL client claiming a Claude Code identity — a mismatch between declared
identity and stack.

**E6 — undici header fidelity is close, not exact.**
Caller-supplied header order is preserved and names are lowercased, but
`fetch()` adds `sec-fetch-mode: cors` and `accept-language: *`, which the
genuine client does not send.

**E7 — `@trishchuk/fetch` (napi-rs + BoringSSL) is the wrong tool.**
All 19 `impersonate` presets were measured. The best (chrome99/100/101/104/110,
edge99/101) still differs from E3 by 12 weighted features and **no preset
equals** the capture: the extension set and order belong to the preset, and the
five `tlsOptions` knobs cannot remove extensions. Worse for this use case, it
injects Chrome client hints (`sec-ch-ua: "Google Chrome";v="147"`, `sec-fetch-*`,
`priority`) and reorders caller-supplied headers. "Chrome's TLS plus Chrome's
headers plus `user-agent: claude-cli`" is a worse combination than the status
quo.

**E8 — Bun itself is dependency-installable.**
`npm view bun` → 1.4.2, `os: [darwin, linux, freebsd, win32, android]`, with
`@oven/bun-windows-x64`, `@oven/bun-linux-aarch64`, and the rest published as
optional dependencies. The runtime that matches E3 can therefore arrive as a
dependency rather than a manual install.

---

## Architecture

```
plugin process (Node / DSH host)
│
│  ordered header list + body bytes        ← supplied by this package's profile
│
└── transport client  ──[ stdio: length-prefixed frames ]──▶  bun bridge child
                                                              │
                                                              ├─ TLS: Bun/BoringSSL, ALPN http/1.1
                                                              ├─ request issued with Bun `fetch`
                                                              └─ response head + body streamed back
```

Responsibilities:

- **Transport client (plugin side).** Spawns and supervises one long-lived child;
  frames requests; returns a Web-stream-shaped body so the plugin's existing
  consumption (including SSE) is unchanged. Falls back to the current undici
  path when the child is unavailable, so a bridge failure degrades to today's
  behaviour rather than to an outage.
- **Bridge child (Bun side).** Issues the request with Bun's own `fetch`, so the
  handshake — SNI, ALPN `http/1.1`, cipher order, extension set and order — comes
  from the same runtime the genuine client embeds, and the response body is
  forwarded incrementally. It never listens on a socket. **Raw `Bun.connect` is
  not usable** (G1): it cannot be told to offer ALPN `http/1.1`, and its extension
  set differs from the genuine client's.
- **This package.** Unchanged. It keeps producing the ordered header list, the
  beta push order, and the body.
- **Header serialization is the runtime's, deliberately.** Bun canonicalizes
  header order and casing (conventional fields first, the rest sorted, mixed
  casing on the conventional ones). That is not a defect to correct: the genuine
  client is the same runtime issuing `fetch`, so its wire bytes carry the same
  canonicalization. Fighting it would move us _away_ from the target. This
  package's `HeaderPair[]` order remains the logical contract; its own analysis
  already records such differences as "wire-equivalent but byte-different".

Connection policy (matching E3): one connection per request, `session_ticket`
offered (BoringSSL default), no HTTP/2, no connection pooling across requests.

## Gate results (measured 2026-10-10, both platforms)

The two gates that decided the design are closed, and one earlier assumption was
corrected by them.

| Gate                      | Result                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1 — ALPN control**     | **Solved by using `fetch`.** `Bun.connect` with `tls.alpnProtocols`, `tls.ALPNProtocols`, or `tls.alpn` sends **no ALPN** and only 10 extensions (`TLSEXT_TYPE_application_layer_protocol_negotiation`, `status_request`, `sct` all absent). Bun `fetch` sends ALPN `http/1.1` and the full 13-extension set. |
| **G2 — platform parity**  | **Closed.** Bun 1.4.2 on win32/x64 and on linux/arm64 both produce `JA3 = 1523504b38f0fae0d881d4b6554aac1b` — identical to E3 — with the extension order `0 23 65281 10 11 35 16 5 13 18 51 45 43`, 17 ciphers, 4 curves.                                                                                     |
| **G3 — no added headers** | **Closed.** Bun `fetch` adds only `connection`, `host`, and `content-length`; no `sec-fetch-*`, no `accept-language`, no `priority`.                                                                                                                                                                          |
| **G4 — streaming**        | Open; prototype-time.                                                                                                                                                                                                                                                                                         |
| **G5 — runtime pinning**  | Open; see Risks.                                                                                                                                                                                                                                                                                              |

**Corrected assumption.** The first draft required the child to write the request
head byte-for-byte from the caller's list. G1–G3 show that would be wrong: the
genuine client's own runtime canonicalizes, so the bridge must let Bun do it.

## Protocol (stdio)

Length-prefixed frames, 4-byte big-endian length then payload; payload is JSON
for control and raw bytes for bodies, so bodies are neither base64-inflated nor
newline-split. Every frame carries a `streamId`, which is what allows one child
to serve concurrent requests (usage polling alongside a streaming turn).

The child passes the caller's header list to `fetch` verbatim as _values_ and
lets the runtime serialize them; header-order and casing opinions belong neither
here nor in this package, because the runtime that will serialize them is the
same one the target client uses.

## Remaining unknowns

G1–G3 are closed (see gate results). What remains is local and zero-egress.

1. **Cost budget.** Spawn plus handshake latency for one long-lived child, and
   the per-request cost of the `fetch` path versus undici.
2. **Streaming throughput.** SSE frames must cross the stdio framing without
   materializing whole responses, and must not be buffered by the child.

## Phases

- **P0 — fingerprint harness.** The listener plus JA3 comparer used for E4–E7 and
  for G1–G3, committed as a test asset so every later claim is re-derivable.
  Re-running it is what detects a runtime change that moves the ClientHello.
- **P1 — bridge prototype.** Child + client; equality test of its ClientHello
  against the E3 vector, on Windows and Linux. The G2 command already produces
  the expected value on both platforms; the prototype must keep producing it
  through the framing and supervision layers.
- **P2 — request-fidelity test.** For a fixed request, assert the field set, the
  beta order, and the absence of runtime-added headers (the G3 assertion), rather
  than byte-equality of a hand-written head — the runtime owns serialization.
- **P3 — plugin integration.** The Claude provider's transport switches to the
  bridge; other providers keep their existing clients.
- **P4 — end-to-end.** One real request per provider path, then removal of the
  superseded path.

## Exit criteria

1. ClientHello equality with E3 **including SNI**, on the DSH host platform.
   Met on win32/x64 and linux/arm64 for Bun 1.4.2 (G2); must hold through the
   prototype and be re-asserted by the P0 harness on every runtime bump.
2. Request field set equality for a fixed case, with no runtime-added headers
   beyond `connection`, `host`, and `content-length` (G3).
3. SSE streaming works over the framing, with bounded memory for a long turn.
4. No listening socket exists while a request is in flight (verified by the
   platform's socket table, not by inspection of the code).

## Risks and maintenance

- **Runtime pinning.** Matching the client's TLS means matching its runtime. The
  2.1.280 binary embeds **Bun v1.4.3**; the equality measurement was taken with
  **1.4.2**, which produces the identical ClientHello, so the two are
  indistinguishable _today_. Pin the runtime the profile's client embeds, and let
  the P0 harness — not the version number — decide whether a bump is safe.
- **Dependency shape.** The `bun` npm meta-package's postinstall fails under npm
  ("Your package manager doesn't seem to support bun"), although it still leaves
  the platform binary in `node_modules/@oven/bun-<platform>`. Depend on
  `@oven/bun-<platform>` directly instead; verified working on win32/x64.
- **Process supervision.** A crashed child must not fail requests silently; the
  fallback path must be observable in logs, with a risk alert rather than a
  quiet downgrade.
- **Platform variance.** Windows/macOS/Linux Bun builds are separate artifacts;
  the equality test belongs in CI per platform, not once by hand.
- **Scope discipline.** The bridge must stay transport-only. Any header or body
  opinion added here duplicates this package's ownership and will drift.
