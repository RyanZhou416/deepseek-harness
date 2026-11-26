# dsh-plugin-simflow-relay

English | [中文](README.zh.md)

The external SimFlow tool uses this loopback HTTP route to wake the DSH Session bound to a slot.

## Behavior

- `POST <path>` (default `/api/simflow/relay`) accepts JSON: `{"sessionId","slot","text","mailId"?,"kind"?}`.
- Authentication: only loopback connections are accepted. `x-simflow-token` must match the first line of `tokenFile` (at least 32 characters). The plugin uses a constant-time comparison and rereads the file for each request so the token can rotate. Both routes are registered on the Host WebServer as `auth: 'anonymous'`: SimFlow carries no browser session or API credential, so the loopback check and the token are the whole gate. A route left at the WebServer default (`required`) would be refused with 401 or 503 before the handler runs.
- Delivery uses the same path as the `session` tool's `send`: a working Session receives `Agent.send(message, 'next-step', true)` at the next step; the Session Controller resumes and wakes an idle or stored target.
- The model sees `SimFlow 发来「<slot>」的消息：` followed by SimFlow's text. The source is `kind: 'simflow'`, `form: 'relay'`; the separate `Message from another Session (...)` prefix is not added.
- Success returns `202 {ok, messageId, targetSessionId, targetStatus}` (`targetStatus` is working, idle or stored before delivery). Failures return `{ok:false, reason, error}` and do not deliver:
  - `410 archived`: the Workspace has archived the Session. Although DSH can queue a send, the archived Session cannot take a model step. The plugin checks before and after resolving the target and refuses the message.
  - `404 not-found`, `409 subagent-owned` (controlled by a subagent runtime), `409 stopped` (stopped before delivery), `503 unavailable`.
  - `400/401/403/405/413`: invalid request, token, non-loopback connection, method or size.
- Deduplication: a `(sessionId, mailId)` pair wakes the target once within the last 2,048 entries; a retry returns `200 {duplicate:true}`.
- On the SimFlow side (CL 30157/30165), each result becomes a mailbox `relay` event. An `archived/not-found/subagent-owned` result prompts the chief to update the roster. `simflow chief mail relay-retry [--id]` retries unarchived mail that did not reach its target, skipping invalid bindings that have not changed.

## Installation (user action)

```powershell
dsh plugin --profile <name> add C:\Project\deepseek-harness\fork-plugins\dsh-plugin-simflow-relay
```

The default in `cordis.patch.yml` is `tokenFile = D:\Ryan416_DESKTOP-LETT6RL_TheSunNeverSets\Tools\SimFlow\.data\relay-token`. After installation, restart DSH and enable `enabled` in `Tools/SimFlow/.data/relay.json` on the SimFlow side.

## Tests

```powershell
node --import ./test/register.mjs --test test/relay.test.mjs
```

The test loader in `test/resolve-hooks.mjs` resolves the Host-supplied `@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-host-webserver`, and `@deepseek-ai/schemastery` from this checkout; no profile installation is needed. `the carrier admits both routes anonymously` boots a real `WebServer` and fails with 503 when either route loses its `auth: 'anonymous'`.
