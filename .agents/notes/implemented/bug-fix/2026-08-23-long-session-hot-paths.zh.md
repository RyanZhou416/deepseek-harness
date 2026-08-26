# Agent Note: 长会话避免重复处理完整日志和数组头部

Status: implemented

[English](2026-08-23-long-session-hot-paths.md) | 中文

## 问题

处于活跃状态的 token-meter 会在每个已提交事件之后通过 `session.events` 继续回放。由于 `Session.events` 有意在 append 后返回一份新的、冻结的完整日志 快照，长时间流式输出会反复复制全部历史，分配量接近二次增长。API proxy 的异步 帧队列还会从数组头部移除每个已交付帧。

持久化 write-behind 会把已经完成脱离且递归冻结的实时事件再次克隆进短暂批处理窗口， 并用 `splice(0)` 排空窗口。会话搜索同样会克隆每个实时事件、序列化完整克隆以计算 指纹，而且在确认现有实时索引是否已经描述同一不可变快照之前，就提前投影搜索文档。 已挂载会话的历史读取还会在选择很小的一页之前再次复制完整快照。

JSONL 元数据列表还会在每次 `list()` 和 `listSnapshots()` 时重新解码全部已存储的 Zstandard 头。Host 搜索路径先列一次可见会话，SQLite provider 又会为每个游标页 协调一次持久化，因此宽泛 Web 搜索会成倍放大头读取工作。Host 在第一页和续页之间 交替时，原先只保留一页的结果缓存也会确定性抖动。

这些成本会同时出现在长会话工作负载中，但它们都不足以成为削弱持久日志不可变性或 改变逐帧线协议的理由。

浏览器还通过两条独立 WebSocket downlink 分别消费对话事件和 host 状态。mux downlink 丢失或严重积压时，用户自己的消息与 Agent 动作会停止发布，而低频 host downlink 仍可能把会话显示为“进行中”。刷新能从持久 history 恢复全部缺失行，但传输层没有应用心跳或静默上限，因此表面仍打开的连接代际不会自动恢复。

## 决策

token-meter 保留首次读取时惰性初始化、活跃后主动观察的行为。会话一旦具有计量 状态，提交后的 `session/event` 监听器就直接折叠回调提供的精确冻结事件。如果更早 注册的监听器已在同一次分发中推进 meter，主动监听器不再重复处理；其他游标不匹配 仍回退到原有的回放追赶。冷启动追赶只取得一次不可变的 `session.events` 快照并遍历 一次。

`FrameQueue` 保留逐帧 FIFO 交付并继续保持无界。它以头游标替代 `Array.shift()`，在 yield 前清除已消费槽位，并在排空后重置底层数组，避免已交付帧 被长期高水位数组继续引用。

持久化协调器通过可信 write-behind 准入路径传递 `Session.append()` 发布的深冻结值。 公开的 write-behind 准入仍会克隆借入的可变输入，保留独立使用时的所有权契约。 排空操作以 O(1) 转移 pending 底层数组，不再把每个条目从中 splice 出来。

SQLite 会话查询协调器借用不可变的实时／持久化观察，以连接内的弱 Session 身份、 快照长度和规范的 `surface.replaceGeneration` 作为实时指纹，并把语义文档投影推迟到 指纹确实要求索引工作之后。如果同一个 Session 只追加了事件且替换代数没有变化， 协调器只插入这个已证明安全的尾部文档；遇到 surface replacement、生命周期变化或 旧的／无法解析的指纹时，仍回退到精确的完整日志 fold 和替换。它不再仅为比较代际 就克隆并序列化完整实时日志。

会话搜索和事件搜索以 LRU 保留精确代际页面，总条目权重受现有 `maxLimit` 配置限制。 同一规范化请求／游标链再次到达时，会返回页面的独立副本，不再让相邻游标页互相 顶掉，也不再重复执行同步 FTS 排序；相关语料代际只要变化就不会命中缓存。

