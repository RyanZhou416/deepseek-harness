# Agent Note: 无投影缓存时的窗口优先生成会话打开

Status: implemented

[English](2026-10-18-window-first-session-opening.md) | 中文

## Problem

当没有可用的投影 checkpoint 时，首次打开一个已存储 Session 会很慢。历史控制器可以在没有索引的情况下读取最新尾窗口，但过去除非投影缓存为每个已注册的客户端可见 key 提供完整 baseline，它会拒绝使用该窗口。没有 baseline 时，它会回退到完整 observation，在第一帧之前物化并验证整个日志；投影 fold 只是随后的额外成本。

在一个真实的 188,395 事件、164.6 MB generation 上（Node 24，页缓存已热）测得：

| 阶段 | 时间 |
|---|---:|
| `sessionPersistence.open`（完整日志物化与验证） | 3,430 ms |
| 该 open 之后的 `handle.read()` | 9.2 ms |
| `sessionStats` + token/context 投影 fold | 343 ms |
| 直接尾窗 `readWindow`（10k 事件） | 318–556 ms |

因此冷打开约 90% 的时间花在投影 fold 之前。缓存命中时不会做这些工作，因为 `openWindow` 收到 checkpoint，不再创建完整 observation。目标是让缓存离开首次打开的关键路径，而不是让必须进行的完整投影推导消失。

## Decision

### 1. 先走窗口

对于已存储的父 Session，即使 `read.projections` 缺失或不完整，Host 也直接提供现有的有界尾窗口。opening frame **省略 projection block**，而不是发送空 block：客户端投影 store 会把空 block 当成精确切面，清掉缓存的 title、list metadata、subagent、token 与 stats 行。可选 block 保留这些缓存提示，并把“投影不可用”与“空的投影切面”区分开。subagent 地址路径仍要求完整 observation，因为 `subagent` 投影是地址验证的一部分。

follow opening 不再调用完整的 `observeSession`。在 follow 级合成 fixture 上，首个 snapshot 约 30 ms，而同进程记录的延迟完整读取约 449–456 ms（见 benchmark 门禁说明）。页面加载不变，旧页仍由存储窗口提供。缓存命中的窗口打开此前已跳过冷打开 promotion；无缓存的窗口打开与这一行为一致：它不保留 prepared observation，后续 prompt 或 resume 走普通的冷 Session 恢复路径，而不是把该 Session 标记为只读。

### 2. 首帧之后加载精确的全日志投影

全 Session 数值如果没有完整日志 fold 或持久摘要，就不可能精确。因此产品延迟与精确统计延迟被分开：

- 缺失的 opening block 是明确的“尚未投影”状态（`ProjectionAvailability`），而不是声称窗口计数就是全会话数值；
- 只在用户显式打开统计弹窗或 Context 界面时请求一次精确 `session/projections` 读取；界面挂载、首帧或空闲任务都不会触发；
- 该读取按 Session 保持 single-flight，属于一个 Host connection generation，在 Session 离开视图时停止，并遵守投影 store 的 watermark 合并规则，使过期切点不能回退更新的值；
- 权限或访问拒绝对该 generation 是终止性的，migration-required 读取仍可重试，readiness 回到不可用而不是空转；
- 统计 UI 保留可见的 loading/unavailable 状态。只有 `sessionStats` 有窗口范围回退；`tokenUsage`、`contextPressure` 与 `contextBreakdown` 在精确切点到达前显示加载/不可用文案。

### 3. 老页面工作保持独立

首次打开与老页面加载仍是两项独立成本。generation 索引构建按帧统计换行分隔的记录数，而不是对每一行做 JSON 解码与验证；实际服务的窗口仍由播种严格解码器验证，格式错误或非 1:1 的 generation 保留完整读取回退。一个有界的进程内 memo 按精确 generation 路径、字节大小与修改时间保留已解析的 sidecar 索引，并以 sidecar 文件自身的身份作为附加守卫；预热向后页复用一个解析结果，并发读取方共享一次解析，后端在 teardown 时销毁该 memo。两项改动都保留完整读取回退与持久 sidecar 重建路径。

## Isolation

实现与验证在 ignored clone `tmp/window-first` 的 `feat/window-first-opening` 分支完成，该 clone 拥有自己的 `.git`、`vendor` 与 `node_modules`。运行中的 Host 保留其源文件、`node_modules` 与 `DSH_HOME`；主工作树中未执行 checkout、install、build 或 test，clone 之外的写入仅属于团队自身的编排状态。clone 即交付物；合入 `master` 等待专门的 Host 停止窗口。

## Alternatives considered

**让投影 fold 更快。** fold 只占约 3.8 s 冷打开中的 343 ms，优化它无法解决 3.4 s 的完整物化。

**保留缓存并在启动时预热所有 Session。** 这能保留精确统计，但把完整读取提前，增加内存/CPU 压力，而且正是本改动要移除的缓存依赖。

**把投影摘要写入 Session generation。** 这能让首次读取变快，但会改变持久格式并在日志中重建派生缓存；超出当前格式与所有权规则。

**首次打开总是加载精确投影。** 保留当前正确性，但用户可见延迟不变。

## Consequences

- 冷打开时全会话计数、token 总量、上下文值与部分状态 UI 在用户打开统计或 Context 前暂时不可用。产品文案与 loading 状态会明确表达这一点，而不是把窗口计数当作精确值呈现。
- 延迟读取只在用户显式操作后与滚动及后续导航竞争。Session 离开视图时读取被取消，其 watermark 合并不会回退更新的精确值或实时 frame。
- 缺失 block 与空的精确切面保持区分：wire 字段可选，availability 独立于行数据，测试同时钉住“空精确切面清行”和“缺失 opening 保留缓存行”。
- 仅计数的索引构建失去了构建期行数门禁。播种解码器仍验证每个被服务的行，格式错误或非稠密的 generation 保留完整读取回退，并以空白计数记录、已提交 seq 缺口与膨胀 sidecar 作为负向对照。
- 窗口打开有意不做 promotion。prompt 走普通路径恢复冷 Session，以一次即时后台激活换取首帧永不物化完整日志。
- 早于新注册客户端可见 key 的 checkpoint 仍会被省略；冷打开随后显示不可用 readiness，直到精确读取完成。
- follow 级 benchmark 强制冷打开与缓存命中重开的首帧上限，以及相对延迟读取 ≤ 0.5 的首帧占比。托管的 Linux CI lane 拥有所需的最终判定。

## Testing

- focused 集成套件（13 个文件、298 个测试）覆盖 history window 与边界、小 Session 路径、投影 store、Session manager 与 service，以及 JSONL 索引、窗口与 memo 文件。
- adjacency 运行（79 个文件、1,906 个测试：1,892 通过、1 跳过）只复现了改动前基线同样失败的 13 个测试（`session-presets.host.spec.ts` ×12、`transport.client.spec.ts` ×1）；它们不是本改动造成的。
- `benchmarks/session-open/window-first-follow.bench.ts` 记录冷打开首帧（约 30 ms，CI 上限 75 ms）且完整 observation 与完整 persistence open 均为零，延迟精确读取（约 449–456 ms）恰好各一次，缓存命中重开（约 37 ms，上限 95 ms）携带精确 block 且无延迟读取。冷首帧相对延迟读取的占比为 0.068，门禁为 0.5。
- typecheck、doc-quick 聚合、export-JSDoc 与 Cordis catalog 门禁通过。benchmark 门禁说明拥有记录的样本、workload、内存端点与校准。
