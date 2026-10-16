---
description: "预置请求记录能力缝：模型路由如何把即将发出的请求写入自身 session 日志，以及为什么只有通过持久化检查的记录才允许发出。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-request-record

[English](README.md) | 中文

## 概述

`dsh-llm-request-record` 拥有 `ctx.llmRequestRecord` 服务与 `llm/request-record` session 事件。模型路由在构建完字节之后、发出之前调用 `recordPreparedRequest`；该服务把一条记录追加到所属 session 的日志，等待该日志到达持久存储，然后以记录自身的序号作答，或以固定拒绝作答——调用方必须遵守该拒绝，不得发送。记录只陈述「发出过什么」：有序 system 文本、模型、用途、wire 库与 profile；它从不陈述结果，因此持久化结果为 `false`、被拒绝或期限触发时，这条 prepared 记录仍留在日志里，而发送被禁止。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Host 组合中挂载本包并配置持久化期限。服务注册为 `ctx.llmRequestRecord`。

```yaml
- name: '@deepseek-ai/dsh-llm-request-record'
  config:
    flushTimeoutMs: 5000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `flushTimeoutMs` | 无（必填） | 一条 prepared 记录等待 `SessionStore.flush` 的毫秒上限；超过即告知调用方该记录尚未持久。可接受范围为 `1` 到 `MAX_TIMER_DELAY_MS`（2147483647） |

`flushTimeoutMs` 没有默认值。这个上限防止一个卡住的持久化监听器无限期拖住模型请求，因此由部署显式声明，而不是继承一个编译进来的数字。小于 `1` 或大于 `MAX_TIMER_DELAY_MS`（2147483647 毫秒，定时器可接受的最大延迟）的值都是加载错误。

### 记录一次预置请求

`recordPreparedRequest(context, payload): Promise<LlmRequestRecordOutcome>` 接收请求所属的 live session 与调用方对请求的观测，并只以两种形状之一作答：

| 结果 | 含义 |
|---|---|
| `{ ok: true, preparedId }` | 记录已在 session 日志中的 `preparedId` 处，且至少一个持久化监听器成功 settle |
| `{ ok: false, code: 'REQUEST_RECORD_UNAVAILABLE' }` | 没有任何持久记录承载该请求：无 live session、payload 无效、没有参与的持久化监听器、监听器失败，或期限已到 |
| `{ ok: false, code: 'CLAUDE_REQUEST_RECORD_CONTEXT_REQUIRED' }` | 请求没有命名 session，因此没有任何日志可以承载它的记录 |

两个失败码都禁止发送。结果类型是完备的：调用方需要据以行动的一切拒绝都以 `ok: false` 到达，而不是以 rejection 到达。`CLAUDE_REQUEST_RECORD_CONTEXT_REQUIRED` 由「根本没有 session 就到达该能力缝」的调用方报告，此时还没有可发出的服务调用；本服务只回答 `REQUEST_RECORD_UNAVAILABLE`。

调用方提供 `provider`、`model`、`purpose`、`systemBlocks`、`wireLibrary` 与 `profile`。服务提供 `v`、`phase` 与 `systemDigest`，因此调用方无法声明一个自身文本不满足的 schema 或摘要。

### 读取一条已记录的请求

`reconstructRequestSystem(events, preparedId?)` 从 session 的事件数组投影出该次记录的有序 system 文本——活体事件或从持久存储读回的事件都行，因为它只读传入的数组，不读任何 Session 历史访问器。

传入一次成功调用返回的 `preparedId` 即可读取那一次尝试。每次尝试各有一条记录，因此要在多次重试中重构某一次发送，消费者必须传入它为该次发送记录的 id；省略 id 时读取最近一条，那只是「手上没有 id」时的默认。

### 被记录的事件

`llm/request-record` 承载一条 `LlmRequestRecordData`：`v: 1`、`phase: 'prepared'`、`provider` 判别式（今日为 `'claude'`）、`model`、`purpose`（`'conversation'`、`'compaction'` 或 `'session-title'`）、`systemBlocks`（发出的 system 文本，每个 block 一项，按 wire 顺序）、`systemDigest`（`JSON.stringify(systemBlocks)` 的 `sha256`）、`wireLibrary` 与 `profile`。

记录自身的日志 `seq` 就是它的标识；没有单独的 id，也没有 step 内的序号。对每次到达 recorder 的尝试都各有一条记录，因此重试的请求产生的记录多于被应答的请求；二者不是一对一配对的。

`systemBlocks` 只承载逐 block 文本。`cache_control` 标记与 block 之间的序列化空白无法从该事件还原，本包也不作此声明。

该事件不设 `ignorable` 标记，因此在读取时是必需类型：不认识该类型的 build 会拒绝整份日志，而不是跳过这条记录。写入方因此必须在「已声明该类型的 build 正在运行」之后才发布，部署顺序不是可选项。

### 保密等级

被记录的文本就是调用方自己的 system prompt，其中可能包含部署自行配置的秘密。因此该事件与 `system/message` 同级：完全按 session 日志的方式读取。本包既不剥离也不声称剥离任何内容，也没有任何字段被描述为「无秘密」。用户 prompt 正文、access token、账号标识与邮箱地址根本不在词汇表内。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Service Definition（`LlmRequestRecordService`）、session 日志 Provider（`SessionRequestRecordProvider`，默认导出）、必填 `Config`，以及有界的持久化等待 |
| [`src/types.ts`](src/types.ts) | 事件 payload、调用方 payload、context、失败码联合，以及 `SessionEventMap` 合并 |
| [`src/record-data.ts`](src/record-data.ts) | 纯函数：把一个 payload 补全为记录、对记录的文本取摘要、按 `preparedId` 或最近一条投影出某次记录的 system 文本 |
| [`tests/record.spec.ts`](tests/record.spec.ts) | 真实 `SessionStore` 上的 Provider 行为：append 身份、每次尝试一条记录、false/被拒/迟到的持久化结果、不 settle 监听器的有界 drain、卸载时关闭接纳 |
| [`tests/recorded-composition.spec.ts`](tests/recorded-composition.spec.ts) | 私有持久化监听器把已接受事件写成 JSONL；读取方随后从磁盘字节中选中某一次尝试 |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | Loader 从测试专用 `cordis.yml` 挂载本包（模块解析由本测试注入的 importer 提供），并应用其必填上限 |
| — | 不发布运行时 invariant 伴随件；本包除自身服务执行的 append-and-flush 契约之外，不暴露独立的 event 序列或可变关系。 |

### 为什么一个包同时承担两个角色

Definition 与其 Provider 由同一能力拥有并一起演进：调用方契约恰好就是 Provider 执行的 append-and-flush 序列，拆成第二个包只会多出一份该词汇表的副本。消费者依赖抽象服务，因此第二个 Provider（另一种传输、另一套持久化规则）可以替换本实现而不触碰调用方。

### 持久化语义

`recordPreparedRequest` 通过 live `SessionStore` 追加，然后等待该 session 的 `SessionStore.flush(session)`。追加先在内存中提交，因此失败或迟到的 flush 仍然把记录留在日志中的 `seq` 处；改变的只是结果。等待由 `flushTimeoutMs` 界定，而期限只界定等待——Provider 从不取消监听器的写入，因此缓慢或卡住的持久化监听器保留自己的磁盘写入，调用方只得知该记录尚未持久。

Provider 启动的每次 flush 都归它所有，直到 settle。卸载时先停止接纳，然后最多再等一个配置期限来等待未完成的 flush，因此卸载既不会卡在停滞的文件系统上，也不会在它启动的 flush 仍被等待时返回。

### 消费者契约

消费者通过作用域依赖（`ctx.inject(['llmRequestRecord'], …)`）或 `ctx.get` 取得服务，绝不自行追加记录。在没有 recorder 的组合中注册一条会发送模型请求的路由属于组合错误：无法发布自己所发内容的路由不得发送。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Session 子系统](../../../docs/subsystems/session.zh.md) —— 事件日志、其读取方，以及本服务使用的持久化检查点。
- [持久化目录](../../../docs/persistence-catalog.zh.md) —— 每个 session 事件的生成式参考，含 `llm/request-record`。
- [`@deepseek-ai/dsh-session`](../../core/session/README.zh.md) —— `SessionStore`、`flush`，以及 live session 要求。
- [`dsh-plugin-subscriptions`](../../../fork-plugins/dsh-plugin-subscriptions/README.zh.md) —— 消费本能力缝的 Claude Messages 路由。

-----

<a id="model-experience"></a>
## 模型体验

无，因为这些记录仅进日志：它们从不被投影进模型请求，也不改变模型读取的任何 prompt、工具 schema 或结果。

#### KV Cache 影响

不会直接失效；记录只追加到 session 日志，从不进入请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是本包当前的约束，界定了消费者今日可以依赖的范围。

- **只有一个 producer 判别式** —— `provider` 是封闭字面量联合，今日唯一成员是 `'claude'`。第二个 producer 会增加一个成员及其自有的带版本 payload；它不能把本包的字段复用于另一种 wire 形状。
- **读取方是投影，不是展示面** —— `reconstructRequestSystem` 按 `preparedId` 从事件数组中选中某一次尝试的 system 文本，省略 id 时取最近一条。把这些记录展示在 Session 浏览器、CLI 或导出中由相应消费者拥有，目前尚不存在，因此记录除此之外只能通过原始日志看到。
- **旧 build 无法跳过这条记录** —— 该事件不设 `ignorable`，不认识 `llm/request-record` 的 build 会拒绝整份日志，而不是丢弃该记录。写路径必须在「已声明该类型的 build」及其重启之后才发布；见本事件的持久化 ack 记录。
- **`systemBlocks` 不是 wire 正文** —— 需要精确请求字节的消费者必须单独记录；本事件有意排除 `cache_control` 标记与 block 之间的空白。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放方向，明确非权威。

#### 未来：按 session 合并 flush

同一 session 在同一请求内的两条记录目前会等待两次 `flush`。如果部署显示出该开销，Provider 可以把一个同步区间内追加的记录合并到一次 flush 上，同时保持每次尝试一条记录。

</details>
