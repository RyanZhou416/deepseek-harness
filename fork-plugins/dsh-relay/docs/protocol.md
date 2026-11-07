# DshRelay client API

The `dsh-relay` plugin publishes the local DSH Web Host through a relay server under a personal subdomain. This document is the contract between the plugin and the relay gate. It contains no deployment values: the plugin user enters the relay's base domain in the plugin settings.

## Terms

| Term | Meaning |
|---|---|
| Base domain | The relay's DNS name, for example `relay.example.com`. Every user address is `https://<username>.<base domain>/`. |
| Client key | A personal key the relay administrator issues to one person. Format `dshk_<43 base64url characters>` (32 random bytes). The relay stores only its SHA-256. |
| Account | Username plus password. The password is stored only as a scrypt hash. |
| Tunnel | One frp TCP proxy from the relay's loopback `remotePort` to the local DSH Web port. |

## Transport

- Base URL: `https://<base domain>/__dsh/api/v1`.
- Every request is `POST` with `content-type: application/json` and a body of at most 16 KiB; any other method gets `405 bad-request`.
- Every request carries `authorization: Bearer <client key>`.
- Every response is JSON. Success is `{ "ok": true, ... }`; failure is `{ "ok": false, "code": "<code>", "message": "<human text>" }` with the HTTP status listed below.
- `client-key-invalid`, `client-key-mismatch` and `credentials-invalid` responses are delayed by about 400 ms; validation errors are not.

## Client key binding

A key is either unbound or bound to one username. The first successful `connect` with an unbound key binds it to that username. A bound key works only for its username. One username may own several keys, one per machine. Revoking a key rejects every later request that uses it; tunnels already running keep running until frpc reconnects, because frp authenticates with the per-user tunnel token.

## `POST /connect`

Signs in, creates the account on first use, records the DSH session the gate injects, and returns the tunnel parameters.

Request:

```json
{
  "username": "ryan",
  "password": "at least ten characters",
  "dsh": {
    "authority": "127.0.0.1:3080",
    "cookie": "dsh-auth-<name hash>=v1.<body>.<signature>"
  }
}
```

- `username` matches `^[a-z][a-z0-9-]{0,30}[a-z0-9]$` or is a single letter, and is not on the relay's reserved list.
- `password` has at least the relay's minimum length (default 10) when the account is created. An existing account accepts its current password regardless of length.
- `dsh.authority` is `127.0.0.1:<port>` or `localhost:<port>`: the Host and Origin the relay sends upstream, which the local DSH accepts as loopback.
- `dsh.cookie` is one `name=value` DSH browser-session cookie whose authority is `dsh.authority`; its name must be `dsh-auth-<base64url(sha256(dsh.authority))>`. The relay injects it as the `Cookie` header of every proxied request.

Behavior:

1. Validate the client key (`401 client-key-invalid`) and its binding (`403 client-key-mismatch`).
2. Validate `username` (`400 username-invalid`, also when it is missing) and the `dsh` fields (`400 dsh-invalid`).
3. If the account does not exist, check the password length (`400 password-too-short`), allocate a remote port (`503 port-pool-exhausted` when none is free), and create the account with a new tunnel token. Otherwise verify the password (`401 credentials-invalid`).
4. Bind an unbound key to the username.
5. Store `dsh.authority` and `dsh.cookie` for the account, replacing any earlier binding.

Response `200`:

```json
{
  "ok": true,
  "username": "ryan",
  "created": false,
  "url": "https://ryan.relay.example.com/",
  "tunnel": {
    "frpVersion": "0.71.0",
    "serverAddr": "203.0.113.10",
    "serverPort": 80,
    "websocketPath": "/~!frp",
    "tlsServerName": "203.0.113.10",
    "caPem": "-----BEGIN CERTIFICATE-----\n...",
    "sharedToken": "<frps auth.token>",
    "user": "ryan",
    "frpToken": "<per-user token for metadatas.frpToken>",
    "remotePort": 13080
  }
}
```

The client builds its frpc configuration only from `tunnel`. frpc 0.71 always dials the WebSocket path `/~!frp` and has no setting to change it, so `tunnel.websocketPath` must be `/~!frp`; the client refuses any other value. `tunnel.user` and `tunnel.frpToken` must be sent as frpc `user` and `metadatas.frpToken`; the relay's frp server plugin rejects any other user or any other `remotePort`.

## `POST /password`

Request `{ "username", "password", "newPassword" }`. Errors: `401 client-key-invalid`, `403 client-key-mismatch`, `401 credentials-invalid` (also for an unknown or malformed username, so the response does not reveal which accounts exist), `400 password-too-short`, `400 password-unchanged`. Success `200 { "ok": true }`. Every browser session of the account signed in with the old password stops working; the DSH binding and the tunnel token are unchanged.

## Gate behavior that depends on `connect`

- The relay serves `https://<username>.<base domain>/` only to a browser session of that same username. A session of another user is treated as signed out.
- The upstream of a user address is `127.0.0.1:<remotePort>` of that account, and the upstream Host and Origin are the account's stored `dsh.authority` (`127.0.0.1:3080` for accounts created before this API).
- An account without a stored DSH cookie shows the gate's "not bound yet" page after sign-in.

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `client-key-invalid` | 401 | Missing, unknown, malformed, or revoked client key. |
| `client-key-mismatch` | 403 | The key is bound to another username. |
| `credentials-invalid` | 401 | Wrong password for an existing account. |
| `username-invalid` | 400 | The username cannot be a subdomain label or is reserved. |
| `password-too-short` | 400 | A new password is shorter than the relay minimum. |
| `password-unchanged` | 400 | `newPassword` equals the current password. |
| `dsh-invalid` | 400 | `dsh.authority` or `dsh.cookie` is missing or malformed. |
| `port-pool-exhausted` | 503 | No remote port is free for a new account. |
| `bad-request` | 400 | Body is not JSON, too large, or not an object. |
| `internal` | 500 | Unexpected relay failure. |
