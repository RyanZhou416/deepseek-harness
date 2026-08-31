---
description: "进程级 Agent 模型阶段准入：适用于需要在长任务或高并发运行中限制并发并通过 V8 堆压力滞回保护 Host 的部署。"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-admission

[English](README.md) | 中文

## 概述

`dsh-memory-admission` 在不改变会话日志或模型输入的前提下，限制同一进程内所有 Agent 的模型阶段。它在模型历史组装前按 FIFO 顺序准入拟执行的 step，在 V8 heap 压力过高时关闭准入，并在最终 `assistant/message` 处、tool execution 等待 child Agent 之前释放容量。长时间运行或高并发 profile 中，不受限的模型历史组装和响应流可能耗尽 Node heap，此时应选择本插件；它只延迟新工作，不会取消已经获准的模型阶段。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 `dsh-agent-loop` 之前挂载本插件，并让 loop entry 注入 `memoryAdmission`，这样配置创建的 Agent 不会在准入 listener 安装前启动。发布的 base bundle 已使用这一顺序。

### 何时选择

当多个 Agent 可能在同一 Host 进程内并发组装长历史或流式接收模型响应时，选择本 guard。如果部署已经拥有等价的进程级调度器，或者模型工作位于 heap 互不影响的隔离进程中，则无需使用。

### 最小配置

```yaml
- id: memory-admission
  name: '@deepseek-ai/dsh-memory-admission'
  config:
    maxConcurrentSteps: 8
    heapHighWatermarkRatio: 0.82
    heapLowWatermarkRatio: 0.72
    sampleIntervalMs: 100

- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  inject: [memoryAdmission]
  config:
    agents: []
```

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `maxConcurrentSteps` | `8` | 进程内最多同时获准的 Agent 模型阶段数 |
| `heapHighWatermarkRatio` | `0.82` | 关闭新准入的 V8 heap-used 比率 |
| `heapLowWatermarkRatio` | `0.72` | 压力发生后重新开放准入的比率 |
| `sampleIntervalMs` | `100` | 有调用方等待时重新采样 heap 的间隔 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-memory-admission)是所有可接受字段及其 JSDoc 的完整来源。

### 调度与失败行为

`heapLowWatermarkRatio` 必须小于 `heapHighWatermarkRatio`，顺序无效会使插件加载失败。等待中的 step 在 Agent activity 的取消信号下保留已 claim 的输入；下游 pre-step 接受之前不会产生会话事件。取消只移除对应的 FIFO waiter。reservation 在匹配的持久化 `assistant/message` 处释放；`step/end`、Agent idle、Agent disposal 与插件 disposal 是后备释放路径。插件 disposal 还会拒绝全部排队准入。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

`StepAdmissionGate` 拥有一个 FIFO waiter 队列、active counter 和 V8 heap hysteresis。插件在 `agent/pre-step` 取得容量，只在下游 listener 接受 step 后记录准确的 Agent／turn／step，并用 `session/event` 匹配该 reservation。在 `assistant/message` 释放可限制模型历史和模型流的驻留，同时确保 tool execution 与 subagent wait 不占用父级 slot。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件配置、生命周期 listener 与 reservation ownership |
| [`src/gate.ts`](src/gate.ts) | FIFO 并发及 heap-hysteresis gate |
| [`src/invariant.ts`](src/invariant.ts) | 包 invariant ownership 注册 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Agent 生命周期](../../../docs/agent-lifecycle.zh.md)——turn、step、request 与 tool 的顺序。
- [Core 子系统](../../../docs/subsystems/core.zh.md)——Agent event 与 loop 合同。
- [防御性模式](../../../docs/defensive-patterns.zh.md)——取消、dispose 与异步 ownership 规则。

-----

<a id="model-experience"></a>
## 模型体验

### 延迟请求准入

#### 模型看到的内容

不增加 system 文本或 tool schema。`agent/pre-step` 等待进程容量或更低 heap 压力时，请求可能更晚开始。

#### Token 影响

不增加直接 token。

#### KV Cache 影响

该策略保留每个获准请求的原始消息顺序，不会替换已有的可复用前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- Heap 准入观察 V8 `heapUsed`；native buffer、subprocess 与浏览器内存不在该指标内。
- 已获准的模型阶段可能越过高水位，本策略不会取消它。
- 持续内存压力可能让新 step 等待，直到内存下降或对应 activity 被取消。
- 并发上限只在进程内生效；不同 Harness 进程之间不会协调 reservation。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
