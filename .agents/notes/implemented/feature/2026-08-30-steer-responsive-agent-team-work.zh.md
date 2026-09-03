# Agent Note: 响应 steering 的 Agent Team 工作

Status: implemented

[English](2026-08-30-steer-responsive-agent-team-work.md) | 中文

## Problem

可继续子级接受 FIFO 后续消息与 next-step steering，但 Agent Teams 会把每条父到子消息按持久 peer mailbox 请求的 quiet 或 wakeup 模式发送。Lead 指令因此可能排在普通子级轮次之后，而不能进入最近的模型边界。

后台命令本身不能让 teammate 保持可响应。模型可以让 `job_output(wait: true)` 把当前 step 保持到任务结算或配置的超时结束，因此即使命令已经有独立 job owner，next-step 输入仍然只能等待。

任意工具调用都不能被安全遗弃。工具可能拥有外部副作用或没有后台 owner 的未结算结果；在工具结果存在前启动另一个模型请求，也会在会话历史中留下没有配对结果的工具调用。

## Decision

RC.1 将 `SubagentRuntime.sendMessage(sender, target, content, options)` 作为公开的相邻 Agent 操作。它负责 live-lineage 授权、per-child 串行、冷恢复、Activation 所有权与 inbox 接受前取消，并在最近 step 边界 steer 运行中的子级。Fork 不恢复原有公开 `steer()` 或 `followup()` 方法，只增加一个 symbol-keyed Host-only adapter，在复用同一 continuation 投递机制时保留协议 provenance。

无论模型请求 quiet 还是 wakeup 模式，Agent Teams 都会通过 Host-only Subagent steering adapter 投递每条 Lead-to-teammate mailbox 消息。该 adapter 保留持久 Team message source，而不是冒充 Agent sender。teammate 发起的 peer 消息保留 [Agent Teams 决策](2026-08-05-agent-teams.zh.md)中的持久 quiet 与 next-turn 模式。Team service 根据确切 membership 与 sender identity 推导该策略；提示词和工具参数不负责强制执行。

全局面向模型的 `send_message` control 使用 RC.1 的公开 `sendMessage()`，因此 Agent Teams 之外的普通 coordinator-to-child 指令同样使用最近 step 行为。host-user 与浏览器 prompt 路径保留 FIFO 投递；Host-only Team adapter 不会重新分类人类输入。

浏览器 Queue Dock 会在 live 可继续子级对话里公开排队消息的编辑、移除与 steering action。Client 通过专用 `subagents/updateQueuedByParent` Remote 路由这些操作；Remote 会授权持久直接父级地址，并且只修改选中的 pending next-turn occurrence。编辑保留身份与 source，移除会持久取消该 occurrence，steering 还要求子级正在运行，随后把消息移入 next-step 输入。Remote 使用 `subagent/queue-item-not-found` 报告过期 occurrence，使用 `subagent/delivery-unavailable` 报告不可用的编辑或移除，并使用 `subagent/steer-unavailable` 报告不可用的 steering。

Bash 与 PowerShell 工具 consumer 接受默认值为 `false` 的 `forceRunInBackground`。启用后，consumer 隐藏 `run_in_background`，等待 `ctx.jobs` 后再注册，并把每条命令作为 owner-scoped job 启动后返回 id。进程由 job runtime 持有，直到完成、取消、owner dispose 或 service dispose。

`dsh-tool-jobs` 接受默认值为 `false` 的 `yieldWaitOnNextStep`。启用后，阻塞的 `job_output` 调用会观察所属 agent 的持久 next-step inbox。已有或新插入的 next-step 输入只会中止 registry wait，随后 `job_output` 读取并返回当前输出与任务状态。任务保持在线，普通 next-turn FIFO 输入不会结束等待。

私有 Agent Teams profile 会启用强制 Bash 与 PowerShell job，以及响应 steering 的 job wait。其他 profile 保留已有 schema 与等待行为，除非显式选择加入。

## Alternatives considered

**取消每个运行中的子级轮次。** 拒绝，因为 steering 已经提供所需的安全边界插入，而取消可能遗弃已领取工作与部分完成的外部副作用。

**让每个工具 Promise 与 steering 竞争。** 拒绝，因为只有对独立 owner 工作的被动等待才能在不遗弃底层操作的情况下释放。未来通用的让出操作仍要求工具生产方显式选择加入。

**依靠指令选择后台模式或非阻塞读取。** 拒绝，因为模型遵从不能保证可响应性。profile 与 service 负责调度决策。

**在每个 profile 中启用新行为。** 拒绝，因为强制后台 schema 与提前结束等待都是可观察的兼容性变更。通用选项保留 false 默认值，实验性 Team profile 负责选择加入。

## Testing

Subagent 测试区分运行中 Activation 的 next-step steering 与 FIFO follow-up，并保留既有授权、冷恢复、dispose 与一次性行为。Queue Dock 与 Client 测试覆盖可继续子级的编辑、移除、steering、一次性只读状态、持久地址路由与过期 occurrence 收敛。Team mailbox 测试覆盖 Lead steering、teammate quiet/FIFO 投递、target-local 串行、持久化恢复、中断与 pending 限额。Job 测试证明 next-step 让出保持任务运行、next-turn 消息不会让出且默认行为不变。Bash、PowerShell 与 profile 测试证明强制 job 会移除模型参数、返回真实 job id、呈现后台结果，并在 loader 并发激活时安全等待 jobs 能力。

## Consequences

Lead 指令仍需等待子级当前模型请求或工具调用完成；steering 不会取消 step。强制后台执行阻止 shell 工作占有该 step，响应 steering 的 `job_output` 则阻止后续被动 job wait 在 next-step 输入到达后继续延长它。

同一 step 中接受的多条 Lead 指令仍是有序 next-step 消息，并一起进入下一次请求。该设计消除后续轮次的队头阻塞，而不会静默替换持久指令。

通用后台与等待选项在 false 默认值下不增加任何行为或 schema 变更。RC.1 负责全局 `send_message` 工具的最近 step 行为；本 fork 不增加与其竞争的通用消息 API。私有 Team profile 会让 shell 调用返回 job id，并允许 `job_output(wait: true)` 在 next-step 输入待处理时于超时前返回 `[status: running]`。
