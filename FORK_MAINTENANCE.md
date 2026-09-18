# RyanZhou416 Fork Maintenance Reference

## Summary

本文是 `RyanZhou416/deepseek-harness` 的 fork 维护真源，记录官方仓库之外仍需保留的源码行为、启动脚本、外置 DSH_HOME、插件补丁、会话数据红线、合并流程和验证入口。上游合并或插件升级不得只按文件覆盖；维护者必须逐项证明某个 fork 行为已由上游等价实现，才能删除对应代码、配置和测试。

本文描述当前 `master` 的已提交源码行为与 2026-09-04 审计到的仓库外运行层。具体发布 SHA 以 `git rev-parse origin/master` 为准；任何尚未提交的工作树文件都不属于同事可取得的发布基线。

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
| Published fork | `master` after local integration | `dsh-v0.1.6-alpha.2` 官方结构、16 GiB Windows Host、长任务保护与 fork-maintained plugin 基线；精确 SHA 用 Git 查询，避免文档自引用失真 |
| Current official target | `dsh-v0.1.6-alpha.2` on 2026-09-17 | 精确不可变 tag；不要改合并已越过该 tag 的 rolling `upstream/master` |
| AgentTeams subtree | `fork-plugins/dsh-agent-teams` | 上游 `v0.1.19` + 本 fork 0.1.6 Alpha.2 私有适配；subtree merge 记录精确 split |
| Context subtree | `fork-plugins/dsh-context` | 上游 `v0.53.3` + 本 fork 字段级投影、V3 header 计价和关闭 modal 性能优化 |
| Subscriptions subtree | `fork-plugins/dsh-plugin-subscriptions` | 上游 `v0.9.2` + 本 fork 0.1.6 Alpha.2 私有适配；凭据与 Session 格式不变 |

当前维护的源码兼容基线是 `dsh-v0.1.6-alpha.2`。整合采用官方异步 Agent 创建、handle-based Session persistence、Session format v3、通用 `session.updateQueue`、多实例 Client Session、Plugin Manager、Subagent activation limits、cursorless Assistant frame、Web Terminal、SSH、MCP resources、Browser/Computer Use 和连接容错，再按本文的行为与测试补回仍缺失部分；后续合并禁止整体恢复旧版文件。

0.1.6 Alpha.2 的 `SESSION_FORMAT_VERSION` 仍为 `3`；只读 open 可以准备受支持的历史 generation，写 open 在验证后发布 v3 successor。逻辑 `SessionHeader` 使用 `isSeeded`，精确 inherited cut 由 handle metadata 与 `session/end-seed` 表示。第三方插件即使磁盘数据可读，也必须重新构建并在隔离 profile 验证逻辑 API。

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

Alpha.2 官方 `packages/llm/token-meter/src/index.ts` 保存精确 consumed offset，并只通过 indexed Session 读取未消费记录。它已经消除每次 event 的整日志 materialization，因此不得恢复 fork 原有 direct-event fast path 与整日志 fallback。

#### Persistence write-behind ownership

`packages/session/session-persistence-jsonl/src/storage.ts` 的 live route 复用 `Session.append()` 已 detached/deep-frozen 的 event；公开 `SessionHandle.append()` 仍在异步排队前复制 borrowed input。写批次通过交换 backing array 在 O(1) 转移，失败时把原批次放回队首并保持顺序。

上游替代必须同时保证 immutable ownership、O(1) batch detach 和失败重放顺序；单纯缓存 Session snapshot 不等价。

#### JSONL/Zstd metadata cache

`packages/session/session-persistence-jsonl/src/index.ts` 以精确 selected-generation revision 缓存验证后的 header，并让并发 `list()` caller 共享一次 discovery。单个 caller abort 只取消自己的等待；revision 变化会重新验证，删除路径会清理 cache，返回值保持 detached。

