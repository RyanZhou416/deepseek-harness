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
| Subscriptions subtree | `fork-plugins/dsh-plugin-subscriptions` | 上游 `v0.9.4` + 本 fork RC.1/V4 私有适配；凭据与 Session 格式不变 |

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

官方 `maxConcurrentJobsPerOwner=10` 管理 live jobs，`maxActiveSubagents=8` 管理 continuable child activation；两者都独立于 terminal Job 留存。上游替代必须有 terminal TTL/count、unreported protection、active exclusion 和有界维护算法。

### Client rendering and connection state

#### Tool detail lazy materialization

`packages/client/ui-tool` 沿用官方 `ToolRow` 输入延迟格式化接口，并让通用结果通过 `outputNode` 保持原始 block 引用，折叠时只检查是否有输出、错误时只取首行；展开后才压平整个输出。`toolRowModel.output` 的按需 getter 缓存专门工具行明确读取的文本；专门 card model 仍按需复制大型数组。

RC.1 已延迟 generic Tool input formatting；fork 只补回仍缺失的 output flatten 与大型 card array lazy materialization。聚焦验证为 `packages/client/ui-tool/tests/tool-row.client.spec.tsx`。

#### Global backend-disconnect overlay

`packages/client/ui-settings-general/src/client/ConnectionOverlay.tsx` 复用官方 `ctx.connection.state`、`reconnect()` 和 `ConnectionIndicator`，在 `shell.overlay` 顶部居中显示 disconnected/connecting/recovered。Sidebar 收起时仍可见，健康初始状态不渲染，恢复绿态保留两秒。

该组件只控制 WebSocket reconnect，不启动 Host。上游只有提供全局、sidebar-independent、actionable 状态且不引入 silent Host restart 时，才能替代它。

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

### Local launch and build scripts

仓库包含 [clean.cmd](clean.cmd)、[build.cmd](build.cmd)、[run.cmd](run.cmd)、[clean.command](clean.command)、[build.command](build.command)、[run.command](run.command) 与 [setup.command](setup.command)。三个 Windows 入口共用 [fork-windows-pnpm.cmd](scripts/fork-windows-pnpm.cmd)：它读取 `package.json` 锁定的 pnpm 版本，通过 npm 在 `%TEMP%` 下准备私有副本，校验入口文件、命令 shim 与版本，并把私有 shim 目录置于子进程 `PATH` 首位；依赖安装脚本启动的 `pnpm` 因此也不会落到残缺的 Corepack 缓存。npm registry 默认使用 npmmirror，可用 `npm_config_registry` 覆盖。`clean.cmd` 只调用仓库拥有的 `pnpm run clean`，在依赖缺失时先安装依赖，不删除 `node_modules`、profile 或 Session 数据；`build.cmd` 执行 install + build。两者安装依赖时默认限制 pnpm child concurrency 为 4，可用 `DSH_PNPM_CHILD_CONCURRENCY` 覆盖，避免大型升级后同时启动过多 worker；聚焦验证为 `scripts/fork-windows-launchers.spec.ts`。`run.cmd` 默认 `DSH_HOME=C:\Project\deepseek-harness-data`，创建 diagnostics，并追加 `--max-old-space-size=16384` 与 Node fatal/uncaught reports 后运行 Web profile。源码 CLI 为 profile 选择 link resolution，使配置的 workspace provider 与其内部 consumer 都解析到 `src/`；构建后入口仍使用 built runtime resolution。真实源码入口工具往返测试负责防止 `src/lib` 模块身份再次分裂。

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
| `@nanmicoder/dsh-agent-teams` | `0.1.20-dsh017rc1.1` | Installed, enabled | 真实 profile 使用仓内固定 artifact；停止 Host 后更新，禁止被 npm latest/next 直接覆盖 |
| `dsh-plugin-subscriptions` | `0.9.4-dsh017rc1.1` | Installed | 仓内固定 artifact；凭据文件原地保留，profile 是否启用沿用显式插件配置 |
| `@vlln/dsh-task-status` | Removed | Not installed | 已从依赖、bundle、patch、lockfile 和 `node_modules` 删除；profile 不得恢复 |
| `dsh-context` | `0.55.0-dsh017rc1.1` | Installed, enabled | 真实 profile 保留 `300/60/100/400/100/100` bounds；源码与回滚规则见 `fork-plugins/dsh-context/FORK_MAINTENANCE.md` |
| `dsh-shell-command` | Removed | No package or configuration | profile 不安装 |
| `@deepseek-ai/dsh-subagent-dsh-sdk` | Link to source checkout | Enabled for process provider | 跟随源码构建，worker 数据与主 sessions 隔离 |

