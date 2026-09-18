# Agent Note: Exact local Subscriptions release ports

Status: implemented

English | [中文](2026-09-18-local-subscriptions-release-port.zh.md)

## Problem

`dsh-plugin-subscriptions` consumes pre-stable DSH Agent lifecycle, credential, provider, and Web client APIs. Installing a registry tag directly into the deployed profile can combine a plugin with a different DSH dependency cohort, while leaving the old profile package gives no reviewed path to current provider fixes and account behavior.

DSH Alpha.2 also ships its own Plugin Manager. Keeping `dshmarket` beside it gives two package-management surfaces authority over the same profile and makes a repeatable local-plugin installation harder to verify.

## Decision

The fork vendors the exact upstream `dsh-plugin-subscriptions` tag `v0.9.2` under [`fork-plugins/dsh-plugin-subscriptions`](../../../../fork-plugins/dsh-plugin-subscriptions/FORK_MAINTENANCE.md) and distributes the private `0.9.2-dsh016alpha2.1` artifact only for DSH `0.1.6-alpha.2`. Its peer declarations, development dependencies, overrides, lockfile, package identity, and checked-in SHA-256 identify that exact pair.

The private port retains upstream provider, account, credential-store, request-translation, and tool behavior. It supplies Alpha.2's awaited `agent/created` result and startup source fields and installs the browser runtime dependencies required by the plugin's independent test environment. It changes no Session event, Session format, credential format, provider wire fields, or tool result.

`setup.command` verifies AgentTeams, Context, and Subscriptions artifacts before changing a profile. When `dshmarket` is installed, setup removes it through `dsh plugin`; the final profile verifier rejects `dshmarket` in package sections or `dsh.profile.bundles`. Installation changes only profile packages and configuration. Credentials, Sessions, attachments, provider accounts, and workspace state remain untouched, and a running Host must be stopped before applying the package change.

## Alternatives considered

**Install upstream `latest` directly.** Rejected because a moving registry selector does not pin the reviewed source or DSH dependency cohort and cannot preserve a reproducible rollback artifact.

**Keep Subscriptions v0.6.0.** Rejected because it leaves the deployed profile behind reviewed upstream provider, failover, cache-affinity, image-result, and orphan-tool-call fixes.

**Keep `dshmarket` beside the official Plugin Manager.** Rejected because overlapping profile-package managers add configuration and update paths without preserving a capability that Alpha.2 lacks.

## Consequences

The deployed plugin can move to upstream v0.9.2 without migrating its credential or provider data. The repository retains one auditable source import and one fixed artifact; the profile retains one package-management path after setup.

Each future Subscriptions or DSH release requires an exact source import, coherent Alpha.2-or-newer dependency port, package build and tests, artifact identity and digest checks, and a stopped-profile installation. Rollback changes the pinned package and bundle only; it does not restore or rewrite runtime data.