该优化不改变 JSONL/Zstd 文件格式。上游替代必须能识别 append、replace、delete，并且不能让一个 caller 的取消终止所有并发 caller。

#### SQLite live search and bounded pages

`packages/session-query/session-query/src/documents.ts` 与 `packages/session-query/session-query-sqlite/src/index.ts` 用 live Session object identity、event count 和 canonical surface replacement generation 区分 append-only suffix 与 replacement。安全 append 只索引新增 documents；replacement 或 lifecycle 变化执行完整 fold。

Session search 和 event search 使用 exact-generation/request/cursor key 的 item-weighted LRU；两个 cache 均受现有 `maxLimit` 限制，并向 caller 返回 detached copy。上游替代必须同时保持 suffix reconciliation、replacement rejection 和 bounded ownership-safe result cache。

### Runtime residency bounds

#### Idle Web Agent eviction

`packages/api/session-controller/src/agent.ts`、`index.ts`、`history.ts` 和 `commands.ts` 让 Session Controller 持有其 create/resume/fork 的 `AgentHandle`。默认 `idleSessionRetentionMs=300000`；只有 durable、unfollowed、idle、无 pending inbox、无 live child、无 running/stopping job 的 owned Agent 才进入计时。

到期路径先 `sessions.flush()`，再验证 persistence snapshot，最后只 dispose Controller 自己持有的 handle；Session list row 与磁盘日志保留，下次操作 cold resume。无 persistence 时不淘汰，配置 `0` 可禁用。它是 residency 回收，不是 Agent 并发限制。

上游替代必须包含 follower/child/inbox/job exclusions、flush、持久化证明、list row 保留和 cold resume；简单 LRU 或无证明的 timer dispose 不等价。

#### Reference-owned Client Sessions

Alpha.2 的 `packages/api/session-controller/src/client/sessions/service.ts` 通过带 source 标签的 `retain()` 管理 Client Session generation。工作区 `mainView` reference 拥有当前选中会话；最后一个 reference 释放时，Controller 会先撤回 binding 与 Agent-scoped Context，再异步释放 Session 与 detailed-history stream。目录元数据和 per-Session projection store 位于 instance 之外，替代 generation 可以安全复用这些投影值。

同 id generation 替换、opening cancellation 与延迟 teardown 均有 identity guard；旧 cleanup 无法撤回新 binding。该官方模型同时释放 off-stage window、scoped feature state 和 Host follower，因此 fork 不再恢复 `suspendHistory()` 或保留无 Consumer 的 Session instance。

#### Terminal jobs retention

`packages/jobs/jobs-local` 新增可选 `terminalJobRetentionMs` 与 `maxRetainedTerminalJobsPerOwner`。包默认省略两项以保持上游行为；shipped base profile 配置为一小时 TTL 和每个 exact owner 100 条 terminal target。

Count pruning 只删除最旧且已 reported 的 completed/killed/failed records；unreported 记录保留到 TTL 或 teardown，running/stopping 永不参与。Exact owner 与 unowned bucket 分离，最小堆和一个 `unref()` timer 避免每次全表 scan/sort；waiter 与刚结算 id 在读取完成前受保护。

官方 `maxConcurrentJobsPerOwner=10` 管理 live jobs，`maxActiveSubagents=8` 管理 continuable child activation；两者都独立于 terminal Job 留存。上游替代必须有 terminal TTL/count、unreported protection、active exclusion 和有界维护算法。

### Client rendering and connection state

#### Tool detail lazy materialization

`packages/client/ui-tool` 的 `ToolRowDetailsModel` 在折叠状态只暴露 summary/state 和 `hasBody` / `hasOutput`。`ToolRow` 仅在 disclosure 打开时读取 cached getters，推迟 pretty args、flattened output 和大型 card array copies。

Alpha.2 已延迟 generic Tool input formatting；fork 只补回仍缺失的 output flatten 与大型 card array lazy materialization。

#### Global backend-disconnect overlay