AgentTeams、Context 与 Subscriptions 均使用本地 `file:` tgz，不依赖 release-age 例外。profile 不再安装 dshmarket；禁止 wildcard 和未经审计的 `pnpm update --latest`。

2026-09-24 的 Windows profile 升级先将四个配置文件备份到 `C:\Project\deepseek-harness-data\diagnostics\profile-backups\pre-017rc1-20260924-1900`，再用 DSH Plugin Manager 安装三个固定 tgz。`verify-profile`、`verify-patch` 与组合后的 `verify-dump` 均通过；没有修改 Session、附件或凭据。

Mac 主 checkout 已快进至同一 fork master；`clean.command`、`build.command` 和 `setup.command` 均通过。`setup.command` 将原 profile 的四个配置文件备份到 `/Users/zhouxiran/.dsh/profile-backups/web-20260924T122912Z-84951`，真实 Web profile 已安装上表的三个固定版本。Mac 的 205 个 Cordis 配置检查通过，`run.command` 启动验收时的 Web 响应为 HTTP 200。

### Local AgentTeams package

维护真源位于 `fork-plugins\dsh-agent-teams`，完整保留上游运行源码、测试、构建脚本和资产。仓库安装器使用 `fork-plugins\releases\nanmicoder-dsh-agent-teams-0.1.20-dsh017rc1.1.tgz`，SHA256 为 `17CDEA664A3EC8764CB8763FEC32A8CAE54F5F6429C89958DBE141A26253FF4B`。该 package 标记为 private，禁止用上游 npm scope 发布；旧制品仍可从 Git 历史恢复。

当前 fork artifact 随 Git 提交，同事不依赖这台机器的外置 `.local-plugins-src`。工作树只保留当前 AgentTeams 与 Context 安装包及校验值；历史制品由 Git 历史承担回滚证据。

必须保留的 fork 行为：

1. 保留上游 v0.1.19 的原子 roster/DAG 创建、仅启动 ready member、改名工具成员恢复、repair scope、任务修订、next-step 协调、陈旧消息抑制、attempt 校验、退休成员清理、安全 reassignment 与任务纠正；v0.1.20 只更新上游文档。
2. RC.1 发行路径使用 awaited `agent/created`、`Session.ownEvents()` 与统一 Host delivery adapter；legacy setup 和旧 Host Queue 形态只保留为回归 fixture，不构成发行兼容声明。
3. Team 内部队长指令、scheduler assignment、peer delivery 和 mailbox recovery 使用 Host Queue/Steer 规则，来源为 `agent-teams-host`；fork 不再重复维护最近-step 或退休成员策略。
4. Client 使用 `uiConversation`、`uiWorkspace` 的 projection refresh 与 `[data-composer-input]`；Host capability 层保持 14 个 Captain 工具和 4 个成员工具稳定。package peer、development dependency、完整 DSH override cohort 与 lockfile 固定为 `0.1.7-rc.1`。
5. 普通 captain 不驻留时，成员报告先通过 Host Session Controller cold resume captain；Captain Session start 会重投 durable mailbox，成功逐条 ack，失败记录及后缀释放 delivery lease。
6. Windows directory rename 使用独立的 5 次重试预算；构建清理目标用跨平台 `basename()` 校验。
7. `readUnreadMailbox()` 使用只保留 pending 消息的 256-entry / 8 MiB 有界 LRU，并以 `dev/ino/size/mtimeNs/ctimeNs` 检测文件替换；lease 每次按当前时间重算，append/claim/release/ack/archive/remove 成功后精确失效。完整历史读取和磁盘 JSONL 字节格式不变。

`.local-plugins-src\...dsh012.2/.3/.4` 只是历史解包产物，不能再当维护源。以后用 `git subtree pull --prefix=fork-plugins/dsh-agent-teams https://github.com/NanmiCoder/dsh-agent-teams.git <tag> --squash` 获取精确官方发布，再在 fork 内重放和验证上述行为；不得用 npm install 覆盖 subtree。

