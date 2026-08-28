# Agent Note: 长会话限制重复分配与实时驻留

Status: implemented

[English](2026-08-23-long-session-hot-paths.md) | 中文

## Problem

多条彼此独立的热路径会让工作量随完整 Session 日志增长。活跃 token meter 会在每个 event 后重新读取公共整日志快照；persistence 会在批处理前再次 clone 已经脱离来源且递归冻结的 event；实时全文搜索会 clone、序列化并重新投影完整 Session；JSONL 列表会反复解码未变化的 header；相邻搜索页也会在单页缓存中互相驱逐。

高并发工作负载对 model phase 准入和空闲 Web Agent 驻留也没有进程级上界。模型响应已经结束后，Tool 或 subagent 等待仍可能占用容量；即使没有浏览器跟随，已经持久化的空闲 Session 也会保持 attached。

无损的[打包 Session 历史传输](../architecture/2026-08-15-packed-session-history-transport.zh.md)限制了重新打开和重连成本，但持续打开的浏览器标签页仍接收标量实时 event。一个异常长且已经完成的回答仍可能在 Client window 中留下数万条标量 chunk。折叠的 Tool 行也会在读者展开前执行 JSON 解析、结果扁平化和 card model 构造。

Gateway 会发送 WebSocket Ping，但不会因为已打开的 socket 长期没有 Pong 而处置它。半开 carrier 因此只能等待 TCP 或网络中间层发现故障，之后既有重连和 journal repair 路径才会运行。

## Decision

当 cursor 与本次 append 匹配时，token meter 直接 fold `session/event` 提供的精确冻结 event。冷状态或意外落后的状态只捕获一次不可变 `session.events` 快照并完成一次 replay。

Persistence 为 `Session.append()` 发布的深度冻结值提供可信的 `enqueueFrozen()` 路径；独立的借用输入入口仍执行 clone。写入通过 O(1) 转移 pending backing array；失败时将同一 batch 放回后续 event 之前。

SQLite session-query provider 通过弱引用身份区分实时 Session，并使用 event 数量与规范 surface replacement generation 组成 fingerprint。已经证明为纯 append 的后缀只增加新搜索文档；replacement 或生命周期变化仍执行完整确定性 fold。精确 generation 的 Session 与 event 结果页使用由既有 `maxLimit` 限制总 item 权重的 LRU，返回页与缓存副本相互隔离。

JSONL persistence 按精确 stat 派生的 artifact revision 缓存每个已验证 header。并发 list 与 snapshot-list 请求共享一次元数据扫描，调用方取消只放弃自己的等待。artifact revision 变化会强制重新验证，成功的 discovery 会清理已经不存在的条目。

Base bundle 挂载一个进程级 FIFO memory-admission guard。默认最多同时准入八个 model phase；V8 heap 达到上限的 0.82 时关闭准入，降至 0.72 时重新开放。reservation 在匹配的最终 `assistant/message` 处释放，早于 Tool execution 或 child Agent 等待；`step/end`、idle、取消与 dispose 负责清理。该 guard 只改变调度，不写 Session event。

Session Controller 拥有其创建或恢复的每个 Agent handle。只要 history follower、待处理 inbox、owned child、活跃 job 或 running 状态仍需要它，已经持久化的空闲 Agent 就继续驻留。达到配置的五分钟保留时间后，controller flush Session、确认 persistence snapshot，并且只 dispose 自己持有的 handle；列表行与日志继续保留，之后可正常冷恢复。

Client Session state 统计每次 opening snapshot 之后收到的标量 event。数量达到 20,000 后，下一个最终 `assistant/message` 只 restart 一次 `RemoteJournalStream`；官方 follow opening 随后用无损 packed window 替换标量 tail，并重置计数。未完成的 model phase 始终保持精确；实现不增加 settled projection、稀疏 sequence range 或另一套 history API。

