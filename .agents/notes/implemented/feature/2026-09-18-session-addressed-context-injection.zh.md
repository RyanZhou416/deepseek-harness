# Agent Note: 按 Session 寻址的 Agent 消息使用带来源的上下文注入

Status: implemented

[English](2026-09-18-session-addressed-context-injection.md) | 中文

## 问题

DSH 提供三种更窄的跨 Session 机制：直接可继续 parent/child 消息、Team mailbox 和只读 Session reference。知道另一 Session id 的普通 Agent 无法在不创建这些关系的情况下向它交付新信息。Host `session.prompt` 接受任意 Session id，也能恢复冷工作，但它把输入记录为人类用户提示词，且不携带发送 Session 身份。把该 Remote 方法直接暴露为模型工具，会让 Agent 编写的内容在持久历史中无法与用户权限区分。

目标部署允许跨工作区、lineage 与 Session 角色边界发送消息，包括向自身发送。runtime 目标策略、审批、频率限制和 relay depth 限制因此会违背预期能力。接收方仍需要持久发送者身份，以及一条指导：仅仅收到消息并不授权自动回复、确认、转发或轮询交换。

## 决策

Web bundle 的 `standard`、`ptc` 与 `cordis` Agent preset 会在各自 Agent 工具作用域内挂载 `@deepseek-ai/dsh-tool-session-message`；Host 全局工具层与 `minimal` preset 保持不变。该包注册发现、发送与状态工具。`session_find({ query })` 委托给现有 Session-reference candidate 目录，因此标题、id 与工作区匹配会复用浏览器 `@` 选择器的投影标签与同工作区排序，而不激活候选项。它要求非空子串、排除自身，并把结果与 Session-query header 元数据联结，移除包括 AgentTeams teammate 在内、持久标记为 `origin: subagent` 的每个 Session。普通用户创建的 fork 仍保留在结果中，因为只有 parent lineage 并不代表委派。工具把标签视为不可信数据，并告诉模型把歧义匹配交给用户选择。

`session_send_message({ session_id, message })` 只从确切在线的 `exec.agent` 取得发送方；模型输入不能提供或覆盖 `senderSessionId`。它接受 `ctx.agents` 中任何确切在线目标，不考虑工作区、lineage、origin 或是否等于发送方。不存在在线目标时，它委托给 `ctx.sessionController.resolveAgent()`，使普通持久 Session 在 Controller 现有单写入者与驻留所有权下冷恢复。

目标通过启用唤醒的一条带来源消息收到 next-step inbox 输入。Agent loop 的持久 inbox splice 会在目标领取前记录接受。运行中的目标会在后续 step 边界准入上下文；空闲目标会通过同一 next-step 路径启动轮次并领取它。这绕过普通 next-turn 用户队列，同时保留 peer-message 来源。插入成功后，工具结果返回消息、发送方与目标 id；它不是已读回执或回复 future。

同一个包还注册 `session_message_status({ session_id, message_id })`。它在不激活目标的情况下检查完整已校验目标日志，并重放持久 inbox 坐标，以区分待处理注入上下文、旧版排队轮次、纯领取、模型历史准入、轮次完成、pre-step 拒绝、持久取消与未知目标／消息对。它还折叠未被 `tool/result` 结算的顶层 `tool/call` 集合，以及未被 `tool/ptc-dispatch` 结算的嵌套 `tool/ptc-dispatch-start` 集合。原生或嵌套的未结算 `terminal_send` 报告 terminal blocking；其他调用报告 tool blocking；没有未结算调用的运行中目标报告 model blocking。结果是时间点观察，而不是订阅或自动唤醒发送方。

每条消息复用现有 `agent-message` relay 来源：

```ts
import type { SessionId } from '@deepseek-ai/dsh-session'

interface AgentMessageSource {
  readonly kind: 'agent-message'
  readonly form: 'relay'
  readonly senderSessionId: SessionId
}
```

第一个内容块标识经 JSON 编码的发送方 id，并把输入框定为不可信 peer context。它告诉接收方：不要仅仅因为消息抵达就回复、确认、转发或发送另一条 Session 消息；只有在它对用户当前任务有实质帮助时才采取行动。工具描述向发送方提供配套规则：禁止确认、仅状态更新、轮询、自动回复、转发与对话流量。这些提示是唯一的消息风暴控制；runtime 不提供目标、频率、relay depth 或自身消息限制。

工具描述还会保留专用路由，但不在发送操作中通过代码强制。直接可继续 parent 或 child 使用 `send_message`；teammate 使用 AgentTeams 消息；`session_send_message` 只面向用户显式提供、由传入 Session 消息标识、由用户创建 Session reference 暴露，或由 `session_find` 为用户点名目标返回的无歧义独立 id。发现仍由用户驱动：模型不能请求空目录，委派 child 永不出现在结果中，并且模型必须展示歧义匹配而非静默选择。

### 技术可用性不是目标策略

