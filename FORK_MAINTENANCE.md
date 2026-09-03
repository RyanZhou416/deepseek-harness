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
| Published fork | `master = origin/master` | `dsh-v0.1.2-rc.1` 官方结构、16 GiB Windows Host、长任务保护与 continuable-subagent Queue edit/remove/steer 基线；精确 SHA 用 Git 查询，避免文档自引用失真 |
| Pre-Queue behavior anchor | `7b86d0a01b` | Queue 仅支持 steer 时的历史定位点，不是当前发布基线 |
| Alpha.2 integration | `133c48c733` / `origin/integrate/upstream-alpha2` | 长任务、AgentTeams 和 transient retention 整合提交 |
| Alpha.2 official merge | `e481d7cb31` | 合并 `dsh-v0.1.2-alpha.2` (`0a53fb55be`) |
| Pre-alpha.2 WIP backup | `origin/backup/wip-before-alpha2-20260831 = f1c600d51e` | 逐文件恢复证据；它是 sibling，禁止用它 reset 当前 master |
| Older local backup | `backup/pre-upstream-0.1.2-alpha.1-20260829 = 595cd48136` | alpha.1 前的本地证据 |
| Integration worktree | `C:\Project\deepseek-harness-alpha2-integration` at `133c48c733` | alpha.2 整合留档，不是当前运行目录 |
| Pre-RC.1 backup | `origin/backup/pre-upstream-rc1-20260904 = eb0cbabe39` | RC.1 整合前已推送的完整 fork 恢复点 |
| RC.1 integration | `integrate/upstream-rc1`, worktree `C:\Project\deepseek-harness-rc1-integration` | 已完成：官方 merge `646dffed9f`、fork 行为移植 `a19e092544`、生成物与类型修正验证 `42aec50270` |
| Current official target | `dsh-v0.1.2-rc.1 = a66e470204` on 2026-09-04 | 精确不可变 tag；不要改合并已越过该 tag 的 rolling `upstream/master` |

当前维护的 `master` 兼容基线是 RC.1。整合采用 RC.1 重构后的 Session indexed reads、Tool 展开懒计算、相邻 Agent messaging、Chat/Conversation/Trajectory 性能和连接容错，再按本文的行为与测试补回仍缺失部分；后续合并仍禁止整体 cherry-pick alpha.2 旧文件。

RC.1 的物理 JSONL `seedLength` 仍可由 decoder 兼容，`SESSION_FORMAT_VERSION` 仍为 `0`；逻辑 `SessionHeader` 已从 `seedLength` 演进到 `isSeeded`，并引入 branded `SessionSeq` / `SessionLogOffset`。RC.1 还兼容 v3/v4/v5 projection cache，并对无法解析的单条派生缓存执行 backup-and-skip。第三方插件和本地 AgentTeams 包即使磁盘数据可读，也必须重新构建并在隔离 profile 验证逻辑 API。

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

Continuable-subagent Queue edit/remove/steer 已作为当前 `master` 的正式行为提交，覆盖 Subagent 控制 API、Session Remote、Queue Dock、E2E、生成目录和中英文文档。任何后续上游合并前仍必须检查 `git status --short --branch`；若出现新的在制修改，先提交到独立 `backup/wip-before-<tag>-<date>` 分支并推送 `origin`，禁止只依赖 stash。

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

RC.1 官方 `packages/llm/token-meter/src/index.ts` 保存精确 consumed offset，并只通过 `Session.eventAt(SessionSeq)` 读取未消费记录。它已经消除每次 event 的整日志 materialization，因此 integration 退役 fork 原有 direct-event fast path 与 `Session.events` fallback；不得为了保留旧文件重新引入。

#### Persistence write-behind ownership

`packages/session/session-persistence/src/coordinator.ts` 与 `write-behind.ts` 提供 trusted `enqueueFrozen()`，复用 `Session.append()` 已 detached/deep-frozen 的 event；公共 borrowed-input `enqueue()` 仍 clone。写批次通过交换 backing array 在 O(1) 转移，失败时把原批次放回队首并保持顺序。

上游替代必须同时保证 immutable ownership、O(1) batch detach 和失败重放顺序；单纯缓存 Session snapshot 不等价。

#### JSONL/Zstd metadata cache

`packages/session/session-persistence-jsonl/src/index.ts` 以精确 artifact revision 缓存验证后的 header，并让并发 `list()` / `listSnapshots()` 共享一次 scan/stat。单个 caller abort 只取消自己的等待；revision 变化会重新验证，删除路径会清理 cache，返回值保持 detached。

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

