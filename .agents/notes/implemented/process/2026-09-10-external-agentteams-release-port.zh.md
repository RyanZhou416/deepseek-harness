# Agent Note: 精确移植外置 AgentTeams 发布版本

Status: implemented

[English](2026-09-10-external-agentteams-release-port.md) | 中文

## 问题

外置 AgentTeams 插件若不由最后一个持有者删除已结束的队列项，就会为每个团队锁 key 保留一条 Promise chain。长期运行且创建许多团队的 profile 会因此在团队结束后继续累积进程内存。该插件还使用预稳定的 DSH Agent setup、Session 读取、Host 投递、Web client 和 profile 组合 API，因此直接安装上游 npm candidate 可能丢失 fork 行为或混用不兼容的 DSH 包。

本 fork 还依赖最近 step 成员投递、冷 Captain 邮箱恢复、退休成员投递拒绝、有界未读邮箱投影、fallback 持久化和 parked-attempt 恢复。整体替换上游源码无法区分这些部署保证与已过时的兼容代码。

## 决策

本 fork 在 [`fork-plugins/dsh-agent-teams`](../../../../fork-plugins/dsh-agent-teams) 中引入精确的外置 tag `v0.1.16-rc.3`，并且只为 DSH `0.1.5-rc.1` 分发私有产物 `0.1.16-dsh015rc1.1`。manifest、peer 声明、开发依赖、pnpm overrides、lockfile、兼容策略、setup 脚本和仓库内 SHA-256 全部指向这一精确组合。

运行时保留上游 `withTeamLock()` 的末尾队列项删除逻辑及其串行交接测试。DSH 0.1.5 RC.1 适配会把未发布 Agent 显式传入成员 setup，通过 `ownEvents()` 读取当前 Session 事件，使用统一 Host Queue/Steer adapter，并保留 [`FORK_MAINTENANCE.md`](../../../../FORK_MAINTENANCE.md#local-agentteams-package) 列出的全部 fork 投递、恢复、退休和缓存行为。

Profile 安装使用仓库内产物，不使用 npm `latest` 或 `next`。安装只更换可执行插件代码；工作区 `.agent-teams` 记录、Session、附件和凭据均不修改。新代码必须在 profile 重启后才会生效。

## 备选方案

**直接安装上游 `v0.1.16-rc.3`。** 拒绝，因为其发布兼容矩阵不包含 DSH `0.1.5-alpha.2`，且该包不包含本 fork 的 Host 投递、冷 Captain、退休成员和缓存保证。

**只把锁删除补丁应用到现有插件源码。** 拒绝，因为精确的上游 candidate 还管理稳定的 Captain/成员 capability 展示、Web 批准唤醒和已有团队复用指引。保留局部复制会增加后续源码比较和回归归因的难度。

**用 DSH 实验性 Agent Teams 替换外置插件。** 拒绝，因为两种实现具有不同的工具、持久状态、Web 展示和操作行为。官方实验包不会迁移或保留外置插件的团队。

## 影响

已结束的团队锁 key 不再在进程中累积，同时等待中的后继调用仍保持串行。私有产物会保留 fork 现有的持久数据和定制投递行为，也可通过重新安装上一份仓库内产物回滚。

以后的 AgentTeams 或 DSH 发布都需要重新执行精确源码导入、完整依赖固定、聚焦 API 移植、完整插件验证、package identity 与摘要检查以及真实 profile 启动。仅通过上游测试或 npm 安装不足以证明兼容。
