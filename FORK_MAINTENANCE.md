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
| Published fork | `master` after local integration | `dsh-v0.1.5-rc.1` 官方结构、16 GiB Windows Host、长任务保护与 fork-maintained plugin 基线；精确 SHA 用 Git 查询，避免文档自引用失真 |
| Pre-Queue behavior anchor | `7b86d0a01b` | Queue 仅支持 steer 时的历史定位点，不是当前发布基线 |
| Alpha.2 integration history | `133c48c733` | 长任务、AgentTeams 和 transient retention 的已合并历史锚点；集成分支已删除 |
| Alpha.2 official merge | `e481d7cb31` | 合并 `dsh-v0.1.2-alpha.2` (`0a53fb55be`) |
| Pre-alpha.2 WIP backup | `origin/backup/wip-before-alpha2-20260831 = f1c600d51e` | 逐文件恢复证据；它是 sibling，禁止用它 reset 当前 master |
| Older backup history | `595cd48136` | alpha.1 前的已合并恢复锚点；本地分支已删除 |
| Pre-RC.1 backup history | `eb0cbabe39` | RC.1 整合前的已合并恢复锚点；远程分支已删除 |
| RC.1 integration history | `646dffed9f` / `a19e092544` / `42aec50270` | 官方 merge、fork 行为移植与生成物修正已进入 `master`；集成分支和 worktree 已删除 |
| Alpha.2 integration | `6481bd2cbb` plus the following fork port | 官方结构 merge 位于该提交；fork 行为重做位于其后的 `master` 提交 |
| Pre-alpha.2 integration backup | `backup/pre-upstream-dsh-v0.1.3-alpha.2-20260908 = 5ef0e2f82f` | 合并前可恢复源码基线；真实 DSH_HOME 仍需独立备份 |
| Pre-0.1.5 integration backup | `backup/pre-upstream-dsh-v0.1.5-alpha.2-20260910 = 0142680498` | 合并前源码与 jobs 唤醒修复的恢复基线；真实 DSH_HOME 仍需独立备份 |
| Pre-0.1.5 RC.1 integration backup | `backup/pre-upstream-dsh-v0.1.5-rc.1-20260910 = 59008c418e` | 合并前包含历史 v2 Session 恢复修复的源码基线；真实 DSH_HOME 仍需独立备份 |
| Current official target | `dsh-v0.1.5-rc.1 = 183f08e9c6` on 2026-09-10 | 精确不可变 tag；不要改合并已越过该 tag 的 rolling `upstream/master` |
| AgentTeams subtree | `fork-plugins/dsh-agent-teams` | 上游 `v0.1.16-rc.3@bf17f93d35` + 本 fork 0.1.5 RC.1 私有适配；subtree merge 记录精确 split |
| Context subtree | `fork-plugins/dsh-context` | 上游 `v0.41.3@dce08e0db3` + 本 fork 投影和关闭 modal 性能优化 |

当前维护的源码兼容基线是 `dsh-v0.1.5-rc.1`。整合采用官方 handle-based Session persistence、Session format v3、通用 `session.updateQueue`、cursorless Assistant frame、长会话恢复和连接容错，再按本文的行为与测试补回仍缺失部分；后续合并禁止整体恢复旧版文件。

0.1.5 RC.1 的 `SESSION_FORMAT_VERSION` 为 `3`；只读 open 可以准备受支持的历史 generation，写 open 在验证后发布 v3 successor。逻辑 `SessionHeader` 使用 `isSeeded`，精确 inherited cut 由 handle metadata 与 `session/end-seed` 表示。第三方插件和本地 AgentTeams 包即使磁盘数据可读，也必须重新构建并在隔离 profile 验证逻辑 API。

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
5. 不得恢复固定 Agent/model-step concurrency guard。已删除的 `memory-admission` 及 dormant `bounded-subagent-provider.cjs` 都不是当前设计。
6. Host 内存压力不得触发静默自动重启。watchdog 可以优雅关闭并落盘，前端必须显示断线，恢复由用户手动启动。
7. 上游冲突采用“官方结构优先、fork 行为逐项重做”。Session、API、schema、包布局、生成文件和 lockfile 不得整树保留旧 fork 版本。
8. 外置 profile、preset、本地 tgz 和 DSH_HOME 不受 Git 保护；每次上游或插件更新前必须单独备份它们。
9. 测试默认使用 focused batches；单批性能或压力测试保持在 20 秒内，除非用户明确授权更长测试。完整构建可以按实际耗时运行。

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