本 fork 以 `v0.1.20` 生成 `0.1.20-dsh017rc1.1`。上游拥有 scheduling、next-step delivery、retired-member cleanup、repair scope 与 task correction；fork adapter 只补 RC.1 source/导航适配、冷 Captain mailbox 恢复和有界 unread mailbox projection。后续上游发布先按行为测试去重，再提升 subtree 基线和私有版本；profile 始终安装 fork artifact。

### Local Context package

维护真源位于 `fork-plugins\dsh-context`，仓库安装器使用 `fork-plugins\releases\dsh-context-0.55.0-dsh017rc1.1.tgz`，SHA256 为 `F75D2CB582BF21813D883644600B866EC84800ED6E8D0E835187C1D7F48CA714`。该版本采用上游 v0.55.0 的 V0/V2/V3/V4 fold、Context Insights、余额展示、增量 turn 账本、按需 backfill 与 slim-head/on-demand-detail 传输，并保持既有 projection key 和 Session event vocabulary 不变。

### Local Subscriptions package

维护真源位于 `fork-plugins\dsh-plugin-subscriptions`，仓库安装器使用 `fork-plugins\releases\dsh-plugin-subscriptions-0.9.4-dsh017rc1.1.tgz`，SHA256 为 `4F2A6D5D86C7AB0D342C3F7C4FACC3D16C49C3628D6EAD41B9964C426DCDFD88`。该版本采用上游 v0.9.4 的多账号 provider、usage UI、Codex 搜索、图片结果、Antigravity 与 provider failover，并增加 RC.1 的 V4 工具角色转换；凭据格式与工具输出不变。

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
| Five-minute idle Agent eviction | Preserve | Require opening-only follower pin, child/inbox/job exclusions, flush + persistence proof and cold resume |
| History follow opening release | Preserve | Require bounded opening output, full-observation release, promotion ownership and gap-free delivery across eviction |
| Reference-owned Client Session generations | Replaced by official references | Keep final-release withdrawal and projection-store retention; do not restore `suspendHistory()` |
| 20k final-message packed rebase | Replaced by cursorless Assistant frames | Keep official transient-stream settlement; do not restore scalar chunk accumulation |
| Tool output/card lazy calculation | Ported onto RC.1 | Preserve generic output-on-expand and card-array laziness; official already defers input formatting |
| Jobs one-hour TTL / 100 terminal target | Ported onto RC.1 | Official ring caps do not bound terminal-record count or lifetime; preserve unread protection and lightweight heap indexes |
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
| Independent Session creation and unrestricted Session-id Agent messages | Preserve | Keep same-call create-and-start, configured permission inheritance before delivery (never custom or current-session-only Auto), server-derived sender attribution, wake-enabled next-step delivery and prompt-only loop guidance; do not fold it into human `session.prompt` or widen subagent adjacency |
| Context field-level COW and bounded views | Preserve | v0.55.0 adds turn ledger and selective arguments, but not dirty retention, view identity reuse or closed-modal subscription release |
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

pnpm exec vitest run packages/session/session-persistence-jsonl/tests/multi-edge-publication.spec.ts packages/session-query/session-query/tests/observation.spec.ts packages/session-query/session-query/tests/session-query.spec.ts

pnpm exec vitest run packages/api/session-controller/tests/agent-residency.host.spec.ts packages/api/session-controller/tests/session.client.spec.ts packages/api/session-controller/tests/sessions-service.client.spec.ts packages/client/ui-tool/tests/tool-row.client.spec.tsx packages/client/ui-settings-general/tests/connection-overlay.client.spec.tsx

pnpm exec vitest run packages/api/session-controller/tests/session-history-journal.host.spec.ts packages/api/session-controller/tests/transport.host.spec.ts packages/api/session-controller/tests/session-cold.host.spec.ts

pnpm exec vitest run packages/jobs/jobs-local/tests/retention.spec.ts packages/jobs/jobs-local/tests/jobs.spec.ts packages/jobs/jobs-local/tests/loader-composition.spec.ts packages/jobs/tool-jobs/tests/tool-jobs.spec.ts packages/subagent/subagent/tests/continuation.spec.ts packages/subagent/subagent/tests/control.spec.ts packages/subagent/tool-subagent-control/tests/tool-subagent-control.spec.ts packages/experimental/agent-team/tests/team.spec.ts packages/shell/tool-pwsh/tests/tools.spec.ts

pnpm exec vitest run scripts/fork-profile-setup.spec.ts

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