`packages/client/ui-settings-general/src/client/ConnectionOverlay.tsx` 复用官方 `ctx.connection.state`、`reconnect()` 和 `ConnectionIndicator`，在 `shell.overlay` 顶部居中显示 disconnected/connecting/recovered。Sidebar 收起时仍可见，健康初始状态不渲染，恢复绿态保留两秒。

该组件只控制 WebSocket reconnect，不启动 Host。上游只有提供全局、sidebar-independent、actionable 状态且不引入 silent Host restart 时，才能替代它。

### Subagent and AgentTeams responsiveness

#### Continuable child steer

Alpha.2 官方 `SubagentRuntime.sendMessage(sender,target,...)` 统一 direct parent/child messaging 并支持 image；fork 未恢复旧公开 `.steer()` / `.followup()`。Team mailbox 只使用官方 symbol-keyed Host queue/steer adapter，以保留 Team message source。

#### External AgentTeams mailbox delivery

外置 AgentTeams v0.1.19 拥有 live member 的 next-step delivery、inactive member 的 Queue、稳定 message id、accept/ack、target-local serialization、crash recovery、cold replay 与退休成员拒绝。Fork 不再修改 DSH 官方实验性 Team mailbox。

Fork 仍让 inactive Captain 通过 Session Controller cold resume，并在 awaited `agent/created` 阶段按 durable mailbox 顺序重投；成功逐条 ack，失败释放当前记录和未处理后缀。未读 projection 使用 256-entry / 8 MiB LRU，磁盘 JSONL 格式不变。

Team 消息先写入 durable mailbox，再尝试 Host delivery；Host 接纳后记录才标记为已投递，失败记录保持可重试。消息进入正在执行不可中断工具的 Agent 收件箱后会等待该工具结算，不会抢占工具，也不代表消息丢失。成员遗漏 `attempt_id` 时，v0.1.19 返回包含当前 id 的可重试错误且不撤销 attempt；只有不匹配的 id 才按 stale attempt 拒绝。

#### Session-addressed Agent messages

Web bundle 的 `standard`、`ptc` 与 `cordis` preset 在 Agent 工具作用域内挂载 `@deepseek-ai/dsh-tool-session-message`；Host 全局工具层与 `minimal` preset 不挂载。其 `session_send_message` 把确切在线调用 Agent 的 Session id 记录为 `agent-message` relay 来源，再通过 `inject()` 写入目标 next-step 上下文。它不会唤醒空闲目标或创建 Agent 编写的用户轮次；运行中目标在后续 step 准入，空闲目标等待其他唤醒输入。在线目标不受工作区、lineage、origin 或自身目标限制；冷普通 Session 通过 Session Controller 恢复，冷 subagent 仍由其 parent 或 Team 生命周期负责。

同包的 `session_find` 复用 `dsh-session-reference` 的 candidate 目录，按用户提供的非空标题／id／工作区子串查找独立 Session，再用 Session-query header 排除所有持久 `origin: subagent`（包括 AgentTeams teammate），同时保留普通用户 fork，且不激活冷候选项；重复标题必须交给用户选择，不能静默猜测。

发送工具没有 runtime 目标策略、频率限制、relay depth 或自身消息限制。工具描述把直接 parent/child 路由到 `send_message`、把 teammate 路由到 AgentTeams，并只允许使用用户提供、传入 Session 消息标识、用户创建 reference 暴露，或 `session_find` 为用户点名目标返回的无歧义独立 id；接收消息框架要求模型不要确认、轮询、自动回复或转发。这些提示词是唯一的消息风暴控制。接受只表示目标 durable inbox 已插入注入上下文，不表示已读或已回复。待处理注入会阻止冷恢复的普通 Agent 淘汰，直到其他输入唤醒它、队列控制丢弃它，或 Controller 停止。