JSONL 持久化把每个已验证不可变头绑定到精确的 stat 日志修订号（设备、inode、大小、 mtime 和 ctime）。未变化的列表会复用头；append、替换或外部 writer 改变修订号后会 重新验证。成功列表中已经不存在的条目会从缓存移除。API 的历史／fork 读取复用已经 不可变的 `Session.events` 切面，不再在截取所需页面或前缀前分配第二份完整日志数组。

并发 JSONL `list()` 与 `listSnapshots()` 调用共享一次元数据扫描；快照结果直接携带该次 扫描唯一一次 stat 得到的修订号，不再对每个文件重复 stat。调用方取消只放弃自己的 等待。浏览器历史请求在首次、重连或更早页每次请求 20 条 append-origin message，并使用[已结算稀疏投影](2026-08-26-settled-history-browser-window.zh.md)；raw API 读取仍然可用。

base 组合挂载进程级 memory-admission guard。FIFO reservation 限制已获准 model phase 数，V8 heap 达到压力水位时关闭新准入；高低水位形成滞回，每个 reservation 则在最终 `assistant/message` 处释放，避免 tool execution 等待 child Agent 时继续占用容量。`step/end`、idle 和 dispose 是兜底释放点。API Proxy 只保留自己拥有的顶层 Agent handle。配置的 retention 到期后，idle handle 只有在没有 inbox 工作、child Agent、pending interaction、active job 或 mux subscriber，且 flush 与持久化快照证明已落盘时才会转冷。驻留卸载仍发布普通后端 dispose 生命周期，但保留客户端的持久会话列表行。

两条事件队列现在每五秒发送一个瞬态 `stream/heartbeat`。该标记与业务帧经过同一队列，但绝不 append 到 Session。浏览器在传输层消费它：连续二十秒静默，或收到延迟至少十秒的心跳，都会主动关闭该 downlink。既有连接代际控制器随后会中止同代的另一条流、重连两条连接，并从 history 重建已打开的对话窗口。因此半开 socket 与持续有帧但已经陈旧的队列都能自动恢复，无需轮询每个长会话。

## 验证

token-meter 测试固定监听器顺序追赶、服务重载、畸形事件重试，并证明首次实时发布之后不会随每次 append 重新读取完整公共日志。API proxy 套件继续固定 FIFO 帧内容和流清理。write-behind 测试同时固定可变借入输入的复制路径与冻结事件保持身份的路径。SQLite 搜索测试证明实时索引协调不会对不可变历史执行 `structuredClone`，纯追加回归固定尾部插入路径，surface replacement 固定完整 fold 回退，结果缓存回归固定相邻游标页复用、代际失效和调用方修改隔离。JSONL 测试固定头复用、stat 修订号失效以及共享扫描、单次 stat 快照和调用方独立取消语义。真实 AgentLoop 与 Loader 组合测试固定 memory-admission 的并发、滞回、取消以及 tool／subagent wait 之前的 model-phase 释放；API resolver／residency 测试固定 handle 转交、持久性检查、mux 保留与持久列表行保留。既有搜索、游标、surface、持久化和并发套件继续固定结果契约。

传输测试还固定两条队列的心跳产生、静默流超时、延迟心跳拒绝、新鲜心跳接受、timer 清理以及 runtime 对控制帧的隔离。针对报告中的真实会话，新浏览器能显示用户 02:18 的消息、全部 Agent 动作和 02:22 的完整回答，而旧页面仍保持陈旧，从而在本次恢复改动之前就证明持久化与后端执行完好。

隔离的 4 GiB 堆 Web 实例使用 118 个真实会话（148,657,249 字节）的只读副本。 最大会话的 50-message 对照请求展开为 20,434 个连续事件和 4,523,242 字节 JSON， 耗时 6.46 秒；发布的 20-message 页面观测到 10,769 个事件、2,330,763 字节 JSON， 耗时 2.35 秒。短时混合负载中，按 stat 限定的头复用把 Node 私有提交峰值从约 1.89 GiB 降到 0.89 GiB；不同的宽泛搜索仍会占满一个核心并超时。这些数据把安全的 元数据改进与尚未解决的历史／宽查询执行边界工作区分开来。

