---
kind: upgrade-guide
description: "当任务所有权可用时，AetherShell 查询等待超时会交出同一次运行的后台任务，而非终止执行。"
---

# AetherShell 前台等待交接给原任务

[English](guide.md) | 中文

## 变更

可选 AetherShell 适配器改变了 `aether_call`、`aether_pipeline` 和 `aether_eval` 的 `timeoutMs` 语义：当启用 `promoteOnTimeout`，且调用具有有效 Agent 和可用任务注册表时，它表示前台等待预算，而非到期杀停执行的期限。每项被接纳的操作都在启动前登记。等待到期返回 `kind: "promoted"` 及原 `jobId`，不会终止或重复操作；到期前完成的调用仍返回原有结果。

`executionTimeoutMs` 是独立的执行硬期限。省略时由 `maxBackgroundRuntimeMs` 提供部署上限，零表示外层运行时长不设上限。原生内部限制仍适用，包括 `proc_run` 的 `timeout_ms`。显式取消会停止并等待所属执行清理。发现、持久会话和原始流式 `aether_job_start` 保留既有期限及返回格式。缺少任务所有权、关闭交接，或启动前接纳被拒绝时，查询仍受前台杀停期限限制。

## 迁移

1. 使用配套 Host 构建升级可选适配器软件包，再重启 DSH 加载新 JavaScript 模块版本。替换安装软件包不会在正在运行的 Host 中激活它。
2. 需要旧有杀停期限的调用方必须提供 `executionTimeoutMs`，或在 profile 的 `aether-shell` 配置中设置 `promoteOnTimeout: false`。`timeoutMs` 保留为前台等待时长。
3. 收到 `kind: "promoted"` 后，用 `job_output` 收集返回的 `jobId`；结算结果以 JSON 包含规范 AetherShell 结果。用 `job_kill` 停止任务。不能仅因前台等待结束就重新提交原命令。
4. 确认慢操作返回任务 id、`job_output` 给出最终结果，且外部效果只发生一次。较大的最终值可能改为给出 `aether_result_page` 取回 id。任务和保留结果都不跨 Host 重启或 owner 释放存活。
