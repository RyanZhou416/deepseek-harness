---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-15-claude-request-record-and-retry-disposition

[English](2026-10-15-claude-request-record-and-retry-disposition.md) | 中文

## 概述

新增 `llm/request-record` 根：Claude 路由把这次尝试的准备记录写入承载它的 session 日志，并在发送 Messages 之前等待其 flush 成功。同一次变更确认四个既有失败载体上的可选属性 `retryDisposition`——`assistant/attempt.data.stream[].chunk.reason.failure`、`assistant/message.data.stream[].chunk.reason.failure`、`llm/retry.data.failure` 与 `turn/end.data.reason.error`——该属性在现行源码中已经声明，只是此前没有被记录基线确认。没有任何既有根新增必填字段，没有重写任何已 finalize 的记录，Session 格式版本仍为 4。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-15-claude-request-record-and-retry-disposition
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "754aecb40d34579e58b5c2ecaf02b656e77da6b14e5d4d3226d9ac56f233982d"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "715bd97099035ded3c8a0870651479b529846baaaa93922fe241d8277e0ba37f"
    decision: same-version
  - root: "event:llm/request-record"
    previous: null
    after: "942da666ffc494e49f13049e1d970937be8527416663ebe7b59a15b4e9119e87"
    decision: same-version
  - root: "event:llm/retry"
    previous: "2026-09-14-image-offload"
    after: "a486593955d481f24a7da719794f3aa3dcdce2bb6075c84ebc4ab7d102825557"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-09-16-session-format-v4"
    after: "216b0406926982f0683a8f346c416e1a9e24f2f897f84ac26c9e477c989eb97a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

`retryDisposition` 是可选属性，且 `'forbid'` 本就是其唯一取值：认识该属性的读取方仍能读取更早写出的日志，那里该字段只是缺席；较早的读取方遇到较新的日志时可能保留或忽略这个未知属性，不能据此反推该字段曾经缺席。本次不新增任何处置码。`llm/request-record` 是新增的 required-on-read 根，因此早于它的 Host 会拒绝整份日志而不是跳过该记录：读取方先于写入方发布，该事件不设 `ignorable` 标记。既有根的必填字段不变，四个载体因此保持同版本。

<a id="verification"></a>
## 验证

已在隔离副本中运行。订阅插件项目使用 TypeScript 5.9.3 对其所有 src 与 test 的 `noEmit` 与 emit 通过，全部迁移后再跑 `tsc -p tsconfig.test.json` emit 通过，Host/Client 113 引用类型图与 SDK client build 通过。`compiled-recording-tests/output.log` 14 例通过——wire-record 7、真实 `subscriptions.apply` 2、modelConfig 4、进程重启 1——入口是编译测试文件经 workspace alias 指向 src，不代表 built 制品通过。`affected-consumers-with-recording-fixture/output.log` 86 例通过，覆盖 http、stream、credential、quota、control、maintenance-status；此前已绿的 response-fidelity 未重跑、不重复计数。SDK：2 例选中通过（TS 记录转发 1、agent-loop 既有 forbid 1）、47 例未选，Python 记录转发 1 例选中通过；SDK 生产源码未改。reader/normalizer：storage-contract 3 例与新增 normalizer 3 例通过；schema ack `--check` 为 63 roots / 8 history（含 `llm/request-record`）并通过。早前的 service、headless 场景、source-plane 与进程重启证据仍然有效、不重复计数。仍未验证：完整发行 bundle 与 tarball、bare 安装与回滚、全仓 docs/config 门、真实 provider 调用与 live window；续接/ATIS（CA）仍未接线。

<a id="dev-note"></a>
## 开发备注

无。
