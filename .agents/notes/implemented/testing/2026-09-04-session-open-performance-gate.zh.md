# Agent Note: 打开大型 Session 的必需 CI 性能 gate

Status: implemented

[English](2026-09-04-session-open-performance-gate.md) | 中文

## 问题

Session format v2 的推出改变了两条成本随模型输出增长的路径：JSONL backend 迁移并发布 released-v0 log，Client fold 每个已结算回复中嵌入的紧凑 stream。两条路径都没有可执行的性能检查，因此首次打开在 127,400 事件的合成 log 上从约 35 ms 增长到约 5 s（在 575,000 chunk 的真实 log 上从约 0.3 s 增长到 26 s，峰值 RSS 2.7 GB，并在 512 MB 堆限制下耗尽堆），Client fold 也随流式 delta 数而不是紧凑记录数线性增长，这些退化未被察觉地进入了 master。

只测 `SessionPersistence.open()` 不能稳定表达用户或 Host 等待的结果。工作可以在 `open()`、`SessionHandle.read()`、Session restore 与 projection 之间移动，而首次历史页和冷 Agent 恢复还包含这些操作之上的独立编排。操作结束时未经 GC 的一次 `heapUsed` 采样也不能区分仍被 Session 持有的数据与可回收的迁移临时对象。

## 决定

Linux pull request 运行必需的 `node 24 / benchmarks` job，执行 `pnpm run check:ci:bench` → `scripts/run-ci-bench.ts`。其临时 library 构建按 [PR 产物构建政策](../process/2026-10-05-pr-artifact-typechecks.zh.md)省略重复的 TypeScript 诊断；必需的完整构建保留这些诊断。私有 `@deepseek-ai/dsh-benchmarks` workspace 拥有 benchmark 专属依赖。该命令先构建 workspace library 和 `benchmarks/.dsh-build/` 下的专用 worker，再调用 `vitest.bench.config.ts`。[标准托管运行器说明](../../../../.github/workflows/ci.yml)拥有运行器选择及外层 job 超时。该 job 单独运行 benchmark lane；Vitest 逐文件运行，只负责准备输入、启动测量子进程、汇总结果和执行预算断言。每条被计时的 Node CPU 路径都以纯 Node 执行编译后的 JavaScript，并移除 `NODE_OPTIONS` 且不加载 TypeScript runtime；workspace 裸导入因此从 `benchmarks/node_modules` 通过 package exports 解析到构建后的 `lib/` 入口。

必需性能 gate 位于顶层 `benchmarks/`，按被测用户路径而非 package 归属组织。Host 文件使用 `*.bench.ts`，Client 面文件使用 `*.bench.client.ts`，场景专属 worker 与 fixture 留在对应 benchmark 旁且不带 benchmark 后缀。包内 `.perf.ts` 文件仍是非门禁诊断；`scripts/` 负责编排而不承载 benchmark case。

Session benchmark 使用固定参数合成 released-v0 输入：200 轮，每轮 500 个 text delta 与 125 个 reasoning delta，共 127,400 个逻辑事件。输入使用 Zstandard，并固定 logical rows 的分组与 frame 拆分，使每次运行处理相同的事件、字节与 frame 分布。每个合成 turn 先开始 step，再追加 user surface 输入，使 V2-to-V3 migration 能预留受保护的 system head 而不重排历史。fixture 直接构造 released-v0 physical rows，不依赖当前 runtime 的历史 encoder；压缩以及所有被测读取和 migration 入口仍使用生产代码。输入在计时前写入每个样本独占的临时目录；benchmark 不使用录制的 Session。

每个 Session endpoint 都针对用户生命周期中的两个时点运行。`first-open` 最初只有 released V0 generation，包含 migration；只读消费者不发布后继文件，可写 Agent resume 才会发布。测试准备阶段在计时外通过同一套生产 migration 生成一次 `post-upgrade-reopen`，再把未改动的 V0 前代和已发布的当前 generation 后继一起复制到每个样本目录。Reopen 样本使用全新进程，因此测量用户升级完成后的磁盘再次打开，不包含 migration 或进程内 cache。