同包的 `session_message_status` 用目标 Session id 与已接受 `messageId` 只读折叠目标完整日志，不唤醒目标。它区分 pending-context、claimed、model-context、processing-tool、completed、rejected、discarded 与 unknown，并从顶层工具事件和 PTC sub-dispatch 同时识别未结算 `terminal_send` 的 terminal blocking；状态是时间点观察，不自动推送给发送方。

#### Retired official Team scheduling patches

`forceRunInBackground` 与 `yieldWaitOnNextStep` 没有进入 0.1.6 移植。真实 profile 使用外置 AgentTeams，不挂载官方实验性 Team profile；保留两个仅由未启用 profile 消费的公共配置会扩大每次上游合并的冲突面。普通 jobs completion wake、Windows 控制台隔离和 AgentTeams 自己的 next-step delivery 独立保留。

#### Browser Queue Dock

Alpha.2 Queue Dock 通过通用 `session.updateQueue` 对 live Session 的精确 pending occurrence 执行 edit、remove 或 steer。Edit 保留 message identity/source，remove 持久取消 occurrence，steer 只在当前状态允许时把 occurrence 提升到 next-step；continuable child 使用同一 Session-addressed API。

Fork 不再维护独立 subagent Queue Remote 或错误码。后续上游合并必须保留 `session.updateQueue` 的 occurrence identity、通用 Session/continuable-child 寻址、发送中禁用状态、单条与批量 Steer，以及 durable `agent/inbox/spliced` 记录。

### Local launch and build scripts

仓库包含 [clean.cmd](clean.cmd)、[build.cmd](build.cmd)、[run.cmd](run.cmd)、[clean.command](clean.command)、[build.command](build.command)、[run.command](run.command) 与 [setup.command](setup.command)。Windows 脚本准备 Corepack/pnpm 和镜像 registry；`clean.cmd` 只调用仓库拥有的 `pnpm run clean`，在依赖缺失时先安装依赖，不删除 `node_modules`、profile 或 Session 数据；`build.cmd` 执行 install + build，`run.cmd` 默认 `DSH_HOME=C:\Project\deepseek-harness-data`，创建 diagnostics，并追加 `--max-old-space-size=16384` 与 Node fatal/uncaught reports 后运行 Web profile。

macOS 的 `clean.command`、`build.command` 和 `run.command` 共用 `scripts/fork-macos-runtime.sh`。`clean.command` 与 Windows 入口使用同一个仓库 cleaner，保留依赖与用户数据。该 helper 从 `PATH`、Apple Silicon Homebrew 和 Intel Homebrew 路径查找 Node，拒绝不受支持的 Node 23，仅在私有临时目录安装固定 Corepack fallback，并使用仓库锁定的 pnpm。`run.command` 默认 `DSH_HOME=~/.dsh`，创建权限 `0700` 的 diagnostics，启用 Node fatal/uncaught reports，并把 V8 old-space 设为物理内存的一半且限制在 4–16 GiB；`DSH_MAX_OLD_SPACE_MIB` 可显式覆盖。它不会静默重启 Host。

macOS 的 `setup.command` 是一次性显式 profile 安装入口。它校验并安装仓内 Agent Teams 和 Context tgz，为 Context 应用低开销 bounds，且只备份它可能改动的 profile 配置四文件。它不导入或修改另一台机器的 Session、附件、DSH credential store、projection cache 或 `.agent-teams`；`--dry-run` 不创建 Harness home 或 package-manager 目录。

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
| `dshmarket` | — | Removed | Alpha.2 官方 Plugin Manager 接管安装、配置与运行时启停；profile 升级时移除 package 与 bundle |
| `@nanmicoder/dsh-agent-teams` | `0.1.19-dsh016alpha2.1` | Installed, enabled | 真实 profile 使用仓内固定 artifact；停止 Host 后更新，禁止被 npm latest/next 直接覆盖 |
| `dsh-plugin-subscriptions` | `0.9.2-dsh016alpha2.1` | Installed | 仓内固定 artifact；凭据文件原地保留，profile 是否启用沿用显式插件配置 |
| `@vlln/dsh-task-status` | Removed | Not installed | 已从依赖、bundle、patch、lockfile 和 `node_modules` 删除；profile 不得恢复 |
| `dsh-context` | `0.53.3-dsh016alpha2.1` | Installed, enabled | 真实 profile 保留 `300/60/100/400/100/100` bounds；源码与回滚规则见 `fork-plugins/dsh-context/FORK_MAINTENANCE.md` |
| `dsh-shell-command` | Removed | No package or configuration | profile 不安装 |
| `@deepseek-ai/dsh-subagent-dsh-sdk` | Link to source checkout | Enabled for process provider | 跟随源码构建，worker 数据与主 sessions 隔离 |

