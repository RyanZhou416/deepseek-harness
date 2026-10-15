# Agent Note: Web fetch reaches any destination the process can

Status: implemented

English | [中文](2026-10-11-web-fetch-unrestricted-destinations.zh.md)

## Problem

TUN clients can return synthetic DNS addresses that are not public unicast even when the requested website is public. Validating and pinning those answers confuses an intermediate routing address with the final destination, rejecting requests before the TUN can handle them. Identifying one client or fake-IP range cannot solve this across changing network configurations. The public-address rule also prevents intentional access to local and private services.

## Decision

`@deepseek-ai/dsh-web-fetch-http` does not restrict destination addresses. Its provider issues each `GET` through the process's global `fetch` with `credentials: 'omit'`, following the installed proxy policy or the system network. Loopback, private, link-local, unique-local, cloud-metadata, and NAT64-translated addresses are not rejected by the provider. There is no address mode or allowlist.

The provider retains HTTP(S)-only URLs, the 2,048-character URL cap, embedded-credential rejection (`WEB_BLOCKED_URL`), same-origin-only redirects with target validation on every hop, anonymous requests, byte and character caps, redirect and timeout limits, content-type validation, and its product `User-Agent`.

## Supersession and scope

This note supersedes the public-address rule in [the web capability seam](2026-06-24-web-capability-seam.md) and the proxy-specific address-check exception in [the outbound proxy policy](2026-08-27-outbound-proxy-policy.md). Both records remain active for their other decisions. [FORK_MAINTENANCE.md](../../../../FORK_MAINTENANCE.md#web-fetch-without-destination-restrictions) records preservation and deployment requirements.

## Alternatives considered

**Identify and exempt a TUN client's fake-IP range.** Rejected because clients and configured ranges can change, and an address alone cannot establish the mapped destination. This retains a deployment-specific classification rather than using the system network normally.

**Require an explicit HTTP proxy.** Rejected as the primary fix because it changes the application's request path instead of supporting an operator's existing TUN-only setup. Explicit proxy settings remain supported, not required.

**Discard non-public IPv6 answers or force IPv4.** Rejected because fake addresses can use either family, including reserved IPv4 ranges. Filtering IPv6 can hide one failure without removing dependence on the chosen synthetic range or validating the final destination.

## Consequences

**The provider gives up public-network isolation.** Model-selected requests can read reachable loopback, private-network, and metadata services, or disclose data to reachable endpoints. This is an accepted cost, not a claim that fake addresses are safe. Deployments needing isolation must enforce it through tool-execution policy, network egress controls, or by disabling fetch.

**The provider needs no TUN-specific configuration.** The process transport and operating system decide routing. Connection resets, DNS failures, timeouts, and other network errors remain possible.

**One request path follows the process transport.** The provider neither constructs a private dispatcher nor resolves or pins destination addresses itself.

## Testing

`pnpm exec vitest run packages/web/web-fetch-http/tests packages/web/tool-web/tests` covers local retrieval, private and synthetic addresses handed to the transport, configured-proxy routing, and the retained limits. The [Loader test](../../../../packages/web/tool-web/tests/loader-fetch.spec.ts) loads the [YAML fixture](../../../../packages/web/tool-web/tests/fixtures/cordis.fetch.yml) and observes rendered tool output from a loopback server. A source-provider check on the reported TUN network returned HTTP 200 for `example.com` and `github.com` without proxy configuration. The [recorded scenario](../../../../snapshots/session/web-fetch/snapshot.yml) uses real loopback transport without DNS substitution and passes built-artifact replay on Windows. Its test-only composition excludes platform-specific shell tools, and the headless adapter recognizes the run's JSON-quoted workspace path without weakening other transcript comparisons.