每个 access kind 与 endpoint 的样本都在全新、已编译的 Node 子进程中运行。模块加载、Host 服务初始化和 fixture 准备在测量开始前完成；测量进程不执行额外的预热解析。正常堆模式运行五个独立样本，报告全部样本及最小值、中位数和最大值，并以中位数执行各访问状态独立的固定预算。另一个子进程使用固定 128 MB old-space 上限运行同一路径，只判断能否完成；低堆限制引起的额外 GC 不进入正常时间基线。

该 lane 包含四个独立的 Session 打开 benchmark，并保留 Client fold benchmark：

| Benchmark | 被测路径 | 时间指标 |
|---|---|---|
| 阶段剖面 | 分别为 first open 与 post-upgrade reopen 执行真实 persistence open、handle read、Session restore 与 projection | `openMs`、`readMs`、`sessionRestoreMs`、`projectionMs` 各自使用固定预算；只读 migration 归入 first-open `openMs`；后继编码、verify 与 publish 属于可写 Agent resume |
| 首屏历史 | 两种 access kind 分别经 Host Session history controller 读取到首个分页 snapshot | First open 与 reopen 各有一个端到端预算；均包含 source stat、读取、Session restore、projection、分页与 snapshot 构造，first open 还包含 migration；两者都不包含 Gateway 网络传输、Client fold 或浏览器 paint |
| Agent resume | 对两种 access kind 分别调用 `ctx.agents.resume()`，直到 Agent 创建、setup、发布与 loop 启动完成 | First open 与 reopen 各有一个端到端预算；两条路径都不与首屏历史串行，也不依赖它留下的 cache |
| Follow-level 窗口优先打开 | 对冷存储的父 Session 驱动 `SessionHistoryController.follow()`，使用合成的带 message 的当前 generation，直到产出首个 snapshot；随后在同一进程执行延迟的精确 whole-log projection 读取；第二个场景用持久化的完整 projection checkpoint 重新打开同一 generation | 首屏与延迟精确读取各有独立端点；冷首屏中位数必须不超过延迟读取中位数的一半并低于其绝对上限，cache-warm 首屏中位数使用自己的上限，插桩计数器要求两条打开路径的 complete observation 均为零 |
| Client fold | 大小两个 v2 history window 经真实 `ConversationNodeAssembler` 与全部 Chat Definition fold | 大窗口的绝对时间与相对小窗口的缩放比各自使用固定预算 |

Follow-level benchmark 依据 `benchmarks/session-open/synthetic-follow-session.ts` 中的受评审常量准备一个确定性的当前格式 generation：10,240 个 completed turn，每轮包含一条 user prompt、一条 assistant reply 和一个 step，共 61,440 个事件。fixture 经生产 create/append 路径写入，每 8 轮为一个 Zstandard frame，共 1,281 个 frame，压缩后约 2.25 MiB。确定性的不可压缩 prompt/reply 文本使产物高于生产环境的 2 MiB small-source 截止值，因此 controller 有资格使用 bounded window 路径；任何样本运行前，先通过一次不计时的完整 read 验证该 generation 及其带 message 的尾部。每个样本把 fixture 复制到独占的 `mkdtemp` 根目录，并在全新的已编译 Node 子进程中运行，因此进程内 cache、Session cache 或此前的测量都不能回答这次打开。模块加载、Host 服务初始化和复制在计时前完成；OS page cache 不清除，热 page-cache 读取属于 workload。fixture 是当前 generation，因此不运行 migration；不使用真实 Session、录制材料、`DSH_HOME`、profile、网络服务或 listener。cache-warm 场景复制整个源根目录而不是单个 generation 文件：一次不计时的完整 fold 经生产 `SessionProjectionCache` 把完整 checkpoint 持久化到 `session_projcache` domain，重新打开的进程从同一 cache seam 提供该 checkpoint。因此 cache-warm 打开模拟后续进程打开一个已被先前 Host 完整 fold 并 checkpoint 的 Session；它附带精确 block，且不安排延迟读取。

第一个端点从 `follow()` 请求开始，到首个 snapshot frame 交付给 consumer 结束。它包含 source `stat`、bounded window read、window 校验、interrupted-turn 补齐、分页、projection block 构造与 snapshot 构造；不包含 Host 初始化、fixture 准备、显式 GC、延迟精确读取、Gateway transport、Client projection-store 合并或浏览器绘制。第二个端点计时延迟的精确 whole-log 读取：`sessionQuery.observeSession(..., { projectionMode: 'all' })`，即 `session/projections` action 背后的 complete observation。它在同一 fixture 与同一进程中执行与冷 complete opening 相同的完整 log 物化、Session restore 与 projection fold，且不含该调用之上的 Remote transport 与权限检查。cache-warm 场景没有第二个端点：它的精确 block 在同一次 bounded window read 中从持久化 checkpoint 附带，benchmark 断言没有安排延迟读取。

