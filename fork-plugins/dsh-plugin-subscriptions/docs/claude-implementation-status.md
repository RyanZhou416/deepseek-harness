# Claude reliability and maintenance implementation status

Maintainer-facing reference for the Claude request-reliability and account-maintenance work designed in [claude-reliability-design.md](claude-reliability-design.md) and [claude-account-maintenance-design.md](claude-account-maintenance-design.md). It records what the source tree implements, the verification actually performed, the limits that remain, and what the running profile executes.

Focused synthetic checks establish the implemented rules. They do not establish parity with a Desktop-managed Claude Code client, acceptance by the production server, or fraud-detection behavior, and this page is not a full-completion claim. The preservation rules and the per-mechanism verification owners live in [FORK_MAINTENANCE.md](../FORK_MAINTENANCE.md) and are not restated here.

## Implemented source

- `src/providers/claude-failure.ts` owns the one ordered classification for this route — a failed status and an in-band `error` event share it — with the closed retry allow-list, the `forbid` default for an unlisted code, `PERMISSION_DENIED` for a bare 403, `UNCLASSIFIED_PROVIDER_ERROR`, `STREAM_INCOMPLETE`, the delivered-output stop and the ambiguous-send stop; `src/providers/claude-protocol-state.ts` owns the one protocol-block store the adapter, the maintenance owner and the status projection share.
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

At this checkpoint, the inspected Web profile executes the accepted `0.9.4-dsh017rc1.30` artifact, recorded as `installed-and-verified` on 2026-10-16 after the Host was stopped. `0.9.4-dsh017rc1.31` is packaged as [dsh-plugin-subscriptions-0.9.4-dsh017rc1.31.tgz](../../releases/dsh-plugin-subscriptions-0.9.4-dsh017rc1.31.tgz); its release acceptance is `ready-for-user-stop-install-start`, its runtime change since `.30` is `lib/auth/oauth-flow.js` plus a module-comment-only change to `lib/auth/oauth-flow.d.ts`, its client bundle is byte-identical, and it was compared with the accepted `.30` source (127 files). Its install has not happened, so the accepted `.30` artifact is what a running Host executes. Installing `.31` requires stopping the Host first; see [FORK_MAINTENANCE.md](../FORK_MAINTENANCE.md#verification-and-packaging) and its [Deployment](../FORK_MAINTENANCE.md#deployment) section.