#### Live scalar rebase

Client Session 在每个 opening snapshot 后统计 scalar live events。达到 `DEFAULT_LIVE_EVENT_REBASE_THRESHOLD=20000` 后，它等待下一个最终 `assistant/message`，只重启一次 `RemoteJournalStream`，再用官方 lossless packed snapshot 替换 scalar tail并清零计数。

未完成回答不会被截断；Host log、seq、time、source provenance、文件格式均不改变。上游只有在 live stream 自带无损 compaction/rebaseline 且不会在 tool/message 中间制造 gap 时，才能替代它。

#### Terminal jobs retention

`packages/jobs/jobs-local` 新增可选 `terminalJobRetentionMs` 与 `maxRetainedTerminalJobsPerOwner`。包默认省略两项以保持上游行为；shipped base profile 配置为一小时 TTL 和每个 exact owner 100 条 terminal target。

Count pruning 只删除最旧且已 reported 的 completed/killed/failed records；unreported 记录保留到 TTL 或 teardown，running/stopping 永不参与。Exact owner 与 unowned bucket 分离，最小堆和一个 `unref()` timer 避免每次全表 scan/sort；waiter 与刚结算 id 在读取完成前受保护。

官方 `maxConcurrentJobsPerOwner=10` 是 live jobs 限制，不是本 fork 新增的 Agent 并发限制。上游替代必须有 terminal TTL/count、unreported protection、active exclusion 和有界维护算法。

### Client rendering and connection state

#### Tool detail lazy materialization

`packages/client/ui-tool` 的 `ToolRowDetailsModel` 在折叠状态只暴露 summary/state 和 `hasBody` / `hasOutput`。`ToolRowBody` 仅在 disclosure 打开时读取 cached getters，推迟 pretty args、flattened output、error full text 和大型 card array copies。

RC.1 已延迟 generic Tool body formatting；integration 在其行为上补回仍缺失的 output flatten 与大型 card array lazy materialization。后续合并应继续以官方结构为基线，只保留这一可测缺口。

#### Global backend-disconnect overlay

`packages/client/ui-settings-general/src/client/ConnectionOverlay.tsx` 复用官方 `ctx.connection.state`、`reconnect()` 和 `ConnectionIndicator`，在 `shell.overlay` 顶部居中显示 disconnected/connecting/recovered。Sidebar 收起时仍可见，健康初始状态不渲染，恢复绿态保留两秒。

该组件只控制 WebSocket reconnect，不启动 Host。上游只有提供全局、sidebar-independent、actionable 状态且不引入 silent Host restart 时，才能替代它。

### Subagent and AgentTeams responsiveness

#### Continuable child steer

RC.1 官方 `SubagentRuntime.sendMessage(sender,target,...)` 统一 direct parent/child messaging 并支持 image；integration 已采用它，未恢复 fork 旧公开 `.steer()` / `.followup()`。Fork 仅保留 symbol-keyed Host adapter，使 Team mailbox 在最近 step 投递时仍保有 Team message provenance；durable AgentTeams mailbox 仍需单独核验。

#### Lead-to-teammate mailbox delivery

`packages/experimental/agent-team/src/mailbox.ts` 根据 exact membership 与 sender identity，把 Lead-to-teammate 的 quiet/wakeup 请求都作为 nearest-step steer 投递。Teammate-origin quiet/inject 与 wakeup/FIFO 保持原语义，recovery 不会因为 cold target 跳过 Lead directive。

官方 generic adjacent steer 不能单独替代 durable Team mailbox。替代实现还必须保留 stable message id、Team message source、accept/ack、target-local serialization、crash recovery 和 cold replay。

#### Forced background shell and yielding job wait

`packages/shell/tool-bash` 与 `tool-pwsh` 提供默认 `false` 的 `forceRunInBackground`；`packages/jobs/tool-jobs` 提供默认 `false` 的 `yieldWaitOnNextStep`。普通 profile 因默认值不改变行为。

Private AgentTeams profile 显式强制 Bash/PowerShell 命令作为 owner-scoped job 启动，并让 `job_output(wait:true)` 在 next-step input 到达时只结束 registry wait、返回当前 output/status；底层 job 继续运行，普通 next-turn FIFO input 不触发让步。

不得用通用 `Promise.race` 丢弃任意 tool call。上游替代必须保持 job ownership、kill/dispose、next-step 与 next-turn 区分，以及 jobs service 并发激活时的安全注册。

