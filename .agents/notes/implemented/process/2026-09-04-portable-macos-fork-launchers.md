# Agent Note: Portable macOS fork launchers

Status: implemented

English | [中文](2026-09-04-portable-macos-fork-launchers.zh.md)

## Problem

The fork's macOS launchers required `node` and `corepack` specifically under `/usr/local/bin`, which excluded ordinary Apple Silicon Homebrew and version-manager installations. The run launcher also omitted the bounded heap and diagnostic report policy used by the Windows launcher, while the fork-maintained Agent Teams and Context artifacts remained present in Git but absent from every new machine's profile.

Copying the Windows Harness home is not a deployment mechanism. Its profile contains machine paths, and the same home owns credentials, Sessions, attachments, derived caches, and other user data that a source checkout must never distribute or rewrite.

## Decision

`build.command` and `run.command` source `scripts/fork-macos-runtime.sh`. The helper discovers Node from `PATH`, `/opt/homebrew/bin`, or `/usr/local/bin`; accepts Node `22.19+` or `24+` while rejecting Node 23; installs the pinned Corepack fallback `0.34.5` only under a private per-user temporary directory; and requires the exact pnpm version from the repository `packageManager` field. Before starting the pinned pnpm shim, the helper disables Corepack's interactive download prompt, announces the preparation, and leaves startup diagnostics visible; a cold cache can download without waiting on an invisible terminal question.

`build.command` remains an install-and-build operation. `run.command` resolves blank, tilde-prefixed, relative, and absolute `DSH_HOME` values with the Harness path rules, creates a non-symlink diagnostics directory with mode `0700`, and adds fatal and uncaught Node reports without supervising or restarting the Host. Its default V8 old-space budget is half of physical memory, clamped from 4 GiB through 16 GiB; `DSH_MAX_OLD_SPACE_MIB` is an explicit validated override.

`setup.command` is the separate, explicit profile mutation. It verifies the committed Agent Teams and Context artifacts by SHA-256 and package identity, backs up only an existing web profile's `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and `cordis.patch.yml`, initializes a missing web profile, pins that profile to the repository pnpm version, installs both local artifacts, merges the Context low-overhead bounds while retaining unrelated patch rows, and validates installed versions, bundle membership, lock references, and the composed config. Repeating a converged setup performs no package or patch mutation; `--dry-run` creates neither the Harness home nor package-manager directories.

The setup excludes credentials, settings, Sessions, attachments, projection caches, diagnostics, workspace `.agent-teams` data, marketplace plugins, subscriptions, watchdogs, custom presets, and process-worker profiles. Those remain machine-owned and require separate explicit configuration.

## Alternatives considered

**Add `/opt/homebrew/bin` beside the existing hard-coded directory.** Rejected because nvm, asdf, Volta, and user-managed Node installations would remain unsupported, and the scripts would continue to disagree with the repository engine range.

**Install or repair plugins every time `run.command` starts.** Rejected because launching the Host must not mutate a profile, contact a package registry, or race a running profile's package manager.

**Copy the working Windows `DSH_HOME` to each Mac.** Rejected because it combines non-portable paths with account secrets and durable user data. The setup derives a new profile around the receiving machine's own home instead.

**Give every Mac a 16 GiB old-space budget.** Rejected because a 16 GiB machine could enter swap pressure before V8 reaches that limit. The adaptive cap gives 16 GiB to machines with at least 32 GiB of physical memory and leaves an explicit override for known deployments.

## Consequences

A fresh Mac receives reproducible source tooling and both fork plugin artifacts without receiving another machine's runtime data. Build, profile setup, and Host launch are separate visible actions, so each operation has one mutation scope and failure surface.

The profile's local artifact references remain tied to the checkout path; moving the checkout requires rerunning `setup.command`. The setup does not reproduce the Windows watchdog, ChatGPT preset, marketplace inventory, or process workers. POSIX behavior and an isolated real profile installation are covered on the Windows development host, but a physical macOS cold start remains required before claiming host qualification.
