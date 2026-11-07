# dsh-relay fork maintenance

This subtree is a fork-maintained DSH plugin, not an upstream import. It implements the client half of the DshRelay client API documented in [`docs/protocol.md`](docs/protocol.md) and must track this fork's DSH APIs.

## Behavior

The plugin is one package with two halves. The host half owns `/api/relay.*`, the credential record `dsh-relay/account`, the DSH browser-session cookie minting, the relay protocol calls, the frpc run directory, and one supervised `frpc` child process. The browser half registers the **Remote access** settings page and its `settings.relay` dictionaries.

Behaviors that must survive any refactor:

- **Credential storage.** Domain, username, password, personal client key, and the auto-connect preference live in one `grant` credential record. No secret is written to `cordis.yml`, a profile patch, a log line, an error detail, or an RPC response.
- **Cookie minting.** A cookie is minted per connection from the signing secret in `client-connection/browser-session`, with the exact authority reported to the relay. The name is `dsh-auth-<base64url(sha256(authority))>` and the payload is the version-1 browser payload `packages/client/connection/src/browser-auth.ts` verifies. The lifetime is the Host's `cookieMaxAgeDays` minus one day, never below one day.
- **Relay protocol.** Every request is one HTTPS `POST` with the personal key as a bearer token and a JSON body at most 16 KiB. Error codes map to typed failures; a relay response is validated before any tunnel value is used.
- **frpc acquisition.** The archive is downloaded only for the release the relay names, checked against the pinned SHA-256 for `<version>/<platform>-<arch>`, and extracted in-process (zip on Windows, `tar.gz` elsewhere). An unpinned release, a mismatched hash, or a malformed archive is refused.
- **Run directory.** `<DSH_HOME>/dsh-relay/run/` is owner-only, and every file in it is written owner-only with an exclusive create. The configuration derives only from the returned tunnel.
- **Process lifecycle.** One supervisor owns the child, the startup timeout, and the restart backoff. Teardown awaits the child's exit; a newer generation invalidates every in-flight step so a late response cannot move a later connection's state.
- **Authenticated RPC.** The settings endpoints register only below the connection plugin's `/api` channel, which applies the Host/Origin fence and browser-session check. The plugin does not add its own authentication.

## Preservation rules

- Keep the pinned frpc hashes in `src/config.ts` aligned with the official frp release checksums. Do not accept an archive without a per-version pin.
- Keep `docs/protocol.md` as the protocol source. A server-side protocol change updates that document first, then the client.
- Keep the cookie payload and name derivation byte-compatible with `packages/client/connection/src/browser-auth.ts`. A change there must update the client and its BrowserAuth-backed test in the same change.
- Do not add deployment values (server domains, addresses, tokens, ports) to source, tests, defaults, or documentation. The protocol document and the tests use documentation addresses only.
- Treat the password and client key as write-only values across the RPC boundary. A status response may carry presence flags, never a value or a value-derived hint.

## Focused verification

Run from `fork-plugins/dsh-relay` with the repository's toolchain:

```powershell
..\..\node_modules\.bin\tsc --noEmit -p tsconfig.tests.json
..\..\node_modules\.bin\vitest run
```

- `tests/host/cookie.spec.ts` mints through the real `packages/client/connection/src/browser-auth.ts` verifier.
- `tests/host/protocol.spec.ts` covers success, every protocol error code, timeouts, unreachable servers, and malformed responses against a local fake server.
- `tests/host/frpc-*.spec.ts` cover configuration rendering, archive extraction, hash refusal, and supervisor restart/teardown behavior with a fake `frpc` fixture.
- `tests/host/controller.spec.ts` covers the full connect path, download, password change, and generation invalidation.
- `tests/client/*` cover the locale dictionaries, the settings registration, the RPC caller, and the page interactions.
- `tests/compose/loader-composition.spec.ts` mounts the plugin through the vendored Loader beside the shipped credential, web-server, and connection plugins, then calls the authenticated `/api/relay.status` and `/api/relay.save` routes over HTTP.

Build integration is verified by `scripts/fork-plugins-build.spec.ts`; `scripts/fork-plugins-build.ts` stages this plugin as a pnpm `link:` and writes no deployment value into the profile.