#### Browser Queue Dock

当前 Queue Dock 允许 direct parent 对 live continuable child 的一个精确 pending `nextTurn` occurrence 执行 edit、remove 或 steer。Edit 只接受文本并保留原 message identity/source；remove 持久取消该 occurrence；steer 只在 child 正在运行时把同一 occurrence 提升到 `nextStep`。Idle continuable child 可 edit/remove，one-shot 与 inactive child 保持只读。

浏览器通过 `updateQueuedByParent` Remote 携带 durable parent/child address、item id 与 mutation。Host 在 wire boundary 验证文本结构，复用 durable direct-parent address authorization 与 per-child serialization，且不要求 parent Agent 在线；stale、inactive、unauthorized、non-text 和 cancelled 均使用 namespaced errors。该实现复用既有 `agent/inbox/spliced`，不新增 Session event type，也不改变磁盘格式。上游替代必须保持 occurrence identity、idle edit/remove、running-only steer、one-shot read-only、direct-parent authority 和这些失败语义。

### Local launch and build scripts

仓库新增 [build.cmd](build.cmd)、[run.cmd](run.cmd)、[build.command](build.command) 与 [run.command](run.command)。Windows 脚本准备 Corepack/pnpm 和镜像 registry；`build.cmd` 执行 install + build，`run.cmd` 默认 `DSH_HOME=C:\Project\deepseek-harness-data`，创建 diagnostics，并追加 `--max-old-space-size=16384` 与 Node fatal/uncaught reports 后运行 Web profile。

macOS `.command` 脚本要求 `/usr/local/bin/node` 与 Corepack，设置镜像后执行 build 或 Web；它没有 16 GiB `NODE_OPTIONS`，也没有 Windows DSH_HOME 默认值。不要在文档或合并中声称两个平台启动策略完全相同。

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
| `dshmarket` | `1.38.1` | Enabled | RC.1 隔离 profile 精确升级到 `1.41.0`；停机冷启动，保持 `allowRestart:false` |
| `@nanmicoder/dsh-agent-teams` | `0.1.14-dsh012.4` local tgz | Enabled | 禁止被 npm latest 直接覆盖，见下一节 |
| `dsh-plugin-subscriptions` | `0.5.3` | Installed, disabled | RC.1 隔离 profile 精确升级 `0.6.0` 后仍先禁用；首次启用显式收紧 `rateLimit.wait` |
| `@vlln/dsh-task-status` | Removed | Not installed | 2026-09-04 已从依赖、bundle、patch、lockfile 和 `node_modules` 删除；RC.1 profile 不得恢复 |
| `dsh-context` | `0.37.0` | Installed, disabled | RC.1 隔离 profile 精确升级 `0.41.3`；该版已改为按需 header content并有 RC.1 compatibility matrix |
| `dsh-shell-command` | Removed | No package or configuration | 2026-09-04 已删除残留注释；RC.1 profile 不安装 |
| `@deepseek-ai/dsh-subagent-dsh-sdk` | Link to source checkout | Enabled for process provider | 跟随源码构建，worker 数据与主 sessions 隔离 |

当前 live profile 的 `minimumReleaseAgeExclude` 只允许精确版本：`dsh-plugin-subscriptions@0.5.3`、`dsh-context@0.37.0`、`dshmarket@1.36.0`、`dshmarket@1.38.1`。RC.1 隔离升级若被 release-age 阻止，只可为已审计的 `dsh-plugin-subscriptions@0.6.0`、`dsh-context@0.41.3`、`dshmarket@1.41.0` 增加精确项；禁止 wildcard，也禁止未经审计的 `pnpm update --latest`。

### Local AgentTeams package

当前 profile 通过 `file:` 安装 `profiles\web\.local-plugins\nanmicoder-dsh-agent-teams-0.1.14-dsh012.4.tgz`，SHA256 为 `FA2916BBAF45C18F6AE956D3678CE9943E959BC231AAEDFA10EE480CE561DD89`。旧 `.1`–`.3` tarballs 是 rollback evidence，不得在确认 `.4` 和后继包稳定前覆盖。

必须保留的 `.4` 行为：

