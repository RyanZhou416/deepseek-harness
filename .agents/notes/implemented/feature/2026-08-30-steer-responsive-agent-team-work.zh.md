# Agent Note: 响应 steering 的 Agent Team 工作

Status: implemented

[English](2026-08-30-steer-responsive-agent-team-work.md) | 中文

## Problem

可继续子级接受 FIFO 后续消息与 next-step steering，但 Agent Teams 会把每条父到子消息按持久 peer mailbox 请求的 quiet 或 wakeup 模式发送。Lead 指令因此可能排在普通子级轮次之后，而不能进入最近的模型边界。

后台命令本身不能让 teammate 保持可响应。模型可以让 `job_output(wait: true)` 把当前 step 保持到任务结算或配置的超时结束，因此即使命令已经有独立 job owner，next-step 输入仍然只能等待。

任意工具调用都不能被安全遗弃。工具可能拥有外部副作用或没有后台 owner 的未结算结果；在工具结果存在前启动另一个模型请求，也会在会话历史中留下没有配对结果的工具调用。

## Decision

Alpha.2 将 `SubagentRuntime.sendMessage(sender, target, content, options)` 作为公开的相邻 Agent 操作。它负责 live-lineage 授权、per-child 串行、冷恢复、Activation 所有权与 inbox 接受前取消，并在最近 step 边界 steer 运行中的子级。Fork 不恢复原有公开 `steer()` 或 `followup()` 方法；Team 投递使用官方 symbol-keyed Host queue 与 Steer adapter，使 Team message source 进入同一 continuation 机制。

Agent Teams 通过 Host Steer 把 Lead 指令投递给 live teammate，并通过 Host Queue 唤醒 inactive teammate。两种 adapter 都保留持久 Team message source，而不是冒充 Agent sender。teammate 发起的 peer 消息保留 [Agent Teams 决策](2026-08-05-agent-teams.zh.md)中的持久 quiet 与 next-turn 模式；后续 wakeup 会在自身之前准入更早的 quiet mail。Team service 根据确切 membership 与 sender identity 推导该策略；提示词和工具参数不负责强制执行。

仓内维护的 `@nanmicoder/dsh-agent-teams` 构建通过 `harness-compat` adapter 识别测试覆盖的精确 Harness contract 中的 lifecycle setup、FIFO Queue、统一 Queue/Steer 和公开相邻 Agent 消息操作。其发行兼容策略只接受 `dsh-v0.1.6-alpha.2`；legacy adapter 只作为回归 fixture，不构成 package 兼容声明。退休成员守卫包装运行宿主实际提供的全部操作，并在所属 Cordis scope 结束时恢复原生 property descriptor。

全局面向模型的 `send_message` control 使用 alpha.2 的公开 `sendMessage()`，因此 Agent Teams 之外的普通 coordinator-to-child 指令同样使用最近 step 行为。host-user 与浏览器 prompt 路径保留 FIFO 投递；Host-only Team adapter 不会重新分类人类输入。

Alpha.2 通过按 Session 寻址的 `session.updateQueue` Remote 路由 Queue Dock 的编辑、移除与 Steer action。它只修改一个 pending occurrence，编辑会保留身份与 source，移除会持久记录，并以 Session domain failure 报告 stale occurrence 或不可用 Steer。Continuable child 与普通 Session 使用同一操作；fork 不再携带独立 subagent Queue Remote 或错误词汇。

外置 AgentTeams v0.1.19 通过 Host Queue/Steer adapter 拥有成员 next-step 投递。官方实验性 Team profile 与通用 shell/job 工具保持 DSH 0.1.6 上游实现；原有强制后台与让步等待 fork 已由[退役未使用的官方 Team 调度补丁](../simplification/2026-09-15-retire-unused-official-team-scheduling-fork.zh.md)取代。

## Alternatives considered

**取消每个运行中的子级轮次。** 拒绝，因为 steering 已经提供所需的安全边界插入，而取消可能遗弃已领取工作与部分完成的外部副作用。

**让每个工具 Promise 与 steering 竞争。** 拒绝，因为只有对独立 owner 工作的被动等待才能在不遗弃底层操作的情况下释放。未来通用的让出操作仍要求工具生产方显式选择加入。


## Testing

Subagent 与 Session Controller 测试区分 next-step steering 与 FIFO follow-up，并覆盖 Queue 编辑、移除、stale occurrence 收敛、授权、冷恢复、dispose 与一次性行为。仓内插件测试覆盖 awaited lifecycle setup、live Steer 与 inactive Queue 路由、退休成员拒绝、冷 Captain 邮箱重投递和依赖组检查。Team mailbox 测试覆盖 target-local 串行、持久化恢复、中断与 pending 限额。

## Consequences

Lead 指令仍需等待子级当前模型请求或工具调用完成；steering 不会取消 step。

同一 step 中接受的多条 Lead 指令仍是有序 next-step 消息，并一起进入下一次请求。该设计消除后续轮次的队头阻塞，而不会静默替换持久指令。

DSH 拥有全局 `send_message` 工具与 `session.updateQueue`；本 fork 不增加与其竞争的通用消息 API，也不保留未使用的官方 Team 调度选项。