#### Off-stage history follow suspension

`packages/api/session-controller/src/client/sessions/session.ts` 与 `service.ts` 只让 staged Client Session 保持 detailed-history Remote。切换或显式 clear 会 `suspendHistory()`，但保留 Session scope、binding、当前 window、projection、queue、draft 和 feature state；重新选择时从 durable history 重开。

Masked list gap 不被当作用户导航，stream disposal 会等待 quiescence，open/resync/loadOlder 使用 generation 与 identity guards。该机制停止旧窗口继续增长并释放 Host follower，但不会释放已经加载的 Client window。

#### Terminal jobs retention

`packages/jobs/jobs-local` 新增可选 `terminalJobRetentionMs` 与 `maxRetainedTerminalJobsPerOwner`。包默认省略两项以保持上游行为；shipped base profile 配置为一小时 TTL 和每个 exact owner 100 条 terminal target。

Count pruning 只删除最旧且已 reported 的 completed/killed/failed records；unreported 记录保留到 TTL 或 teardown，running/stopping 永不参与。Exact owner 与 unowned bucket 分离，最小堆和一个 `unref()` timer 避免每次全表 scan/sort；waiter 与刚结算 id 在读取完成前受保护。

官方 `maxConcurrentJobsPerOwner=10` 是 live jobs 限制，不是本 fork 新增的 Agent 并发限制。上游替代必须有 terminal TTL/count、unreported protection、active exclusion 和有界维护算法。

### Client rendering and connection state

#### Tool detail lazy materialization

`packages/client/ui-tool` 的 `ToolRowDetailsModel` 在折叠状态只暴露 summary/state 和 `hasBody` / `hasOutput`。`ToolRow` 仅在 disclosure 打开时读取 cached getters，推迟 pretty args、flattened output 和大型 card array copies。

Alpha.2 已延迟 generic Tool input formatting；fork 只补回仍缺失的 output flatten 与大型 card array lazy materialization。

#### Global backend-disconnect overlay

`packages/client/ui-settings-general/src/client/ConnectionOverlay.tsx` 复用官方 `ctx.connection.state`、`reconnect()` 和 `ConnectionIndicator`，在 `shell.overlay` 顶部居中显示 disconnected/connecting/recovered。Sidebar 收起时仍可见，健康初始状态不渲染，恢复绿态保留两秒。

该组件只控制 WebSocket reconnect，不启动 Host。上游只有提供全局、sidebar-independent、actionable 状态且不引入 silent Host restart 时，才能替代它。

### Subagent and AgentTeams responsiveness

#### Continuable child steer

Alpha.2 官方 `SubagentRuntime.sendMessage(sender,target,...)` 统一 direct parent/child messaging 并支持 image；fork 未恢复旧公开 `.steer()` / `.followup()`。Team mailbox 只使用官方 symbol-keyed Host queue/steer adapter，以保留 Team message provenance。

#### Lead-to-teammate mailbox delivery

`packages/experimental/agent-team/src/mailbox.ts` 根据 exact membership 与 sender identity，把发往 live teammate 的 Lead 指令作为 nearest-step steer；inactive child 通过 Host queue 冷恢复。Teammate-origin quiet 只注入 live target，wakeup 进入 queue；后续 wakeup 会按 mailbox 顺序先准入较早 quiet mail。

官方 generic adjacent steer 不能单独替代 durable Team mailbox。替代实现还必须保留 stable message id、Team message source、accept/ack、target-local serialization、crash recovery 和 cold replay。

#### Forced background shell and yielding job wait

`packages/shell/tool-bash` 与 `tool-pwsh` 提供默认 `false` 的 `forceRunInBackground`；`packages/jobs/tool-jobs` 提供默认 `false` 的 `yieldWaitOnNextStep`。普通 profile 因默认值不改变行为。

Private AgentTeams profile 显式强制 Bash/PowerShell 命令作为 owner-scoped job 启动，并让 `job_output(wait:true)` 在 next-step input 到达时只结束 registry wait、返回当前 output/status；底层 job 继续运行，普通 next-turn FIFO input 不触发让步。

不得用通用 `Promise.race` 丢弃任意 tool call。上游替代必须保持 job ownership、kill/dispose、next-step 与 next-turn 区分，以及 jobs service 并发激活时的安全注册。

#### Browser Queue Dock

