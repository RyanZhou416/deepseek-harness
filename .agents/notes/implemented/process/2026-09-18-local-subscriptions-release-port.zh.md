# Agent Note: 精确移植本地 Subscriptions 发布版本

Status: implemented

[English](2026-09-18-local-subscriptions-release-port.md) | 中文

## 问题

`dsh-plugin-subscriptions` 使用预稳定的 DSH Agent 生命周期、凭据、provider 和 Web client API。直接把 registry tag 安装到实际 profile 可能会让插件与不同的 DSH 依赖组混用，而保留旧 profile package 则无法通过经过审查的路径获得当前 provider 修复与账户行为。

DSH Alpha.2 还内置了 Plugin Manager。继续并列保留 `dshmarket` 会让两个 package-management 界面共同管理同一个 profile，也会增加可重复验证本地插件安装的难度。

## 决策

本 fork 将上游 `dsh-plugin-subscriptions` 精确 tag `v0.9.2` 引入 [`fork-plugins/dsh-plugin-subscriptions`](../../../../fork-plugins/dsh-plugin-subscriptions/FORK_MAINTENANCE.md)，并且只为 DSH `0.1.6-alpha.2` 分发私有产物 `0.9.2-dsh016alpha2.1`。其 peer 声明、开发依赖、override、lockfile、package identity 和仓库内 SHA-256 全部指向这一精确组合。

私有适配保留上游 provider、账户、credential-store、请求转换和工具行为。它补充 Alpha.2 所需的 awaited `agent/created` 结果与 startup source 字段，并安装插件独立测试环境所需的 browser runtime 依赖。它不改变 Session event、Session format、凭据格式、provider wire 字段或工具结果。

`setup.command` 会在修改 profile 前校验 AgentTeams、Context 和 Subscriptions 产物。若已安装 `dshmarket`，setup 会通过 `dsh plugin` 移除它；最终 profile verifier 会拒绝 package section 或 `dsh.profile.bundles` 中残留的 `dshmarket`。安装只改变 profile package 与配置。凭据、Session、附件、provider 账户和工作区状态保持不变；应用 package 变更前必须停止正在运行的 Host。

## 备选方案

**直接安装上游 `latest`。** 拒绝，因为移动的 registry selector 无法固定已经审查的源码或 DSH 依赖组，也无法保留可重复的 rollback 产物。

**继续使用 Subscriptions v0.6.0。** 拒绝，因为这会使实际 profile 无法获得已经审查的上游 provider、failover、cache affinity、图片结果和遗留 tool-call 修复。

**在官方 Plugin Manager 旁继续保留 `dshmarket`。** 拒绝，因为重叠的 profile package manager 会增加配置与更新路径，却不保留 Alpha.2 缺失的能力。

## 影响

实际插件可以升级到上游 v0.9.2，而无需迁移凭据或 provider 数据。仓库只保留一份可审计的源码导入和一个固定产物；setup 后的 profile 只保留一条 package-management 路径。

以后每次升级 Subscriptions 或 DSH 都需要精确导入源码、完整适配 Alpha.2 或更新版本的依赖组、执行 package 构建与测试、检查产物 identity 和摘要，并在 profile 停止后安装。Rollback 只改变固定 package 与 bundle，不恢复或改写运行数据。
