# claude-account-client — 纯单账号维护客户端

[English](README.md) | 中文

`src/claude-account-client/` 是给 Mac 池 direct worker 用的**协议读写客户端**：token（authorize URL／code exchange／refresh）、strict profile、managed settings 基础 reader，以及它们共用的 transport／deadline 缝。它复用 `claude-core` 的 `readBoundedBody` 与 `CoreTransport` 契约、`claude-engine/failure-rules` 的版本拒绝词表；**不导入 `providers/**`**、不导入 DSH/Cordis。

权威来源：`providers/claude.ts`（token helpers／strict profile／`claudeSettingsFetch`）、`providers/claude-protocol.ts`（角色 header 表与端点）、`providers/claude-managed-settings.ts`（envelope 校验），固定源码证据 `R/phase34/business-followup/outbound-parity/fixed-source-evidence.json`（9 anchors，UTF-16 偏移 + chunk hash）与 `.../desktop-unavoidable-functions/managed-settings-addendum.json`（`adopted-request-construction`：settings 请求构造与 200/204/304/404 分支）。Mac 侧边界见 `C:/Project/mac-pool-design/COMMUNICATIONS.md`、`CONTRACTS.md`。

## 所有权边界

| 责任 | 归属 |
|---|---|
| 凭据选择、刷新 ticket、CAS 提交、pending→active 提升 | 调用方 `CredentialVault`（本模块只返回 typed grant，**不写任何 store**） |
| 账号调度、账号池、session pin、取消收束 | 调用方 worker／RequestCoordinator（本模块无 poll、无池、无 timer 轮询） |
| 出口代理、TLS、目标白名单 | 调用方注入的 transport／`EgressBroker`（本模块**不建代理、不 direct global fetch**） |
| `code`／`state` 的一次性 | 宿主（本模块每次调用发一个 POST，不声称 exactly-once） |
| settings 的「哪些键可执行／哪些必须阻断」 | 调用方 policy consumer（本模块只返回 envelope，不宣称任何键已执行） |
| 是否发请求的资格判定 | 调用方 `required`／`beforeRequest` hook（0 I/O、不读 active 凭据） |

## 导出 API

- `CLAUDE_ACCOUNT_CLIENT_PROFILE`：显式固定 profile（client id `9d1c250a-…2f5e`、plain UA `claude-code/2.1.288`、authorize/token/profile/settings 端点、scope 串）。**每个调用都要求显式传入**；`claudeAccountProfileFailure(profile)` 把 origin＋path 钉死，server 返回、env、页面都不能改 grant 目标。
- `buildOAuthAuthorization({profile, redirectUri, codeChallenge, state, scopes?})`：固定参数集与顺序（`code=true`、`response_type=code`、`S256`）；PKCE challenge 与 state 由调用方提供，`pkceCodeChallenge(verifier)` 只是便利 helper。profile 非固定或一次性输入为空 → throw（配置错误 fail loud）。
- `exchangeAuthorizationCode(input)` / `refreshTokenGrant(input)` → `ClaudeTokenOutcome`（`grant | not-required | cancelled | timeout | invalid_grant | refused | unreachable | invalid`）。
  - grant body 与 CC child 一致：code exchange 带 `code/redirect_uri/client_id/code_verifier/state`；refresh 带 `refresh_token/client_id/scope`，`refreshScopeString` 只去掉 `org:create_api_key`，其余 scope 原样保留。
  - 30s 上限**覆盖 POST 与 body 消费**（`CLAUDE_TOKEN_TIMEOUT_MS`），本模块自己 arm deadline（`ClaudeAccountTimers` 可注入，默认 `CLAUDE_SYSTEM_TIMERS`），并把 `timeoutMs` 交给注入的 transport；无默认 fetch。
  - 响应逐字段校验成 `ClaudeTokenGrant{accessToken, refreshToken?, expiresInSeconds?, scopes, account?}`，无 unchecked cast；端点明确给出永久 grant code（`invalid_grant`／`invalid_token`，写进 `failure.reason`，只取固定 allowlist 常量）才判 permanent。
  - **凭据销毁判据**：`claudeFailureDropsCredential(failure)` 只对 `failure.code === 'invalid_grant'` 返回 true。generic 401（`unauthorized`）、timeout、cancelled、unreachable 一律 false——worker **不得**据普通 401 销毁 Vault active，本模块也从不自己删凭据。
  - 失败只有固定 code，不携带 body，也不带 cause。