## 考虑过的替代方案

- **暴露可变 Session 日志或让旧事件数组继续增长**：不予采纳，因为不可变快照是 防止消费者改写持久历史的所有权边界。 - **丢弃、合并或批量处理队列帧**：不予采纳，因为缺失会话事件会产生序列缺口， 改变 WebSocket envelope 还会扩大线协议，而不是修复队列操作。 - **在本次改动中给 FrameQueue 增加硬容量**：不予采纳，因为溢出必须使完整流代际 失败并重建，而尚未证明每一种 host 帧都能在重连后重建。 - **在本次跟进中把 SQLite FTS 移入 Worker**：暂缓，因为这会把数据库所有权、持久化 观察、取消和关闭全部跨越进程边界。精确代际缓存无需这种架构分叉即可消除重复扫描； 首次宽泛查询仍保持同步。 - **给现有历史页增加 raw-event 硬上限**：不予采纳，因为客户端有意依赖一个连续的 seq 区间来完成 tool call/result 配对、replacement source group、compaction 记录、 重连修复和前页相邻性。安全上限需要新的可续传历史投影或事件分块线协议；暗中截断 `maxMessages` 会制造缺口，却仍声称满足现有契约。 - **在 mux subscriber 仍连接时卸载 idle 会话**：不予采纳，因为当前 mux 是 Host 唯一的 live-session 订阅信号。卸载会等待 subscriber 归零，不会虚构 per-session interest 或与 活跃浏览器代际竞争。 - **通过列表虚拟器卸载离屏 Chat 行**：本次不予采纳，因为键控渲染器可能拥有本地 交互状态。未来的虚拟器必须先迁移或明确保存这些状态，并用浏览器测试证明滚动、 选择、页面内查找和无障碍行为。 - **在保持行挂载的同时使用 `content-visibility: auto`**：不予采纳，因为生产浏览器 的离屏固有尺寸会参与 Chat 用于分页锚点和底部跟随的同一套滚动几何。在这些交互的 浏览器契约通过之前，仅保持挂载身份还不够。 - **再增加一套会话历史懒加载器**：不予采纳，因为冷会话和浏览器历史已经按需加载并 从尾部分页；替换这些路径会复制既有的持久化和重连语义。
- **会话运行时轮询 history**：不予采纳，因为健康流也会反复解码数千 raw event，恢复成本还会随 resident session 数量增长。队列内心跳直接测试真实交付路径，每个浏览器间隔只增加两个很小的帧。

## 后果

活跃长流不再为 token-meter 的每次更新重新物化完整公共事件快照；队列交付避免重复删除数组头部，同时不改变会话文件、事件溯源或回放。持久化批处理不再复制每个实时 payload，会话搜索／历史读取也避免冗余完整日志克隆和提前执行实时索引工作。纯实时追加会扩展 FTS 索引而不是替换它；相同搜索会复用有界、与调用方修改隔离的游标页；重复 JSONL 列表避免重复发现、stat 和未变化 Zstandard 头解码，同时仍按精确 stat 修订号失效。Model-phase 准入限制并发增长，但不跨 tool 或 subagent wait 保留容量；已落盘、无订阅的 idle Web 会话会释放 Agent 与 Session heap，而不改变存储日志或列表身份。陈旧浏览器代际现在会自动重连并从 history 修复，不再要求手动刷新。surface rewrite 保留规范的完整 fold 行为。活跃和已订阅会话仍驻留，`FrameQueue` 仍没有硬背压容量，Chat 仍承担每个已加载行的 DOM 和 React 内存；按消息限制的 raw API 页面仍可能包含数万个事件，而浏览器使用已结算稀疏投影；首次或不同的宽泛 SQLite 查询也仍为同步。瞬态 RPC 帧 union 新增 `stream/heartbeat`；Session event schema、会话格式版本、Zstandard 产物和存储路径均不改变。
