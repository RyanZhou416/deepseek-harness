# dsh-plugin-simflow-relay

[English](README.md) | 中文

让外部 SimFlow 工具直接唤醒“槽位绑定的 DSH 会话”的 loopback HTTP 入口。

## 行为

- `POST <path>`（默认 `/api/simflow/relay`），JSON：`{"sessionId","slot","text","mailId"?,"kind"?}`。
- 鉴权：只收 loopback 连接；请求头 `x-simflow-token` 必须等于 `tokenFile` 首行（≥32 字符，常量时间比较，每次请求重读，可随时轮换）。两条路由在宿主 WebServer 上以 `auth: 'anonymous'` 注册：SimFlow 不带浏览器会话或 API 凭据，loopback 检查与口令就是全部鉴权；沿用 WebServer 默认（`required`）会让请求在进入处理器前被 401/503 拒绝。
- 投递：与 `session` 工具 `send` 同一路径——活着的会话 `Agent.send(message, 'next-step', true)` 在下一步收到；空闲/仅落盘的会话经 Session Controller 恢复并唤醒。
- 模型可见内容：前导 `SimFlow 发来「<slot>」的消息：` ＋ SimFlow 自定义正文；消息源 `kind: 'simflow'`、`form: 'relay'`，**不带** `Message from another Session (...)` 前缀（两者不叠加）。
- 返回：`202 {ok, messageId, targetSessionId, targetStatus}`（`targetStatus`＝投递前 working/idle/stored）；失败一律 `{ok:false, reason, error}`、不投递：
  - `410 archived`：目标在 Workspace 中已归档。DSH 对归档会话仍会接受 `send`，但归档门拒绝其一切模型步，信会静默挂起——本插件在解析前后各查一次，具名拒收；
  - `404 not-found`、`409 subagent-owned`（会话归子代理运行时）、`409 stopped`（投递前停止）、`503 unavailable`；
  - `400/401/403/405/413`：请求形状、口令、非本机、方法、体积。
- 去重：同一 `(sessionId, mailId)` 只唤醒一次（最近 2048 条），重投返回 `200 {duplicate:true}`。
- SimFlow 侧（CL 30157/30165）：每次中继结果记为信箱 `relay` 事件；`archived/not-found/subagent-owned` 视为绑定失效，向总设计发一次“请更新名册”；`simflow chief mail relay-retry [--id]` 重投未成功的未归档信（绑定未改的失效信跳过）。

## 安装（用户操作）

```powershell
dsh plugin --profile <name> add C:\Project\deepseek-harness\fork-plugins\dsh-plugin-simflow-relay
```

`cordis.patch.yml` 已带默认配置：`tokenFile = D:\Ryan416_DESKTOP-LETT6RL_TheSunNeverSets\Tools\SimFlow\.data\relay-token`。安装后重启 DSH；SimFlow 侧把 `Tools/SimFlow/.data/relay.json` 的 `enabled` 改为 `true` 即开启。

## 测试

```powershell
node --import ./test/register.mjs --test test/relay.test.mjs
```

（测试经 `test/resolve-hooks.mjs` 把宿主提供的 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/schemastery` 映射到本仓库 checkout，无需安装 profile；`the carrier admits both routes anonymously` 用真实 `WebServer` 起服务，任一丢失 `auth: 'anonymous'` 时以 503 失败。）
