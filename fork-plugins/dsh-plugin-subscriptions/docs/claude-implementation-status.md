# Claude reliability and maintenance implementation status

Maintainer-facing reference for the Claude request-reliability and account-maintenance work designed in [claude-reliability-design.md](claude-reliability-design.md) and [claude-account-maintenance-design.md](claude-account-maintenance-design.md). It records what the source tree implements, the verification actually performed, the limits that remain, and what the running profile executes.

Focused synthetic checks establish the implemented rules. They do not establish parity with a Desktop-managed Claude Code client, acceptance by the production server, or fraud-detection behavior, and this page is not a full-completion claim. The preservation rules and the per-mechanism verification owners live in [FORK_MAINTENANCE.md](../FORK_MAINTENANCE.md) and are not restated here.

## Implemented source

- `src/providers/claude-failure.ts` owns the one ordered classification for this route — a failed status and an in-band `error` event share it — with the closed retry allow-list, the `forbid` default for an unlisted code, `PERMISSION_DENIED` for a bare 403, `UNCLASSIFIED_PROVIDER_ERROR`, `STREAM_INCOMPLETE`, the delivered-output stop, and the retryable issued-send transport failure; `src/providers/claude-protocol-state.ts` owns the one protocol-block store the adapter, the maintenance owner and the status projection share.
- `src/providers/claude-maintenance.ts`, `claude-account-state.ts`, `claude-profile.ts` and `claude-managed-settings.ts` own live-session binding, credential renewal, profile freshness and completeness, and the conditional managed-settings read. `src/index.ts` holds the Host-contract gate (`ctx.llm.failureRecoveryVersion` must be `1`, otherwise the Claude route is refused as `CLAUDE_HOST_INCOMPATIBLE`), the awaited hydration in the pre-request hook, the structured status projection and the per-session execution-stage tool guard.
- `src/providers/claude-policy-limits.ts` with `src/claude-core/` owns the independent `policy_limits` document, and `src/claude-core/control-requirements.ts` classifies the two known `enforce_`/`require_` controls out of the operation-permission key set.
- `src/providers/claude-device.ts` derives the Messages device id from the account key and a hash of this machine's operating-system identifier; a host with no usable identifier fails with `CLAUDE_DEVICE_IDENTITY_UNAVAILABLE` instead of an account-only or random fallback.
- `src/claude-core/`, `src/claude-engine/` and `src/claude-account-client/` are the extractable single-account modules; each imports neither the harness nor this plugin's provider layer.
- `src/auth/oauth-flow.ts` validates the callback path and the attempt's `state` ahead of both an authorization code and a provider error; the `.31` source adds that error-branch check.

## Verification performed

The source-level runs below used injected transports, synthetic responses and a private temporary `DSH_HOME` or private Claude configuration roots; the packaging, documentation and upgrade checks ran against the candidate or a private profile. None contacted a provider and none read a real credential. Counts describe separate runs whose cases overlap; they are not a summed suite or a coverage metric.

- Local synthetic authentication cases: 116 passed. The same work found that the OAuth callback's provider-error branch did not validate `state`.
- `.31` source: the new callback regressions (10 cases) passed, and the prior unfixed artifact rejected the all-clear assertion on 4 error callbacks, as expected.
- `.31` packed artifact: the same 10 callback regressions and 3 package-import/client-factory tests passed, and a tampered artifact hash was refused.
- Documentation checks: 42 passed against the candidate.
- Private-profile upgrade rehearsal: 257 runtime members installed, 129 files of other plugins unchanged, and a repeated upgrade was idempotent.
- `.30` finalize: all 11 steps succeeded, including `check-host-stopped` and `install-verify`, and 256 installed members were verified.
- Earlier focused batches (reliability, maintenance lifecycle, profile and policy, store and accounts, HTTP lifecycle, policy limits) passed; their counts overlap with the sets above and stay with their specs.

