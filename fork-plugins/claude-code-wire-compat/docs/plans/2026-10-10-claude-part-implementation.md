# Implementation plan — Claude-part update for `dsh-plugin-subscriptions`

**Status:** design settled; this plan is the last document before implementation.
**Sources of truth:** [`verification-layer-2.1.280.md`](../analysis/verification-layer-2.1.280.md)
(gaps G1–G4 and their fixes), [`2026-10-10-subscription-transport-masquerade.md`](./2026-10-10-subscription-transport-masquerade.md)
(the Bun-stdio bridge design), and the carve index for the genuine client's behaviour.

## 0. Where the code lives and how it ships

| Piece                   | Location                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Plugin source (fork)    | `deepseek-harness/fork-plugins/dsh-plugin-subscriptions`                                                            |
| Plugin release artifact | `deepseek-harness/fork-plugins/releases/dsh-plugin-subscriptions-<version>.tgz`                                     |
| Profile reference       | `deepseek-harness-data/profiles/web/package.json` → `file:…releases/dsh-plugin-subscriptions-0.9.4-dsh017rc1.8.tgz` |
| Wire library source     | `C:/Project/claude-code-wire-compat` (`@tormentalabs/claude-code-wire-compat` 0.7.1)                                |
| Wire library install    | nested under the installed plugin's own `node_modules`                                                              |

Consequences that shape the work:

1. **Every plugin change is a release.** Edit source → build → `pnpm pack` a new
   versioned tarball → update the profile's `file:` reference → reinstall → reload
   the profile. There is no link-based hot path today.
2. **Wire-library changes must be delivered deliberately.** The plugin depends on a
   published version, so a local change needs either a packed dependency, a
   workspace override in the plugin, or a plugin-local vendored copy. The
   recommendation is a packed dependency with a `-dsh` suffixed version, so the
   plugin's `dependencies` stays honest.
3. **The fork rules apply.** `FORK_MAINTENANCE.md` records fork-specific behaviour,
   its preservation rule and its focused verification; plugin and profile changes
   update it in the same change.

## 1. Phase 1 — wire library: identity line and reporting block (G2, G4)

Pure library work, offline, covered by the existing fixture pipeline.

1. `src/system-prompt.ts` carries one hardcoded identity literal. Replace it with
   the three literals and a selector mirroring the genuine client: vertex → the
   interactive CLI form; a recorded value → that value; non-interactive → the
   Agent-SDK form when an appended system prompt is present, otherwise the
   "built on the Claude Agent SDK" form; all other cases → the interactive CLI form.
2. Emit the reporting block (`# Reporting outcomes …`, verbatim from the carve)
   between the identity block and the host prompt, with **no** cache breakpoint.
3. Re-seal the golden fixtures and add cases for the headless path (identity form
   `f`, reporting block present, block count and breakpoint positions asserted).
4. Gates: `typecheck`, `lint`, `test`, `fixtures:check`, `test:pack`.

## 2. Phase 2 — plugin: header removal and mode inputs (G3, G2 input)

1. Remove `x-client-request-id` from the Messages request. Determine whether it
   originates in the plugin adapter or the wire library's header builder, and
   remove it at that origin; the response-side use of the name is untouched.
2. Pass the invocation mode into the wire builder (`isNonInteractive`,
   `hasAppendSystemPrompt`) so the Phase 1 selector has its inputs.
3. Bump the plugin version, rebuild, repack, update the profile reference, reinstall.
4. Verification: replay a plugin-built request against the local listener and
   assert the header set equals the recorded genuine set, and the system array
   matches the recorded block sequence and breakpoint positions.

## 3. Phase 3 — Bun-side transport (G1)

Follows the bridge design document; no new decisions here.

1. Add the bridge inside the **plugin** (`lib/bridge/`), not the wire library — the
   wire library stays I/O-free, which is a stated contract of that package.
2. Runtime: depend on `@oven/bun-<platform>`; the bridge runs as a child process
   speaking the length-prefixed frame protocol with `streamId` correlation, and
   issues requests with Bun's `fetch` (raw `Bun.connect` cannot set ALPN).
3. Make it a configured transport with an explicit fallback switch. Default to the
   bridge; keep the current path reachable for rollback.
4. Failure policy: **fail closed**. A bridge that cannot start must produce a clear
   error rather than silently reverting to the Node/undici path, which is the exact
   configuration this work exists to eliminate. The fallback switch is the only
   sanctioned way back.
5. Gates: streaming over the frame protocol (the existing stream test extended to
   the bridge), runtime pinning, and a fingerprint regression that fails when the
   runtime version changes.

## 4. Phase 4 — verification that non-exposure holds

1. **Transport equality.** Build a request through the bridge against the local TLS
   listener and compare its ClientHello fingerprint with the genuine client's on
   the same host; they must be identical.
2. **Structural equality.** Diff the plugin's request against the recorded genuine
   structure: header set, system block sequence, block count, cache breakpoint
   positions, attribution block contents, and `metadata.user_id` shape.
3. **End-to-end.** One real request through a profile, with the pacing rule
   respected; confirm the response streams and the session continues.
4. **Accepted difference, recorded.** The tool catalogue stays the host's (option 1:
   accept). This is a product decision, not an oversight; it is restated in the
   audit document so it is never mistaken for a missed fix.

## 5. Risks and their handling

| Risk                                                          | Handling                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Wire-library version drift between repo and packed dependency | pack a `-dsh` version and pin it exactly; the plugin's dependency line stays truthful      |
| Bridge becomes a new failure domain                           | fail closed with a clear error, verbose-only logging, explicit fallback switch             |
| Profile reload does not pick up a new plugin build            | reinstall the profile, then verify by a request-path assertion rather than assuming        |
| Fixture churn hides a behavioural change                      | assert block sequence and breakpoint positions explicitly, not only whole-request equality |
| Runtime bump changes the fingerprint                          | the fingerprint regression gate (Phase 3, gate G5) fails loudly                            |

## 6. Order of work and stop points

```
Phase 1  wire library (G2, G4)      offline, testable, no user-visible change
Phase 2  plugin headers + inputs    small, verified by structural equality
Phase 3  Bun bridge (G1)            structural; gates G4/G5 close here
Phase 4  transport + structural verification, then one paced end-to-end request
```

Phases 1 and 2 are independent of the bridge and can land first; Phase 3 is the
only change that alters how traffic leaves the machine.