无限制规则约束的是授权，而不是目标能否被正确物化。任何在线 Agent id 都可投递，包括在线 subagent。通用 Session Controller 恢复会刻意拒绝生命周期属于 subagent 子系统的冷 Session，因此冷 subagent 在其 parent 或 Team 路径激活前仍不可用。未知、损坏、并发不可用或已经不在线的身份会在收件箱接受前失败。

调用方取消会在目标解析前检查一次，并在插入前立即再检查一次。Session Controller 恢复是共享且去重的，并不归本次工具调用所有，因此冷激活期间取消可能使普通目标保持驻留，但会阻止消息插入。`send()` 接受消息后，调用方无法撤回它。唤醒会让目标启动自己的轮次；冷恢复的普通 Agent 可能在该轮次运行期间保持驻留，直到 Controller 停止。

## 验证

聚焦单元覆盖发现时排除委派 child、无限制在线投递、自身寻址、确切发送者来源、冷普通 Session 解析、校验、取消、陈旧发送方拒绝、HMR 清理、每种持久状态阶段、并发工具投影与 terminal blocking。生产 Agent-loop fixture 验证投递会通过 next-step 通道唤醒空闲目标，并保持普通 next-turn inbox 为空。真实 Loader 组合验证 Cordis 条目注册模型工具并交付带来源内容。Web bundle 组合、生成工具目录、成对包文档与无密钥记录 Web schema 快照共同负责发行展示。

## 考虑过的替代方案

**扩宽 `SubagentRuntime.sendMessage()`。** 该操作拥有相邻授权、可继续 Activation 驻留和 Steer 语义。移除其关系检查会抹掉 parent/child 生命周期保证，并让无关 Session 通信依赖 subagent manager。按 Session 寻址的工具仍是 Agent 注册表与 Session Controller 之上的独立 Consumer。

**直接暴露 `session.prompt`。** 这只需少量代码即可复用冷恢复与 Queue/Steer 选择，但它会把 Agent 编写文本持久化为没有发送者来源的人类 user source。收件箱接受后，包装层无法修复该来源。

**添加独立 mailbox 文件与 queued/delivered 事件协议。** Sidecar mailbox 可以在不物化目标的情况下接受消息，但它会复制持久 Agent 收件箱、需要恢复与确认状态，并在 Session 日志之外引入另一种顺序来源。现有普通 Session 冷恢复和有界驻留使直接持久收件箱插入已经足够。

**应用工作区、lineage、自身目标、频率或 hop 限制。** 这些控制可以降低数据外泄与反馈循环风险，但违背本部署明确的无限制寻址需求。工具流水线仍允许后续部署自行挂载审批或拒绝策略；发行插件本身依赖提示词指导。

**另建标题索引。** Session-reference 发现已经为 Web `@` 选择器拥有投影标题回退、cwd 亲和排序、取消与候选上限。第二份索引会在冷标题上发生漂移，并重复其性能策略；模型工具改为委托给该所有者，只用 Session-query header 移除 child Session。

**使用 FIFO follow-up 或普通 inject 投递。** Follow-up 会把 peer 内容放入普通 next-turn 通道；普通 inject 会让空闲目标保持睡眠。启用唤醒的 next-step send 保留 peer 来源，绕过普通用户队列，并在目标空闲时启动它。

**把每次状态转换推送回发送方。** 自动通知会增加发送方上下文，并可能唤醒另一轮回复循环，而这正是本功能的提示框架要避免的失败。显式只读状态检查会报告当前持久证据，但不产生跨会话流量。

## 后果

- Web Agent 可以按确切 id 向无关在线 Agent 与冷普通 Session 注入带来源文本，而无需创建 subagent 或 Team 关系。
- 用户可以说出独立 Session 名称而无需复制 id；标题查找复用 Web reference 目录，在不激活候选项的情况下过滤委派 child，并让歧义保持可见。
- 来源归因持久且由服务端推导，但不会向收到的内容授予权限。
- 该机制刻意允许自身消息、跨工作区消息与无界消息图；忽略指导的模型可能创建昂贵循环。
- 冷 subagent 仍归其现有生命周期所有者，而在线 subagent 是无限制目标。
- 发送方可以在不唤醒目标的情况下检查持久处理进度与当前前台工具阻塞；`pending-context` 明确区分未领取上下文与普通用户队列，`model-context` 不被描述为人类理解。
- peer 消息会通过 next-step 投递唤醒空闲目标。冷恢复的普通 Agent 可能在目标轮次运行期间保持驻留，直到 Controller 停止。
- 该功能为每次 Web Agent 请求增加固定工具 schema 成本，并为每条目标消息增加带来源 peer framing 成本。
- 实现增加一个工具包和 Agent-preset 条目，但不改变 Agent Loop、Session 格式、SDK 协议、Host 全局工具层或相邻 Agent 消息服务。

本决策保留[相邻 Agent 共享一个 Steer send_message 操作](../architecture/2026-08-27-adjacent-agent-steer-messaging.zh.md)中的相邻保证，并为更广泛场景添加独立的按 Session 寻址上下文操作。