AgentTeams、Context 与 Subscriptions 均使用本地 `file:` tgz，不依赖 release-age 例外。profile 不再安装 dshmarket；禁止 wildcard 和未经审计的 `pnpm update --latest`。

### Local AgentTeams package

维护真源位于 `fork-plugins\dsh-agent-teams`，完整保留上游运行源码、测试、构建脚本和资产。仓库安装器使用 `fork-plugins\releases\nanmicoder-dsh-agent-teams-0.1.19-dsh016alpha2.1.tgz`，SHA256 为 `1C93655EE5162987ECBA1BBCD6C084E84DE87A486EF8ED4AF2E33D957EEBE9B9`。该 package 标记为 private，禁止用上游 npm scope 发布；旧制品从工作树移除并仍可从 Git 历史恢复。

当前 fork artifact 随 Git 提交，同事不依赖这台机器的外置 `.local-plugins-src`。工作树只保留当前 AgentTeams 与 Context 安装包及校验值；历史制品由 Git 历史承担回滚证据。

必须保留的 fork 行为：

1. 保留上游 v0.1.19 的原子 roster/DAG 创建、仅启动 ready member、改名工具成员恢复、repair scope、任务修订、next-step 协调、陈旧消息抑制、attempt 校验、退休成员清理、安全 reassignment 与任务纠正。
2. 0.1.6 Alpha.2 发行路径使用 awaited `agent/created`、`Session.ownEvents()` 与统一 Host delivery adapter；legacy setup 和旧 Host Queue 形态只保留为回归 fixture，不构成发行兼容声明。
3. Team 内部队长指令、scheduler assignment、peer delivery 和 mailbox recovery 使用 v0.1.19 的 Host Queue/Steer 规则；fork 不再重复维护最近-step 或退休成员策略。
4. Client 使用 `uiConversation`、`uiWorkspace` 和 `[data-composer-input]`；Host capability 层保持 14 个 Captain 工具和 4 个成员工具稳定。package peer、development dependency、完整 DSH override cohort 与 lockfile 固定为 `0.1.6-alpha.2`。
5. 普通 captain 不驻留时，成员报告先通过 Host Session Controller cold resume captain；Captain Session start 会重投 durable mailbox，成功逐条 ack，失败记录及后缀释放 delivery lease。
6. Windows directory rename 使用独立的 5 次重试预算；构建清理目标用跨平台 `basename()` 校验。
7. `readUnreadMailbox()` 使用只保留 pending 消息的 256-entry / 8 MiB 有界 LRU，并以 `dev/ino/size/mtimeNs/ctimeNs` 检测文件替换；lease 每次按当前时间重算，append/claim/release/ack/archive/remove 成功后精确失效。完整历史读取和磁盘 JSONL 字节格式不变。

`.local-plugins-src\...dsh012.2/.3/.4` 只是历史解包产物，不能再当维护源。以后用 `git subtree pull --prefix=fork-plugins/dsh-agent-teams https://github.com/NanmiCoder/dsh-agent-teams.git <tag> --squash` 获取精确官方发布，再在 fork 内重放和验证上述行为；不得用 npm install 覆盖 subtree。