`sessionQuery.observeSession` 与 `sessionPersistence.open` 上的委托计数器证明首屏未走 complete-observation 路径，`sessionQuery.readWindow` 上的计数证明读取了 bounded window。冷首屏必须报告 `path: 'window'`、absent projection block、零 complete observation、零完整 persistence open，以及至少一次 window read。延迟精确读取必须报告恰好一次 complete observation 和一次完整 persistence open，这证明计数器确实能观察到它要拒绝的路径；没有这个正向包含，一个坏掉的零计数器会白送 negative control。cache-warm 首屏必须报告 `path: 'window'`、最新存储 seq 上的精确 block、零 complete observation、零完整 persistence open、至少一次 window read，且没有延迟读取。改动前的实现要求 stored window 提供完整 projection checkpoint，冷 cache 不提供时回退到 `sessionQuery.observeSession`，因此同样的冷首屏断言会失败。该改动前失败即 negative control；CI 不 checkout 历史 revision。

受评审的首屏 gate 由一个无量纲比例和两个绝对上限组成。冷五次样本中位数必须不超过延迟精确读取中位数的 `MAX_FIRST_FRAME_SHARE = 0.5`：延迟读取正是 window-first 首屏在同一 fixture 与同一进程中避免的 complete-observation 工作，因此该比例既不需要 CI 时间系数，也不需要存储的时长。它还必须低于 `FIRST_FRAME_BUDGET_MS = 75 ms`，该上限来自 30 ms 的受评审参考预期并经 `ciTimeBudget()` 换算。cache-warm 五次样本中位数必须低于 `CACHED_FIRST_FRAME_BUDGET_MS = 95 ms`，该上限来自 38 ms 的参考预期。延迟精确读取会被测量并报告，但不设预算：它是本改动有意移出首屏的成本，其参考中位数记录在下方。benchmark 在断言每项 gate 前报告每个原始样本、聚合与整进程 peak RSS。benchmark 不覆盖 subagent 地址路径、小型存储 Session、seeded log 或 malformed-window 回退；这些仍走 complete observation，并由 Session-history 测试覆盖。

阶段剖面显式调用各层正式入口，不复制 decode、migration、restore 或 projection 算法。首屏历史和 Agent resume 分别以新的 first-open 与 reopen 根目录运行真实上层入口，因此组件数据不冒充端到端结果，一个场景也不会给另一个场景预热进程或 Session cache。四阶段之和仅用于解释成本；首屏与 Agent resume 的端到端时间各自由外层时钟直接测量。

正常堆模式在 Host 初始化完成且 Session 尚未访问时执行固定的两轮显式 GC，记录起点内存；操作计时结束后，在该场景要求的长期对象仍明确可达时再次执行同样的 GC，再记录终点内存。Agent resume 场景在终点保留 Agent、Session、完整 events 与正常服务 cache，它的 `heapUsed` 增量是常驻 Session 内存预算的主指标。Follow-level 打开场景在首屏保留后记录一个 GC 后快照，冷 no-cache 场景还在延迟精确 observation 保留后记录第二个快照。每个增量只度量对应端点保留的对象，因此延迟 whole-log 读取无法被藏进首屏端点；cache-warm 场景只保留首屏与 cache 服务状态。每个场景同时报告 `external`、`arrayBuffers`、GC 后 RSS 和 `process.resourceUsage().maxRSS`；128 MB 模式继续防止瞬时分配峰值被终点 GC 隐藏。显式 GC 时间不计入操作时间。

一个不计时的小型 fixture 前置用例验证当前 migration、消息保留、V0 字节不变及后继再次打开。Worker 失败时保留 stderr 首尾各十行或致命堆错误，使准备阶段拒绝与预算超限可区分。计时性能用例不重复功能测试的内容断言，只要求目标调用完成并到达对应的可观察终点。Client fold benchmark 继续使用真实 `ConversationNodeAssembler` 与全部 Chat Definition，要求大窗口的绝对时间和相对小窗口的缩放比均低于固定预算。

