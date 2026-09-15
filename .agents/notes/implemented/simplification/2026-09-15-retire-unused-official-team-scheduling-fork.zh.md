# Agent Note: 退役未使用的官方 Team 调度 fork

Status: implemented

[English](2026-09-15-retire-unused-official-team-scheduling-fork.md) | 中文

## 问题

本 fork 曾为 Bash 与 PowerShell 增加 `forceRunInBackground`，为 `tool-jobs` 增加 `yieldWaitOnNextStep`，并修改 DSH 实验性 Agent Teams mailbox delivery。它们唯一的生产 Consumer 是实验性 Team profile，而实际 Web profile 使用外置 `@nanmicoder/dsh-agent-teams`。为一个未挂载 profile 继续维护公共配置、测试、文档和生成目录，会增加每次上游合并的成本，却不改变实际部署产品。

## 决策

DSH 实验性 Agent Teams、其 profile、Bash、PowerShell 与 `tool-jobs` 保持 `dsh-v0.1.6-alpha.1` 的精确上游实现。Fork 不暴露 `forceRunInBackground` 或 `yieldWaitOnNextStep`，也不修改官方 Team mailbox。

外置 AgentTeams v0.1.18 拥有成员 next-step delivery、inactive Queue delivery、退休清理和 task-attempt 调度。私有插件层只保留 DSH 0.1.6 awaited-creation 兼容、冷 Captain mailbox 恢复、有界未读 mailbox projection 和 Windows directory rename 预算。通用后台任务完成唤醒与 Windows 子进程控制台隔离仍是独立 fork 行为，因为实际 profile 会使用它们。

## 备选方案

**保留默认关闭的选项。** 拒绝，因为 false 默认值不会消除公共 API、生成目录、测试或合并冲突，而且没有已部署组合会使用这些选项。

**在外置插件旁启用官方 Team profile。** 拒绝，因为两种实现使用不同的工具、状态目录、UI 和生命周期策略；同时挂载只会重复协调能力，不能替换外置插件。

**删除全部 Team 相关 fork 行为。** 拒绝，因为冷 Captain 恢复和有界未读 mailbox 读取仍有外置插件的生产 Consumer，v0.1.18 并未提供它们。

## 影响

官方实验性 Team profile 与上游 DSH 完全一致，不再强制 shell 调用进入 job，也不会因 next-step 输入提前结束阻塞的 job read。实际部署的外置 AgentTeams 保留关键行为：成员协调仍在 next-step 响应，durable Captain mail 可以冷恢复，mailbox polling 保持有界。后续 DSH 合并不再为这个已放弃的 profile 修改官方 Team、Bash、PowerShell 或 job-wait 代码。
