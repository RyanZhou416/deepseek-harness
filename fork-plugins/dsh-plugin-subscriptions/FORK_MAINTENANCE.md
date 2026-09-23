# Subscriptions fork maintenance

This subtree carries the private `dsh-plugin-subscriptions` build shipped with this fork.

## Provenance

- Upstream repository: `https://github.com/V1ki/dsh-plugin-subscriptions.git`
- Upstream tag: `v0.9.4`
- Fork package version: `0.9.4-dsh017rc1.1`
- Subtree path: `fork-plugins/dsh-plugin-subscriptions`
- Distribution artifact: `fork-plugins/releases/dsh-plugin-subscriptions-0.9.4-dsh017rc1.1.tgz`

## Fork behavior

The fork keeps upstream provider, account, credential-store, request-translation, and tool names. It uses the RC.1 awaited `agent/created` payload and exact DSH dependency cohort. The V4 adapter maps first-class `role: 'tool'` messages to the existing provider translators' result blocks, preserving call id, failure flag, order, and image attachments; developer messages fail explicitly until a provider supports them. The independent test environment installs the UI primitive runtime dependencies that the Harness Web application normally supplies.

Each Node test process gets a private temporary `DSH_HOME` before plugin imports. Codex and Grok stream tests inject their fetch implementation through the adapter's existing option, so a developer's proxy configuration and credentials cannot redirect synthetic requests to real providers. Production routes still use the configured proxy.

No Session event, Session format, credential format, or provider wire format changes. Existing subscription credentials remain owned by the plugin's configured DSH home and are not copied into this repository.

## Verification and packaging

Run from this directory:

```powershell
corepack pnpm@10.30.2 install --frozen-lockfile --ignore-scripts --ignore-workspace
corepack pnpm@10.30.2 build
corepack pnpm@10.30.2 test
corepack pnpm@10.30.2 pack --pack-destination ..\releases
```

Store the artifact's uppercase SHA-256 beside it as `dsh-plugin-subscriptions-0.9.4-dsh017rc1.1.tgz.sha256`. Inspect the packed manifest before installation.

## Updating upstream

Import an exact reviewed tag through the subtree, reapply the RC.1 cohort and lifecycle adaptations, run the package suite, advance the private version, and rebuild the fixed artifact. Never install npm `@latest` directly into the live profile.

## Rollback

Rollback changes only the pinned package and profile configuration after DSH stops. Preserve the plugin credential store and do not rewrite Session, attachment, or provider-account data.
