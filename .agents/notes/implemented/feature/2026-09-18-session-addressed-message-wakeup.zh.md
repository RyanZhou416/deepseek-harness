# Agent Note: 按 Session 寻址的消息唤醒空闲目标

Status: implemented

[English](2026-09-18-session-addressed-message-wakeup.md) | 中文

## 问题

`session_send_message` 最初使用 `inject()`，而该方法刻意让空闲 Agent 保持睡眠。这对后台完成通知等被动上下文生产方是正确的，但显式 peer 消息会一直等待，除非之后有无关输入唤醒目标。消息传输必须保留直接的 next-step 投递、不使用普通 next-turn 用户队列，并且能到达空闲接收方。

## 决策

`session_send_message` 使用 `Agent.send(message, 'next-step', true)` 投递带来源消息。持久 inbox 事件仍是 `next-step` splice，发送者身份仍是 `agent-message`；`wakeup: true` 会在目标空闲时启动目标轮次，在目标运行时保留最近 step 语义。传输不会调用 `followup()`，也不会把 peer 内容放入普通 `next-turn` 队列。`session_message_status` 仍是只读操作，从不唤醒目标。

早期的上下文注入说明继续拥有发现、授权、归因、状态和消息风暴指导；其投递章节已改为记录启用唤醒的 next-step 行为。与被动 `inject()` 的区别仍是包级生命周期规则。

## 验证

工具包测试检查确切的 `send(message, 'next-step', true)` 调用。生产 Agent-loop fixture 观察空闲接收方的 `turn/start`，等待目标停稳，并验证 `next-turn` 为空且 next-step splice 已领取。Loader 组合和生成的工具 schema 继续覆盖发送者归因与直接展示。

## 备选方案

**继续使用被动 `inject()`。** 这保留安静的后台上下文，但会让空闲目标上的显式 peer 消息保持待处理，违背通信功能的投递预期。

**使用 `followup()`。** 它会唤醒目标，却把 peer 内容放入普通 next-turn 用户队列，赋予该功能明确不需要的用户提示词调度语义。

**通过第二条合成消息唤醒。** 独立 wake 事件会产生两条投递路径，增加排序与取消复杂度，并可能出现只唤醒而没有带来源上下文的情况。现有 `send()` wake 标志原子拥有插入和唤醒 latch。

## 结果

- 显式 Session 消息会唤醒空闲普通 Agent，同时仍通过 next-step inbox 到达。
- 运行中 Agent 会在下一个 step 边界接收消息；已经领取 batch 的 step 可能不会包含领取之后到达的消息。
- Peer 消息可以启动目标轮次，因此会消耗模型与工具资源；提示词仍禁止确认、转发和消息风暴。
- 必须保持被动的生产方继续直接使用 `inject()`。

本说明只取代[按 Session 寻址的 Agent 消息使用带来源上下文注入](2026-09-18-session-addressed-context-injection.zh.md)中的非唤醒投递选择。
