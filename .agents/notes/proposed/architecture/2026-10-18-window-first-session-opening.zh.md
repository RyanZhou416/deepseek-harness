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

对于已存储的父 Session，即使 `read.projections` 缺失或不完整，也直接提供现有的有界尾窗口。opening frame 在窗口 cursor 处携带空 projection baseline；客户端对统计与上下文使用已有的窗口口径回退。subagent 地址路径仍要求完整 observation，因为 `subagent` 投影是地址验证的一部分。

这会移除首次打开中的完整 `observeSession`。预计首帧从约 3.8 s 降到实测窗口范围的 0.6–0.8 s，且不依赖缓存状态。

### 2. 首帧之后加载精确的全日志投影

全 Session 数值如果没有完整日志 fold 或持久摘要，就不可能精确。因此本提案把产品延迟与精确统计延迟分开：

- 空 opening baseline 是明确的“尚未投影”状态，而不是声称窗口计数就是全会话数值；
- 在统计或 Context 界面打开时按需调度一次精确 `session/projections` 读取，或在首帧后空闲时执行；
- 结果带 watermark 合并进同一个 projection store，后续导航会取消待处理读取；
- 统计 UI 必须保留可见的 loading/unavailable 状态，不能把窗口计数当作精确值。

默认路径不执行完整读取；从不打开统计的用户不会付出这份成本。

### 3. 老页面工作保持独立

首次打开与老页面加载是两项独立成本。现有索引构建为了记录 offset 仍解码并验证每一行；只记录 offset/newline 的构建实测从同一遍历的 1,864 ms 降到 425 ms，而实际服务的页面仍由 seeded decoder 严格验证。一个有界的解析索引 memo 可以去掉每个 warm page 重复的 30–37 ms sidecar 解析。这些改动可以在打开路径之后落地，并必须保留完整读取回退。

## Isolation and integration

开发在 `tmp/window-first` 的干净 clone 中进行（被仓库忽略，拥有自己的 `.git` 和 `node_modules`），分支为 `feat/window-first-opening`。运行中的 Host 保留当前文件和 `node_modules`；主工作树中不执行 checkout、install、build 或 test。所有命令使用 clone 自己的 root、私有临时 `DSH_HOME`，且不监听 3080 端口。

Clone 会作为 feature branch 推送。合入 `master` 等待专门的 Host 停止窗口；运行中的 Host 永远不会切到 feature branch。只有在分支合并且所有路径确认独立后才删除 clone。

## Stage plan

1. **契约与基线**：冻结空 baseline 语义，定义投影 readiness 状态，记录 cold/warm 测量，并添加证明当前路径会执行完整 open 的失败负向对照。
2. **服务端窗口优先**：对父 Session 放开完整 checkpoint 限制，保留 subagent 回退，并添加窗口/opening 测试。
3. **客户端 readiness 与 loading**：把空 baseline 传播为明确的 loading 状态；精确值不可用时统计继续使用窗口回退。
4. **投影按需生命周期**：single-flight 精确投影读取、导航取消、watermark 检查，并合并进现有 store。
5. **Benchmark 证明**：无缓存冷首次打开、首帧、精确投影后续读取，以及快路径不执行完整 observation。
6. **老页面索引构建**：offset/newline 构建，配合严格服务页面验证与完整读取回退。
7. **老页面索引 memo**：有界、按 identity 的解析索引复用，包含释放与失效测试。
8. **集成审查**：跨包行为、负向对照、文档，以及交给用户审查的单一 feature-branch 交付。

## Alternatives considered

**让投影 fold 更快。** fold 只占约 3.8 s 冷打开中的 343 ms，优化它无法解决 3.4 s 的完整物化。

**保留缓存并在启动时预热所有 Session。** 这能保留精确统计，但把完整读取提前，增加内存/CPU 压力，而且正是本改动要移除的缓存依赖。

**把投影摘要写入 Session generation。** 这能让首次读取变快，但会改变持久格式并在日志中重建派生缓存；超出当前格式与所有权规则。

**首次打开总是加载精确投影。** 保留当前正确性，但用户可见延迟不变。

## Acceptance criteria

- 无投影缓存的冷父 Session 打开从有界窗口生成首个 snapshot，且不调用完整 observation 路径。
- opening frame 明确标记其 cursor 处投影不可用；窗口口径统计继续作为客户端回退，且不被标成精确全会话数值。
- 按需精确投影读取是 single-flight、可被导航取消、检查 watermark，并最终替换回退值。
- subagent 打开仍要求并验证其投影 identity。
- 有完整缓存时重新打开至少不慢于当前行为。
- 冷首帧 benchmark 相对记录基线有实质改善，旧代码上的负向对照会让同一断言失败。
- 现有 history window、paging、subagent、projection-store 与统计测试保持绿色；窗口不可用或格式错误时完整历史回退仍有效。

## Risks

- 冷打开时全会话计数、token 总量、上下文值与部分状态 UI 会暂时不可用；产品文案与 loading 状态必须诚实表达。
- 后台精确读取可能与滚动及后续导航竞争；按需触发与取消策略需要浏览器证据，而不只是 Node 计时。
- 空 baseline 不能被客户端 store 误认为真实的空投影切面；watermark 与 readiness 语义需要明确测试。
- 老页面索引构建改动会失去构建期的行数门禁；服务 decoder 必须保留严格验证与完整读取回退，并为损坏 sidecar 添加负向对照。
- Clone 隔离会增加磁盘占用，并且绝不能与运行中的 checkout 共享 `vendor` 或 `node_modules` 链接。
