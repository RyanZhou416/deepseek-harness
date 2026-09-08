# Agent Note: 响应 steering 的 Agent Team 工作

Status: implemented

[English](2026-08-30-steer-responsive-agent-team-work.md) | 中文

## Problem

可继续子级接受 FIFO 后续消息与 next-step steering，但 Agent Teams 会把每条父到子消息按持久 peer mailbox 请求的 quiet 或 wakeup 模式发送。Lead 指令因此可能排在普通子级轮次之后，而不能进入最近的模型边界。

后台命令本身不能让 teammate 保持可响应。模型可以让 `job_output(wait: true)` 把当前 step 保持到任务结算或配置的超时结束，因此即使命令已经有独立 job owner，next-step 输入仍然只能等待。

任意工具调用都不能被安全遗弃。工具可能拥有外部副作用或没有后台 owner 的未结算结果；在工具结果存在前启动另一个模型请求，也会在会话历史中留下没有配对结果的工具调用。

## Decision

Alpha.2 将 `SubagentRuntime.sendMessage(sender, target, content, options)` 作为公开的相邻 Agent 操作。它负责 live-lineage 授权、per-child 串行、冷恢复、Activation 所有权与 inbox 接受前取消，并在最近 step 边界 steer 运行中的子级。Fork 不恢复原有公开 `steer()` 或 `followup()` 方法；Team 投递使用官方 symbol-keyed Host queue 与 Steer adapter，使协议 provenance 进入同一 continuation 机制。

Agent Teams 通过 Host Steer 把 Lead 指令投递给 live teammate，并通过 Host Queue 唤醒 inactive teammate。两种 adapter 都保留持久 Team message source，而不是冒充 Agent sender。teammate 发起的 peer 消息保留 [Agent Teams 决策](2026-08-05-agent-teams.zh.md)中的持久 quiet 与 next-turn 模式；后续 wakeup 会在自身之前准入更早的 quiet mail。Team service 根据确切 membership 与 sender identity 推导该策略；提示词和工具参数不负责强制执行。

全局面向模型的 `send_message` control 使用 alpha.2 的公开 `sendMessage()`，因此 Agent Teams 之外的普通 coordinator-to-child 指令同样使用最近 step 行为。host-user 与浏览器 prompt 路径保留 FIFO 投递；Host-only Team adapter 不会重新分类人类输入。

Alpha.2 通过按 Session 寻址的 `session.updateQueue` Remote 路由 Queue Dock 的编辑、移除与 Steer action。它只修改一个 pending occurrence，编辑会保留身份与 source，移除会持久记录，并以 Session domain failure 报告 stale occurrence 或不可用 Steer。Continuable child 与普通 Session 使用同一操作；fork 不再携带独立 subagent Queue Remote 或错误词汇。

Bash 与 PowerShell 工具 consumer 接受默认值为 `false` 的 `forceRunInBackground`。启用后，consumer 隐藏 `run_in_background`，等待 `ctx.jobs` 后再注册，并把每条命令作为 owner-scoped job 启动后返回 id。进程由 job runtime 持有，直到完成、取消、owner dispose 或 service dispose。

`dsh-tool-jobs` 接受默认值为 `false` 的 `yieldWaitOnNextStep`。启用后，阻塞的 `job_output` 调用会观察所属 agent 的持久 next-step inbox。已有或新插入的 next-step 输入只会中止 registry wait，随后 `job_output` 读取并返回当前输出与任务状态。任务保持在线，普通 next-turn FIFO 输入不会结束等待。

私有 Agent Teams profile 会启用强制 Bash 与 PowerShell job，以及响应 steering 的 job wait。其他 profile 保留已有 schema 与等待行为，除非显式选择加入。

## Alternatives considered

**取消每个运行中的子级轮次。** 拒绝，因为 steering 已经提供所需的安全边界插入，而取消可能遗弃已领取工作与部分完成的外部副作用。

**让每个工具 Promise 与 steering 竞争。** 拒绝，因为只有对独立 owner 工作的被动等待才能在不遗弃底层操作的情况下释放。未来通用的让出操作仍要求工具生产方显式选择加入。

**依靠指令选择后台模式或非阻塞读取。** 拒绝，因为模型遵从不能保证可响应性。profile 与 service 负责调度决策。

**在每个 profile 中启用新行为。** 拒绝，因为强制后台 schema 与提前结束等待都是可观察的兼容性变更。通用选项保留 false 默认值，实验性 Team profile 负责选择加入。

## Testing

Subagent 与 Session Controller 测试区分 next-step steering 与 FIFO follow-up，并覆盖 Queue 编辑、移除、stale occurrence 收敛、授权、冷恢复、dispose 与一次性行为。Team mailbox 测试覆盖 live Lead steering、inactive-child wakeup、teammate quiet/FIFO 投递、target-local 串行、持久化恢复、中断与 pending 限额。Job 测试证明 next-step 让出保持任务运行、next-turn 消息不会让出且默认行为不变。Bash、PowerShell 与 profile 测试证明强制 job 会移除模型参数、返回真实 job id、呈现后台结果，并在 loader 并发激活时安全等待 jobs 能力。

## Consequences

Lead 指令仍需等待子级当前模型请求或工具调用完成；steering 不会取消 step。强制后台执行阻止 shell 工作占有该 step，响应 steering 的 `job_output` 则阻止后续被动 job wait 在 next-step 输入到达后继续延长它。

同一 step 中接受的多条 Lead 指令仍是有序 next-step 消息，并一起进入下一次请求。该设计消除后续轮次的队头阻塞，而不会静默替换持久指令。

通用后台与等待选项在 false 默认值下不增加任何行为或 schema 变更。Alpha.2 拥有全局 `send_message` 工具与 `session.updateQueue`；本 fork 不增加与其竞争的通用消息 API。私有 Team profile 会让 shell 调用返回 job id，并允许 `job_output(wait: true)` 在 next-step 输入待处理时于超时前返回 `[status: running]`。
