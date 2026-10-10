# RyanZhou416 Fork Maintenance Reference

## Summary

本文是 `RyanZhou416/deepseek-harness` 的 fork 维护真源，记录官方仓库之外仍需保留的源码行为、启动脚本、外置 DSH_HOME、插件补丁、会话数据红线、合并流程和验证入口。上游合并或插件升级不得只按文件覆盖；维护者必须逐项证明某个 fork 行为已由上游等价实现，才能删除对应代码、配置和测试。

本文描述本 fork 的已提交源码行为与仓库外运行层；真实 profile 的版本须以其 `package.json` 和安装目录核对。具体发布 SHA 以 `git rev-parse origin/master` 为准；尚未推送的分支不属于同事可取得的发布基线。

## Contents

- [Baseline](#baseline)
- [Safety rules](#safety-rules)
- [Source deltas](#source-deltas)
- [Runtime and plugins](#runtime-and-plugins)
- [Preservation matrix](#preservation-matrix)
- [Upstream merge procedure](#upstream-merge-procedure)
- [Plugin update procedure](#plugin-update-procedure)
- [Verification](#verification)
- [Known limitations](#known-limitations)

-----

## Baseline

### Git topology

| Subject | Current value | Meaning |
|---|---|---|
| Fork remote | `origin = https://github.com/RyanZhou416/deepseek-harness.git` | 唯一常规推送目标 |
| Official remote | `upstream = https://github.com/deepseek-ai/deepseek-harness.git` | 只用于 fetch 和合并官方 release tag |
| Published fork | `master` after local integration | `dsh-v0.1.7-rc.1` 官方结构、16 GiB Windows Host、长任务保护与 fork-maintained plugin 基线；精确 SHA 用 Git 查询 |
| Current official target | `dsh-v0.1.7-rc.1` on 2026-09-24 | 精确不可变 tag；不要改合并已越过该 tag 的 rolling `upstream/master` |
| AgentTeams subtree | `fork-plugins/dsh-agent-teams` | 上游 `v0.1.20` + 本 fork RC.1 私有适配与有界未读邮箱缓存 |
| Context subtree | `fork-plugins/dsh-context` | 上游 `v0.55.0` + 本 fork 字段级投影、V4 header 计价和关闭 modal 性能优化 |
| Subscriptions subtree | `fork-plugins/dsh-plugin-subscriptions` | 上游 `v0.9.4` + 本 fork RC.1/V4 私有适配与 pinned Claude Code 2.1.288 wire；凭据与 Session 格式不变 |

当前维护的源码兼容基线是 `dsh-v0.1.7-rc.1`。整合采用官方 Agent 创建、handle-based Session persistence、Session format V4、通用 `session.updateQueue`、引用拥有的 Client Session、Plugin Manager、Subagent activation limits、cursorless Assistant frame、Web Terminal、SSH、MCP resources、Browser/Computer Use 和连接容错，再按本文的行为与测试补回仍缺失部分；后续合并禁止整体恢复旧版文件。

RC.1 的 `SESSION_FORMAT_VERSION` 为 `4`；只读 open 可以准备受支持的历史 generation，写 open 在验证后发布 v4 successor。第三方插件即使磁盘数据可读，也必须重新构建并在隔离 profile 验证逻辑 API；旧代文件不得原地改写。

### Local paths

| Purpose | Path |
|---|---|
| Source checkout | `C:\Project\deepseek-harness` |
| Real DSH_HOME | `C:\Project\deepseek-harness-data` |
| Web profile | `C:\Project\deepseek-harness-data\profiles\web` |
| Diagnostics | `C:\Project\deepseek-harness-data\diagnostics` |
| Isolated process workers | `C:\Project\deepseek-harness-data\process-workers` |
| Isolated validation home | `C:\Project\deepseek-harness-data\validation-home` and separately created validation copies |

### Working-tree protection

Continuable-subagent Queue edit/remove/steer 由 alpha.2 的通用 `session.updateQueue`、Session Remote、Queue Dock 与快照覆盖；fork 的旧 `subagents.updateQueuedByParent` 已删除。任何后续上游合并前仍必须检查 `git status --short --branch`；若出现新的在制修改，先提交到独立 `backup/wip-before-<tag>-<date>` 分支并推送 `origin`，禁止只依赖 stash。

-----

## Safety rules

1. `C:\Project\deepseek-harness-data\sessions`、`attachments`、`storages`、`.credentials.yaml`、`settings.yaml`、`.anonymous-user-id` 和 `plugins` 是用户数据，不是可重建缓存。禁止删除、重命名、原地迁移或用验证副本覆盖。
2. AgentTeams 状态位于各工作区的 `.agent-teams\<teamId>\team.json` 与 `inbox\*.jsonl`。它不在 DSH_HOME 内，但同样属于会话成果和恢复数据，任何代码 clean 都不得触碰。
3. 会话或插件格式升级必须先复制到隔离 DSH_HOME 验证。integration 版本第一次启动禁止直接指向真实 DSH_HOME。
4. Fork 改动不得新增或修改 Session event type、`SESSION_FORMAT_VERSION`、JSONL/Zstd 路径或物理布局，除非用户明确批准迁移并已有可逆备份。当前已提交 fork 没有这些格式变化。
5. Host 内存压力不得触发静默自动重启。watchdog 可以优雅关闭并落盘，前端必须显示断线，恢复由用户手动启动。
6. 上游冲突采用“官方结构优先、fork 行为逐项重做”。Session、API、schema、包布局、生成文件和 lockfile 不得整树保留旧 fork 版本。
7. 外置 profile、preset、本地 tgz 和 DSH_HOME 不受 Git 保护；每次上游或插件更新前必须单独备份它们。
8. 测试默认使用 focused batches；单批性能或压力测试保持在 20 秒内，除非用户明确授权更长测试。完整构建可以按实际耗时运行。

-----

## Source deltas

### Stable prompt boundary for the subscription wire

`@deepseek-ai/dsh-system-prompt` gained an opt-in `stable` flag on section registrations and
`renderPromptSections`, and `GenerateOptions` gained `systemSections`, the rendered prompt
kept as its assembled sections. The fork's Claude subscription plugin groups the sections the
way the genuine client's prompt is shaped — shared text ahead of session-specific text — and
emits the client's cache layout: an unmarked identity block, a `scope: "global"` marker on the
shared side and a plain marker on the session side. The grouping lives in the plugin; the loop
renders and logs the prompt unchanged.

**Preservation rule.** Keep the addition additive. `renderPrompt`'s bytes, `system`,
`messages`, and every existing session event must stay exactly as upstream has them; a
provider must receive a byte-identical request whenever `systemStable` is absent, which is
every request that does not start with a stable section. Renaming or restructuring `system`
would change what every other provider sends.

**Focused verification.** `npx vitest run packages/core/system-prompt/tests/system-prompt.spec.ts`
covers the prefix invariant and the empty-stable case; the subscription plugin's own suite
covers the layout it derives from the split.

### Split backoff ceiling from accepted provider wait

`BackoffConfig` and `ResolvedRetryBackoff` in `@deepseek-ai/dsh-llm` gained an optional
`providerWaitMaxMs`, and `@deepseek-ai/dsh-llm-retry` bounds a provider-disclosed `Retry-After`
by it rather than by `maxDelayMs`. `maxDelayMs` bounds only the route's own exponential
backoff, and `providerWaitMaxMs` resolves to `maxDelayMs` when a policy omits it, so every
policy that omits the field behaves exactly as it does upstream. The subscription plugin sets
both: its Claude route backs off inside the client's 32-second ceiling while still sitting out
a provider-disclosed reset for the configured hours, and one field could not express both.

**Preservation rule.** Keep the addition optional and default-equal. A policy that omits
`providerWaitMaxMs` must resolve, retry, and serialize its policy key exactly as upstream does,
so no other provider's behavior, session events, or retry numbering change. Retain the
separation through merges: collapsing the two ceilings restores either a local backoff that can
grow into hours or a rate-limit wait that fails a turn the genuine client would sit out.

**Focused verification.** `npx vitest run packages/llm/llm/tests/retry-policy.spec.ts
packages/llm/llm-retry/tests` covers resolution, validation, policy-key serialization, and the
waited disclosed reset. The subscription plugin's `test/rate-limit.spec.ts` covers both
ceilings per route.

### Tool-search block round-trip (subscriptions)

The Claude subscription route can request Anthropic's tool-search tool when a tool declares
`deferLoading`, and the response then carries `server_tool_use` (assistant) and
`tool_search_tool_result` (user) blocks. A request that drops them is missing blocks the API
expects, so the plugin's Anthropic translator captures both while streaming, records them on
the assistant message's replay envelope as `response.serverBlocks` entries of
`{ index, block }`, and splices each block back verbatim ahead of the visible harness block at
its recorded index when the next request is built. `@tormentalabs/claude-code-wire-compat` —
the fork's own wire library, outside this repository — accepts both block types in its message
whitelist and enforces the same pairing invariant it applies to `tool_use`/`tool_result`: a
result whose call id has no `server_tool_use` in the same request is invalid input. The
envelope keeps `kind: 'claude'` and `version: 1`, and a message whose envelope carries no
`serverBlocks` produces output identical to one built before this feature.

**Preservation rule.** Keep the library's block whitelist and the plugin's capture and replay
in step: the plugin's request building reaches these blocks only when the installed library
knows them, so an upstream merge that rewrites either side must keep both. Envelope entries are
optional and index-based; do not renumber or reorder the existing per-index entries, and do not
emplace a placeholder block in the visible message to hold a position — the message builder
drops an empty text block.

**Focused verification.** `npx vitest run test/validation/content-blocks.test.ts` in the wire
library covers the verbatim round trip, preserved extra keys, and the unpaired-rejection
invariant. The plugin's `test/translate.spec.ts` covers streaming capture with insertion
positions, the chained stream-to-rebuild replay, and the no-capture case.

### Claude proxy-only egress

`DSH_CLAUDE_PROXY_URL` 为 `dsh-http-proxy` 的 Claude 域名提供不允许 `NO_PROXY` 绕过的专用代理路由，非法配置拒绝启动，代理连接失败不回退直连。域名范围和保护边界以[包说明](packages/util/http-proxy/README.md#protected-claude-destinations)为准；这是显式代理保护，不检查 TUN 或最终公网出口。该变量只允许启动环境和 DSH_HOME 的 `.env` 提供，项目 `.env` 不能改写它。保留 `policy.spec.ts`、`claude-egress.spec.ts` 和 app-boot 的来源校验测试。运行中 Host 的配置尚未启用该源码功能；须停机后构建并在本机配置代理地址，不能仅凭 TUN 网卡存在就放行。

### Subscription pool scheduling

订阅插件的源码调度策略由 `pool.scheduling` 控制：Claude 与 ChatGPT 的临近重置、ChatGPT 的余额收尾及重置卡条件均采用有限加权，并用当前账号的活跃池请求数惩罚拥挤。保留按会话、提供方与模型池区分的粘性，统一按调整后评分应用切换门槛，首个输出后不切账号。并发预约覆盖首字节等待并在每条退出路径释放；已过期窗口不按无限紧迫度计分。保留 `pool.spec.ts` 的并发屏障和 `snapshots/session/subscription-pool-routing`。该策略包含在 `0.9.4-dsh017rc1.14` 制品中；部署须在 Host 停止后升级插件制品及版本固定记录。

ChatGPT 源码提供默认关闭的 `autoResetCredits` 开关，入口为订阅账号管理。当前账号额度耗尽且其可用卡在所有已登录 ChatGPT 账号中最早到期时才自动用卡，不要求其他账号也耗尽。保留全账号最新卡列表比较、使用前最新额度复核、手动/自动串行与落盘防重复记录；开关不能被模型编辑器的旧副本覆盖。验证入口为 `codex-auto-reset.spec.ts`、设置/RPC 与池测试、`account-manager-browser.mjs` 和上述无密钥会话回放。`0.9.4-dsh017rc1.14` 包含该功能，默认关闭，禁止在 Host 运行时替换安装目录；具体规则以[插件 README](fork-plugins/dsh-plugin-subscriptions/README.md)为准。

订阅网络重试修复保留原始提供方策略穿过 `AccountPreferencesAdapter`，使十次重试、指数退避与抖动到达 Host。账号池中仍可请求的成员发生网络故障时，必须保留该成员的错误，不得把其他成员的额度或认证冷却附在它上面，造成超出等待上限而终止。保留账号尝试顺序的双向回归、策略透传测试，以及 `subscription-network-retry` 无密钥会话回放。该修复随 `0.9.4-dsh017rc1.14` 制品发布；安装须在 Host 停止后进行。

### Model-specific request images

`dsh-llm.prepareRequestImages` shares retained-occurrence counting and per-attachment preparation across DeepSeek, pi-ai and subscription routes. Preserve immutable normalized attachments, count repeated user/tool images separately, exclude logged offloads, and derive each request from its current model route. Anthropic Messages and the Claude subscription adapter apply the 20/21-image dimension boundary; Claude also checks model image-count limits and exact JSON request bytes before dispatch. Compatible variants remain cached; changing models does not enlarge a previous preview or revive offloaded history. Focused checks: `llm/tests/request-images.spec.ts`, pi-ai context/routing tests, and `fork-plugins/dsh-plugin-subscriptions/test/image-policy.spec.ts`. Deployment requires rebuilding the matching Harness and pinned subscription artifact after the Host stops; source edits do not update the installed tarball.

### Pinned Claude Code wire (subscriptions)

订阅插件的 Claude 聊天请求全部经 `@tormentalabs/claude-code-wire-compat`(fork 精确固定 `0.7.2-dsh14`,GPL-3.0-or-later,私有制品不对外分发)按 pinned `CLAUDE_CODE_2_1_288_PROFILE`(CLI 2.1.288 / SDK 0.128.0)构建:billing 指纹块与 identity system 块、beta 组合、`metadata.user_id` 关联三元组、cache breakpoint 与完整头部计划均由构建器拥有,不得再手写 `anthropic-beta`/`x-app`/缓存标记。保留 `cacheControl` 四开关并带 `ttl: '1h'`(真实客户端出厂值),thinking 的 `display: 'summarized'`、effort 与 `output_config` 同发;构建器按 pinned 目录校验两者。不发 `accept` 头(真实客户端不发)。

身份:`sessionId` 取 harness 会话 id(缺失时每请求 UUID),`deviceId`/`accountUuid` 存于 `ClaudeSession`(登录时铸造/发现,刷新保留,旧会话首用懒回填;回填失败以 `INVALID_REQUEST` 明确失败,不发送伪造三元组);`deviceId` 按真实客户端格式铸造为 64 位十六进制(32 随机字节),绝非 UUID。`previousRequestId` 把响应 `request-id` 头链入下一请求 billing 块的 `cc_prev_req`,按(规范账号, wire 会话)分键,池在同一会话内切换账号绝不会把另一账号的 request-id 链进来(共 256 条上限);响应缺头时清除链路。`cc_prompt_id` 由(会话, 轮次)确定性派生(`claudePromptId`):同一会话同一轮次必得同一 id、请求字节也相同,另一会话或下一轮则不同 —— 它是**模型可见**的值,DSH 的"模型可见⟺已记录"要求它可重建,随机 UUID 无法重建。该轮的工具续步复用同一 id;probe/标题辅助请求的抑制未建模。响应 `request-id` 头另记入该助手消息的回放信封(`response.requestId`),与 `cc_prev_req` 链路互为可核对的两侧。池切换还会滚动 wire 会话 id(`claudeWireSessionId`,共 256 条上限):harness 会话的第一个账号段沿用 harness 会话 id 逐字不变(单账号会话字节不变),之后的每个账号段铸新 UUID,使一段对话不会横跨两个账号身份;切回原账号恢复原 id 与原链。构建器 `INPUT_TOO_LARGE` 经 `oversizeWireError` 映射回已记录的图片 offload 错误,精确 32 MB 检查保留在 `assertClaudeRequestBytes`;其余构建器拒绝码经 `mapClaudeWireError` 映射为带 wire 码与解释的 `INVALID_REQUEST`(`INVALID_EFFORT`/`INVALID_THINKING`/`UNSUPPORTED_CAPABILITY`/`CRYPTO_UNAVAILABLE`/`INVALID_IDENTITY`/`INVALID_UNICODE`,其余走默认),不得以通用 transport 失败示人。中途 system 消息在所有模型上以 user 角色 `<system-reminder>` 形式随历史就位(新 wire 无 system 角色消息),DSH 侧 `systemPromptUpdate: 'in-history'` 分辨率不变。usage/models/Files 端点改用 pinned profile 的 CLI user-agent;本地 `claude --version` 探测已删除。装配请求时补齐缺失的 `tool_result`:请求内没有任何结果应答的 `tool_use` 才按真实客户端原位合成 `is_error: true` 的 `[Tool result missing due to internal error]`(结果已在请求别处出现则不合成,只改装配请求、不改历史,与 `tool-pairing.ts` 对其它 wire 的全局配对一致);Files API 上传缓存按(规范账号, 内容 sha256)分键并限 256 条,登录/登出随该账号缓存一起清除,池切换绝不复用其它账号的 file id;Claude/Codex/Grok 的 code 与 refresh 授予请求一律 `redirect: 'error'`,不得跟随重定向把 code 或 refresh token 重放到另一来源。聚焦验证:`test/claude-wire.spec.ts`、更新后的 `test/translate.spec.ts` 与 `test/models.spec.ts`(全部注入 fetch、零凭据),授予重定向与上传缓存另见 `test/codex.spec.ts`、`test/grok.spec.ts`。已随 `0.9.4-dsh017rc1.14` 构建;部署走 `fork-plugins/deploy-subscriptions-web.ps1`:停 Host 后在普通 PowerShell 运行,脚本校验 sha256、Host 监听护栏、自动备份已装副本与 `package.json`/`pnpm-lock.yaml`,并用 `pnpm add` 更新 profile 的 file 固定引用(避免后续 `pnpm install` 降级),不触碰 `DSH_HOME\plugins\subscriptions` 凭据目录;回滚用旧 tgz 走同样的 `pnpm add` 形式。

### Goal disabled by default

所有内置 base-backed profile 关闭 Goal 服务、自动续跑、模型工具与命令；Web 预设和目标栏也关闭。`goal-disabled` 准入插件阻止已排队的 Goal 轮次和收尾通知进入新模型请求，混合输入保留普通消息，旧 Goal 日志不改写。Goal 实现和历史格式仍保留，专用测试以显式 opt-in 组合继续覆盖它。

部署前须在 Host 停止后同步外置 `chatgpt-dsh` 预设，禁用其 `command-goal` 与 `tool-goal` 两行。不得清空既有 Goal、会话或缓存来完成禁用。保留 `goal-round-driver/tests/disabled.spec.ts`、`apps/web/tests/goal-disabled.e2e.ts`、Web 预设组合测试和 `goal-disabled` 记录会话；合并上游时不得只关闭模型工具而恢复自动驱动。

### Latest user-message revision

Chat edits the latest ordinary text-only user message in its existing idle Session with no pending input. `session.editLastMessage` admits a durable queued revision; `agent/prepare-input` excludes the obsolete suffix before context assembly, and `agent/message-surface` finalizes the normally processed input at request admission. Preserve the Session identity and current model, strict exclusion of the old prompt and response from derived history, retry identity across request preparation, and hidden superseded Chat rows after reload. Original log events and spent-token totals remain; filesystem effects are not rolled back. Focused verification lives in `packages/api/session-controller/tests/edit-last-message.host.spec.ts`, Chat conversation-node tests, and the Web message-actions scenario.

### Long-session Host allocation

#### Incremental token accounting

官方 `packages/llm/token-meter/src/index.ts` 保存精确 consumed offset，并只通过 indexed Session 读取未消费记录。它已经消除每次 event 的整日志 materialization，因此不得恢复 fork 原有 direct-event fast path 与整日志 fallback。

#### Persistence write-behind ownership

`packages/session/session-persistence-jsonl/src/storage.ts` 的 live route 复用 `Session.append()` 已 detached/deep-frozen 的 event；公开 `SessionHandle.append()` 仍在异步排队前复制 borrowed input。写批次通过交换 backing array 在 O(1) 转移，失败时把原批次放回队首并保持顺序。

上游替代必须同时保证 immutable ownership、O(1) batch detach 和失败重放顺序；单纯缓存 Session snapshot 不等价。

#### JSONL/Zstd metadata cache

`packages/session/session-persistence-jsonl/src/index.ts` 以精确 selected-generation revision 缓存验证后的 header，并让并发 `list()` caller 共享一次 discovery。单个 caller abort 只取消自己的等待；revision 变化会重新验证，删除路径会清理 cache，返回值保持 detached。

该优化不改变 JSONL/Zstd 文件格式。上游替代必须能识别 append、replace、delete，并且不能让一个 caller 的取消终止所有并发 caller。

#### Decoded cold-log retention

`packages/session/session-persistence-jsonl/src/index.ts` 的 revision-keyed `coldLogMemo` 最多保留两份已解码日志，默认 `coldLogMemoRetentionMs=10000`；命中会重置空闲计时，过期、写入失效、LRU 淘汰和插件卸载都会释放引用及 timer。`0` 禁用 completed-result memo，当前格式的单个 read handle 因而可能重复解码。read-only 历史迁移仍复用 in-flight preparation，紧接着的 observe-to-resume 交接仍可共享一次解码；超过空闲窗口后重新解码。

上游替代必须同时保持 revision 校验、交接期复用、空闲时间与条目数上限、失效和卸载清理；仅限制条目数会让两份数百 MiB 的历史无限期驻留。此项只改变内存留存，不改变 Session 文件或 migration 发布规则。

#### Current-generation decode sharing

`packages/session/session-persistence-jsonl/src/index.ts` 在当前代际缓存未命中时，按 Session id、物理路径和 stat 修订合并同时进行的 `open`/`read` 解码。各调用者独立取消等待；最后一个等待者离开才取消底层读取，文件修订变化会启动独立解码。完成后仍由既有短时 memo 负责 observe-to-resume 交接，不延长已完成日志的保留时间。

上游替代必须保留同修订单次读取、跨修订隔离、独立取消与最后等待者取消；该共享只降低并发完整解码的峰值，不等于分页读取，也不释放运行中 Agent 的完整 Session 历史。聚焦验证为 `pnpm exec vitest run packages/session/session-persistence-jsonl/tests/jsonl.spec.ts -t 'current-generation decode|current-generation reader'`。

#### Session-owned fork prefix sharing

`packages/core/session/src/index.ts` 用模块私有 `WeakSet` 标记 Session 已经拥有并深度冻结的 event 标识。普通调用方 seed 仍执行无损 JSON 快照与深度冻结；来自 live Session 的 fork 前缀则在独立的父级与子级日志数组中共享这些不可变 event 对象，后续 append 只增长各自数组。生产 `shared-frozen` restore 的已冻结 event 也进入该可信集合，`detached` restore 不会被推断为可共享。

上游替代必须保留外部 seed 的引用隔离、共享 event 的深度不可变性、父子数组独立增长和 restore aliasing 语义。只用 `Object.isFrozen()` 接受任意外部 shallow-frozen event 不等价。44,600-event 本地 corpus 中，父 Session 约 339 MiB；两个 fork 从原来的约 488/638 MiB 降至约 341/341 MiB。聚焦验证为 `pnpm exec vitest run packages/core/session/tests/fork.spec.ts packages/core/session/tests/session.spec.ts`。

#### Cold Session observation retention

`packages/session-query/session-query/src/observation.ts` 与 `packages/session-query/session-query-sqlite/src/index.ts` 在既有五条目 LRU 上增加 `preparedSessionCacheMaxArtifactBytes=4194304`：first-party persistence 报告的物理文件超过门槛时照常读取，但最后一个观察租约释放后不再缓存完整 prepared Session。Session 转为 live 时立即撤掉同 id 的冷缓存引用；已经发出的观察租约仍持有自己的精确 cut。未报告文件大小的 provider 仍由条目数限制。

上游替代必须保留完整读取、revision/实例匹配、活跃租约独立性、live 切换失效和大文件不长期缓存；物理文件门槛不等于解码后 heap 上限。

#### Resume projection checkpoint seeding

`packages/core/agent-loop` 的 `resume` 在 `sessions.prepare()` 之后调用可选的 `ctx.sessionProjectionCache.hydratePrepared(session, seed)`，与 session-query 冷观察的预置方式相同；包对 `dsh-session-projection-cache` 是可选 peer。旧路径中 resume 不读取检查点，`ReactLoopAgent` 构造时首次 `stateOf()` 会在事件循环上把全部投影单元从 seq 0 同步折叠整份日志，token meter 与 `dsh-context` 占其大部分。缓存行身份不符、版本不符或超出日志末尾时只有对应单元从头折叠，代价与旧路径相同。

`session-switch.stress.ts`（6 万事件目标、16 个 root 持续流式、fork 插件）中，经侧栏切换到已驱逐长 Session 时 Host 事件循环最长阻塞由 6.4–7.1 s 降为 0.30–0.54 s，页面显示耗时不变；修复前剖面 54% 在 resume 构造的全量折叠，修复后剩余主要为日志解码。真实最大 Session 的压缩日志约为该测试目标的 8 倍。回归为 `resume.spec.ts` 的 `seeds projection cells from the projection cache instead of folding the stored log`，旧实现失败。合并上游时保留 resume 的检查点预置；上游若把预置移入投影注册表或 Session 准备阶段，须覆盖 resume 与冷观察两条路径。

#### Cold-read event-loop slices

`packages/session/session-persistence-jsonl/src/index.ts` 的 `ZSTD_DECODE_YIELD_INTERVAL_MS` 由上游 500 改为 50：冷读取在 Zstandard 帧边界让出事件循环的间隔。解码之后，`decodeStoredLog()` 不再一次同步运行 `validateStoredEvents()` 与 `freezeStoredEvents()`，而由 `adoptStoredEventsCooperatively()` 先对整份日志运行 `assertStoredEventTypes()`，再逐条 `adoptStoredEvent()` 并深冻结，按同一间隔让出并在让出后检查取消。`packages/session/session-persistence` 为此把 `validateStoredEvents()` 拆成这两个导出函数，原函数行为不变；类型检查先覆盖整份日志，所以较新版本写入的日志仍按 unsupported 而非 corruption 拒绝。旧格式一次性迁移路径与 `MIGRATION_DECODE_YIELD_INTERVAL_MS` 保持上游行为。

真实最大三份 Session（6.3–8.7 万事件、69–75 MiB zstd）单独解码各需 1.06–1.41 s、单帧最长 8–13 ms，解码后的采纳与冻结另需 154–218 ms；500 ms 间隔下其他 Session 的流式输出与输入回显会连续停顿两到三次约 0.5 s，随后再停顿约 0.2 s。改后解码与采纳切片均不超过约 50 ms，类型检查 2–4 ms。同一 `session-switch.stress.ts`（fork 插件）中，冷切换的 Host 事件循环最长阻塞由 382–492 ms 降为仅改间隔时的 138–204 ms，再降为 110–158 ms，解码总 CPU 时间与页面显示耗时不变。剩余阻塞主要来自核心 `sessions.prepare()`（真实 Session 64–116 ms）、投影检查点预置与首帧构建。回归为 `jsonl.spec.ts` 的 `adopts a cold log in event-loop slices` 与 `stops cold-log adoption when its last reader cancels`，以及 `storage-contract.spec.ts` 的 `refuses a later unknown event type ahead of an earlier damaged record`；去掉采纳让出时前两者失败。合并上游时保留 50 ms 切片与类型检查先于逐条采纳的顺序，除非上游给出覆盖长 Session 冷读取的同等或更短切片。

#### SQLite live search and bounded pages

`packages/session-query/session-query/src/documents.ts` 与 `packages/session-query/session-query-sqlite/src/index.ts` 用 live Session object identity、event count 和 canonical surface replacement generation 区分 append-only suffix 与 replacement。安全 append 只索引新增 documents；replacement 或 lifecycle 变化执行完整 fold。

Session search 和 event search 使用 exact-generation/request/cursor key 的 item-weighted LRU；两个 cache 均受现有 `maxLimit` 限制，并向 caller 返回 detached copy。上游替代必须同时保持 suffix reconciliation、replacement rejection 和 bounded ownership-safe result cache。

### Runtime residency bounds

#### Idle Web Agent eviction

`packages/api/session-controller/src/agent.ts`、`index.ts`、`history.ts` 和 `commands.ts` 让 Session Controller 持有其 create/resume/fork 的 `AgentHandle`。默认 `idleSessionRetentionMs=300000`；只有 durable、idle、无 pending inbox、无 live child、无 running/stopping job 的 owned Agent 才进入计时。history follower 仅在开场帧交付期间暂时阻止计时，不再使已打开的空闲 Session 永久驻留。

到期路径先 `sessions.flush()`，再验证 persistence snapshot，最后只 dispose Controller 自己持有的 handle；Session list row 与磁盘日志保留，下次操作 cold resume。无 persistence 时不淘汰，配置 `0` 可禁用。它是 residency 回收，不是 Agent 并发限制。

上游替代必须保持 opening-only follower pin、child/inbox/job exclusions、flush、持久化证明、list row 保留和 cold resume；简单 LRU 或无证明的 timer dispose 不等价。

#### History follow opening ownership

`packages/api/session-controller/src/history.ts` 在交付首帧前完成完整历史观察与 message-aligned page，首帧只携带所需页面、header 和 projection baseline。完整观察在 generator 长期等待事件前释放；prepared Session 的独立 promotion 租约只保留到首帧交付并转交后台激活，取消或同步激活失败会释放该租约。首帧交付后 follower 放开 Agent residency pin，仍监听 `session/event`、`session/created` 与可选的 Assistant frame，因此空闲 Agent 淘汰及之后冷恢复不会截断历史流。

上游替代必须验证首帧 cut、帧 ordinal、后续事件连续性、开场取消和 promotion 失败的单次释放；把 `using` 观察留在 async generator 的长期循环中会重新持有整份历史。

#### Reference-owned Client Sessions

Alpha.2 的 `packages/api/session-controller/src/client/sessions/service.ts` 通过带 source 标签的 `retain()` 管理 Client Session generation。工作区 `mainView` reference 拥有当前选中会话；最后一个 reference 释放时，Controller 会先撤回 binding 与 Agent-scoped Context，再异步释放 Session 与 detailed-history stream。目录元数据和 per-Session projection store 位于 instance 之外，替代 generation 可以安全复用这些投影值。

同 id generation 替换、opening cancellation 与延迟 teardown 均有 identity guard；旧 cleanup 无法撤回新 binding。该官方模型同时释放 off-stage window、scoped feature state 和 Host follower，因此 fork 不再恢复 `suspendHistory()` 或保留无 Consumer 的 Session instance。

#### Terminal jobs retention

`packages/jobs/jobs-local` 新增可选 `terminalJobRetentionMs` 与 `maxRetainedTerminalJobsPerOwner`。包默认省略两项以保持上游行为；shipped base profile 配置为一小时 TTL 和每个 exact owner 100 条 terminal target。

Count pruning 只删除模型已通过 `job_output` 读取的最旧 completed/killed/failed records；仅等待状态或列出任务不算读取，unreported 记录保留到 TTL 或 teardown，running/stopping 永不参与。`src/retention.ts` 用 exact-owner bucket、只含 id/时间的轻量最小堆、一个 `unref()` 到期 timer 和一个合并的延期裁剪 timer，避免每次全表 scan/sort；刚结算的 id 不在其结算信号内被数量裁剪，空索引会清理 timer。

共享的到期与延期裁剪 timer 必须在不携带 Agent initiator 的异步上下文中创建和续建。`LocalJobRegistry` 在初始化时通过 `agents.withoutInitiator()` 捕获调度上下文，避免首个结算任务的已销毁 Agent 随共享 timer 长期驻留，也避免 teardown 期间再次开启 initiator scope。保留 `jobs.spec.ts` 对实际 Node Timeout 上下文、owner 删除后的续建、零目标延期裁剪的回归；2026-09-27 事故快照和隔离复现均确认旧路径可在 owner 条目删除后继续持有其 Session。

官方 `maxConcurrentJobsPerOwner=10` 管理 live jobs，`maxActiveSubagents=8` 管理 continuable child activation；两者都独立于 terminal Job 留存。上游替代必须有 terminal TTL/count、unreported protection、active exclusion 和有界维护算法。

#### Skill watcher initiator isolation

`packages/skill/skill-filesystem` 的 `SkillWatchManager` 在构造时通过 `agents.withoutInitiator()` 捕获不带 Agent initiator 的异步上下文（没有 `agents` 服务时使用构造时快照），并在该上下文中创建 chokidar 根监听和 `watchFile` 祖先轮询，重建监听同样经过这两处。Node 原生监听句柄持有创建时的 AsyncContextFrame；旧路径让首个触发技能发现的 Agent 连同整份 Session 日志随共享监听器驻留，每个被监听的根最多钉住一个已销毁 Agent。

隔离 Web 复现（shipped 组合、4 个 root、2 轮、1,500 事件种子）中，修复前两次各残留 1 个 Agent 及其 Session，持有链为 Global handles → AsyncContextFrame → ReactLoopAgent；修复后两次均为 0。加入冷恢复子 Agent 的 `send_message`、`session_send_message` 与 `workflow` 后，在隔离监听器的条件下 140 个 Agent 全部回收，没有发现其他留存路径。真实实例 2026-09-30 至 10-01 的 37 小时记录中，已销毁仍存活 Agent 从 7 个增至 48 个，其事件从 11.7 万条增至 152 万条，JS 堆从约 4 GiB 增至 14 GiB；这些留存与本修复的对应程度须用修复后 `memory-ownership.ndjson` 的 `agentsDisposedRetainedOver60s` 复核。回归为 `skill-filesystem-watcher.spec.ts` 的 `opens shared watchers outside the Agent whose discovery requested them`。合并上游时保留监听器创建与重建的中性上下文，以及包对 `@deepseek-ai/dsh-agent` 的 peer/dev 依赖。

#### Agent initiator weak reference

`packages/core/agent` 的 `AgentRegistry.initiators` 在 `AsyncLocalStorage` 中保存 `WeakRef<Agent>`，`currentInitiator()` 读取时解引用；live Agent 仍由注册表强持有，所以运行期间的归属不变，只有已被注册表移除且无其他引用的 Agent 才会读成 `undefined`。Node 24 的每个原生句柄（socket、Timeout、FSEvent）都持有创建时的 AsyncContextFrame，此 ALS 是该 frame 到 Agent 的唯一强边；按句柄逐一改用中性上下文（如上面的 jobs 与 skill watcher）无法覆盖依赖内部创建的句柄。

2026-10-03 只读检查运行约 24 小时的实例：149 个指向本机代理端口的 Undici CONNECT 隧道 socket 停在 CLOSE_WAIT 且从未销毁，其出现时段与长期留存 Agent 从 3 个升至 14 个相符；Undici 的进程级 `fastNowTimeout` 也会续用首个请求的上下文。隧道未关闭的根因尚未定位，本补丁只切断 Agent 留存，不回收 socket 本身。隔离 lifetime 压测加 `DSH_LIFETIME_LEAK_HANDLES=1`（每次模型调用开一个永不关闭的 timer，4 root × 2 轮、3 子 Agent）中，旧实现残留 24 个 Agent 与 24 个 Session，持有链为 Timeout → AsyncContextFrame → ReactLoopAgent；弱引用后为 0。回归为 `agent-initiator.spec.ts` 的 `lets an Agent be collected while a handle opened under it stays active`，旧实现失败。合并上游时保留 ALS 中的弱引用和注册表对 live Agent 的强持有；上游若改为在 ALS 中保存其他持有 Agent 的对象，也须保持弱引用。

#### Read window line detachment

`packages/fs/tool-fs/src/read-render.ts` 的 `buildWindow` 用 `structuredClone` 复制每条保留的窗口行。V8 子串与父串共享存储，旧路径中 `read` 结果的 `meta.lines` 随 live Session 事件常驻，返回的少量行会钉住整份解码后的文件文本；`snapshotJsonValue` 不复制字符串，因此结果快照不会切断这条引用。模型可见文本、展示元数据和会话日志不变。

运行 28.6 小时的真实实例（37 个 live Session、141 万事件、堆 9.2 GiB）退出前的存活分配采样中，`fs-local` `readWholeText` 解码的文本仍存活约 968 MiB，占堆 10.3%。回归为 `read-render.spec.ts` 的 `keeps returned lines without retaining the decoded file they came from`；旧实现在 20 份约 4 MB 文本各取 20 行后留存约 77 MiB 并失败。合并上游时保留窗口行与输入 chunk 的存储分离；复制方式须逐字保留孤立代理项，`Buffer` UTF-8 往返不等价。

### Per-record storage load concurrency

`packages/storage/storage-json/src/per-record-unit.ts` 的 `loadTableRecords` 以 `RECORD_LOAD_CONCURRENCY`（64）为上限读取记录文档。上游的并发加载对整张表无界 `Promise.all`；真实 `session_projcache` 约 1 万条记录时，Windows 进程在约 8192 个描述符处 EMFILE，同期启动的 `connection` 打开 `.credentials.yaml.lock` 失败，Web 启动中止。Windows 上 `wx` 创建在描述符分配失败前已落盘，会留下 0 字节孤儿锁；`withFileLock` 不回收孤儿锁，确认无 DSH 进程后由操作者删除。被 EMFILE 打断的记录按 per-record 契约读作缺失，只退化为从日志重折叠。回归为 `per-record-load-concurrency.spec.ts`；旧实现同时打开全部 300 个文档并失败。合并上游时保留有界读取，除非上游已以等价方式限制并发。

### Client rendering and connection state

#### Projection update work

`ui-subagent` 的关闭目录触发器只订阅所属 root 的目录与直接子项运行状态；完整树的订阅、映射和展开状态由打开时才挂载的菜单持有。保留关闭态数量、名称、运行状态的即时更新，以及悬停、固定展开、键盘、焦点恢复、逐级加载和导航。合并上游时不能把完整 `projectionsBySession`、`byId` 和 status Map 的订阅重新放回关闭态组件；相关状态变化与无关状态不触发重渲染都有真实 store 回归。

`SessionManager` 与 `ClientSessions` 复用未变的投影包装对象、目录行、成员数组和映射。旧序号、相同序号以及未改变任何数据的 baseline 不再触发全局目录刷新；首次出现的空 baseline 仍发布新成员。单个 Session 的键级投影仍在微任务内发布并立即可读；全局目录的投影刷新按[目录按帧合并](#catalog-frame-coalescing)发布。连接代际、冷缓存优先级和引用生命周期保持原语义，没有丢弃 Host 控制帧。后续增加可观察字段时，必须同时更新包装与等值比较。

`session-projection-cache` 的实时写入接管注册表已经深拷贝的 checkpoint，只继续执行无损 JSON 校验；冷恢复的状态可能与返回视图共享引用，因此仍执行分离复制。检查点仍在日志 flush 前截取，并在日志持久化后才写入缓存；创建、轮次结束、销毁以及 count/interval 写入时机不变。合并时保留这两条所有权路径的区分，以及等待 flush 期间修改实时状态、冷读取返回后修改输入、非法 JSON、写入失败和退出清理回归。若上游取消注册表 checkpoint 的深拷贝保证，实时缓存路径必须同步恢复复制。

2026-09-28 的合成对照中，256 个 Session、24 个更新源、96 次有效更新和 96 次重放，通知由 192 次降为 96 次，目录行与投影包装的引用变化均由 49,152 次降为 96 次，成员数组变化由 192 次降为 0；这些是确定性传播计数，不是浏览器帧率。真实构建产物的 checkpoint 诊断使用 18 个 Session、8 个投影、每投影 256 个嵌套条目，每组运行三个新 Node 进程：CPU 中位数由 421 ms 降到 265 ms，重新引入原实现为 375 ms；wall 中位数分别为 322、283、385 ms。所有样本写出的 18 份缓存文件内容摘要和总字节数完全相同。诊断包含真实 JSON 存储，但排除准备、验证和清理；GC 后内存为端点读数，不代表瞬时峰值。传播计数由 [sessions-service.client.spec.ts](packages/api/session-controller/tests/sessions-service.client.spec.ts) 的 `limits catalog invalidation to sessions with accepted control updates` 用例调用 [projection-update-work.perf.client.ts](packages/api/session-controller/tests/projection-update-work.perf.client.ts)；持久化诊断入口为 [checkpoint-write.perf.ts](packages/session/session-projection-cache/tests/checkpoint-write.perf.ts)。

#### Status and catalog derivation

`ui-session` 在一次 list cut 内集中协调 running、成员与完成未读状态，最多同步发布一次；独立 Remote status 事件仍立即发布。没有状态变化的 projection-only 更新跳过状态 Map 重建。保留首次 baseline 前 idle 事件、未知子代理 running、主视图完成确认、人工交互优先级及卸载清理；32 个 Session 同批变化的确定性回归将状态通知从 32 次降为 1 次，32 行无关投影刷新中的 list 读取从 35 次降为 2 次。上述是工作次数，不是整页耗时。

Session Manager 的行缓存同时核对当前 summary、投影值、有效 blank、展示标题兜底与 depth；Host 成员、顺序和 parent link 未变时复用 lineage 结果。Client 主目录行用 manager entry 弱键与当前 retainedBy 复用，子目录标签覆盖和保留子项仍随后处理，不能直接复用 previousById 中已覆盖的行。缓存只保留当前输入，删除行时修剪，WeakMap 不独立保活旧 entry；公共不可变映射仍是线性构造。

聚焦回归位于 `ui-session/tests/ui-session.client.spec.ts`、`status-controller.client.spec.ts` 与 `session-controller/tests/manager.client.spec.ts`、`sessions-service.client.spec.ts`。256 个合成 Session、24 个更新源、96 次有效更新的对照中，lineage 遍历从 96 次降为 0 次，未命名会话的工作区标题派生从 24,576 次降为 96 次；保留原有有效更新通知和引用变化计数。父节点到达/移除/补全、子目录标签撤销、retain/release 后无关更新、旧快照不变及重连低序号/空标题均有行为验证。

#### Bounded catalog and sidebar work

静态 Client library 保留 `process.env.NODE_ENV` 表达式，由最终 Web shell 决定开发或生产分支；不能让中间 tsdown 构建提前固化为开发模式。生产 `set()` 跳过额外 deep freeze，开发构建仍执行检查；Immer 的 `update()` 语义不变。`scripts/client-bundle-purity.spec.ts` 用真实两段构建固定两种行为，旧 preset 会在该负对照失败。

Workspace 手动排序使用按 id 索引的双向节点和显式后序栈放置新 fork，放置阶段为 O(N)，前置的 recency 排序仍为 O(N log N)。保留 saved 相对顺序、pin/archive 分区、父子与兄弟顺序、缺失或成环 parent 和深链；完整 Ungrouped 顺序使用线性检查。当前 main Session 按 `byId` identity 计算一次并传给目录、flat/search 和行高亮；不能把 `mainView` 引用与 panel 高亮合并，也不能删除非当前显示模式仍需维护的 `activeSessionOrders`。回归位于 `ui-workspace/tests/tree.client.spec.ts` 和 `workspace-browser.client.spec.tsx`。构建产物的 1k/4k 合成对照中，三个新 Node 进程的 wall 中位数分别由 1.229/17.392 ms 降到 0.793/3.060 ms，顺序摘要相同；这是排序组件测量，不是整页帧率。

Session Controller 的 `listProjectionExcludeKeys` 默认 `[]`，保持上游和未知插件的完整提示值；fork Web 模板只排除已确认详情专用的 `contextHeaders` 与 `turnOutline`。注册表和 checkpoint cache 在 state 校验与 wire view 前执行可选排除，水位仅计实际服务的行；完整 follow、显式 projection、restore/hydrate 与持久行不受影响。`sessionListMetadata` 是 blank/recency 计算的必需输入，配置加载时禁止排除。合并上游时重查 Context Overview、schedule、subagent discovery、usage 和第三方提示消费者；详情键若新增目录消费者，需要同步改其按需读取。`fork-runtime/setup-profile.mjs` 只管理 controller 的该字段，保留其它配置与 `!!js` 原文；对无法安全定点更新的 flow/alias/重复配置报错并保持文件不动。

`sessionStats` 与 `contextPressure` 用弱状态键保留仅含标量的公开视图，私有计时/表面记账变化仍完整折叠；值不变时复用 raw view，避免无效全局帧。WeakMap value 不得反向持有 state、Session、Agent 或事件。未读取 cell 的首次已知值仍发布，随后仅私有变化才静默；registry 的双槽比较、日志水位及持久格式不变。`subagentTiming` 对同一记录时间的普通活跃事件复用状态，descriptor/turn 边界仍完整处理。

control carrier 已开始恢复且仍等待 baseline 时，新的 Host generation ready 复用该 opening；若 baseline 已先到或旧流仍健康，则继续 restart，确保清水位后有新 baseline。保留 delayed initial ready、两种 baseline/ready 顺序、terminal failure 和 dispose 回归；旧代码在 pending-recovery 负对照中开三条流，候选仅开两条。

#### Catalog frame coalescing

`SessionManager.handleControlFrame()` 与每个投影存储的任意键回调通过 `Notifier.markFrameDirty()` 标记全局目录：同一动画帧内的实时控制帧只重建一次 manager 列表快照，也只运行一次 `ClientSessions.projectList()`。每条 WebSocket 消息都是独立任务，原微任务批处理在高并发下等于每收到一帧就遍历一次完整目录；150 个运行 Agent 的合成浏览器剖面中，`Notifier.publish` 约每秒 1,700 次，占主线程约 46%。

键级投影面（包括决定输入框提交状态的 `inbox`）、`recordMutation()` 的结构性列表变化以及无 `requestAnimationFrame` 的环境仍按微任务发布；结构性变化会同时发布已累积的投影。后台标签页暂停动画帧时，目录中的投影显示延后到下一次结构性变化或回到前台。合并上游时保留按帧目录与微任务键级通道的区分，不得把 `inbox` 或输入框相关通道改为按帧。回归为 `sessions-service.client.spec.ts` 的 `publishes consecutive live control frames as one catalog rebuild per animation frame`：旧实现对 8 个连续控制帧发布 8 次，候选只发布 1 次。

#### Tool detail lazy materialization

`packages/client/ui-tool` 沿用官方 `ToolRow` 输入延迟格式化接口，并让通用结果通过 `outputNode` 保持原始 block 引用，折叠时只检查是否有输出、错误时只取首行；展开后才压平整个输出。`toolRowModel.output` 的按需 getter 缓存专门工具行明确读取的文本；专门 card model 仍按需复制大型数组。

RC.1 已延迟 generic Tool input formatting；fork 只补回仍缺失的 output flatten 与大型 card array lazy materialization。聚焦验证为 `packages/client/ui-tool/tests/tool-row.client.spec.tsx`。

#### Connection recovery under load

Loopback 页面与声明 `ownsHost` 的载体不按浏览器外网 `offline` 状态中断连接或暂停重试；远程页面仍保留原离线抑制策略。真正的载体失败、手动重连和销毁继续走原 Connection 生命周期。重试告警保留本次失败及其 cause；WebSocket 关闭错误附带关闭码、原因和 clean 标志，恢复后的下一次重试不复用旧错误。

Session control reader 遇到终止性协议或业务错误后仍报告失败，并且不在当前健康 generation 内无限重试；新的 Connection generation 创建新 reader。恢复期间的列表标题使用仅供展示的旧字符串，既有投影值与序号仍清空。当前 control baseline（包括缺 title）、成功显式投影读取或成功完整列表会结束对应兜底；连续重连、列表失败、删除与销毁有独立回归，不能把旧显示重新写成权威投影。

Gateway 每个 socket 只保留一枚待确认 Ping。未完成写入时，`bufferedAmount` 的实际下降重置连续停滞计数；写入完成后才开始等待 Pong。连续两个检查周期既无写入进展、或已发送 Ping 连续两个周期无 Pong，仍终止该 socket；Pong、关闭或旧写回调不能影响后续 probe。终止前保留 I/O poll 机会。合并上游时保留慢速排空与完全停滞的区分，不得通过无限等待或单纯加长超时替代。

单个大 write 的部分 TCP 传输不一定让 `bufferedAmount` 下降，仍可能达到有界停滞期限；不能把该修复描述为覆盖所有慢网络。Host 仅在心跳终止时记录 phase、reason 与 bufferedBytes，Client 的关闭码和原因由对应重试告警保留。

聚焦验证为 `packages/client/connection/tests/client-apply.client.spec.ts`、`connection.client.spec.ts`、`packages/api/gateway/tests/stream-server.host.spec.ts`、`gateway.client.spec.ts`、`packages/api/session-controller/tests/manager.client.spec.ts`、`client-apply.client.spec.ts` 和 `apps/web/tests/connection-recovery.e2e.ts`。浏览器验证使用测试私有 Host、已录制的合成 Session、受控列表/基线屏障和页面内网络事件，不操作用户网络或运行实例。

#### Global backend-disconnect overlay

`packages/client/ui-settings-general/src/client/ConnectionOverlay.tsx` 复用官方 `ctx.connection.state`、`reconnect()` 和 `ConnectionIndicator`，在 `shell.overlay` 顶部居中显示 disconnected/connecting/recovered。Sidebar 收起时仍可见，健康初始状态不渲染，恢复绿态保留两秒。

该组件只控制 WebSocket reconnect，不启动 Host。上游只有提供全局、sidebar-independent、actionable 状态且不引入 silent Host restart 时，才能替代它。

### Isolated integrated validation

`DSH_PERF_CAPTURE=1` 为合成 Web 续接场景保存同时段的 Node/浏览器 CPU profile、Chrome timeline 和源码映射（`tmp/runtime-profiles/`）。测量脚本预先定位控件并只检查尾部消息，避免全页可访问性查询污染剖面；普通无剖面基准与剖面归因结果分开。未来替换诊断时保留两侧录制、源码定位和对测试观察开销的检查，不能以单个 API 响应耗时代替卡顿归因。

保留 `apps/web/stress-tests/subagent-reconnect.stress.ts` 的八个真实 continuable child + paced stream + WebSocket 重连组合断言：完整持久化输出、每个孩子恰好一次 start/end、最终释放、父会话标题及未发送草稿保留。该场景报告真实键盘输入与恢复耗时，但不以测试 Host RSS 宣称产品内存稳定；独立临时目录和随机端口不接触用户数据。长历史手动诊断 `apps/web/tests/complex-history.perf.ts` 使用当前 V4 system head、当前五行侧栏预览和 Trajectory 逻辑行数，工具轮次按 Windows `pwsh` / POSIX `bash` 调用并验证真实输出，禁止用旧界面文案或跳过工具错误代替负载。

`apps/web/stress-tests/workload.ts` 是多 Agent 压测共享的合成模型，其工具比例按真实部署的只读聚合计数校准；`agent-lifetime.stress.ts` 检查已销毁 Agent/Session 能否回收，`multi-agent-typing.stress.ts` 在数十至上百个运行 Agent 下检查输入框丢字、插入位置和只读窗口，`session-switch.stress.ts` 测量空闲与数十个运行 Agent 下经侧栏切换到冷、热长 Session 的显示耗时和 Host 事件循环阻塞。lifetime 的卸载等待窗口覆盖 `jobs` 长任务，因为有运行中后台任务的 Agent 按设计不卸载；switch 按真实日志约每帧两个事件写入种子，并先让目标经历一次驱逐以生成投影检查点。三者都使用测试私有 DSH_HOME 和随机端口，以 `pnpm exec vitest run --config vitest.web-stress.config.ts <file>` 运行，`DSH_STRESS_*` 与 `DSH_LIFETIME_*` 旋钮以各文件头为准，其中 `DSH_LIFETIME_LEAK_HANDLES=1` 模拟比请求活得更久的传输句柄。lifetime 发现残留时在 `tmp/agent-lifetime/` 写出堆快照，并用 `fork-runtime/diagnostics/retainers.mjs` 输出最短强引用链；typing 的 `stall` 与 `reconnect` 模式在页面内包装 WebSocket，以模拟 Host 卡顿后的积压与断线，并让积压帧逐条作为独立任务派发。Playwright 的 WebSocket 路由与测试 Host 同进程，会拖慢 Host 并制造假超时，因此不得用它替代页面内注入。`launchWebScaffold()` 只在 replay 对比时记录 `session/created`，以免 scaffold 本身成为留存者。快照可能包含路径，留在本机，禁止提交。

### Subagent catalog ordering

The conversation-header subagent menu sorts each sibling level by creation time descending, keeping catalog order for equal timestamps. Preserve the original projection arrays and stable row positions during activity updates; `ui-subagent/tests/conversation-ui.client.spec.tsx` covers newest-first display without mutating catalog membership.

### Background-only delegation

Shipped base and Web preset delegation tools set `enableRunInForeground: false`. The tool omits the scheduling parameter and foreground output variant, defaults one-shot providers to background Jobs, and rejects explicit `run_in_background: false` before model validation or child creation. Continuable children retain their durable ids, messages and settlement notices. Preserve execution-time rejection, cancellation and Job collection; prompt-only guidance is insufficient. Workflow and Ralph keep their separate orchestration policies.

The package default remains `true` for custom compositions. Deploying this policy to the existing Windows profile also requires `enableRunInForeground: false` on the external `chatgpt-dsh` preset's delegation rows. The optional [process-worker overlay](fork-runtime/web/subagent-process-background.patch.yml) changes the existing `subagent_process` row to a background Job. Apply runtime configuration only after the running Host has stopped; source changes do not update an already loaded tool. These changes do not modify Session formats or stored data.

Focused verification: `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts`, model-selection tests, and the keyless `subagent-background-only` recorded-session scenario.

### Forced ordinary Subagent models

通用设置的 **Subagent 模型覆盖** 行与插件页共用 `subagent.modelOverride`。模型和推理强度选择即时保存，仅修改该字段并携带当前修订；不提交插件页的未保存草稿。保留“不覆盖”、模型默认强度、切换模型清除旧强度、只读与旧 Host 隐藏、失效模型标识保留和失败时维持已接受值。验证入口为 `ui-settings-subagent` 的组件与注册测试，以及 `apps/web/tests/plugin-config.e2e.ts` 的 General Settings 场景。

`subagent.modelOverride` 默认为 `false`；设置页 **插件 → Subagent → 强制模型覆盖** 可选择 provider、model、reasoning effort，和深度/容量一起按同一 namespace revision 保存。Host `SubagentRuntime.start/startContinuable` 在创建前覆盖调用者模型参数并验证最终路由；省略 effort 时清除父级继承，采用模型默认值。开启时不支持 `agentOptions` 的普通后端明确拒绝，工作流、Ralph、普通工具与嵌套委派统一受约束，已有子代理/冷恢复保留持久化的模型。该设置不构成对 shell、任意 Host 代码或配置编辑的安全隔离。

AgentTeams 成员是用户指定的例外；核心 `startAgentTeamsMember` symbol 与插件 `harness-compat.startMember` 配对，保留 Team 成员自己的模型选择，普通后代仍走受覆盖的入口。不得改成按标签前缀豁免、model-visible 跳过参数或仅前端默认值。保留现有 `start/startContinuable` 调用路径上的插件生命周期/委派限制。合并上游时验证 `subagent/tests/{service,child-agent,continuation}.spec.ts`、`tool-subagent/tests/model-selection.spec.ts`、设置页 controller/component tests 与 `apps/web/tests/plugin-config.e2e.ts` 的 override 保存快照；同时保留 AgentTeams 内部适配器与对应私有包。

### Subagent and AgentTeams responsiveness

#### Continuable child steer

官方 `SubagentRuntime.sendMessage(sender,target,...)` 统一 direct parent/child messaging 并支持 image；fork 未恢复旧公开 `.steer()` / `.followup()`。Team mailbox 只使用官方 symbol-keyed Host queue/steer adapter，以保留 Team message source。

#### External AgentTeams mailbox delivery

外置 AgentTeams v0.1.20 拥有 live member 的 next-step delivery、inactive member 的 Queue、稳定 message id、accept/ack、target-local serialization、crash recovery、cold replay 与退休成员拒绝。RC.1 的 Host 协调消息使用专属 `agent-teams-host` source；Fork 不修改 DSH 官方实验性 Team mailbox。

Fork 仍让 inactive Captain 通过 Session Controller cold resume，并在 awaited `agent/created` 阶段按 durable mailbox 顺序重投；成功逐条 ack，失败释放当前记录和未处理后缀。未读 projection 使用 256-entry / 8 MiB LRU，磁盘 JSONL 格式不变。

Team 消息先写入 durable mailbox，再尝试 Host delivery；Host 接纳后记录才标记为已投递，失败记录保持可重试。消息进入正在执行不可中断工具的 Agent 收件箱后会等待该工具结算，不会抢占工具，也不代表消息丢失。成员遗漏 `attempt_id` 时返回包含当前 id 的可重试错误且不撤销 attempt；只有不匹配的 id 才按 stale attempt 拒绝。

#### Session-addressed Agent messages

Web bundle 的 `standard`、`ptc` 与 `cordis` preset 在 Agent 工具作用域内挂载 `@deepseek-ai/dsh-tool-session-message`；Host 全局工具层与 `minimal` preset 不挂载。其 `session_send_message` 把确切在线调用 Agent 的 Session id 记录为 `agent-message` relay 来源，再以 wakeup 方式写入目标 next-step 上下文。它不使用普通 next-turn 用户队列；空闲目标会被唤醒，运行中目标在后续 step 准入。在线目标不受工作区、lineage、origin 或自身目标限制；冷普通 Session 通过 Session Controller 恢复，冷 subagent 仍由其 parent 或 Team 生命周期负责。

同包的 `session_create` 仅允许在线普通 Agent 在用户要求单独对话时创建普通 Session，并在同次调用以 wake-enabled next-step 消息启动自包含任务。它复制调用方工作区、Agent preset 与已配置的权限 preset，采用 profile 默认模型；任务来源保留调用方 Session id，不冒充用户输入，也不自动向创建者回报。自定义权限、仅限当前 Session 的 Auto 权限与委派 subagent 在创建前拒绝；创建后投递失败会报告已创建 id，不谎称任务已接受。上游合并须保留这一创建／投递分离的真实状态及权限预设先于任务投递的顺序。

同包的 `session_find` 复用 `dsh-session-reference` 的 candidate 目录，按用户提供的非空标题／id／工作区子串查找独立 Session，再用 Session-query header 排除所有持久 `origin: subagent`（包括 AgentTeams teammate），同时保留普通用户 fork，且不激活冷候选项；重复标题必须交给用户选择，不能静默猜测。

发送工具没有 runtime 目标策略、频率限制、relay depth 或自身消息限制。工具描述把直接 parent/child 路由到 `send_message`、把 teammate 路由到 AgentTeams，并只允许使用用户提供、传入 Session 消息标识、`session_create` 返回、用户创建 reference 暴露，或 `session_find` 为用户点名目标返回的无歧义独立 id；接收消息框架要求模型不要确认、轮询、自动回复或转发。这些提示词是唯一的消息风暴控制。接受只表示目标 durable inbox 已插入带来源上下文，不表示已读或已回复；空闲目标会被 next-step wakeup 启动，普通 next-turn 队列不参与。

同包的 `session_message_status` 用目标 Session id 与已接受 `messageId` 只读折叠目标完整日志，不唤醒目标。它区分 pending-context、claimed、model-context、processing-tool、completed、rejected、discarded 与 unknown，并从顶层工具事件和 PTC sub-dispatch 同时识别未结算 `terminal_send` 的 terminal blocking；状态是时间点观察，不自动推送给发送方。

#### Retired official Team scheduling patches

`forceRunInBackground` 与 `yieldWaitOnNextStep` 没有进入 0.1.6 移植。真实 profile 使用外置 AgentTeams，不挂载官方实验性 Team profile；保留两个仅由未启用 profile 消费的公共配置会扩大每次上游合并的冲突面。普通 jobs completion wake、Windows 控制台隔离和 AgentTeams 自己的 next-step delivery 独立保留。

#### Browser Queue Dock

Alpha.2 Queue Dock 通过通用 `session.updateQueue` 对 live Session 的精确 pending occurrence 执行 edit、remove 或 steer。Edit 保留 message identity/source，remove 持久取消 occurrence，steer 只在当前状态允许时把 occurrence 提升到 next-step；continuable child 使用同一 Session-addressed API。

Fork 不再维护独立 subagent Queue Remote 或错误码。后续上游合并必须保留 `session.updateQueue` 的 occurrence identity、通用 Session/continuable-child 寻址、发送中禁用状态、单条与批量 Steer，以及 durable `agent/inbox/spliced` 记录。

### Released V3 error-turn migration

`session-format-v3-to-v4` 只在 V3 step 已记录 `tool/call`、没有追加结果且同一 turn 随后以 `reason.kind: 'error'` 结束时，于 `step/end` 前插入 `TOOL_OUTCOME_UNKNOWN` 的 tool 角色错误结果，引用已记录的启动事件；它不执行工具，也不把已开始调用伪称为 `TOOL_NOT_STARTED`。正常完成轮次、后续新 step 和未关闭尾部继续拒绝，原始 V3 代际保持不变。上游合并须保留这一限定修复与原生 V4 的未结算调用拒绝规则。聚焦验证由 `packages/session/session-format-v3-to-v4/tests/error-turn-tools.spec.ts` 和 `packages/session/session-persistence-jsonl/tests/v3-error-tool-migration.spec.ts` 覆盖；一份 7,011 事件的真实 V3 日志经实际 JSONL 后端只读恢复为 7,012 个 V4 事件，源 SHA-256 未变，未发布后继文件。

### Glob search-root guidance

`packages/fs/tool-fs-search/src/glob.ts` 的系统提示和工具 schema 明确区分 `path` 搜索根与 `pattern` 结果过滤：已知目录时传入最窄的 `path`，超时后缩小目录再试，不能把 pattern 中的目录前缀当成遍历范围限制。该定制不修改 ripgrep argv、结果排序、权限或默认 30 秒预算。

上游替代必须保留这一区分与超时恢复指引；聚焦验证为 `packages/fs/tool-fs-search/tests/tools.spec.ts` 的 guidance/registration 测试，以及 recorded-session 的系统提示和 schema pins。

### Local launch and build scripts

仓库包含 [clean.cmd](clean.cmd)、[build.cmd](build.cmd)、[run.cmd](run.cmd)、[clean.command](clean.command)、[build.command](build.command)、[run.command](run.command) 与 [setup.command](setup.command)。三个 Windows 入口共用 [fork-windows-pnpm.cmd](scripts/fork-windows-pnpm.cmd)：它读取 `package.json` 锁定的 pnpm 版本，通过 npm 在 `%TEMP%` 下准备私有副本，校验入口文件、命令 shim 与版本，并把私有 shim 目录置于子进程 `PATH` 首位；依赖安装脚本启动的 `pnpm` 因此也不会落到残缺的 Corepack 缓存。npm registry 默认使用 npmmirror，可用 `npm_config_registry` 覆盖。`clean.cmd` 只调用仓库拥有的 `pnpm run clean`，在依赖缺失时先安装依赖，不删除 `node_modules`、profile 或 Session 数据；`build.cmd` 执行 install + build，并关闭 pnpm 的 `optimistic-repeat-install` 快速跳过，让安装阶段检查和恢复缺失的本地命令入口（例如 `node_modules/.bin/tsx.cmd`）。两者安装依赖时默认限制 pnpm child concurrency 为 4，可用 `DSH_PNPM_CHILD_CONCURRENCY` 覆盖，避免大型升级后同时启动过多 worker；聚焦验证为 `scripts/fork-windows-launchers.spec.ts`。`run.cmd` 默认 `DSH_HOME=C:\Project\deepseek-harness-data`，创建 diagnostics，并追加 `--max-old-space-size=16384` 与 Node fatal/uncaught reports 后运行 Web profile。源码 CLI 为 profile 选择 link resolution，使配置的 workspace provider 与其内部 consumer 都解析到 `src/`；构建后入口仍使用 built runtime resolution。真实源码入口工具往返测试负责防止 `src/lib` 模块身份再次分裂。

macOS 的 `clean.command`、`build.command` 和 `run.command` 共用 `scripts/fork-macos-runtime.sh`。`clean.command` 与 Windows 入口使用同一个仓库 cleaner，保留依赖与用户数据。该 helper 从 `PATH`、Apple Silicon Homebrew 和 Intel Homebrew 路径查找 Node，拒绝不受支持的 Node 23，仅在私有临时目录安装固定 Corepack fallback，并使用仓库锁定的 pnpm；如果更新或中断留下不完整的固定版本缓存，它会在启动 pnpm 前删除该版本目录并重新下载，不需要手动清理。`run.command` 默认 `DSH_HOME=~/.dsh`，创建权限 `0700` 的 diagnostics，启用 Node fatal/uncaught reports，并把 V8 old-space 设为物理内存的一半且限制在 4–16 GiB；`DSH_MAX_OLD_SPACE_MIB` 可显式覆盖。它不会静默重启 Host。

macOS 的 `setup.command` 是一次性显式 profile 安装入口。它校验并安装仓内 Agent Teams、Context 与 Subscriptions tgz，移除 dshmarket，为 Context 应用低开销 bounds，且只备份它可能改动的 profile 配置四文件。它不导入或修改另一台机器的 Session、附件、DSH credential store、projection cache 或 `.agent-teams`；`--dry-run` 不创建 Harness home 或 package-manager 目录。

Windows 在 `core.symlinks=false` 的检出中可能把 Git 跟踪的 Cordis 配置 symlink 写成目标路径文本。`verify-cordis-config` 只对 Git mode `120000` 且解析后仍在仓库内的文件跟随该文本；普通配置仍按 YAML 解析，循环或越界目标失败。实际 macOS symlink 与 Windows materialized symlink 都须通过 `pnpm run verify-cordis-config`，不得全局跳过 profile 校验。

RC.1 的 `verify-no-unknown-casts` 静态门禁除了官方 baseline，还读取 `scripts/no-unknown-casts.imported-baseline.json` 中按文件、行片段及计数固定的继承项。该表仅记录从本 fork 升级前基线及本次三个不可变插件 tag 已存在的表达式；新写入的 unknown cast 已移除。后续新增、移动或重复的 cast 仍失败，清理继承项时运行 `pnpm run verify-no-unknown-casts --prune`。聚焦验证为 `scripts/verify-no-unknown-casts.spec.ts`、`scripts/verify-cordis-config.spec.ts` 和对应两个 gate。

### Derived files

`docs/config-catalog*`、`docs/subsystems/subagent*`、`docs/tool-catalog*`、`packages/extensions/tool-cordis/src/api-catalog.ts`、slot catalog、README/i18n sidecars 和 `pnpm-lock.yaml` 是上述 owner source 的派生物。合并时先保留官方生成物，再完成 source port，最后运行 generators；禁止只保留 generated diff。

当前主要决策记录为：[long-session hot paths](.agents/notes/implemented/bug-fix/2026-08-23-long-session-hot-paths.md)、[bounded transient retention](.agents/notes/implemented/bug-fix/2026-08-31-bounded-transient-runtime-retention.md)、[connection recovery control](.agents/notes/implemented/feature/2026-08-28-web-connection-recovery-control.md) 和 [steer-responsive Agent Teams](.agents/notes/implemented/feature/2026-08-30-steer-responsive-agent-team-work.md)。

-----

## Runtime and plugins

### 16 GiB Host and manual recovery

`C:\Project\deepseek-harness-data\run-safe.cmd` 固定真实 DSH_HOME 和 diagnostics，并用 `--max-old-space-size=16384` 启动源码 Web profile。Exit 75、76、134 都只记录并暂停；当前脚本明确写入 `restart=disabled`，走 `automatic_restart_disabled`，后端保持离线等待人工启动。

Web profile 插入 `memory-watchdog.cjs`：250 ms 采样、60 s 日志、heap ratio 0.75 warning、0.90 shutdown、连续 8 个高样本才停机、RSS 16384/20480 MiB warning/shutdown、exit 76。命名中的旧 `restart*` 配置字段不代表 supervisor 会重启。

`run.cmd` 与 `run-safe.cmd` 都给主 Host 16 GiB heap；只有 `run-safe.cmd` 负责记录退出并停在人工恢复提示。Node reports 排除 env/network 并写入 diagnostics。

### Web profile inventory

| Package | Installed | Runtime state | Preserve rule |
|---|---:|---|---|
| `dshmarket` | — | Removed | 官方 Plugin Manager 接管安装、配置与运行时启停；profile 不恢复旧 package 或 bundle |
| `@nanmicoder/dsh-agent-teams` | `0.1.20-dsh017rc1.3` | Installed, enabled | 真实 profile 使用仓内固定 artifact；停止 Host 后更新，禁止被 npm latest/next 直接覆盖 |
| `dsh-plugin-subscriptions` | `0.9.4-dsh017rc1.11` | Installed; Windows Web enabled | 仓内固定 artifact；凭据文件原地保留，其他 profile 是否启用沿用显式插件配置 |
| `@vlln/dsh-task-status` | Removed | Not installed | 已从依赖、bundle、patch、lockfile 和 `node_modules` 删除；profile 不得恢复 |
| `dsh-context` | Windows: `0.55.0-dsh017rc1.3`; Mac: `0.55.0-dsh017rc1.1` | Installed, enabled | 真实 profile 保留 `300/60/100/400/100/100` bounds；源码与回滚规则见 `fork-plugins/dsh-context/FORK_MAINTENANCE.md` |
| `dsh-shell-command` | Removed | No package or configuration | profile 不安装 |
| `@deepseek-ai/dsh-subagent-dsh-sdk` | Link to source checkout | Enabled for process provider | 跟随源码构建，worker 数据与主 sessions 隔离 |

AgentTeams、Context 与 Subscriptions 均使用本地 `file:` tgz，不依赖 release-age 例外。profile 不再安装 dshmarket；禁止 wildcard 和未经审计的 `pnpm update --latest`。

2026-09-24 的 Windows profile 升级先将四个配置文件备份到 `C:\Project\deepseek-harness-data\diagnostics\profile-backups\pre-017rc1-20260924-1900`，再用 DSH Plugin Manager 安装三个固定 tgz。`verify-profile`、`verify-patch` 与组合后的 `verify-dump` 均通过；没有修改 Session、附件或凭据。

Mac 主 checkout 已快进至同一 fork master；`clean.command`、`build.command` 和 `setup.command` 均通过。`setup.command` 将原 profile 的四个配置文件备份到 `/Users/zhouxiran/.dsh/profile-backups/web-20260924T122912Z-84951`，真实 Web profile 已安装上表的三个固定版本。Mac 的 205 个 Cordis 配置检查通过，`run.command` 启动验收时的 Web 响应为 HTTP 200。

### Local AgentTeams package

维护真源位于 `fork-plugins\dsh-agent-teams`，完整保留上游运行源码、测试、构建脚本和资产。仓库安装器使用 `fork-plugins\releases\nanmicoder-dsh-agent-teams-0.1.20-dsh017rc1.3.tgz`，SHA256 为 `8CCAA66D5E026DBED6363CA569B25BB8D4869E931BD92DC495458175C151980A`。该 package 标记为 private，禁止用上游 npm scope 发布；Windows profile 已安装该 artifact，更新须在 Host 停止后进行。

fork artifact 随 Git 提交，同事不依赖这台机器的外置 `.local-plugins-src`。保留当前与仍被已安装 profile 引用的制品及校验值，历史制品也可从 Git 历史恢复。

必须保留的 fork 行为：

1. 保留上游 v0.1.19 的原子 roster/DAG 创建、仅启动 ready member、改名工具成员恢复、repair scope、任务修订、next-step 协调、陈旧消息抑制、attempt 校验、退休成员清理、安全 reassignment 与任务纠正；v0.1.20 只更新上游文档。
2. RC.1 发行路径使用 awaited `agent/created`、`Session.ownEvents()` 与统一 Host delivery adapter；legacy setup 和旧 Host Queue 形态只保留为回归 fixture，不构成发行兼容声明。
3. Team 内部队长指令、scheduler assignment、peer delivery 和 mailbox recovery 使用 Host Queue/Steer 规则，来源为 `agent-teams-host`；fork 不再重复维护最近-step 或退休成员策略。
4. Client 使用 `uiConversation`、`uiWorkspace` 的 projection refresh 与 `[data-composer-input]`；Host capability 层保持 14 个 Captain 工具和 4 个成员工具稳定。package peer、development dependency、完整 DSH override cohort 与 lockfile 固定为 `0.1.7-rc.1`。
5. 普通 captain 不驻留时，成员报告先通过 Host Session Controller cold resume captain；Captain Session start 会重投 durable mailbox，成功逐条 ack，失败记录及后缀释放 delivery lease。
6. Windows directory rename 使用独立的 5 次重试预算；构建清理目标用跨平台 `basename()` 校验。
7. `readUnreadMailbox()` 使用只保留 pending 消息的 256-entry / 8 MiB 有界 LRU，并以 `dev/ino/size/mtimeNs/ctimeNs` 检测文件替换；lease 每次按当前时间重算，append/claim/release/ack/archive/remove 成功后精确失效。完整历史读取和磁盘 JSONL 字节格式不变。
8. 活动轮询把当前 captain 和所有已挂载卡片的 active captain/team 对传给 Host，包括右侧并排会话，在 activity/mailbox 装配前过滤；摘要保留全部任务结构，主会话 staged 计划的长说明与 execution prompt 通过详情读取并按 revision 复用。旧无范围请求保留完整字段和 captainInbox，新 Client 兼容旧 Host；畸形 scope/detail 查询在扫描前返回 400。详情 cache 由各 poller 持有，stop 释放；mutation 代际、同 revision 失效、失败期间 presentation identity 和每次请求自己的 AbortSignal 均须保留，避免旧响应覆盖表单。hidden 暂停，visible 立即刷新，隐藏中止的首次恢复不能提前完成 firstTick。归档旁侧卡数据保留到最后一个卡引用卸载，inactive target 不维持热轮询；归档只读，旁侧卡不获取编辑器长详情。

9. 只有明确 captain/team 对且不含 Captain 发现请求时，在原有 live/archive 目录枚举后先按 team id 过滤，再读取 `team.json` 并重新校验记录 id 与 captain。保留目录顺序、目录错误传播、目录类型过滤和旧 id；Captain 发现仍读取全部团队。Host 与面板复用按 assignee 精确值分组的任务索引，保留任务顺序、首个运行任务、完成数、removed roster、模型选择和详情；缺失 assignee 与显式空值不同。索引只跟随当前输入，不引入跨请求状态缓存。

10. `state.ts` 的 `atomicWriteText` 在临时文件改名前、以及 Windows 直接覆盖回退中，都先 `FileHandle.sync()`，断电后不会留下长度正确而内容全零的 `team.json` 或 mailbox。`findTeamByCaptain`、`findTeamByParticipant` 与 capability 的 `currentTeam` 扫描工作区时跳过 JSON 或结构损坏的团队，并按目录与原因以 `DSH_AGENT_TEAMS_UNREADABLE_TEAM` 进程警告提示一次；按 team id 直接读取仍抛错，I/O 错误照常传播。2026-10-04 崩溃零填充了一个 3 MB `team.json`，该工作区每次插入收件箱消息后回合都以 JSON 解析失败结束。回归为 `capabilities.test.mjs` 的 unrelated unreadable team 用例（旧实现返回 JSON 错误）与 `verify.mjs` 的 zero-filled 查找检查。该修复随 `0.1.20-dsh017rc1.3` 发布；插件目录依赖须按锁文件对齐到 `0.1.7-rc.1` 后再构建（本机 pnpm store 已有时可 `--offline`），否则客户端类型检查失败。

AgentTeams 的 `scripts/activity-state.perf.mjs` 使用 27/58 个合成团队、1,500/2,600 个任务。请求一个团队摘要时，live 响应由约 2.865 MB 的全量结果降至 10,416 字节，归档由约 5.003 MB 降至 8,458 字节；所选团队的 56/45 项任务完整保留，详情仍可单独读取。明确目标预筛选的构建产物对照每版各启动三个 Node 进程，按相同 case 顺序温热文件/邮箱缓存：live target-summary 为 `[20.27, 19.20, 20.16]` → `[1.12, 1.37, 1.38]` ms，中位数 20.16 → 1.37 ms；archive 为 `[37.28, 37.88, 39.56]` → `[1.45, 1.38, 1.30]` ms，中位数 37.88 → 1.38 ms。结果字节数及任务数相同，Captain 发现仍承担扫描成本。该测量覆盖命名目标的组件读取，不代表整页或模型延迟。成员分组另用 3×12 与 8×256 的合成单团队验证；参考算法访问次数只作复杂度对照，不作旧产品计时，包含邮箱 I/O 的单团队装配未显示稳定耗时收益。离线 verify、类型检查、兼容/HTTP/生命周期验证及旧 consumer 负对照构成后续合并的验证入口。

`.local-plugins-src\...dsh012.2/.3/.4` 只是历史解包产物，不能再当维护源。以后用 `git subtree pull --prefix=fork-plugins/dsh-agent-teams https://github.com/NanmiCoder/dsh-agent-teams.git <tag> --squash` 获取精确官方发布，再在 fork 内重放和验证上述行为；不得用 npm install 覆盖 subtree。

本 fork 以 `v0.1.20` 生成 `0.1.20-dsh017rc1.3`。上游拥有 scheduling、next-step delivery、retired-member cleanup、repair scope 与 task correction；fork 保留 RC.1 source/导航适配、冷 Captain mailbox 恢复、有界 unread mailbox projection，以及上述活动状态读取策略。后续上游发布先按行为测试去重，再提升 subtree 基线和私有版本；profile 始终安装 fork artifact。

### Local Context package

维护真源位于 `fork-plugins\dsh-context`，仓库安装器使用 `fork-plugins\releases\dsh-context-0.55.0-dsh017rc1.3.tgz`，SHA256 为 `255BA7AA6B84DA2F1301CD7786A2DDBC39AEE0A69BC731547B464B5D32B7B27D`。该版本采用上游 v0.55.0 的 V0/V2/V3/V4 fold、Context Insights、余额展示、增量 turn 账本、按需 backfill 与 slim-head/on-demand-detail 传输，并保持既有 projection key 和 Session event vocabulary 不变。

私有构建保留经官方文档核对的 GPT-6 Astra/Sol、Claude Opus 5.5/Fable 5.1 与 Cursor Grok 4.7 标准速度 API 等值价格。价格匹配识别订阅 provider 别名；投影版本 21 按单次请求区分长上下文费率，必须保留 `long` 费用分组在 wire、Client sanitizer、Agent 合并和总 token 统计中的传递。费用不是订阅账单，定价日期、缓存写入假设和来源见 `fork-plugins/dsh-context/docs/model-pricing.md`。定向价格与界面测试、投影兼容测试、构建包 smoke，以及四个价格/费用模块的 100% 覆盖率是维护检查；升级真实 profile 前仍须确认 DSH 已停止。

Windows Web profile 的 Context 内存修复升级备份位于 `C:\Project\deepseek-harness-data\profile-backups\context-memory-20260927-200916`，安装版本为 `0.55.0-dsh017rc1.3`；已核对安装后的 Host bundle 与构建输出 SHA256 相同，其他直接依赖、bundle 列表和 profile patch 保持原值。定价升级的旧备份 `context-pricing-20260927-063430` 继续保留。

Context 源码的工具归属追踪按 `cordis.original` 解包后的服务身份去重，只保存读取者的插件名，避免恢复回调数组长期持有 Agent 专属代理及其 Session。引用链、隔离内存实验和回归检查见[插件维护记录](fork-plugins/dsh-context/FORK_MAINTENANCE.md#tool-attribution-lifetime)。此修复包含在 `0.55.0-dsh017rc1.3` artifact 中；Windows 已在 Host 停止时完成切换并以诊断模式重启，认证 Web 页面返回 HTTP 200。Mac 的 `setup.command` 与安装校验版本也指向该 artifact，但尚未在 Mac 安装验证。后续插件升级仍须停止 Host 后操作。

### Local Subscriptions package

维护真源位于 `fork-plugins\dsh-plugin-subscriptions`，仓库安装器使用 `fork-plugins\releases\dsh-plugin-subscriptions-0.9.4-dsh017rc1.14.tgz`，SHA256 为 `9C59F35704006FDD071B3C1037120FDA514A358DD972A17103C86D760B122518`。该摘要与仓内制品及其 `.sha256` 文件一致。该版本采用上游 v0.9.4 的多账号 provider、usage UI、Codex 搜索、图片结果、Antigravity 与 provider failover，并增加 RC.1 的 V4 工具角色转换；凭据格式与工具输出不变。

Windows Web profile 启用 `llm-subscriptions`，保留 `rateLimit.wait: false`。 制品在安装前须通过插件测试套件、实际安装目录的接口与 UI 开关检查；2026-10-10 当前源码的插件测试套件 804 项通过、0 失败、退出码 0。已验证的图片处理保持：21 张历史图片中原有 16 张超出多图尺寸上限，请求版本的长边均不超过 2,000 像素，原 Session 和附件摘要保持不变。2026-09-26，固定源码包的 506 项无密钥测试通过；隔离 Web profile 与真实 Web profile 均在随机本地端口启动，认证页面返回 HTTP 200，页面包含 Subscriptions 客户端资源。真实 Profile 的 Codex 状态接口识别到两个已存账号，默认账号的用量查询通过并刷新过期访问令牌；另一个账号及真实模型请求尚未验证。旧 profile patch 备份位于 `C:\Project\deepseek-harness-data\diagnostics\profile-backups\pre-subscriptions-enable-20260926`。

更新时使用 `git subtree pull --prefix=fork-plugins/dsh-plugin-subscriptions https://github.com/V1ki/dsh-plugin-subscriptions.git <tag> --squash`，再重放 `fork-plugins/dsh-plugin-subscriptions/FORK_MAINTENANCE.md`。真实 profile 始终安装仓内固定 artifact，禁止 npm latest 直接覆盖。

本地优化包含 timeline fold 字段级 copy-on-write、request/event/archive/file-op dirty retention trim、恢复态首个 slim/inline/detail value 的 bounds clamp、Host-only 状态的引用稳定 inline/slim cache、关闭 `/context` modal 时释放 projection/detail/history/conversation 订阅，以及用 V3 `system/message` 为后续 header epoch 计价。真实 profile 停机升级后使用 `maxRequestSteps: 300`、`maxKeptTurns: 60`、`maxEvents: 100`、`maxNodes: 400`、`maxArchiveNodes: 100` 和 `maxFileOps: 100`。这些上限只缩小 Context 派生展示，不修改 Session 历史。

更新时使用 `git subtree pull --prefix=fork-plugins/dsh-context https://github.com/bowenliang123/dsh-context.git <tag> --squash`，再逐项重放 `fork-plugins/dsh-context/FORK_MAINTENANCE.md` 所列行为。不得用 npm latest 直接覆盖真实 profile。

### ChatGPT subagent preset

仓内 [`fork-runtime/web/chatgpt-subagent-preset.cjs`](fork-runtime/web/chatgpt-subagent-preset.cjs) 是 `profiles\web\chatgpt-subagent-preset.cjs` 的部署源。Profile patch 必须同时插入 `preset-chatgpt-dsh`（`@deepseek-ai/dsh-agent-preset`，其 `plugins` 由 `cordis:include` 从 `../../.agent-presets/chatgpt-dsh/agent.cordis.yml` 加载）和 `chatgpt-subagent-preset`；只保留磁盘目录不会在 RC.1 注册自定义预设。选择器的 `preset`、`providers` 和 `modelPattern` 均须显式配置，缺失或非法值在激活时失败。

选择器在 `subagent/child-preset` waterfall 中为 provider `codex` 或 model `^gpt-` 的新建进程内子代理选择 `chatgpt-dsh`，其他路由调用 `next()`；共享 `applyChildComposition()` 在子级插件挂载前安装目标预设并写入 `agent-preset/selected`。顶层、非 ChatGPT 与恢复的子代理不重新运行路由规则；恢复使用日志里的选择。目标预设无效时记录告警并继承父预设，不否决创建。不得在 `agent/created` 内异步重挂子级，也不得调用已移除的 `standingKeyFor()`。

升级后运行 `scripts/fork-chatgpt-subagent-preset.spec.ts`、子代理定向测试与 Web 真实组合测试。真实 profile 启动后必须没有该行的激活警告，「Agent 预设」页应列出可选的 `chatgpt-dsh`，并确认内测声明确认与字号写入可持久化。2026-09-24 的 profile patch 备份位于 `diagnostics\profile-backups\pre-chatgpt-preset-registration-20260924-2200`；Session、凭据和预设正文未改动。

Preset 位于 `.agent-presets\chatgpt-dsh`。`no-escalation.cjs` 从 pwsh/write/edit schema 隐藏 sandbox permission 参数，但不改变 executor；persona 正文使用必填 `prefix`。`agent.cordis.yml` 使用 `@deepseek-ai/dsh-workflow-ptc`，并保留自定义 persona、`no-escalation`、`tool-web.fetch:false`、`command-goal` 和 spawn `modelSelectionSettings:true`。

`bounded-subagent-provider.cjs` 仍在磁盘但没有 profile 引用。它是 dormant 历史文件；Alpha.2 的 `dsh-subagent.maxActiveSubagents` 已统一拥有 continuable child 并发限制，无需重新插入另一套 provider 包装。

### Isolated process workers

Profile 注册 `dsh-sdk-process-raw` 和 `subagent_process`：SDK profile、独立 `dshHome=C:/Project/deepseek-harness-data/process-workers`、`deepseek-official/deepseek-v4-flash`、`maxTokens=65536`、每 worker 4096 MiB heap、one-shot、非 background、`maxDepth=provider-managed`。Alpha.2 的 Host Subagent runtime 使用官方默认 `maxActiveSubagents: 8` 与 `maxDepth: 1`；外置 one-shot worker 不占 continuable child pool，且 worker sessions 不进入主 `sessions`。

`process-workers\profiles\sdk\cordis.patch.yml` 中失效的旧 `memory-admission` row 已于 2026-09-04 删除；`local-memory-watchdog` 和其余 worker 配置保留。Subagent 并发上限由 Alpha.2 的 Host runtime 与设置页统一管理。

### Diagnostics

`diagnostics\memory-watchdog.ndjson`、`supervisor.log` 和 Node reports 是故障证据。旧 supervisor 行可能记录历史 restart，不能用旧行判断当前行为；当前脚本的新行以 `restart=disabled` 为准。日志当前没有自动轮转，维护者只能针对已确认的具体文件人工归档，禁止对 DSH_HOME 运行宽泛递归清理。RC.1/profile/plugin/preset 的阶段备份位于 `diagnostics\profile-backups\pre-rc1-20260904-015259`、`pre-agentteams-rc1-20260904-022034`、`pre-chatgpt-preset-rc1-20260904-022706`、`pre-plugin-upgrades-rc1-20260904-023206` 与 `pre-agentteams-rc1.2-20260904-024212`；均不含 Session 或附件。

`diagnostics\deleted-*-artifacts-*` 与 `validation-web-full-partial-node-modules-*` 是上游删除包的可恢复构建残留，不是 Session。清理前仍需解析绝对路径并与 sessions/attachments/storages 分离。

#### Memory ownership verification

普通 Windows `run.cmd` 通过 `fork-runtime/diagnostics/cordis.patch.yml` 自动插入内存探针；保留内部 Inspector 采样、匿名 WeakRef 生命周期与 GC 年龄、活跃历史规模、退出解绑，以及低堆时最多两次快照和资源准入限制。配置、输出上限与解读以[诊断 README](fork-runtime/diagnostics/README.zh.md)为准。合并上游不得恢复只有内存数量、没有分配调用栈与 GC 证据的启动方式。聚焦验证为 `scripts/fork-memory-lifetime.spec.ts`、`scripts/fork-memory-recorder.spec.ts`、Windows 启动器测试及独立数据目录下的真实 Web 启动。此探针不修改 Session 格式、不开放 Inspector TCP 端口、不替代 watchdog，也不自动重启。

2026-09-27 的完整堆引用分析将主要累积归因于 Context 工具归属恢复回调：248 个已销毁 Agent/Session 被长期持有，条件 WeakMap 图模型中约占 10,265 MiB。`0.55.0-dsh017rc1.3` 的真实服务去重与 jobs-local 的中性调度上下文分别修复该引用链和共享任务到期 timer 的旧 Agent 留存；合并上游必须保留下面矩阵中的行为与回归，或验证上游提供等价实现后再移除 fork 补丁。

修复后的诊断实例运行约 3 小时 40 分钟：记录到的 JS 堆最高 2.50 GiB、最后 1.49 GiB，RSS 最高 5.81 GiB、最后 4.29 GiB；已销毁但仍存活 Agent 最多 15 个、最后 4 个，中间曾回到 0。增长快照中的 Context 恢复数组从旧事故的 82,602 项降至 1 项，jobs-local 到期 timer 不携带 Agent 异步上下文。两轮负载并非固定输入基准，引用图字节估算也不等于 RSS 回收量。

外置 `diagnostics\start-dsh-memory-debug.ps1` 使用原 Web profile，启用仅回环的 Inspector、连续 1 MiB 分配采样、30 秒所有权/GC 汇总和 Node reports。完整基线与一次 2 GiB 增长快照只在明确授权后采集；增长快照要求实际堆不超过 3 GiB 且 RAM、磁盘满足预算。高堆快照会暂停 Host 并大幅增加 RSS，不能在接近 watchdog 阈值时自动重复。该诊断工具不属于普通 `run.cmd` 或 Mac 安装器，也不是后台自动重启机制。

本机证据位于 DSH_HOME 下的 `diagnostics\incident-47176-2026-09-26T23-57-57-126Z` 和 `diagnostics\run-10072-20260927-analysis`。原始快照、数字索引与分配剖面包含私有运行内容，只保留在本机，不提交到 Git；维护文档仅记录汇总、机制和验证规则。

#### Deferred memory findings

本轮为降低后续上游合并成本，暂缓以下两项源码修改；它们不是本 fork 已实施的补丁，不得在合并时按“保留修复”重新添加。只在新证据显示其成为主要占用，或上游提供可验证修复时重新评估。

| Finding | Measured scope | Maintenance decision |
|---|---|---|
| Node 内置与 profile 依赖中的两份 Undici 共享 timer 保留请求异步上下文 | 增长快照中合计约 83.63 MiB、两个已销毁 Agent | Agent 留存已由 [Agent initiator 弱引用](#agent-initiator-weak-reference)切断，timer 仍保留其 frame；暂缓依赖和 transport 补丁，上游替代须覆盖两份实现，并保持认证、订阅账户选择和 Agent 归属，不能清空整个 fetch 调用链的上下文 |
| `DomainFacility.open()` 的 `onClosed` 共享闭包保留启动 `loadAll()` 快照 | 当时额外约 11.42 MiB；当前表与旧快照合计约 224.12 MiB，其中约 196.96 MiB 为共享 payload | 暂缓源码补丁；覆盖、删除记录后的 WeakRef/GC 复现已保留，不能将共享数据按双份计量 |

全库投影缓存仍在启动时加载，活跃 Session 仍完整持有历史；按需缓存与历史读取尚未实现。本轮没有改动 Session 格式、迁移规则或模型可见内容。

补充测试发现一个尚未归因到事故占用的源码路径：若 `settled` 监听器同步调用 `jobs.remove()`，之后的 `terminalRetention.track()` 仍可能暂存该记录的索引与 owner，直到 TTL 到期；仅启用数量上限且记录未被读取时可能保留至服务销毁。对外删除通知的回归已覆盖，本轮未扩展修复此路径。

-----

## Preservation matrix

| Behavior | Status | Upstream merge rule |
|---|---|---|
| Token meter direct-event fast path | Replaced by official indexed reads | Do not restore whole-log fallback |
| Frozen persistence enqueue and O(1) batch | Preserve | Require identical ownership and failed-write ordering |
| JSONL metadata revision cache/shared scan | Preserve | Require append/replace/delete and caller-cancellation equivalence |
| Decoded cold-log idle expiry | Preserve | Require two-entry and idle-time bounds, revision-safe handoff reuse, mutation invalidation and timer cleanup |
| Current-generation decode sharing | Preserve | Require same-revision join, revision isolation and independent caller cancellation |
| Session-owned fork prefix sharing | Preserve | Require trusted immutable identities, external-seed detachment and independent append arrays |
| Cold Session large-artifact cache bypass | Preserve | Require physical-size limit, exact revision/lease ownership and live-transition invalidation |
| SQLite suffix indexing/bounded page LRU | Preserve | Require canonical replacement detection and bounded detached cache |
| Resume projection checkpoint seeding | Preserve | Hydrate a resumed prepared Session through the optional projection cache before the Agent reads projections; cover both resume and cold observation |
| Cold-read event-loop slices | Preserve | Keep cold-read decode and stored-event adoption slices at 50 ms with the whole-log type check before per-event adoption, unless upstream bounds them equally or tighter |
| Five-minute idle Agent eviction | Preserve | Require opening-only follower pin, child/inbox/job exclusions, flush + persistence proof and cold resume |
| History follow opening release | Preserve | Require bounded opening output, full-observation release, promotion ownership and gap-free delivery across eviction |
| Reference-owned Client Session generations | Replaced by official references | Keep final-release withdrawal and projection-store retention; do not restore `suspendHistory()` |
| 20k final-message packed rebase | Replaced by cursorless Assistant frames | Keep official transient-stream settlement; do not restore scalar chunk accumulation |
| Tool output/card lazy calculation | Ported onto RC.1 | Preserve generic output-on-expand and card-array laziness; official already defers input formatting |
| Closed subagent catalog subscriptions | Preserve | Keep closed selectors root/direct-child-only and mount complete catalog work with the open menu; preserve visible summaries and all interactions |
| Client projection snapshot identity | Preserve | Reuse unchanged observable values and suppress rejected-frame invalidation without delaying accepted key-face values or changing generation/retention semantics |
| Catalog frame coalescing | Preserve | Publish manager catalog rebuilds for live control frames at most once per animation frame; keep key faces, `inbox`, structural mutations and the no-rAF fallback microtask-batched |
| Live checkpoint ownership transfer | Preserve | Validate already-detached live rows without recopying; keep cold-row detachment and log-before-cache durability |
| Production static-library environment | Preserve | Keep NODE_ENV branches until the final shell build; development freezes and production bypass both need built checks |
| Workspace ordering work | Preserve | Keep indexed fork moves, shared current-session derivation, saved/pin/archive semantics and deep/cyclic parent cases |
| Tool-search block round trip | Preserve | Keep the library's block whitelist and the plugin's capture/replay in step, and keep envelope entries optional and index-based |
| Separate disclosed-wait ceiling | Preserve | Keep `providerWaitMaxMs` optional and default-equal to `maxDelayMs`; a policy that omits it must resolve, retry, and serialize its policy key exactly as upstream |
| Optional catalog hint exclusions | Preserve | Default to all keys, protect sessionListMetadata, filter before view/parse, retain explicit reads and unknown plugins |
| Connection recovery under load | Preserve | Keep loopback independent of external offline hints, one progress-aware bounded Ping, fresh control readers after terminal failures, display-only title retention and close diagnostics |
| Status and catalog derivation | Preserve | Publish one list-cut status result, skip unchanged state work, reuse lineage and row inputs, preserve synchronous Remote status and exact retention/label invalidation |
| AgentTeams target reads and task ownership | Preserve | Filter explicit targets before JSON reads, retain directory enumeration and errors, captain discovery, workspace/captain checks and exact ordered assignee groups |
| Stable public projection views | Preserve | Keep full private fold state and watermarks; weak scalar-view entries must not retain Session or Agent owners |
| Pending control recovery | Preserve | Reuse a recovery opening before its baseline; restart after an accepted baseline or terminal failure |
| Scoped AgentTeams activity | Preserve | Keep paired targets, legacy full compatibility, complete task structure, staged detail revision/abort ownership and visibility recovery |
| Jobs one-hour TTL / 100 terminal target | Ported onto RC.1 | Official ring caps do not bound terminal-record count or lifetime; preserve unread protection and lightweight heap indexes |
| Jobs shared timer initiator isolation | Preserve | Create initial, renewed and deferred-prune timers without an Agent initiator; preserve owner cleanup, expiry behavior and scheduling during teardown |
| Skill watcher initiator isolation | Preserve | Open chokidar root watchers and `watchFile` ancestor polls, including rewatches, without an Agent initiator; keep the `dsh-agent` peer |
| Agent initiator weak reference | Preserve | Store only `WeakRef<Agent>` in the initiator ALS and keep the registry's strong hold on live Agents; any object stored in that ALS must not strongly reach an Agent |
| Read window line detachment | Preserve | Kept `read` window lines must not share storage with the decoded file; use a lossless copy |
| Per-record storage load concurrency | Preserve | Per-record table loads keep a bounded number of record files open; drop only if upstream bounds them equivalently |
| Legacy `memory-admission` package | Retired | Use official `dsh-subagent.maxActiveSubagents` and `maxDepth` settings |
| Generic parent/child messaging | Replaced by official `sendMessage()` | Never restore the old public `.steer()` API |
| Queue edit/remove/steer | Replaced by official `session.updateQueue` | Do not restore `subagents.updateQueuedByParent` |
| Official experimental Team mailbox fork | Retired | Real profile uses external AgentTeams v0.1.20; keep official V4 implementation unchanged |
| Forced Team shell background / yielding wait | Retired | Its only Consumer was the unused official Team profile |
| Global disconnect overlay | Preserve | Official replacement must remain visible with collapsed sidebar |
| Windows/macOS launch/build scripts | Preserve | Official launcher must cover local heap/report/path needs before removal |
| Source CLI module identity and scheduler failure pairing | Preserve | Source profiles use link resolution; every scheduler failure drains work and records result pairs before Turn error |
| Fork-vendored AgentTeams behavior | Preserve and verified for RC.1 | Pull upstream through subtree, retain the private version/artifact, and never install npm latest over the live profile |
| AgentTeams unread mailbox projection LRU | Preserve | Require unchanged JSONL format, dynamic lease expiry, exact mutation invalidation, caller isolation and bounded retention |
| AgentTeams crash-durable state | Preserve | Sync state files before rename or direct overwrite; workspace scans skip content-damaged teams with one warning while direct team reads and I/O errors still throw |
| Independent Session creation and unrestricted Session-id Agent messages | Preserve | Keep same-call create-and-start, configured permission inheritance before delivery (never custom or current-session-only Auto), server-derived sender attribution, wake-enabled next-step delivery and prompt-only loop guidance; do not fold it into human `session.prompt` or widen subagent adjacency |
| Context field-level COW and bounded views | Preserve | v0.55.0 adds turn ledger and selective arguments, but not dirty retention, view identity reuse or closed-modal subscription release |
| Context tool attribution ownership | Preserve | Deduplicate the raw `cordis.original` service, retain only the reader name, preserve the call-site receiver and restore ownership on unload |
| Subscriptions V4 message translation | Ported onto v0.9.4 | Keep tool-call identity, result error/image handling and explicit developer-message refusal |
| Legacy fixed-concurrency wrapper | Retired | Official `maxActiveSubagents` owns the active policy; do not mount the duplicate wrapper |

-----

## Upstream merge procedure

1. Stop DSH and confirm no Host instance owns the real profile or sessions.
2. Run `git status --short --branch` and review every path. Commit all in-flight work to `backup/wip-before-<tag>-<date>`, then push that branch to `origin`; do not rely on stash.
3. Create and push `backup/pre-upstream-<tag>-<date>` from a clean master.
4. Run `git fetch --tags --prune upstream` and record `master`, `origin/master`, `upstream/master` and the exact release-tag SHAs.
5. Create `integrate/upstream-<tag>` in a separate worktree from clean master. Merge the exact official release tag with `--no-ff`; do not merge rolling `upstream/master` directly.
6. Resolve Session/core/API/schema/package layout/generated catalogs/lockfile with official structure first. Resolve conflict files individually; do not apply repository-wide `-X theirs` and do not wholesale cherry-pick old fork commits.
7. Commit the official-first merge before porting fork behavior. Re-implement only the still-missing rows in [Preservation matrix](#preservation-matrix), using the target tag's APIs and focused tests.
8. Take official lockfile first, update manifests during ports, then regenerate with the pinned pnpm version. Update owner source before generated catalogs and bilingual sidecars.
9. Build and test only in the integration worktree. Boot a copied DSH_HOME, validate the long-session clone and every enabled plugin, then compare source Session hashes.
10. Push `origin/integrate/upstream-<tag>`. After it passes, fast-forward master and push normally; never raw force-push.
11. Rebuild the real checkout and profile, update this document's baseline and preservation rows, then let the user start DSH manually.

-----

## Plugin update procedure

1. Read the plugin release/tag source, package peers, release notes and current DSH API changes; npm installation success alone is not compatibility evidence.
2. Back up `profiles\web\package.json`, lockfile, workspace policy, `cordis.patch.yml`, custom `.cjs`, `.agent-presets`, market state and all local tgz/source evidence.
3. Install or pack the candidate only in an isolated profile. Do not change the real profile dependency first.
4. Compare every current local AgentTeams behavior listed above. When upstream implements one, remove the duplicate patch only after equivalent tests pass.
5. Validate Host activation, Web client activation, no console errors, authenticated plugin routes, staged plan, member spawn/navigation, steer while running, failure settlement, cold captain report, mailbox replay and restart recovery.
6. Use a cloned DSH_HOME and copied workspace `.agent-teams`. Never test migrations against the only real copy.
7. Pin the accepted exact tgz/version in package + lock. Preserve rollback artifact and update this document.

-----

## Verification

### Focused source checks

Run only the groups affected by the port. Keep ordinary test batches under 20 seconds.

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile

pnpm exec vitest run packages/session/session-persistence-jsonl/tests/jsonl.spec.ts packages/session/session-persistence-jsonl/tests/zstd.spec.ts packages/session-query/session-query/tests/search-helpers.spec.ts packages/session-query/session-query-sqlite/tests/sqlite.spec.ts

pnpm exec vitest run packages/session/session-persistence-jsonl/tests/multi-edge-publication.spec.ts packages/session-query/session-query/tests/observation.spec.ts packages/session-query/session-query/tests/session-query.spec.ts packages/core/agent-loop/tests/resume.spec.ts packages/session/session-persistence-jsonl/tests/zstd.spec.ts packages/session/session-persistence/tests/storage-contract.spec.ts

pnpm exec vitest run packages/api/session-controller/tests/agent-residency.host.spec.ts packages/api/session-controller/tests/session.client.spec.ts packages/api/session-controller/tests/sessions-service.client.spec.ts packages/client/ui-tool/tests/tool-row.client.spec.tsx packages/client/ui-settings-general/tests/connection-overlay.client.spec.tsx

pnpm exec vitest run packages/api/session-controller/tests/session-history-journal.host.spec.ts packages/api/session-controller/tests/transport.host.spec.ts packages/api/session-controller/tests/session-cold.host.spec.ts

pnpm exec vitest run packages/jobs/jobs-local/tests/retention.spec.ts packages/jobs/jobs-local/tests/jobs.spec.ts packages/jobs/jobs-local/tests/loader-composition.spec.ts packages/jobs/tool-jobs/tests/tool-jobs.spec.ts packages/subagent/subagent/tests/continuation.spec.ts packages/subagent/subagent/tests/control.spec.ts packages/subagent/tool-subagent-control/tests/tool-subagent-control.spec.ts packages/experimental/agent-team/tests/team.spec.ts packages/shell/tool-pwsh/tests/tools.spec.ts

pnpm exec vitest run scripts/fork-profile-setup.spec.ts packages/skill/skill-filesystem/tests/skill-filesystem-watcher.spec.ts packages/core/agent/tests/agent-initiator.spec.ts packages/fs/tool-fs/tests/read-render.spec.ts packages/storage/storage-json/tests/per-record-load-concurrency.spec.ts

pnpm exec vitest run packages/api/session-controller/tests/queue-store.client.spec.ts packages/api/session-controller/tests/transport.client.spec.ts packages/client/ui-conversation/tests/queue-dock.client.spec.tsx

pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/subagent-interrupt.e2e.ts

pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/seeded-history.e2e.ts -t 'serves the projections baseline|lists the seeded session cold'

pnpm exec vitest run packages/api/tool-session-message/tests/tool-session-message.spec.ts packages/api/tool-session-message/tests/loader-composition.spec.ts packages/core/tools/tests/gen-tool-catalog.spec.ts

pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/session-message-composition.e2e.ts
```

Windows 的 Bash suite 被官方 Vitest 配置排除；它需要 Linux/macOS lane 或专门的 POSIX shell 环境，不能以 PowerShell mirror 结果冒充 Bash 实测。

### Generated docs and build

```powershell
pnpm run verify-config-catalog
pnpm run verify-cordis-catalog
pnpm run verify-cordis-api
pnpm run verify-tool-catalog
pnpm run verify-translation-pairing
pnpm run test:docs
pnpm run doc-sync
pnpm run build
git diff --check
git status --short --branch
```

AgentTeams subtree 另跑（每个命令保持短批次）：

```powershell
cd fork-plugins\dsh-agent-teams
corepack pnpm@10.30.2 typecheck
corepack pnpm@10.30.2 build
corepack pnpm@10.30.2 verify
```

只改 fork 维护文档时至少运行 `pnpm run test:docs` 与 `git diff --check`。涉及 packages、profile manifest 或 generated output 时再运行相应 focused tests、build 和 hygiene；不要为了提交重复已经通过且未受影响的行为测试。

### Isolated runtime checks

1. 在复制出的 DSH_HOME 中安装同一 profile 与插件版本。
2. 启动 Web profile，确认版本、会话列表和目标长会话可打开，浏览器 console 没有 plugin activation error。
3. 关闭 Host，确认全局 overlay 显示断线，supervisor 不自动重启。
4. 重启 Host，确认 Session、AgentTeams 状态、成员会话和队列恢复。
5. 对真实 Session 文件和复制前的基线执行 SHA256 比较；任何差异都必须先解释，禁止把测试写回真实目录。
6. 对 AgentTeams candidate 额外验证匿名 route 401、恶意 Host/Origin 403、authenticated route 成功，以及运行成员的 steer/failure/cold-report 路径。

-----

## Known limitations

- 运行中的 Agent 仍完整持有 Host `Session.log`；一个持续输出的单会话仍可能线性增长。`SessionHandle.read(offset, length)` 目前也先解码整份 JSONL/Zstd 再切片，同步历史消费者尚未完成迁移；以上留存修复不是运行中 Agent 的 event-level paging。后续实现须先满足[同步事件读取弃用约束](.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md)，不能只给 `read()` 增加分页参数。
- Alpha.2 已显著降低长会话初始化、流式更新、代码高亮、布局与导航预览成本，但仍不等价于完整 variable-height Chat virtualization；Tool lazy 也不能替代它。
- Host 的普通 Agent loop 仍主要运行在一个 Node event loop；process worker 是显式 one-shot 旁路，不是透明的全局多核调度。
- 第一次不同的 broad SQLite query 仍可能同步占用一个 Host thread。
- Watchdog 是最后一道优雅停机保护，不是 steady-state 回收机制，也不保证十小时高并发绝不退出。
- macOS `run.command` 已具备自适应 4–16 GiB heap 与 Node reports，但不包含 Windows 外置 watchdog、safe supervisor、ChatGPT preset 或 process-worker profile；物理 macOS 冷启动仍是主机资格验证的必需步骤。
- Process-worker SDK profile 的 stale `memory-admission` row 已删除；Alpha.2 的 Host Subagent runtime 默认把 continuable child pool 限制为 8。
- AgentTeams 已随 fork 维护；live Lead 指令使用官方 Host Steer adapter，inactive child 使用 Host Queue adapter。每次 DSH 或 AgentTeams 上游更新都必须重新跑两条路径、退休成员和冷队长邮箱测试。
- AgentTeams 的 append/claim/ack 仍会整份重写单个 mailbox JSONL；未读投影缓存已消除不变文件的每秒重读/解析，但超长高频写邮箱仍存在 O(N) 写放大。下一步只能在保持旧 JSONL 可读和归档历史完整的前提下优化。
- AgentTeams 的进程内 team lock Map 与 scheduler parked-attempt Map 仍有小量键保留；当前有界数据量不构成 P1，但后续应随 team archive/remove 回收。
- Diagnostics 目前没有自动轮转，长期运行后需按具体文件人工归档。

## Dev Note

本文是 fork-local 维护参考，不属于 DeepSeek 官方文档网站，也不承诺当前 `upstream/master` 的版本号长期不变。每次上游合并、插件替换、默认值变化、外置 profile 变化或 Queue API 行为变化后，维护者必须在同一提交中更新本文；若某项被官方等价替代，应记录替代 owner 与验证，然后删除本 fork 的重复实现。

## Local reverse-engineering workbench (`.cc-carve/`)

**Behavior.** `.cc-carve/` holds the Claude Code reverse-engineering assets used to keep
the subscription plugin's Claude path faithful: segmented carves of client builds, the
desktop application's restored source tree, and the verified client binaries.

**Preservation rule.** The directory is local-only and git-ignored; an upstream merge
must not delete the `.cc-carve/` ignore entry in `.gitignore`. The assets are rebuilt
from public release artifacts (checksums in the desktop app's manifest) rather than
committed, so nothing here needs to survive a merge.

**Verification.** `git check-ignore -v .cc-carve` reports the ignore rule, and
`git status --porcelain` lists no path under `.cc-carve/`.