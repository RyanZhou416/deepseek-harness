# @deepseek-ai/dsh-memory-admission

[English](README.md) | 中文

该 guard 在不改变会话日志或模型输入的前提下限制进程级 agent step 准入。它在 `agent/pre-step`、模型历史组装之前取得 FIFO reservation，并持有到匹配的持久化 `step/end`；agent 进入 idle 或 disposed 时会释放遗留 reservation。已经进入的 step 自然完成。当 `maxConcurrentSteps` 已占满或 V8 heap 使用率达到 `heapHighWatermarkRatio` 时，新 step 等待；heap 使用率降到 `heapLowWatermarkRatio` 后才重新开放准入。

安装全部监听器后，插件会提供 `ctx.memoryAdmission`；base bundle 让 agent-loop 注入该 readiness service，因此由配置创建的 Agent 不会在准入生效前启动。

## 配置

```yaml
- id: memory-admission
  name: '@deepseek-ai/dsh-memory-admission'
  config:
    maxConcurrentSteps: 8
    heapHighWatermarkRatio: 0.82
    heapLowWatermarkRatio: 0.72
    sampleIntervalMs: 100
```

`heapLowWatermarkRatio` 必须小于 `heapHighWatermarkRatio`，顺序无效会使插件加载失败。等待中的 step 在 agent 的取消信号下保留已 claim 的输入；下游 pre-step 接受之前不会产生会话事件。取消该 activity 只会移除自己的 FIFO waiter。插件 dispose 会拒绝排队准入并释放活跃 reservation。

该 guard 只改变调度，不增加模型可见内容、会话事件、存储文件、迁移或线协议字段。

## 模型体验

### 延迟请求准入

#### 模型看到的内容

不增加 `system` 文本或工具 schema；请求在进程压力下可能更晚开始。

#### Token 影响

不增加直接 token。

#### KV Cache 影响

该策略保留每个获准请求的原始消息顺序，不会替换已有的可复用前缀。

## 已知限制与暂缓事项

- Heap 准入观察 V8 `heapUsed`；native buffer 和浏览器内存不在该指标内。
- 已经获准的 step 可能越过高水位，本策略不会取消它。
- 持续内存压力会让新 step 等待，直到内存下降或对应 activity 被取消。