本 fork 以 `v0.1.19` 生成 `0.1.19-dsh016alpha2.1`。上游拥有 scheduling、next-step delivery、retired-member cleanup、repair scope 与 task correction；fork adapter 只补 awaited `agent/created`、Alpha.2 `uiWorkspace` 导航、冷 Captain mailbox 恢复和有界 unread mailbox projection。后续上游发布先按行为测试去重，再提升 subtree 基线和私有版本；profile 始终安装 fork artifact。

### Local Context package

维护真源位于 `fork-plugins\dsh-context`，仓库安装器使用 `fork-plugins\releases\dsh-context-0.53.3-dsh016alpha2.1.tgz`，SHA256 为 `8C84B018DE10CF181A77AD151D069A00133D7AF8537EE766F2A46C8154DD5843`。该版本采用上游 v0.53.3 的 V0/V2/V3 fold、Context Insights、按需 backfill、live pricing、注入标签、Host File Activity、右侧 Sidebar 与 slim-head/on-demand-detail 传输，并保持既有 projection key 和 Session event vocabulary 不变。

### Local Subscriptions package

维护真源位于 `fork-plugins\dsh-plugin-subscriptions`，仓库安装器使用 `fork-plugins\releases\dsh-plugin-subscriptions-0.9.2-dsh016alpha2.1.tgz`，SHA256 为 `5B6AC96A2E22946BAC53339F4D2A307AD29DAC5195851BF55606BA946CD37177`。该版本采用上游 v0.9.2 的多账号 provider、usage UI、Codex orphan tool-call 修复、cache affinity、图片结果、Antigravity 与 provider failover，并只增加 Alpha.2 lifecycle/type 适配；凭据格式与工具输出不变。

更新时使用 `git subtree pull --prefix=fork-plugins/dsh-plugin-subscriptions https://github.com/V1ki/dsh-plugin-subscriptions.git <tag> --squash`，再重放 `fork-plugins/dsh-plugin-subscriptions/FORK_MAINTENANCE.md`。真实 profile 始终安装仓内固定 artifact，禁止 npm latest 直接覆盖。

本地优化包含 timeline fold 字段级 copy-on-write、request/event/archive/file-op dirty retention trim、恢复态首个 slim/inline/detail value 的 bounds clamp、Host-only 状态的引用稳定 inline/slim cache、关闭 `/context` modal 时释放 projection/detail/history/conversation 订阅，以及用 V3 `system/message` 为后续 header epoch 计价。真实 profile 停机升级后使用 `maxRequestSteps: 300`、`maxKeptTurns: 60`、`maxEvents: 100`、`maxNodes: 400`、`maxArchiveNodes: 100` 和 `maxFileOps: 100`。这些上限只缩小 Context 派生展示，不修改 Session 历史。

更新时使用 `git subtree pull --prefix=fork-plugins/dsh-context https://github.com/bowenliang123/dsh-context.git <tag> --squash`，再逐项重放 `fork-plugins/dsh-context/FORK_MAINTENANCE.md` 所列行为。不得用 npm latest 直接覆盖真实 profile。

### ChatGPT subagent preset

