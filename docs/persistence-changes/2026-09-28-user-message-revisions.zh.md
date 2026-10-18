---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-28-user-message-revisions

[English](2026-09-28-user-message-revisions.md) | 中文

## 概述

以可选的替换目标与待处理草稿元数据记录同会话人工修改，并添加有界用户输入投影。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-28-user-message-revisions
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "ea1a81f67d4a0f20e95589b1d95fc879ea9e45d25b3fef040771e86a16254aea"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "c0c7977f3c84204e1d98cfa62430678b58df50994c9681a1c9e9fa2498c6ca3f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "0ce71693ef964c3edacbff894b35177282d2b54e7fcc5abd7b3457f6aee0859d"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "33bdc1a0000847a17f8500e4188cbddc52ae676fdffe525b5dae80d21dfadfdf"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

不含这些可选字段的已有事件仍然有效。待处理修改保留编辑文本用于显示，但在处理后的输入替换草稿前不贡献模型消息。userInput 缓存是从仅追加日志重建的新版本 1 投影。Session 格式及已提交的历史代保持不变。

<a id="verification"></a>
## 验证

定向 Session 上下文、控制器、对话与编辑器回归覆盖历史派生、回放、准备失败、连续编辑、幂等和并发输入。Web message-actions 场景验证同会话重新生成、URL 与会话数量不变，以及刷新后的结果。两个 SDK 均有同会话修改的输出快照。

<a id="dev-note"></a>
## 开发备注

无。