The user reports a successful Claude Messages request through the installed build. This confirms that particular request succeeded, not every account, maintenance branch or upstream policy. It is user-observed use rather than an assistant-run network test and establishes no risk-control equivalence.

## Remaining limits

- The full Claude Code permission and control catalog is not implemented. An unmapped or unsupported restriction is refused conservatively, the two known `enforce_`/`require_` controls are observed and warned about without being enforced, and the complete managed-policy consumer set stays out of scope.
- External credential coordination is unproven. A `legacy-writeback` account may spend the same refresh grant an external holder spends and keeps reporting `external-coordination-unproven`, so a single writer is not demonstrated.
- A status read is not fully separated from store migration: `loadStore` still performs the pre-rename auth-store migration and a token-derived account-key rekey, and a read-only caller's rewrite runs outside the write lock.
- No qualified source exists for a proactive remote minimum-version floor. The injected flag source is closable, unawaited and fail-open with a `0.0.0` default, so only the latch over refusals already seen exists.
- This plugin's own continuation state is implemented: the private account-reference salt, span bindings, ATIS pins and identity generations persist across restarts, and the stored plugin selects the previous request id from the durable session log — a missing or empty id scans backward for an eligible record, and an invalid selected non-empty id is omitted without backtracking. The extracted Mac-side pool caller remains paused; its unfinished previous-request selection and ATIS persistence are that caller's, not this plugin's.
- No cross-Host or macOS verification was performed. The route deliberately issues no startup `HEAD /api/hello` preconnect, and the `.31` release acceptance records that withdrawal.
- The repository-wide lint gate is outside what was claimed: unrelated generated-source and worktree failures were left untouched.

## Release checkpoint — 2026-10-16

At this checkpoint, the running profile starts the user-installed `0.9.4-dsh017rc1.32`: the user installed it before the PID 59100 startup, and the 257 runtime member hashes were checked. Its org-pin recovery fix passed the source batches — 25 restart-and-core cases ([test/claude-org-pin-restart.spec.ts](../test/claude-org-pin-restart.spec.ts) 14, [test/claude-core-org-pin.spec.ts](../test/claude-core-org-pin.spec.ts) 11), 2 production-selection cases including the exact empty sub-mount, and 4 existing policy cases — and the packed batches of 3 plain-Node, 14 packed-restart and 2 packed-production cases, with no skips, an unchanged client bundle and a clean package typecheck. The `.33` candidate differs only in that continuation-state IO wait fix — one runtime JavaScript file, with the client bundle unchanged — and its packaged checks passed: 3 plain-Node, 25 packed salt and 2 packed real continuation-refusal cases, all with no skips, while the package's TypeScript 5.9.3 compile is clean for both the server and test projects. Against the installed `.32`, the single negative case finishes with the expected assertion failure (actual finished versus expected waiting) and does not hang. Those counts stay separate rather than summed into a full suite. At that checkpoint, `.32` remained installed and the `.33` offline installation plan awaited the user's manual stop-build-run.

## Verified installation and publication checks — 2026-10-17

The 17:06 startup manifest records `0.9.4-dsh017rc1.33`; its entry hash matches the installed package. A read-only comparison of all 257 package-manifest, patch and runtime files matches the `.33` tarball. This establishes the installed artifact and startup identity, not provider acceptance, and the publication checks did not install or restart anything.

The three focused source files passed together without forced process exit: 14 restart cases, 25 continuation-state cases and 13 production-policy cases, with no failures, skips or cancellation. The production fixture seeds accounts before plugin hydration and checks that a request without a Session is refused by the request-recording contract. Another 30 continuation/resume/request-id cases passed separately. Server and test typechecks passed; a private compilation matched all 254 packaged JavaScript/declaration outputs, and three plain-Node artifact checks passed against the matching fork Host dependencies. Documentation checks passed 42 gates. Full repository lint still reports five failures in existing LLM/runtime and model-selection-test files outside these changes; no full plugin suite or real-provider run is claimed.