`profiles\web\chatgpt-subagent-preset.cjs` 对 parentSession subagent 检测 provider `codex` 或 model `^gpt-`，在首次 step 前 recompose 到 `chatgpt-dsh`，并持久追加 `agent-preset/selected`。顶层会话和非 ChatGPT 子代理不受影响，失败采取 fail-open。

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
| Token meter direct-event fast path | Replaced by alpha.2 indexed reads | Do not restore whole-log fallback |
| Frozen persistence enqueue and O(1) batch | Preserve | Require identical ownership and failed-write ordering |
| JSONL metadata revision cache/shared scan | Preserve | Require append/replace/delete and caller-cancellation equivalence |
| SQLite suffix indexing/bounded page LRU | Preserve | Require canonical replacement detection and bounded detached cache |
| Five-minute idle Agent eviction | Preserve | Require flush + persistence proof + exclusions + cold resume |
| Reference-owned Client Session generations | Replaced by alpha.2 | Keep official final-release withdrawal and projection-store retention; do not restore `suspendHistory()` |
| 20k final-message packed rebase | Replaced by alpha.2 cursorless Assistant frames | Keep official transient-stream settlement; do not restore scalar chunk accumulation |
| Tool output/card lazy calculation | Ported onto alpha.2 | Retain only output/card laziness not supplied by official input-body deferral |
| Jobs one-hour TTL / 100 terminal target | Preserve | Official alpha.2 does not provide it |
| Legacy `memory-admission` package | Retired | Use Alpha.2 `dsh-subagent.maxActiveSubagents` and `maxDepth` settings |
| Generic parent/child messaging | Replaced by alpha.2 official `sendMessage()` | Never restore the old public `.steer()` API |
| Queue edit/remove/steer | Replaced by alpha.2 `session.updateQueue` | Do not restore `subagents.updateQueuedByParent` |
| Official experimental Team mailbox fork | Retired | Real profile uses external AgentTeams v0.1.19; keep official 0.1.6 implementation unchanged |
| Forced Team shell background / yielding wait | Retired | Its only Consumer was the unused official Team profile |
| Global disconnect overlay | Preserve | Official replacement must remain visible with collapsed sidebar |
| Windows/macOS launch/build scripts | Preserve | Official launcher must cover local heap/report/path needs before removal |
| Fork-vendored AgentTeams behavior | Preserve and revalidate for 0.1.6 | Pull upstream through subtree, retain the private version/artifact, and never install npm latest over the live profile |
| AgentTeams unread mailbox projection LRU | Preserve | Require unchanged JSONL format, dynamic lease expiry, exact mutation invalidation, caller isolation and bounded retention |
| Unrestricted Session-id Agent messages | Preserve | Keep server-derived sender attribution, FIFO waking delivery and prompt-only loop guidance; do not fold it into human `session.prompt` or widen subagent adjacency |
| Legacy fixed-concurrency wrapper | Retired | Alpha.2 `maxActiveSubagents` owns the active policy; do not mount the duplicate wrapper |

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

pnpm exec vitest run packages/api/session-controller/tests/agent-residency.host.spec.ts packages/api/session-controller/tests/session.client.spec.ts packages/api/session-controller/tests/sessions-service.client.spec.ts packages/client/ui-tool/tests/tool-row.client.spec.tsx packages/client/ui-tool/tests/tool-row-lazy.client.spec.tsx packages/client/ui-settings-general/tests/connection-overlay.client.spec.tsx

pnpm exec vitest run packages/jobs/jobs-local/tests/jobs.spec.ts packages/jobs/jobs-local/tests/loader-composition.spec.ts packages/jobs/tool-jobs/tests/tool-jobs.spec.ts packages/subagent/subagent/tests/continuation.spec.ts packages/subagent/subagent/tests/control.spec.ts packages/subagent/tool-subagent-control/tests/tool-subagent-control.spec.ts packages/experimental/agent-team/tests/team.spec.ts packages/experimental/agent-team-profile/tests/profile.spec.ts packages/shell/tool-pwsh/tests/tools.spec.ts

pnpm exec vitest run packages/api/session-controller/tests/queue-store.client.spec.ts packages/api/session-controller/tests/transport.client.spec.ts packages/client/ui-conversation/tests/queue-dock.client.spec.tsx

pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/subagent-interrupt.e2e.ts
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
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 build
corepack pnpm@11.7.0 verify
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

- 活跃 Agent 的 Host `Session.log` 仍完整常驻；一个持续输出的单会话仍可能线性增长。当前改动不是 active-log paging。
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
