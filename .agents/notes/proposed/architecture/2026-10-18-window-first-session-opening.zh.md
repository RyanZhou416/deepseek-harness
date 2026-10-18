# Agent Note: 无投影缓存时的窗口优先生成会话打开

Status: proposed

[English](2026-10-18-window-first-session-opening.md) | 中文

## Problem

当没有可用的投影 checkpoint 时，首次打开一个已存储 Session 会很慢。历史控制器可以在没有索引的情况下读取最新尾窗口，但除非投影缓存为每个已注册的客户端可见 key 提供完整 baseline，它目前会拒绝使用该窗口。没有 baseline 时，它回退到完整 observation，在第一帧之前物化并验证整个日志；投影 fold 只是随后的额外成本。

在一个真实的 188,395 事件、164.6 MB generation 上（Node 24，页缓存已热）测得：

| 阶段 | 时间 |
|---|---:|
| `sessionPersistence.open`（完整日志物化与验证） | 3,430 ms |
| 该 open 之后的 `handle.read()` | 9.2 ms |
| `sessionStats` + token/context 投影 fold | 343 ms |
| 直接尾窗 `readWindow`（10k 事件） | 318–556 ms |

因此冷打开约 90% 的时间花在投影 fold 之前。缓存命中时不会做这些工作，因为 `openWindow` 收到 checkpoint，不再创建完整 observation。目标是让缓存离开首次打开的关键路径，而不是让必须进行的完整投影推导消失。

## Proposal

### 1. 先走窗口

对于已存储的父 Session，即使 `read.projections` 缺失或不完整，也直接提供现有的有界尾窗口。opening frame **省略 projection block**，而不是发送空 block：当前客户端 store 会把空 block 当成精确切面，清掉缓存的 title、list metadata、subagent、token 与 stats 行。可选 block 保留这些缓存提示，并把“投影不可用”与“空的投影切面”区分开。subagent 地址路径仍要求完整 observation，因为 `subagent` 投影是地址验证的一部分。

这会移除首次打开中的完整 `observeSession`。预计首帧从约 3.8 s 降到实测窗口范围的 0.6–0.8 s，且不依赖缓存状态。缓存命中的窗口打开已经跳过冷打开 promotion；无缓存的窗口打开与这一既有行为一致。Resume/promotion 成为显式后续步骤，prompt 路径仍必须验证能按需 promote，而不是静默失去继续该 Session 的能力。

### 2. 首帧之后加载精确的全日志投影

全 Session 数值如果没有完整日志 fold 或持久摘要，就不可能精确。因此本提案把产品延迟与精确统计延迟分开：

- 缺失的 opening block 是明确的“尚未投影”状态，而不是声称窗口计数就是全会话数值；
- 只在用户显式打开统计弹窗或 Context 界面时调度一次精确 `session/projections` 读取；界面挂载、首帧或空闲任务都不得触发；
- 精确读取替换不可用状态；结果带 watermark 合并进同一个 projection store，后续导航取消待处理读取；
- 统计 UI 必须保留可见的 loading/unavailable 状态，不能把窗口计数当作精确值。只有 `sessionStats` 有窗口回退；`tokenUsage`、`contextPressure` 与 `contextBreakdown` 当前没有，需要显式的不可用/加载展示，而不是伪造值。

默认路径不执行完整读取；从不打开统计的用户不会付出这份成本。

### 3. 老页面工作保持独立

首次打开与老页面加载是两项独立成本。现有索引构建为了记录 offset 仍解码并验证每一行；只记录 offset/newline 的构建实测从同一遍历的 1,864 ms 降到 425 ms，而实际服务的页面仍由 seeded decoder 严格验证。一个有界的解析索引 memo 可以去掉每个 warm page 重复的 30–37 ms sidecar 解析。这些改动可以在打开路径之后落地，并必须保留完整读取回退。

## Isolation and integration

开发在 `tmp/window-first` 的干净 clone 中进行（被仓库忽略，拥有自己的 `.git` 和 `node_modules`），分支为 `feat/window-first-opening`。运行中的 Host 保留当前文件和 `node_modules`；主工作树中不执行 checkout、install、build 或 test。所有命令使用 clone 自己的 root、私有临时 `DSH_HOME`，且不监听 3080 端口。Clone 用 `--no-hardlinks` 创建；`vendor` 与 `node_modules` 保持不共享。

AgentTeams 编排本身运行在当前 Host。clone 之外唯一允许的写入是本团队的编排产物：运行中 Host 的 `DSH_HOME` 下新建的 member Session 记录，以及主 checkout ignored `.agent-teams` 下的 team state。不得修改任何既有用户 Session、profile、settings、credentials、源码、vendor 或 `node_modules`。成员必须使用 clone 的绝对路径或 `pnpm --dir <clone>`，所有源码/文档编辑限制在 `tmp/window-first`，并串行执行 build/test，避免 8 个 worker 在同一 clone 的输出目录冲突。Clone 会作为 feature branch 推送。合入 `master` 等待专门的 Host 停止窗口；运行中的 Host 永远不会切到 feature branch。只有在分支合并且所有路径确认独立后才删除 clone。