Alpha.2 Queue Dock 通过通用 `session.updateQueue` 对 live Session 的精确 pending occurrence 执行 edit、remove 或 steer。Edit 保留 message identity/source，remove 持久取消 occurrence，steer 只在当前状态允许时把 occurrence 提升到 next-step；continuable child 使用同一 Session-addressed API。

Fork 不再维护独立 subagent Queue Remote 或错误码。后续上游合并必须保留 `session.updateQueue` 的 occurrence identity、通用 Session/continuable-child 寻址、发送中禁用状态、单条与批量 Steer，以及 durable `agent/inbox/spliced` 记录。

### Local launch and build scripts

仓库包含 [build.cmd](build.cmd)、[run.cmd](run.cmd)、[build.command](build.command)、[run.command](run.command) 与 [setup.command](setup.command)。Windows 脚本准备 Corepack/pnpm 和镜像 registry；`build.cmd` 执行 install + build，`run.cmd` 默认 `DSH_HOME=C:\Project\deepseek-harness-data`，创建 diagnostics，并追加 `--max-old-space-size=16384` 与 Node fatal/uncaught reports 后运行 Web profile。

macOS 的 `build.command` 和 `run.command` 共用 `scripts/fork-macos-runtime.sh`。该 helper 从 `PATH`、Apple Silicon Homebrew 和 Intel Homebrew 路径查找 Node，拒绝不受支持的 Node 23，仅在私有临时目录安装固定 Corepack fallback，并使用仓库锁定的 pnpm。`run.command` 默认 `DSH_HOME=~/.dsh`，创建权限 `0700` 的 diagnostics，启用 Node fatal/uncaught reports，并把 V8 old-space 设为物理内存的一半且限制在 4–16 GiB；`DSH_MAX_OLD_SPACE_MIB` 可显式覆盖。它不会静默重启 Host。

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
| `dshmarket` | `1.41.0` | Enabled | RC.1 隔离启动与首屏通过；profile 固定 `allowRestart:false`，禁止插件静默重启 Host |
| `@nanmicoder/dsh-agent-teams` | `0.1.16-dsh015rc1.1` | Enabled | `setup.command` 固定 RC.1 artifact；禁止被 npm latest/next 直接覆盖 |
| `dsh-plugin-subscriptions` | `0.6.0` | Installed, disabled | RC.1 隔离启动通过；profile 固定 `rateLimit.wait:false`，后续单独启用验证真实账户 |
| `@vlln/dsh-task-status` | Removed | Not installed | 2026-09-04 已从依赖、bundle、patch、lockfile 和 `node_modules` 删除；RC.1 profile 不得恢复 |
| `dsh-context` | `0.41.3-dsh013alpha2.1` | Enabled | 保留 `300/60/100/400/100` bounds；源码与回滚规则见 `fork-plugins/dsh-context/FORK_MAINTENANCE.md` |
| `dsh-shell-command` | Removed | No package or configuration | 2026-09-04 已删除残留注释；RC.1 profile 不安装 |
| `@deepseek-ai/dsh-subagent-dsh-sdk` | Link to source checkout | Enabled for process provider | 跟随源码构建，worker 数据与主 sessions 隔离 |

当前 live profile 的 `minimumReleaseAgeExclude` 只允许两个已审计精确版本：`dsh-plugin-subscriptions@0.6.0` 和 `dshmarket@1.41.0`。禁止 wildcard，也禁止未经审计的 `pnpm update --latest`；AgentTeams 与 Context 使用本地 `file:` tgz，不依赖 release-age 例外。

### Local AgentTeams package

维护真源位于 `fork-plugins\dsh-agent-teams`，完整保留上游源码、测试、构建脚本和资产。仓库安装器使用 `fork-plugins\releases\nanmicoder-dsh-agent-teams-0.1.16-dsh015rc1.1.tgz`，SHA256 为 `EAD7426C8BA4D3A72D4054E817CE2E19A4CB60A57F1CA49A9F2ABB7107E9F351`。该 package 标记为 private，禁止用上游 npm scope 发布；旧 artifact 留作回滚。

旧 `.1`–`.4` tarballs 与 `dsh-agent-teams-0.1.14-dsh012.1.bundle` 继续保留为 rollback evidence；其中 `.bundle` 是包含 `.1` 完整历史的 Git bundle，不得随意清理。当前 fork artifact 已随 Git 提交，同事不再依赖这台机器的外置 `.local-plugins-src`。

必须保留的 fork 行为：

