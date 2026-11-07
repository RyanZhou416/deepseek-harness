# dsh-relay

English | [中文](README.zh.md)

Publish the local DSH Web Host through a DshRelay server under a personal address, `https://<username>.<server domain>/`, from a built-in settings page. The plugin signs in with the account and personal client key the relay administrator issued, hands the relay a freshly minted DSH browser-session cookie on every connection, and supervises an `frpc` tunnel to the local DSH Web port.

The plugin contains no deployment values. The relay domain, username, password, and client key are entered by the user and stored in the DSH credential service, never in `cordis.yml` or a profile patch.

## Install

On Windows the repository `build.cmd` stages every fork plugin and links them into the selected `web` profile:

```powershell
.\build.cmd
```

To stage only this plugin during development:

```powershell
cd fork-plugins\dsh-relay
..\..\node_modules\.bin\tsdown
```

Then run `scripts/fork-plugins-build.ts` from the repository root; it builds `lib/index.js` (host) and `lib/client.js` (browser) from source and installs the staged directory with a pnpm `link:`. The plugin requires DSH `0.2.2-rc.1`, Cordis `4.1.0`, and `@deepseek-ai/schemastery` `3.19.0`.

The host half needs the `credentials`, `connection`, and `webServer` services. A headless composition still loads it, but it offers no tunnel there. The browser half registers a **Remote access** page under Settings.

## Settings

Settings → **Remote access** takes four fields:

- **Server domain** — the relay base domain, for example a hostname whose user subdomains serve the relay. Only `https` is accepted; a bare domain is the normal form.
- **Username** — the account's subdomain label: lowercase letters, digits, and hyphens, following the relay protocol.
- **Password** — the account password. A stored password shows a **Saved** placeholder; leaving the input empty keeps it.
- **Client key** — the personal `dshk_…` key the administrator issued. It also shows **Saved** and is kept when the input is empty.

The page shows the derived address `https://<username>.<domain>/` as soon as both fields form a valid address. **Save** stores the fields; **Connect** and **Disconnect** start and stop the tunnel; **Change password** asks for the current password plus the new one twice. The **Connect automatically when DSH starts** switch is saved in the same credential record.

The status area reports **Not configured**, **Downloading frpc**, **Connecting**, **Connected** (with the remote port and the last successful time), or **Failed** with a readable reason mapped from the relay's protocol code, such as an invalid client key, a wrong password, an invalid username, an exhausted port pool, or an unreachable server.

## How it works

1. Validate the stored fields and read the local DSH Web listener's port from `ctx.webServer.port`.
2. Mint a DSH browser-session cookie for `127.0.0.1:<port>` with the signing key the DSH connection plugin stored in the credential record `client-connection/browser-session`. The lifetime is the Host's configured `cookieMaxAgeDays` minus one day, with a one-day floor.
3. `POST https://<domain>/__dsh/api/v1/connect` with the username, password, authority, and cookie, authorized by the personal client key.
4. Download the frp release the relay names, verify the archive against the pinned SHA-256, extract `frpc`, and write the configuration, shared token, and CA certificate into `<DSH_HOME>/dsh-relay/run/`.
5. Start `frpc` with that configuration, treat `login to server success` plus `start proxy success` as connected, and restart the process with exponential backoff after an unexpected exit.

Every connection mints a new cookie, and a connected tunnel repeats the registration every `cookieRefreshIntervalMs` (12 hours by default), so the relay's stored binding stays inside the Host's cookie lifetime however long DSH stays up. A failed refresh leaves the tunnel running and is retried at the next interval; a relay that returns different tunnel parameters gets a full reconnect.

## Security

- The password and client key are stored in the DSH credential service. They are never written to `cordis.yml`, a profile patch, an error message, or a log line, and the RPC status reports only whether each one is stored.
- The local run directory is owner-only (`0700`), and each generated file is written owner-only (`0600`) with an exclusive create.
- The relay API accepts only an `https` server domain. The frp archive is checked against a pinned SHA-256 before it is extracted, and an unknown release is refused instead of run.
- The settings RPC lives at `/api/relay.*` below the connection plugin's authenticated `/api` channel, so it inherits the Host/Origin fence and the browser-session check.
- `frpc` runs with a scrubbed environment: variables whose names contain `KEY`, `SECRET`, `TOKEN`, or `PASSWORD` are removed.

## Troubleshooting

- **The DSH browser-session key is unavailable** — the Host has not created its session signing key yet. Open the DSH web page once, then retry.
- **The client key is unknown or was revoked** — ask the relay administrator for a new key; revoked keys reject every later request.
- **The client key is bound to another username** — the key is already bound to a different account. Use the key issued for this username.
- **The relay uses an frp version this client has no pinned download for** — either the relay administrator changed the frp release without updating the client, or `frpcHashes` needs an entry for that release. A deployment may also point `frpcPath` at an existing `frpc` executable.
- **The downloaded frpc archive failed its SHA-256 check** — the download was corrupted or replaced; retry, and verify the pinned hash if the relay changed its release.
- **frpc could not start the tunnel** — the run directory holds the last generated configuration and token files for inspection. Do not share them; they contain tunnel credentials.
- **A tunnel process outlives the Host** — the plugin stops and awaits `frpc` on disconnect and on unload. If the Host was killed, stop the leftover `frpc` process manually.

## Limitations

- The plugin was developed against the documented client API. Live interoperability with a deployed relay has not been verified in this repository.
- frp archives are pinned for release `0.71.0` on `win32`, `darwin`, and `linux` for `x64` and `arm64`. Another release needs pinned hashes in `frpcHashes`; the plugin refuses an unpinned version.
- A relay whose address serves a different frp release than the one the administrator announced cannot connect until the client pins that release.