## Stage plan

关键路径是契约 → 三条客户端/服务端实现线 → benchmark 测量 → 集成 → 审查。独立的索引、benchmark 脚手架、集成准备与预审查在第一波就开始；实现线在共享契约后并行。

1. **契约**：添加可选 opening projection block、projection readiness 类型，以及 benchmark/observation seam。这是唯一共享类型改动；其他线导入它。
2. **并行实现波**：
   - **服务端窗口优先**：对父 Session 放开完整 checkpoint 限制，省略 projection block，保留 subagent 与小 Session 回退，并添加窗口/opening 测试。
   - **客户端缺失/readiness**：缺失 block 时不清掉缓存的 list/subagent/token/stats 行；为 token 与 context 投影添加显式不可用/加载展示。
   - **按需生命周期**：Manager 拥有的触发、single-flight 精确读取、按 generation 的 readiness、导航取消、watermark 合并与权限回退。
3. **独立并行线**：offset/newline 索引构建、有界解析索引 memo、follow 级 benchmark 脚手架与负向对照、集成准备、契约/风险预审查。它们不与实现波共享写入范围。
4. **Benchmark 测量**：在服务端/客户端实现线与 benchmark 脚手架完成后运行 follow 级冷打开与精确投影后续读取；保留“未调用完整 observation”的负向对照。
5. **集成**：在 clone 中集成实现线与测量，解决索引构建与 memo 的唯一接线点，运行 focused suites/typecheck/docs/benchmark，并交付单一 feature-branch。
6. **独立审查**：在集成准备与集成之后审查集成 diff 与证据；只有无未决 blocker 才给 pass。

## Alternatives considered

**让投影 fold 更快。** fold 只占约 3.8 s 冷打开中的 343 ms，优化它无法解决 3.4 s 的完整物化。

**保留缓存并在启动时预热所有 Session。** 这能保留精确统计，但把完整读取提前，增加内存/CPU 压力，而且正是本改动要移除的缓存依赖。

**把投影摘要写入 Session generation。** 这能让首次读取变快，但会改变持久格式并在日志中重建派生缓存；超出当前格式与所有权规则。

**首次打开总是加载精确投影。** 保留当前正确性，但用户可见延迟不变。

## Acceptance criteria

- 无投影缓存的冷父 Session 打开从有界窗口生成首个 snapshot，且不调用完整 observation 路径。
- opening frame 省略 projection block，而不是声称一个空的精确切面；缓存的 list/subagent/token/stats 值不被清掉，不可用投影由 readiness 状态显式标记。
- 客户端在精确值到达前用窗口回退展示 `sessionStats`，并对 token 与 context 投影显示加载/不可用状态。
- 按需精确投影读取是 single-flight、按 generation、可被导航取消、检查 watermark、感知权限，并最终替换不可用状态。
- 延迟 promotion 已定案并验证：无缓存打开已存储 Session 时，要么仍可通过 prompt 路径继续，要么明确报告在 promote 前是只读。
- subagent 打开仍要求并验证其投影 identity；小的已存储 Session 保持完整 observation 路径。
- 有完整缓存时重新打开至少不慢于当前行为。
- 冷首帧 benchmark 相对记录基线有实质改善，旧代码上的 follow 级负向对照会让同一断言失败。
- 现有 history window、paging、subagent、projection-store 与统计测试保持绿色；窗口不可用或格式错误时完整历史回退仍有效。
- 所有实现编辑、build 与 test 都留在 clone 内；运行中 Host 的源码、`node_modules`、`vendor`、profile 或 Session 数据不被修改。

## Risks

- 冷打开时全会话计数、token 总量、上下文值与部分状态 UI 会暂时不可用；产品文案与 loading 状态必须诚实表达。
- 后台精确读取可能与滚动及后续导航竞争；按需触发与取消策略需要浏览器证据，而不只是 Node 计时。
- 缺失 block 不能被客户端 store 误认为真实的空投影切面；watermark 与 readiness 语义需要明确测试。
- 老页面索引构建改动会失去构建期的行数门禁；服务 decoder 必须保留严格验证与完整读取回退，并为损坏 sidecar 添加负向对照。
- Clone 隔离会增加磁盘占用，并且绝不能与运行中的 checkout 共享 `vendor` 或 `node_modules` 链接。AgentTeams 的 member Session 与 team state 仍会落到运行中 Host 的存储；并行 worker 也会争用机器 CPU，必须串行 build/test 命令。
- 延迟 promotion 会改变冷 Session 变为 live 的时机；prompt/resume 路径必须被证明，而不能假设。