预算按各测量终点分别校准。两次 Node 24.19 x64 CI 运行的中位数最大相差 5.2%；其 CPU 密集型壁钟时间是 Node 24.18 arm64 参考运行的 1.95–2.06 倍。除当前 generation `open` 和 first-open Agent resume 外，源码常量记录参考机器上的预期耗时；`ciTimeBudget()` 将其乘以实测的 2 倍 CI 时间系数和 1.25 倍波动余量。当前 generation `open` 使用标准运行器直接测得的 50 ms 预期值，仅乘以 1.25 倍余量，向上取整得到 63 ms 预算。First-open Agent resume 使用经审查的 562 ms 托管上限。Follow-level 首屏常量记录冷 no-cache 的 30 ms 与 cache-warm 重开的 38 ms，二者都测于单线程性能等级与 M4 Pro 参考机相当的机器；经 `ciTimeBudget()` 分别得到 75 ms 与 95 ms。GC 后增量堆与 Client fold 缩放预算不属于壁钟时间，因此只使用 1.25 倍余量。128 MB 完成性检查仍是独立的瞬时分配限制。由此得到的 first-open 时间上限、受限堆检查、follow-level 上限与 Client fold 上限都会拒绝已知退化。参考固定为 PR #3533 的合并结果，只用于校准和评审预算；CI 不 checkout 或执行历史仓库。预算是源码中的受评审常量，不由环境变量覆盖。

## 校准证据

比较按用户生命周期正交，而不是按产物表示正交。两种实现的 first open 都接收完全相同的固定 V0 字节。Reopen 时，每种实现都在全新进程中读取自己认定的当前格式：栈前参考版本仍读取 V0，V2 实现则读取它已发布的 V2 后继。这里有意比较同一用户后续打开的体验，而不是让两个 codec 处理同一种数据结构。

同一台 Node 24 参考机器上的五次样本中位数构成正反例：

| Access kind | 实现 | 四阶段总时间 | 首屏历史 | Agent resume | Agent GC 后增量堆 | 128 MB old space |
|---|---|---:|---:|---:|---:|---|
| First open | 栈前参考版本 | 249.0 ms | 253.8 ms | 100.7 ms | 26.1 MB | 完成 |
| First open | 重复 snapshot 退化实现 | 4,197.5 ms | 4,284.8 ms | 4,197.9 ms | 4.4 MB | 堆耗尽 |
| Post-upgrade reopen | 栈前参考版本 | 251.1 ms | 253.8 ms | 100.7 ms | 26.1 MB | 完成 |
| Post-upgrade reopen | 重复 snapshot 退化实现 | 49.2 ms | 50.4 ms | 43.8 ms | 4.5 MB | 完成 |

栈前实现以 V0 作为当前格式，因此 first open 不改变磁盘表示；它的原生 V0 首屏历史与 Agent resume 测量同时适用于两个生命周期行。

PR #3640 的标准双 CPU 运行 (run 34023970384, job 101461539961)使用 Node 24.20.0 x64 和 Ubuntu 镜像 `20260831.293.1`。当前 generation `open` 的五次样本为 49.2、47.4、49.1、48.6 和 48.1 ms：中位数 48.6 ms，最大值 49.2 ms。取整后的 50 ms CI 预期值给出 63 ms 上限，不重复乘以 2 倍机器系数。日志标明两个可用 CPU，但未记录型号；它无法区分硬件变化与 Node 版本变化的影响。这是端点专属的运行器校准，不是应用优化或参考机器新测量的证据。其他每项 benchmark 均通过既有预算。确定性正反例在历史 30 ms 上限下拒绝实测中位数，在 63 ms 下接受它，拒绝合成的 75 ms reopen 中位数，并以未改变的 550 ms 上限拒绝合成的 4,000 ms 首次打开耗时。这些正反例验证预算执行，不代表测得新的退化。