1. Team 内部队长指令、scheduler assignment、peer delivery 和 mailbox recovery 对成员使用 Subagent steer，在最近 step boundary 进入。
2. 模型 `sendMessage()` 与 Team Host adapter 都拒绝冷恢复已退休 Team member；人类在成员会话发送的普通消息仍走 Session FIFO。
3. Client 继续使用 `uiConversation`，Host 使用 `SystemPrompt.getSectionOrder('TEAM_POLICY')`；新包必须重新构建并把 peers 对齐 RC.1。
4. 普通 captain 不驻留时，成员报告先通过 Host Session Controller cold resume captain，再投递。
5. Captain Session start 会重投 durable mailbox；成功消息逐条 ack，失败记录及后缀释放 delivery lease，避免丢报和错误确认。

`.local-plugins-src\...dsh012.2/.3/.4` 只是解包后的已构建 `lib` 与发布说明，不含完整 upstream `src/tests/scripts`，不能当作长期源码仓。升级必须从官方 AgentTeams source/tag 开始，再逐条移植并验证上述行为。

官方 AgentTeams `0.1.15` 只原生支持 DSH alpha.2，并加入 raw Web route authentication；其 post-release main 还处理 blank optional fields 与 unrecoverable member failures。它与当前 `.4` 都调用 RC.1 已删除的 Session/Subagent API，不能直接启动。RC.1 适配应以最新 main、PR #124 的 `ownEvents()` 生命周期方案、PR #119 的 `sendMessage()` 方向和 `.4` 行为为输入，生成新的固定本地版本；禁止直接把 profile 改为 `@latest`。

### ChatGPT subagent preset

`profiles\web\chatgpt-subagent-preset.cjs` 对 parentSession subagent 检测 provider `codex` 或 model `^gpt-`，在首次 step 前 recompose 到 `chatgpt-dsh`，并持久追加 `agent-preset/selected`。顶层会话和非 ChatGPT 子代理不受影响，失败采取 fail-open。

Preset 位于 `.agent-presets\chatgpt-dsh`。`no-escalation.cjs` 从 pwsh/write/edit schema 隐藏 sandbox permission 参数，但不改变 executor；它使用的 assemble 事件与字段在 RC.1 仍存在。当前 `agent.cordis.yml` 是 alpha.2 standard 的副本，RC.1 切换时必须从 RC.1 standard 重建后补回 persona 与 `no-escalation`，并验证新增 `command-goal`、recompose、standing mount 和 Session event 恢复。

`bounded-subagent-provider.cjs` 仍在磁盘但没有 profile 引用。它是 dormant 历史文件，默认会固定限流；用户明确禁止固定 Agent 并发，因此不得重新插入。

### Isolated process workers

Profile 注册 `dsh-sdk-process-raw` 和 `subagent_process`：SDK profile、独立 `dshHome=C:/Project/deepseek-harness-data/process-workers`、`deepseek-official/deepseek-v4-flash`、`maxTokens=65536`、每 worker 4096 MiB heap、one-shot、非 background、`maxDepth=provider-managed`。主 profile 不施加额外固定 Agent 并发上限，worker sessions 不进入主 `sessions`。

`process-workers\profiles\sdk\cordis.patch.yml` 中失效的旧 `memory-admission` row 已于 2026-09-04 删除；`local-memory-watchdog` 和其余 worker 配置保留。后续不得为了 worker profile 再把固定 Agent concurrency package 加回主仓。

### Diagnostics

`diagnostics\memory-watchdog.ndjson`、`supervisor.log` 和 Node reports 是故障证据。旧 supervisor 行可能记录历史 restart，不能用旧行判断当前行为；当前脚本的新行以 `restart=disabled` 为准。日志当前没有自动轮转，维护者只能针对已确认的具体文件人工归档，禁止对 DSH_HOME 运行宽泛递归清理。RC.1 profile 清理前的五个配置文件及 SHA-256 基线保存在 `diagnostics\profile-backups\pre-rc1-20260904-015259`，不含 Session 或附件。

`diagnostics\deleted-*-artifacts-*` 与 `validation-web-full-partial-node-modules-*` 是上游删除包的可恢复构建残留，不是 Session。清理前仍需解析绝对路径并与 sessions/attachments/storages 分离。

-----

## Preservation matrix

