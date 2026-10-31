# Agent Note: 有界首帧 Session 历史传输

Status: implemented

[English](2026-10-31-first-frame-history-byte-budget.md) | 中文

## Problem

打开一个 Session 时，其历史作为一条未分片的 WebSocket 文本消息交付。Host 在 [`stream-server.ts`](../../../../packages/api/gateway/src/stream-server.ts) 中把完整的快照帧序列化一次，浏览器在渲染任何对话记录之前要对整个字符串执行 `JSON.parse`。在本机回环上实测，12.8 MB、76 MB 与 44 MB 的首帧到达 Client 分别耗时 1.6 秒、16.9 秒与 11.2 秒，而 Host 的读取、解码与发送合计不足 2 秒：等待主要来自浏览器整帧解码、解析与 GC，且增长快于字节数。

没有任何限制约束这一帧。开启窗口只按消息数分页：Client 最多请求 500 条计数消息，并带上两轮、50 条消息的窗口（[`session.ts`](../../../../packages/api/session-controller/src/client/sessions/session.ts)），Host 在消息边界切分（[`history.ts`](../../../../packages/api/session-controller/src/history.ts)），有界存储窗口读取则限制行数（`windowEventBound`，至少 2,000、最多 10,000 个事件）。因此单条消息或携带大型工具结果的单个轮次就能把一帧变成数十 MB。wire 协议没有按字节表达的页面请求，只有 `page(beforeSeq)`，并且开启要求页尾等于 cursor。

WebSocket 也从未协商 `permessage-deflate`，因此带宽受限的远程 Client 必须传输该帧的每一个字节。目标是限制每帧在 Client 端的解码与解析成本，并让远程部署用 CPU 换带宽，同时不改变分页协议或 Client 的页面假设。

## Decision

### 1. 单个历史页面的序列化字节预算

`SessionController.Config.historyPageMaxBytes`（默认 `0`，即不设上限）限制一页可携带的记录的序列化 UTF-8 字节数。Host 先按现有消息/轮次对齐选出页面，再由 `trimToByteBudget` 把页起点前移到能同时使序列化记录不超预算的最新计数消息组起点。整页内容都在预算内的页面保留原起点，因此裁剪不会删除未受限页面本会携带的非消息事件。即使最新消息组单独超出预算也始终保留它，因此页面总会向前推进，Client 不会空转。如果某个消息及其上方的消息引用了更早的源事件，该候选起点不可用，否则页面会携带一个没有源事件的可视事件。

`hasMore`、页尾和 follow cursor 保持原有含义：`hasMore` 仍是 `起始 seq > 0`，页尾仍是调用方的切点，开启页仍结束于 cursor。预算按 wire 序列化后的页记录（`{"type":"event","event":…}`）计数，不包含较小的帧封套。它适用于实时 Session、向后 `page(beforeSeq)` 请求与 follow 首帧，同时覆盖完整来源路径与存储窗口路径。

预算会覆盖调用方的消息与轮次下限。这不破坏 Client：其文档化契约本就允许在 500 条上限或历史耗尽时提前停止，`loadOlder()` 只是前插收到的页面，`loadThrough(seq)` 会循环直到窗口覆盖目标，并在无进展的页面停止。

有界存储窗口读取保留行数上界，但在配置预算时不再一次请求整个上界。带预算的窗口读取先请求 256 个事件，再把上界乘以 4 逐步扩大到原有对齐上界，并在首个已确定的页上停止：消息/轮次对齐已解析、已到达历史开头，或该页尾部记录已超出预算。最后一种情况即最终结果，因为 `trimToByteBudget` 会保留能容纳的最新消息组，更早的事件只会增加字节，所以该裁剪起点与完整读取所选起点一致。follow opening 还会继续扩大，直到窗口包含日志最后一个 `turn/start`/`turn/end`，使 `interruptedTurnClosers` 看到与完整观察相同的状态。所有请求都不超过对齐所需的行数上界，因此始终无法确定页的窗口仍回退到完整读取；默认 `0` 时仍只请求一次对齐上界。记录与分页仍以消息和行数为界；只有 wire 帧按字节设界。

### 2. mux socket 上可选的 `permessage-deflate`

`TypertGatewayService.Config.streamCompression` 选择该扩展。它默认关闭，保持 ws 的纯文本帧与上游 wire 行为。启用后，服务端用配置的 zlib `level` 压缩达到或超过 `threshold` 字节的下行消息；`concurrencyLimit` 限制同时进行的 zlib 操作数量，超过后 ws 发送不压缩帧；`serverNoContextTakeover` 在每帧后释放 zlib 上下文，而不是按连接保留。未提供该扩展的 Client 仍收到纯文本帧，协商也允许浏览器压缩自身较小的上行帧。

压缩不会减少 Client 的 `JSON.parse` 工作：它解压为字符串后解析同一段文本。其收益在远程链路的带宽。代价是 Host 的 deflate CPU 与 zlib 内存，以及 Client 的 inflate CPU；每连接的 zlib 状态正是并发上限与上下文接管设置所约束的碎片风险。按来源地址判断回环的方案被否决，因为反向代理会让远程对端看起来就是回环。