一次冷 verifier 打包调整移除了运行时 workspace 模块加载，未改变这些预算或测量终点。在 macOS arm64、Node 24.18.0 上，verifier 打包前对同一份 127,400-event fixture 的首次 writable resume 耗时为 164.2、162.4、159.7、149.3、167.7 ms（中位数 162.4 ms）。通过 workspace build 打包 verifier 后为 119.8、120.9、121.9、122.3、121.8 ms（中位数 121.8 ms，降低 25%）。Retained heap 保持 5.4 MB；peak RSS 中位数从 144.9 变为 143.7 MB。Reopen 中位数为 27.5 和 27.1 ms，包含 128 MB completion check 的全部 16 项 Session 用例通过。CPU profile 将旧 verifier 的部分成本归因于模块解析和编译。隔离 package 的 built-worker 测试在旧 worker 上因无法解析 workspace import 而失败，在打包后的 worker 上通过，同时验证错误的 event count 会被拒绝。这些本地结果不能证明 Linux runner 耗时；这些用例使用 450 ms CI 上限。

托管运行 (run 34265057987, job 102192211510)包含已打包的 verifier，first-open Agent-resume 样本为 454.2、454.8、455.4、457.8 和 459.8 ms：中位数 455.4 ms，超过 450 ms。代码等价的前一次运行 (run 34263062688, job 102185561214)报告 436.2 ms 中位数；两个 head 之间只有请求历史双语 README 及其配对记录不同。经审查的上限为 562 ms，即 `floor(450 × 1.25)`，增加 24.89%，比观测到的 455.4 ms 中位数高 23.4%。五次新进程 M4 Pro / Node 24.19 样本范围为 150.07–158.22 ms，中位数为 152.57 ms。一次有界的主线程 profile 未发现明显的小型优化；它不包含 verifier 线程 CPU，也不能证明托管耗时变化的原因。对照在 450 ms 下拒绝已记录中位数，在 562 ms 下接受该值，并拒绝 600 ms。Verifier 打包优化、工作负载、其他时间预算、共享缩放和内存限制均保持不变。

校准后的源码预算如下：

| 测量项 | 参考机预期 | CI 预算 |
|---|---:|---:|
| First-open `open` | 220 ms | 550 ms |
| 当前 generation `open` | 12 ms（历史参考值；CI 预期值：50 ms） | 63 ms |
| 完整 read | 8 ms | 20 ms |
| Session restore | 24 ms | 60 ms |
| Projection | 14 ms | 35 ms |
| First-open 首屏历史 | 220 ms | 550 ms |
| 当前 generation 首屏历史 | 48 ms | 120 ms |
| Window-first 冷首屏 | 30 ms | 75 ms |
| Window-first cache-warm 首屏 | 38 ms | 95 ms |
| Window-first 冷首屏占比 | — | ≤ 0.5× 延迟读取 |
| Window-first 延迟精确 projection 读取 | 448.6 ms（参考观测值） | 不设预算 |
| First-open Agent resume | 180 ms（历史参考） | 562 ms |
| 当前 generation Agent resume | 40 ms | 100 ms |
| Agent GC 后增量堆 | 26.1 MB | 33 MB |
| Client fold 绝对时间 | 16 ms | 40 ms |
| Client fold delta 缩放比 | 2.5× | 3.125× |
| 受限 old space | — | 128 MB |

### 按索引遍历持久化 JSON 数组

JSONL backend 在 memo 化前冻结解码后的 event graph。原生 decoder 与固定 migration catalog 产出无环 JSON graph，其中数组只包含索引值。按数字索引遍历数组仍会冻结每个嵌套对象和数组，同时避免枚举 compact stream 中 125,000 个文本条目和 124,600 个时间差值的字符串键。对象遍历继续保留自有的 `__proto__` 和 `constructor` 数据。Admission、关系校验、解码与冻结都仍在被测 open 终点前完成；浅层 `Object.isFrozen()` 结果不会跳过后代遍历。

在 Apple M4 Pro、Node 24.19.0 上，仅覆盖 open 的 CPU profile 将约 4.2 ms 归因于完整 event 冻结。独立的全新进程 V4 运行得到以下结果；末列恢复并重新构建完全相同的原始遍历，作为负对照：

| Reopen 测量项 | 原始遍历 | 索引遍历 | 恢复原始遍历 |
|---|---|---|---|
| `open` 样本（ms） | 22.2, 22.4, 22.8, 22.6, 22.9 | 17.7, 18.4, 17.4, 17.8, 17.6 | 21.7, 22.4, 22.2, 21.7, 21.6 |
| `open` 中位数（ms） | 22.6 | 17.7 | 21.7 |
| 首屏历史中位数（ms） | 35.0 | 30.6 | 33.6 |
| Agent resume 中位数（ms） | 30.5 | 26.8 | 29.8 |
| Agent 保留堆（MB） | 4.5 | 4.5 | 4.5 |