1. 保留上游 v0.1.16-rc.3 的 authenticated Web routes、bounded request bodies、fallback 持久化、parked-attempt 单次恢复、安全 captain reassignment、reasoning-effort 透传、稳定 capability 展示、Web 批准唤醒和 team-lock queue 清理。
2. 0.1.5 RC.1 发行路径使用创建期显式 Agent 参数、`agent/session-start`、`Session.ownEvents()` 与统一 Host delivery adapter；legacy setup、session event 和 Host Queue 形态只保留为兼容性回归 fixture，不构成发行兼容声明。
3. Team 内部队长指令、scheduler assignment、peer delivery 和 mailbox recovery 对 live member 使用 Host Steer 在最近 step boundary 进入，对 inactive member 使用 Host Queue 创建可冷恢复的独立 turn。
4. Queue、Steer 与公开 `sendMessage()` 都拒绝向已退休 Team member 投递；人类在成员会话发送的普通消息仍走 Session FIFO。
5. Client 使用 `uiConversation` 和 `[data-composer-input]`；Host capability 层保持 13 个 Captain 工具和 4 个成员工具稳定。package peer、development dependency、完整 DSH override cohort 与 lockfile 固定为 `0.1.5-rc.1`。
6. 普通 captain 不驻留时，成员报告先通过 Host Session Controller cold resume captain；Captain Session start 会重投 durable mailbox，成功逐条 ack，失败记录及后缀释放 delivery lease。
7. Windows directory rename 使用独立的 5 次重试预算；构建清理目标用跨平台 `basename()` 校验。
8. `readUnreadMailbox()` 使用只保留 pending 消息的 256-entry / 8 MiB 有界 LRU，并以 `dev/ino/size/mtimeNs/ctimeNs` 检测文件替换；lease 每次按当前时间重算，append/claim/release/ack/archive/remove 成功后精确失效。完整历史读取和磁盘 JSONL 字节格式不变。

`.local-plugins-src\...dsh012.2/.3/.4` 只是历史解包产物，不能再当维护源。以后用 `git subtree pull --prefix=fork-plugins/dsh-agent-teams https://github.com/NanmiCoder/dsh-agent-teams.git <tag> --squash` 获取精确官方发布，再在 fork 内重放和验证上述行为；不得用 npm install 覆盖 subtree。

本 fork 以 `v0.1.16-rc.3@bf17f93d35` 生成 `0.1.16-dsh015rc1.1`。上游 release candidate 提供固定协议、Web 批准唤醒和 team-lock queue 清理；fork adapter 继续覆盖 0.1.5 RC.1 的统一 Host delivery，封住公开 `sendMessage()` 与 Host Queue/Steer 对 retired member 的冷恢复旁路，并消除活动面板每秒重读永久 mailbox 历史的热点。后续上游发布先按行为测试去重，再提升 subtree 基线和私有版本；profile 始终安装 fork artifact。

### Local Context package

维护真源位于 `fork-plugins\dsh-context`，仓库安装器使用 `fork-plugins\releases\dsh-context-0.41.3-dsh013alpha2.1.tgz`，SHA256 为 `8C681B385616770B397A5C44E5676A63C9F84F7C6E54061EE0BAE8F5194388B8`。该版本保持 `contextTimeline` / `contextHeaders` projection key、wire schema、持久状态 schema、`stateVersion` 和 Session event 不变。

本地优化包含 timeline fold 字段级 copy-on-write、dirty retention trim、恢复态首 view bounds clamp、Host-only 状态的引用稳定 wire view，以及关闭 `/context` modal 时的 projection/conversation 订阅释放。真实 profile 使用 `maxRequestSteps: 300`、`maxKeptTurns: 60`、`maxEvents: 100`、`maxNodes: 400` 和 `maxArchiveNodes: 100`。这些上限只缩小 Context 派生展示，不修改 Session 历史。

更新时使用 `git subtree pull --prefix=fork-plugins/dsh-context https://github.com/bowenliang123/dsh-context.git <tag> --squash`，再逐项重放 `fork-plugins/dsh-context/FORK_MAINTENANCE.md` 所列行为。不得用 npm latest 直接覆盖真实 profile。

### ChatGPT subagent preset

`profiles\web\chatgpt-subagent-preset.cjs` 对 parentSession subagent 检测 provider `codex` 或 model `^gpt-`，在首次 step 前 recompose 到 `chatgpt-dsh`，并持久追加 `agent-preset/selected`。顶层会话和非 ChatGPT 子代理不受影响，失败采取 fail-open。

