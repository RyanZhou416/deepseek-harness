---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-28-user-message-revisions

[English](2026-09-28-user-message-revisions.md) | 中文

## 概述

记录同会话人类消息修订（可选替换与待处理草稿元数据）、有界的 userInput 投影，以及合并时对已准备请求 purpose 联合的归一化。

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
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "b509f1946336b63750c4062b08452921fb5492c786c08bd78185f796ac8193e8"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "e44ff2e5d8364e80f289b7341918fa8b956e2c6358147b8a5495e9ddeeb84ff6"
    decision: same-version
  - root: "event:llm/request-record"
    previous: "2026-10-15-claude-request-record-and-retry-disposition"
    after: "26627befdc3416d1c40b749a2373c05343d25b33bc31d8cb2caab2599633116a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "bf4857d0cfa5ddea785005c837f8f2ac6210ef4784982a3fc2a4d98e4aba2c7f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "c89af8ad48d00590b490a885e927b0c3adea1f9163dbd3924bbb6a22e3b3857d"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效。四个消息根只增加可选字段：待处理修订保留编辑文本用于显示，在处理后的输入替换草稿前不贡献模型消息；userInput 是从仅追加日志重建的版本 1 投影。上游将 `GenerateOptions.purpose` 泛化为 `LlmRequestPurposeMap` 后新增了 `auto-review` 变体，因此已准备请求的 `purpose` 联合被重新记录；`purpose` 是模型不可见的元数据，读取方不以它作判别，已经处理 `compaction`、`session-title` 与 `conversation` 的读取方会把新增变体当作不透明数据处理，不会以不同方式解释任何已有记录。Session 格式版本 4 与已提交历史代保持不变。

<a id="verification"></a>
## 验证

本集成阶段执行了持久化门禁：`pnpm run verify-persistence-changes`、`pnpm run verify-persistence-catalog` 与 `pnpm run verify-persistence-formats`；原确认记录中的聚焦 Session 与对话回归不受本次合并影响，将在下一阶段运行。

<a id="dev-note"></a>
## 开发备注

无。