每次运行的全部 17 个 Session 用例均通过，包括 128 MB 完成性检查。原始实现在本机仍低于 63 ms；恢复原始遍历展示了被移除的成本，而托管 benchmark 仍负责给出必须满足的预算结果。工作负载、时间上限、内存上限、冷进程准备与测量终点保持不变。JSONL owner 测试覆盖历史 V3 和当前读取中的嵌套不透明 JSON、修改拒绝及不可变 event 共享。这些测量确认了 reopen 改善，但没有确认一致的 first-open 改善或托管运行器耗时。

### Follow-level 窗口优先打开

开发机器上连续两次五次样本的编译运行确立 follow-level 对照。机器为 AMD Ryzen 9 9950X3D（16 核 / 32 逻辑处理器，4.3 GHz）、Node v24.13.0、win32 x64；其 PassMark 单线程等级约 4.6k，与 4.547k 的 M4 Pro 校准参考相当，因此沿用同一 2 倍 CI 系数。每个样本都是独占根目录副本上的全新已编译 Node 子进程，benchmark 文件在断言各 gate 前报告五个原始样本与中位数聚合。

| 运行 | 端点 | 样本（ms） | 中位数（ms） |
|---|---|---:|---:|
| 1 | 冷首屏 | 30.7, 29.7, 30.7, 30.1, 30.3 | 30.3 |
| 2 | 冷首屏 | 30.8, 30.2, 31.3, 30.3, 32.5 | 30.8 |
| 1 | 延迟精确 projection 读取 | 455.2, 426.0, 474.3, 448.6, 442.2 | 448.6 |
| 2 | 延迟精确 projection 读取 | 465.5, 456.2, 436.8, 438.1, 476.6 | 456.2 |
| 1 | Cache-warm 重开首屏 | 40.2, 37.5, 35.3, 37.4, 35.9 | 37.4 |
| 2 | Cache-warm 重开首屏 | 36.6, 38.4, 46.6, 39.1, 36.1 | 38.4 |

冷首屏相对延迟读取的占比在两次运行中都是 0.068，远低于 0.5 的 gate。每个冷样本都报告 `path: 'window'`、absent projection block、零 complete observation、零完整 persistence open 和恰好一次 bounded window read；随后延迟读取报告恰好一次 complete observation、一次完整 persistence open 和八个 wire projection 值。每个 cache-warm 样本都报告 `path: 'window'`、seq 61,439 上的精确 block、零 complete observation、零完整 persistence open、恰好一次 window read，且没有延迟读取。这些就是 negative control：fast path 从未物化完整 log，而延迟读取证明计数器在完整路径运行时能够检测到它。

GC 后端点不缩放。冷首屏保留堆为 0.7 MB；保留延迟精确 observation 再增加 36.5–36.6 MB。cache-warm 首屏保留堆为 1.1–1.5 MB，因为 cache 服务及其持久化 rows 仍可达。两个场景的整进程 peak RSS 范围为 260.7–268.2 MB。校准后的源码常量为冷首屏 30 ms、cache-warm 重开 38 ms，对应 75 ms 与 95 ms 的 CI 上限；延迟精确读取的 448.6 ms 参考值只记录、不设预算。确定性对照在这些上限下接受已记录中位数，并拒绝各自上限的 1.26 倍。

改动前的 negative control 来自 controller 原有的 checkpoint 要求：没有 projection cache 时，stored window 被拒绝，每次冷打开都会调用 `sessionQuery.observeSession`，从而打开并物化完整 log。因此 benchmark 的冷首屏断言在构造上拒绝改动前行为；其延迟读取的正向包含证明零计数是被观察到的零，而不是脱节的计数器。与既有 history-window benchmark 同 lane 的第三次运行复现了 30.4、454.6 和 35.0 ms 的中位数，并通过两个文件；既有 first-open/reopen benchmark 套件也以未改变的预算通过全部 17 个用例。这些本地测量确认编译 benchmark 的接线与预算执行；托管 Linux benchmark 拥有必需的 CI verdict。