- `readClaudeStrictProfile(input)` → `ClaudeProfileOutcome`（`profile | not-required | withheld | cancelled | unauthorized | refused | unreachable | invalid`）。
  - GET `/api/oauth/profile`：Bearer + plain UA + `content-type: application/json` + `cache-control: no-cache`，10s，64 KiB 产品上界（本模块自有 bound，如实声明）。
  - `account.uuid`、`account.email`、`organization.uuid` 三者必需，否则 `invalid`；`billing_type` 取 **organization**；`complete` = organization billing_type 有值 ∧ account.created_at 有值 ∧ organization.subscription_created_at 非 null；`cc_onboarding_flags` 缺省归一为 `{}` 故不影响完整度；`subscriptionType` 可为 `null` 且独立于 complete。
  - 只返回安全投影＋presence flags（`accountCreated`/`subscriptionCreated`/`onboardingFlags`），不返回 raw date、flag body 或整份文档。
  - 版本拒绝（`client_version_unsupported`）**先于**任何重放判定，绝不吞成 missing；`expected` 身份（account／organization）不符 → `invalid` + `identity_mismatch`，不混旧身份。
  - 默认不 refresh；`reauthorize` 是调用方 hook，最多一次，重放结果仍按同一 `expected` 校验；`beforeRequest` 每次尝试前重判，`false` 即不发。
- `readClaudeManagedSettings(input)` → `ClaudeManagedSettingsOutcome`（`accepted | empty | unchanged | not-required | withheld | cancelled | unauthorized | refused | unreachable | invalid`）。
  - GET `/api/claude_code/settings`，settings 角色自己的 header：plain UA、`anthropic-beta: oauth-2025-04-20`、`accept: application/json`、`cache-control: no-cache`、`pragma: no-cache`，有缓存 checksum 时附 `if-none-match: "<checksum>"`（`claudeIfNoneMatch` 负责引号）。
  - `accepted` 返回 `{uuid, checksum, settings}`，`settings` 原样保留未知键；**syntax-only**：本模块不投影、不宣称执行，unsafe unknown 由调用方 consumer 决定。
  - 304 仅在本次确实发出 validator 时成立（否则 `invalid`/`unexpected_304`）；204/404 为空 sentinel；响应 `redirected` 一律拒绝；10s 上限，1 MiB 产品上界；短寿内存值，不 store、无 raw log。
- `exchangeClaudeRequest` / `ClaudeAccountTimers` / `ClaudeResponseBody` / `readClaudeBody` / `cancelClaudeBody`：每请求的 transport、deadline 与 body 释放。
  - 本模块**自己持有 body reader**（不用 `claude-core` 的 `readBoundedBody`：它一旦 `getReader()` 就无法从外部取消，而这里需要在 deadline／caller 胜出时真正取消那个 reader）。`reader.cancel()` 才会让 pending `read()` 结算并 `releaseLock()`；对 locked stream 调 `body.cancel()` 会 throw，那只说明「没取消成功」，不代表已释放。字节上界、截断判定、每条路径释放的语义与 core 一致。
  - deadline 或 caller abort 胜出时：先 `reader.cancel()`，再 **await 该 read 的 quiescence**（releaseLock 完成）才 return，因此返回 `timeout`／`cancelled` 时资源已真实释放。
  - `Promise.race` 输掉后 transport 才 resolve 的 response：scope 已 closed／expired／cancelled 时**立即 cancel 该 body 且不交给 handler**（`getReader()` 计数为 0），late promise 始终被 observe，不泄连接。
  - caller abort 由 scope 自身的 race 结算，**立即**返回 `cancelled`，不等 30s；deadline 同理返回 `timeout`。
  - 注入 transport 必须 honor `request.signal`（声明式义务，覆盖请求本身）；本模块持有的 response body 由本模块释放，不依赖 transport 履约。非合作的无限 native promise 不强求可中断——那是 cancel owner 的义务。

## 产品防护声明（有意差异）

`CLAUDE_TOKEN_BODY_LIMIT`（65536）、`CLAUDE_PROFILE_BODY_LIMIT`（65536）、`CLAUDE_SETTINGS_BODY_LIMIT`（1048576）是本模块**自有**的 body 字节上界，不是被分析客户端的固定源码常量（其 transport 没有该 cap）。超界即拒绝且不重取；body 内容不会进入 failure、日志或 cause。

## 运行平台声明

本模块 runtime 不造任何 Mac／OS 字段，只固定协议里的 plain UA 常量 `claude-code/2.1.288`。真实 Bun／macOS 平台标识、TLS、代理与预连接行为属于 engine 层，另按 `VALIDATION.md` 验收；本模块不声称与服务端接受或风控等价。

## 未实现（明确缺口）

- `policy_limits` 独立接口（在 `claude-core`）、组织 pin validate 轮询、HEAD 预连接、usage／bootstrap／files 角色。
- settings 的精确策略消费者与执行语义：按池能力另行注册，本模块只提供 envelope。
- 凭据提交、pending 提升、状态文件、会话日志：归 Mac 池的 `CredentialVault`／`DirectStore`。