Preset 位于 `.agent-presets\chatgpt-dsh`。`no-escalation.cjs` 从 pwsh/write/edit schema 隐藏 sandbox permission 参数，但不改变 executor；persona 正文配置在 0.1.5 使用必填 `prefix`。`agent.cordis.yml` 保留自定义 persona、`no-escalation`、`tool-web.fetch:false`、`command-goal` 和 spawn `modelSelectionSettings:true`。

`bounded-subagent-provider.cjs` 仍在磁盘但没有 profile 引用。它是 dormant 历史文件，默认会固定限流；用户明确禁止固定 Agent 并发，因此不得重新插入。

### Isolated process workers

Profile 注册 `dsh-sdk-process-raw` 和 `subagent_process`：SDK profile、独立 `dshHome=C:/Project/deepseek-harness-data/process-workers`、`deepseek-official/deepseek-v4-flash`、`maxTokens=65536`、每 worker 4096 MiB heap、one-shot、非 background、`maxDepth=provider-managed`。主 profile 不施加额外固定 Agent 并发上限，worker sessions 不进入主 `sessions`。

`process-workers\profiles\sdk\cordis.patch.yml` 中失效的旧 `memory-admission` row 已于 2026-09-04 删除；`local-memory-watchdog` 和其余 worker 配置保留。后续不得为了 worker profile 再把固定 Agent concurrency package 加回主仓。

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
| Off-stage history suspension | Preserve | Require stream detach without losing scoped Client state |
| 20k final-message packed rebase | Replaced by alpha.2 cursorless Assistant frames | Keep official transient-stream settlement; do not restore scalar chunk accumulation |
| Tool output/card lazy calculation | Ported onto alpha.2 | Retain only output/card laziness not supplied by official input-body deferral |
| Jobs one-hour TTL / 100 terminal target | Preserve | Official alpha.2 does not provide it |
| Fixed Agent/model-step admission | Retired | Never restore `memory-admission` |
| Generic parent/child messaging | Replaced by alpha.2 official `sendMessage()` | Never restore the old public `.steer()` API |
| Queue edit/remove/steer | Replaced by alpha.2 `session.updateQueue` | Do not restore `subagents.updateQueuedByParent` |
| Durable Team Lead mailbox steer | Preserve separately | Generic adjacent steer alone is insufficient |
| Forced Team shell background / yielding wait | Preserve | Require explicit opt-in and job ownership semantics |
| Global disconnect overlay | Preserve | Official replacement must remain visible with collapsed sidebar |
| Windows/macOS launch/build scripts | Preserve | Official launcher must cover local heap/report/path needs before removal |
| Fork-vendored AgentTeams behavior | Preserve and revalidate for alpha.2 | Pull upstream through subtree, retain the private version/artifact, and never install npm latest over the live profile |
| AgentTeams unread mailbox projection LRU | Preserve | Require unchanged JSONL format, dynamic lease expiry, exact mutation invalidation, caller isolation and bounded retention |
| Dormant fixed-concurrency wrapper | Do not preserve as active behavior | It may remain evidence, but must not be mounted |

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
- Process-worker SDK profile 的 stale `memory-admission` row 已删除；不得用其他固定 Agent 并发限制替代。
- AgentTeams 已随 fork 维护；live Lead 指令使用官方 Host Steer adapter，inactive child 使用 Host Queue adapter。每次 DSH 或 AgentTeams 上游更新都必须重新跑两条路径、退休成员和冷队长邮箱测试。
- AgentTeams 的 append/claim/ack 仍会整份重写单个 mailbox JSONL；未读投影缓存已消除不变文件的每秒重读/解析，但超长高频写邮箱仍存在 O(N) 写放大。下一步只能在保持旧 JSONL 可读和归档历史完整的前提下优化。
- AgentTeams 的进程内 team lock Map 与 scheduler parked-attempt Map 仍有小量键保留；当前有界数据量不构成 P1，但后续应随 team archive/remove 回收。
- Diagnostics 目前没有自动轮转，长期运行后需按具体文件人工归档。

## Dev Note

本文是 fork-local 维护参考，不属于 DeepSeek 官方文档网站，也不承诺当前 `upstream/master` 的版本号长期不变。每次上游合并、插件替换、默认值变化、外置 profile 变化或 Queue API 行为变化后，维护者必须在同一提交中更新本文；若某项被官方等价替代，应记录替代 owner 与验证，然后删除本 fork 的重复实现。