| Behavior | Status | Upstream merge rule |
|---|---|---|
| Token meter direct-event fast path | Retired in RC.1 integration | Keep official indexed `eventAt()` fold; do not restore `Session.events` fallback |
| Frozen persistence enqueue and O(1) batch | Preserve | Require identical ownership and failed-write ordering |
| JSONL metadata revision cache/shared scan | Preserve | Require append/replace/delete and caller-cancellation equivalence |
| SQLite suffix indexing/bounded page LRU | Preserve | Require canonical replacement detection and bounded detached cache |
| Five-minute idle Agent eviction | Preserve | Require flush + persistence proof + exclusions + cold resume |
| Off-stage history suspension | Preserve | Require stream detach without losing scoped Client state |
| 20k final-message packed rebase | Preserve | Require lossless live rebaseline with no unfinished-message gap |
| Tool output/card lazy calculation | Ported onto RC.1 | Retain only output/card laziness not supplied by official input-body deferral |
| Jobs one-hour TTL / 100 terminal target | Preserve | Official RC.1 does not provide it |
| Fixed Agent/model-step admission | Retired | Never restore `memory-admission` |
| Generic parent/child messaging | Replaced by RC.1 official `sendMessage()` | Never restore the old public `.steer()` API |
| Continuable-child exact Queue edit/remove/steer | Preserve | Require durable occurrence identity, idle edit/remove, running-only steer, one-shot read-only and direct-parent authorization |
| Durable Team Lead mailbox steer | Preserve separately | Generic adjacent steer alone is insufficient |
| Forced Team shell background / yielding wait | Preserve | Require explicit opt-in and job ownership semantics |
| Global disconnect overlay | Preserve | Official replacement must remain visible with collapsed sidebar |
| Windows/macOS launch/build scripts | Preserve | Official launcher must cover local heap/report/path needs before removal |
| Local AgentTeams `.4` behavior | Rebase required for RC.1 | Build a new fixed RC.1 package; never install npm latest over the live profile |
| Dormant fixed-concurrency wrapper | Do not preserve as active behavior | It may remain evidence, but must not be mounted |

-----

## Upstream merge procedure

1. Stop DSH and confirm no Host instance owns the real profile or sessions.
2. Run `git status --short --branch` and review every path. Commit all in-flight work to `backup/wip-before-<tag>-<date>`, then push that branch to `origin`; do not rely on stash.
3. Create and push `backup/pre-upstream-<tag>-<date>` from a clean master.
4. Run `git fetch --tags --prune upstream` and record `master`, `origin/master`, `upstream/master` and the exact release-tag SHAs.
5. Create `integrate/upstream-<tag>` in a separate worktree from clean master. Merge the exact official release tag with `--no-ff`; do not merge rolling `upstream/master` directly.
6. Resolve Session/core/API/schema/package layout/generated catalogs/lockfile with official structure first. Resolve conflict files individually; do not apply repository-wide `-X theirs` and do not wholesale cherry-pick old fork commits.
7. Commit the official-first merge before porting fork behavior. Re-implement only the still-missing rows in [Preservation matrix](#preservation-matrix), using official RC.1 APIs and focused tests.
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

pnpm exec vitest run packages/llm/token-meter/tests/token-meter.spec.ts packages/session/session-persistence/tests/write-behind.spec.ts packages/session/session-persistence-jsonl/tests/jsonl.spec.ts packages/session/session-persistence-jsonl/tests/zstd.spec.ts packages/session-query/session-query-sqlite/tests/sqlite.spec.ts

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
- RC.1 已显著降低长会话初始化、流式更新、代码高亮、布局与导航预览成本，但仍不等价于完整 variable-height Chat virtualization；Tool lazy 与 packed rebase 也不能替代它。
- Host 的普通 Agent loop 仍主要运行在一个 Node event loop；process worker 是显式 one-shot 旁路，不是透明的全局多核调度。
- 第一次不同的 broad SQLite query 仍可能同步占用一个 Host thread。
- Watchdog 是最后一道优雅停机保护，不是 steady-state 回收机制，也不保证十小时高并发绝不退出。
- `run.command` 没有 Windows `run.cmd` 的 16 GiB heap 设置。
- Process-worker SDK profile 的 stale `memory-admission` row 已删除；不得用其他固定 Agent 并发限制替代。
- Local AgentTeams `.4` 需要以 RC.1 API 重建，并吸收官方 0.1.15 route authentication 和 post-release failure handling，同时保留本地 nearest-step delivery、retired-member guard 与 cold-captain mailbox；在完成前禁止切换真实 profile。
- Diagnostics 目前没有自动轮转，长期运行后需按具体文件人工归档。

## Dev Note

本文是 fork-local 维护参考，不属于 DeepSeek 官方文档网站，也不承诺当前 `upstream/master` 的版本号长期不变。每次上游合并、插件替换、默认值变化、外置 profile 变化或 Queue API 行为变化后，维护者必须在同一提交中更新本文；若某项被官方等价替代，应记录替代 owner 与验证，然后删除本 fork 的重复实现。