折叠的 Tool 行只派生轻量 title、summary、state 与 presence flag。展开 body 拥有 formatted arguments、flattened results、recovery text 和专用 card model 的缓存 getter，因此隐藏细节只会在展开后支付一次成本。

Gateway Ping/Pong 保持严格的 WebSocket 控制帧协议。每次 Ping 都把下一次 heartbeat interval 设为其 Pong deadline；仍然打开但未确认该 Ping 的 socket 会被终止，既有 carrier-loss 路径随后重连，并从 baseline 重建各 domain stream。

## Verification

定向 token-meter、write-behind、SQLite query、JSONL persistence、memory-admission、Session Controller、Tool row 与 Gateway 测试分别固定各条增量或有界路径。memory-admission composition 测试使用真实 Agent loop，证明容量会在 Tool 与 subagent 工作前释放。Session Controller 通过可注入的小阈值证明只有标量流量不会 restart，而超过阈值后的第一个最终 message 会触发一次 replacement generation。Gateway 测试证明 Ping/Pong 不携带应用消息，并会终止错过下一个 Pong deadline 的 peer。

事故规模的 history 在一个按 message 对齐的页面中包含 256,008 个逻辑 event，其中 256,004 个是 Assistant chunk。packed transport 保留所有逻辑 event，但把连续同 block chunk 表示成少量 record；live rebase 会在回答 final 后应用同一种表示，而不引入有损 projection。

## Alternatives considered

**删除或重写已存储 chunk。** 拒绝，因为 chunk 仍是持久 replay 和诊断证据，其 sequence、timestamp、provenance、fork 与崩溃恢复语义均可观察。

**保留 fork 的 settled sparse history projection。** 在上游 packed transport 发布后拒绝。稀疏 projection 会移除 source sequence reference 并只选择展示子集，而官方 packed record 无损，并且已经参与 reconnect、gap repair 与 pagination。

**按 event 数量裁剪 raw page 或 live stream。** 拒绝，因为静默 gap 会破坏 Tool pairing、replacement provenance、compaction record 和 journal repair。在已 final 的回答后替换完整 generation 可以保留显式 cursor，并让官方 stream 验证连续性。

**先实现 Chat DOM virtualization。** 不作为第一项修复，因为超大 history 的解析、校验、Conversation fold 和 model 驻留都发生在 React render 之前。等 scroll、selection、find-in-page、accessibility 与 variable-height anchor 行为明确后，virtualization 仍可减少 mounted DOM。

**发送应用层 JSON heartbeat。** 拒绝，因为一个物理 Gateway mux 现在拥有全部 domain stream，WebSocket Ping/Pong 可以在不扩展严格 Remote message union 的情况下执行 carrier liveness。JavaScript main-thread 性能仍是另一项浏览器诊断。

**把全文搜索迁入 Worker。** 暂缓，因为这会跨进程边界移动 database ownership、persistence observation、cancellation 和 shutdown。增量 reconcile 与有界精确 generation cache 消除了重复工作，但首次宽泛查询仍为同步。

## Consequences

长流在 token accounting、persistence batching、JSONL discovery 与 live search indexing 中不再重复分配完整日志。模型并发和空闲 Host residency 获得上界，同时不改变模型输入、event 顺序或持久身份。重新打开、重连以及已经 final 的超大 live window 使用官方无损 packed 表示；折叠 Tool 行不会执行与隐藏内容大小成比例的工作。半开 mux socket 会在两个配置 heartbeat interval 内进入既有重连路径。

当 Agent 活跃时，Host 的实时 Session 日志仍完整驻留；未完成 response 可以在最终 message 到达前超过 Client 阈值；第一次不同的宽泛 SQLite 查询仍可能阻塞一个 Host thread；Chat 也仍会挂载每个已加载 presentation row。这些 fork 特有的有界化不会引入 Session event 类型、`SESSION_FORMAT_VERSION`、JSONL storage path 或 migration。