## 考虑过的替代方案

**每次 CI checkout 历史提交并做相对比较。** 拒绝：历史 checkout 需要独立安装，旧版与当前版还可能把工作放在不同 API 阶段，增加时间、依赖和接口漂移。固定 workload 与经正反例校准的静态预算更容易复现和评审。

**只测从 V0 first open。** 拒绝：migration 是一次性升级成本，不能防止进入稳定当前 generation 后的后续打开发生退化。两种 access kind 需要独立的测量与预算。

**只测四个组件阶段。** 拒绝：组件测量便于定位，但会遗漏 source stat、编排、分页和 snapshot 构造，也不能证明首屏路径整体仍然可用且足够快。

**只测首屏或 Agent resume 总时间。** 拒绝：端到端数字能保护结果，却不能指出退化来自存储、读取、Session restore 还是 projection；四阶段预算保留可操作的归因。

**只把 follow-level 首屏设成绝对时长预算。** 拒绝：延迟精确读取在同一进程、同一 fixture 上执行同样的完整物化与 projection fold，因此两者的无量纲占比直接表达实质改善，且不继承某台机器的磁盘或 CPU 速度。编译运行随该比例记录绝对预期与 CI 上限；上限使用共享 CI 时间系数，而比例与内存端点都不使用。

**在生产实现内部添加细粒度计时桩。** 拒绝：这些桩会扩大生产接口并让 benchmark 与实现细节耦合。测试只使用既有服务和对象边界；无法由这些边界解释的成本保留在端到端结果中。

**从 TypeScript 源码运行被测 worker。** 拒绝：源码 loader 会改变模块解析与启动行为，并使嵌套 worker 选择仅适用于源码的启动路径。Vitest 仍可作为不计时的编排层；每个被计时的 worker 都像纯 Node 消费方一样执行构建产物。

**只用时间预算或只看 GC 后内存。** 拒绝：时间无法发现内存退化，终点存活内存也看不到迁移期间的瞬时爆发。正常堆的 GC 后增量与受限堆的完成性分别覆盖两类风险。

**用真实录制语料做 benchmark。** 拒绝：语料 fixture 按策略保持小体量，录制材料不得成为 benchmark 输入，且其重新录制会静默移动 workload。

**把 benchmark 放进现有 gate 聚合中运行。** 拒绝：聚合在一个 runner 上并发运行各 gate，壁钟测量会继承邻居的 CPU 负载。

**把每个跨包 gate 放在一个参与的产品 package 下。** 拒绝：Session 打开跨越 persistence、migration、projection、Host history 与 Agent resume；任选一个参与方都会形成误导性的归属和仅为 benchmark 增加的 package 依赖。仓库级目录拥有集成用户路径，包内诊断仍留在对应实现旁。

**把 benchmark case 放在 `scripts/` 下。** 拒绝：scripts 拥有命令、生成器与编排，而 benchmark case 拥有带类型的测试文件、worker、fixture、预算和生命周期清理。未来的报告或校准命令可以消费 `benchmarks/`，不需要把 case 移入其中。

## 后果

每个 pull request 多付出一个必需 Linux job；该 job 的 Session 部分运行多个短生命周期子进程，以换取冷 cache、独立 V8 heap、明确 GC 状态和可归因的失败。仓库级 benchmark 目录接受有意的跨包测试依赖，而不修改产品 package manifest。固定 Zstandard workload 同时覆盖事件规模与 frame 拓扑；first-open 测量保护一次性升级体验，reopen 测量防止后续打开退化，四阶段预算定位成本归属，首屏预算保护用户可见等待，Agent resume 预算与 GC 后增量保护完整冷恢复及常驻内存，follow-level 窗口优先场景让冷首屏不触发 complete observation、约束 no-cache 与 cache-warm 两种重开并单独测量延迟的精确 projection fold，128 MB 模式保护瞬时分配上限。

Session 与 Node-fold 场景不测量网络传输、浏览器渲染或真实录制 Session，也不是持续性能趋势系统。[前端性能预算](2026-09-06-frontend-performance-budgets.zh.md)拥有浏览器工作流测量。Node 或 runner 变化需要用同一 workload 重新采样并评审预算；修改业务实现时不得顺带放宽预算而不提供新的正反例数据。
