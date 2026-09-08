# Agent Note: 全局 Web 连接恢复 overlay

Status: implemented

[English](2026-09-08-global-connection-overlay.md) | 中文

## Problem

Settings 控件会展示连接丢失与恢复，但侧边栏收起或 Settings 关闭后，该控件可能在浏览器仍断线时被隐藏。用户需要一项在整个 Web shell 中保持可见的恢复操作，同时 Client 不能获得重启 Host 的权限。

## Decision

`dsh-client-ui-settings-general` 在 `shell.overlay` 中注册 `ConnectionOverlay`。它读取官方 `ctx.connection.state`、调用 `ctx.connection.reconnect()`，并使用共享的本地化 `ConnectionIndicator`；健康启动不渲染内容，disconnected 与 connecting 状态保持可操作，recovered 状态保留两秒。

Overlay 独立于侧边栏与 Settings modal。它只控制浏览器的 Gateway 连接，绝不启动、监督或静默重启 Host。

## Alternatives considered

**只在 Settings 旁保留恢复操作。** 拒绝，因为侧边栏收起后该控件会消失，但断线仍会阻塞整个应用。

**由 Client 自动重启 Host。** 拒绝，因为浏览器连接无法区分 Host 已停止、正在启动、维护、策略关闭或外部故障，并且不拥有进程权限。

**永久显示健康指示器。** 拒绝，因为连接从未中断时不需要操作；两秒 recovered 状态可以确认转换，而不会持续占用空闲界面。

## Consequences

每种 shell 布局都能看见并恢复连接丢失，并与 Settings 行内控件使用相同的本地化 label 与 retry 操作。Shell 增加一个 overlay 注册和一个恢复计时器，Host 恢复仍由 operator 显式执行。
