# Agent Note: 长会话限制重复分配与实时驻留

Status: implemented

[English](2026-08-23-long-session-hot-paths.md) | 中文

## Problem

多条彼此独立的热路径会让工作量随完整 Session 日志增长。活跃 token meter 会在每个 event 后重新读取公共整日志快照；persistence 会在批处理前再次 clone 已经脱离来源且递归冻结的 event；实时全文搜索会 clone、序列化并重新投影完整 Session；JSONL 列表会反复解码未变化的 header；相邻搜索页也会在单页缓存中互相驱逐。

高并发工作负载中的空闲 Web Agent 驻留没有上界。即使没有浏览器跟随，已经持久化的空闲 Session 也会保持 attached。

Alpha.2 把 in-flight Assistant frame 保留在持久 history window 之外，并把它们结算进紧凑的 `assistant/message` 或 `assistant/attempt` record。折叠的 Tool 行仍会在读者展开前执行结果扁平化与大型 card array copy。

Gateway 会发送 WebSocket Ping，但不会因为已打开的 socket 长期没有 Pong 而处置它。半开 carrier 因此只能等待 TCP 或网络中间层发现故障，之后既有重连和 journal repair 路径才会运行。

## Decision

Alpha.2 token meter 保存精确的已消费 offset，并只通过 indexed Session access 读取未消费记录。官方路径不会物化完整日志，因此 fork 原有的直接 append 快路径与整日志 fallback 继续保持缺席。

JSONL handle 的 routed live-event 路径保留 `Session.append()` 发布的深度冻结值。公开 `SessionHandle.append()` 仍在异步工作前 clone borrowed input。routed write 通过 O(1) 转移 pending backing array；失败时将同一 batch 放回后续 event 之前。

SQLite session-query provider 通过弱引用身份区分实时 Session，并使用 event 数量与规范 surface replacement generation 组成 fingerprint。已经证明为纯 append 的后缀只增加新搜索文档；replacement 或生命周期变化仍执行完整确定性 fold。精确 generation 的 Session 与 event 结果页使用由既有 `maxLimit` 限制总 item 权重的 LRU，返回页与缓存副本相互隔离。

JSONL persistence 按精确 stat 派生的 selected-generation revision 缓存每个已验证 header。并发 `list()` 请求共享一次 metadata scan，调用方取消只放弃自己的等待。artifact revision 变化会强制重新验证，成功的 discovery 会清理已经不存在的条目。

Session Controller 拥有其创建或恢复的每个 Agent handle。只要 history follower、待处理 inbox、owned child、活跃 job 或 running 状态仍需要它，已经持久化的空闲 Agent 就继续驻留。达到配置的五分钟保留时间后，controller flush Session、确认 persistence snapshot，并且只 dispose 自己持有的 handle；列表行与日志继续保留，之后可正常冷恢复。

折叠的 Tool 行只派生轻量 title、summary、state 与 presence flag。展开 body 拥有 formatted arguments、flattened results、recovery text 和专用 card model 的缓存 getter，因此隐藏细节只会在展开后支付一次成本。

Gateway Ping/Pong 保持严格的 WebSocket 控制帧协议。每次 Ping 都把下一次 heartbeat interval 设为其 Pong deadline；仍然打开但未确认该 Ping 的 socket 会被终止，既有 carrier-loss 路径随后重连，并从 baseline 重建各 domain stream。

## Verification

定向 SQLite query、JSONL persistence、Session Controller、Tool row 与 Gateway 测试分别固定各条增量或有界路径。Gateway 测试证明 Ping/Pong 不携带应用消息，并会终止错过下一个 Pong deadline 的 peer。

事故规模的 history 在一个按 message 对齐的页面中包含 256,008 个逻辑 event，其中 256,004 个是 Assistant chunk。Alpha.2 会迁移历史 generation，并投影持久 Assistant attempt，而不会在结算后继续保留 token-sized Client row。

## Alternatives considered

**删除或重写已存储 chunk。** 拒绝，因为 chunk 仍是持久 replay 和诊断证据，其 sequence、timestamp、provenance、fork 与崩溃恢复语义均可观察。

**先实现 Chat DOM virtualization。** 不作为第一项修复，因为超大 history 的解析、校验、Conversation fold 和 model 驻留都发生在 React render 之前。等 scroll、selection、find-in-page、accessibility 与 variable-height anchor 行为明确后，virtualization 仍可减少 mounted DOM。

**发送应用层 JSON heartbeat。** 拒绝，因为一个物理 Gateway mux 现在拥有全部 domain stream，WebSocket Ping/Pong 可以在不扩展严格 Remote message union 的情况下执行 carrier liveness。JavaScript main-thread 性能仍是另一项浏览器诊断。

**把全文搜索迁入 Worker。** 暂缓，因为这会跨进程边界移动 database ownership、persistence observation、cancellation 和 shutdown。增量 reconcile 与有界精确 generation cache 消除了重复工作，但首次宽泛查询仍为同步。

## Consequences

长流在 token accounting、persistence batching、JSONL discovery 与 live search indexing 中不再重复分配完整日志。空闲 Host residency 获得上界，同时不改变模型输入、event 顺序或持久身份。Alpha.2 拥有 in-flight Assistant settlement；折叠 Tool 行不会执行与隐藏内容大小成比例的工作。半开 mux socket 会在两个配置 heartbeat interval 内进入既有重连路径。

当 Agent 活跃时，Host 的实时 Session 日志仍完整驻留；第一次不同的宽泛 SQLite 查询仍可能阻塞一个 Host thread；Chat 也仍会挂载每个已加载 presentation row。这些 fork 特有的有界化不会引入 Session event 类型、`SESSION_FORMAT_VERSION`、JSONL storage path 或 migration。