推荐的 fork 配置是：远程使用的部署采用 `enabled: true, threshold: 1048576, level: 1, concurrencyLimit: 4, serverNoContextTakeover: true`；仅本机回环使用的部署保持关闭，因为字节预算已经限制帧大小，压缩只是把工作从网络移到 CPU。上游默认保持关闭，因为其契约为纯文本帧。

### 3. 不改动 wire 与 Client

请求类型、follow/page 响应结构与每个 `SessionEventMap` 成员都不变。Client 继续请求相同的消息/轮次窗口，并像对待 500 条上限或历史耗尽那样对待更短的页面。记录与回放不受影响。

## Alternatives considered

**改为压缩 HTTP 历史传输。** 已归档的[打包历史传输](../../archived/architecture/2026-08-15-packed-session-history-transport.md)决策已经否决把 HTTP content-encoding 当作本地解析成本的解法：昂贵的步骤是浏览器的整帧 JSON 解析，而历史经由 WebSocket 而非 HTTP body 到达 Client。按字节限制帧并可选地 deflate 它，针对的正是该决策识别的成本。

**在 Controller 中剥离内嵌的 Assistant 流。** [v2 内嵌 Assistant 流](2026-09-01-v2-embedded-assistant-streams.zh.md)决策已否决把流数据从 Session 事件传输中拆出；Client 需要内嵌流来渲染与回放对话记录。本改动不重新讨论该决定。

**在 Client 增量解析 JSON。** 流式解析器会改变一元帧的消费与所有权方式，而且不能减少远程链路传输的字节。字节预算在没有新 wire 或 Client 解析路径的前提下获得了大部分解析收益。

**调低 500 条消息的默认值。** 这会改变 Client 文档化的分页契约，而且单条消息或单个轮次巨大时帧仍然无界；驱动解析时间的是字节，不是消息数。

**始终启用压缩。** 回环使用会为没有解析收益的 deflate 与 inflate CPU 付费，并按连接保留 zlib 内存。受益的部署可以显式开启。

**通过检测回环自动选择压缩。** 反向代理会终结连接，因此 Host 对远程 Client 看到的来源也是回环；该判断在压缩最重要的场景下会出错。

**按硬性字节上限停止存储窗口解码。** 索引以行对齐的帧工作，少取行会破坏消息/轮次对齐，并导致上文所述的完整日志回退。渐进扩大避开了这一取舍：它保留对齐所需的行数上界，只在页已确定时停止。

## Consequences

- 页面可能短于 Client 的 50 条消息与两轮下限。在消息很大的 Session 上 `loadOlder()` 可能需要点击更多次，`loadThrough()` 会分更多页；两者都不依赖完整页面。
- 裁剪会先序列化未裁剪的页面以度量大小。该过程受现有消息上限约束，与 Gateway 本来就要执行的帧序列化处于同一量级。
- 带预算的窗口读取最多用三次请求取得回看范围（256、1,024 与对齐上界）。被预算裁剪的页只解码较小的首个窗口；受对齐限制的页在这几次请求中解码约 1.6 倍于其上界的行数。256 事件的首次上界是实现常量，因为它只改变读取粒度，不改变返回的页面。
- 携带超大工具结果或超大消息组的单个轮次仍可能产生超出上限的帧。预算是在消息原子性周围尽力而为，而不是硬性帧大小保证。
- 压缩在两端增加 zlib CPU 与内存，并使 `bufferedAmount` 不再可靠地即时反映下行进度，因为 ws 在 `send()` 返回后才压缩。Pong 活动仍是权威的存活信号；拥塞链路仍会在两次错过的 heartbeat 时被发现。
- 默认不设上限保持了现有 wire 组成，因此录制会话快照与 TypeScript、Python SDK 的期望输出不变。
- 预算只统计页记录：开启帧的 header、可选的投影块与紧凑 assistant 流 baseline 不计入其中。
- 部署在 patch 中替换某个插件行时会替换整个 `config`，因此 fork overlay 在已经重述该行其他字段的地方，也必须重述 `historyPageMaxBytes` 与 `streamCompression`。

## Testing

- `packages/api/session-controller/tests/session-history-paging.host.spec.ts` 固定精确适配的切点、少一字节即丢弃一个消息组、超大的最新消息、存储窗口页路径、实时与存储 follow 首帧，以及在有限预算可容纳整页或未配置预算时保持页面不变。它还固定 64 KiB 预算配 4 KiB 消息时只用首个上界读取一次、稀疏 generation 的 256 → 1,024 → 2,000 扩大、未配置预算时只读取一次有界窗口、到达历史开头的窗口，以及开放尾部因最后一个轮次分界多扩大一步从而合成收尾事件与完整开启一致。
- `packages/api/session-controller/tests/controller.host.spec.ts` 固定 Config 默认值与整数校验。
- `packages/api/gateway/tests/stream-server.host.spec.ts` 固定默认不协商、启用后协商并完成大载荷往返、不提供扩展的 Client，以及按配置阈值出现的压缩位。
- `packages/api/gateway/tests/gateway-stream.host.spec.ts` 固定压缩 Config 的默认值与取值范围。
