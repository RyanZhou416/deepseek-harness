# Agent Note: 精确移植外置 AgentTeams 发布版本

Status: implemented

[English](2026-09-10-external-agentteams-release-port.md) | 中文

## 问题

外置 AgentTeams 插件若不由最后一个持有者删除已结束的队列项，就会为每个团队锁 key 保留一条 Promise chain。长期运行且创建许多团队的 profile 会因此在团队结束后继续累积进程内存。该插件还使用预稳定的 DSH Agent setup、Session 读取、Host 投递、Web client 和 profile 组合 API，因此直接安装上游 npm candidate 可能丢失 fork 行为或混用不兼容的 DSH 包。

本 fork 还依赖冷 Captain 邮箱恢复和有界未读邮箱投影。上游 v0.1.18 已拥有最近 step 成员投递、退休成员清理、fallback 持久化、parked-attempt 恢复和 task-attempt 纠正，因此替换源码时必须把这些上游保证与更小的私有层分开。

## 决策

本 fork 在 [`fork-plugins/dsh-agent-teams`](../../../../fork-plugins/dsh-agent-teams) 中引入精确的外置 tag `v0.1.18`，并且只为 DSH `0.1.6-alpha.1` 分发私有产物 `0.1.18-dsh016alpha1.1`。manifest、peer 声明、开发依赖、pnpm overrides、lockfile、兼容策略、setup 脚本和仓库内 SHA-256 全部指向这一精确组合。

运行时保留 v0.1.18 的 scheduling、next-step delivery、retirement、task correction 和 `withTeamLock()` 末尾删除。DSH 0.1.6 适配通过 awaited `agent/created` 初始化成员，通过 `ownEvents()` 读取当前 Session 事件，使用统一 Host Queue/Steer adapter，冷恢复 inactive Captain 以投递 durable mailbox，并保留 [`FORK_MAINTENANCE.md`](../../../../FORK_MAINTENANCE.md#local-agentteams-package) 所列有界未读邮箱缓存。

Profile 安装使用仓库内产物，不使用 npm `latest` 或 `next`。安装只更换可执行插件代码；工作区 `.agent-teams` 记录、Session、附件和凭据均不修改。新代码必须在 profile 重启后才会生效。

导入的插件源码树按其自身维护政策逐字保留上游文档、发行证据与 skill。DSH 文档、术语与仓库引用门禁排除该外部源码树；双语配对的 [`fork-plugins/README.md`](../../../../fork-plugins/README.zh.md)、本 Agent Note 与 [`FORK_MAINTENANCE.md`](../../../../FORK_MAINTENANCE.md)负责 DSH 整合声明。

## 备选方案

**直接安装上游 `v0.1.18`。** 拒绝，因为其发布兼容矩阵止于 DSH `0.1.5-rc.1`，且该包不包含本 fork 的 awaited creation adapter、冷 Captain 投递或未读缓存保证。

**保留 v0.1.16 fork，只修 DSH 兼容。** 拒绝，因为 v0.1.18 拥有任务纠正、依赖就绪启动、陈旧消息过滤和更强的退休清理。保留旧 scheduler 会留下缺陷并扩大后续源码比较。

**用 DSH 实验性 Agent Teams 替换外置插件。** 拒绝，因为两种实现具有不同的工具、持久状态、Web 展示和操作行为。官方实验包不会迁移或保留外置插件的团队。

## 影响

已结束的团队锁 key 不再在进程中累积，同时等待中的后继调用仍保持串行。私有产物在使用当前 DSH 生命周期的同时保留现有 Team JSON 与 mailbox 数据。工作树只保留当前产物；旧 package bytes 仍可从 Git 历史恢复。

以后的 AgentTeams 或 DSH 发布都需要重新执行精确源码导入、完整依赖固定、聚焦 API 移植、完整插件验证、package identity 与摘要检查以及真实 profile 启动。仅通过上游测试或 npm 安装不足以证明兼容。

DSH 门禁仍校验全部由 DSH 维护的整合文档。每个导入插件的完整 lint 与验证套件负责校验其可执行源码；DSH 门禁不会重新解释上游历史证据或嵌套工具配置。
