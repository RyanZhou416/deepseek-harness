# Agent Note: 上下文 projection 开销控制

Status: implemented

[English](2026-09-04-context-projection-cost-controls.md) | 中文

## 问题

vendored `dsh-context` timeline 会为每个仅改变 Host 私有状态的事件复制全部已保留集合，并重新构建、校验、序列化和发布完整协议值。饱和的默认 projection 测得 520,244 字节；一次用户事件从 fold 到 view 构建、schema 校验与 JSON 序列化耗时 3.54 ms，即时 heap 增量为 10.51 MB。`step/start`、首个 token 分片和 `tool/call` 只改变私有 fold 状态，却仍承担大部分开销。

关闭的 `/context` overlay 还会保留 timeline、token-meter、header 与 conversation 订阅。projection 推送会继续渲染一个不返回 DOM 的对话框。retention 只在相关事件后运行，因此在降低 bounds 后，按较大 retention bounds 创建的检查点仍可能先对外提供一次较大的数组。

## 决策

本 fork 将上游 `dsh-context` `v0.41.3` 的 `dce08e0db3ad1dae40da0eb586e7da7f587b32b6` vendored 到 [`fork-plugins/dsh-context`](../../../../fork-plugins/dsh-context/FORK_MAINTENANCE.md)，并发布私有包版本 `0.41.3-dsh012rc1.1`。部署配置使用现有 bounds：`maxRequestSteps: 300`、`maxKeptTurns: 60`、`maxEvents: 100`、`maxNodes: 400` 与 `maxArchiveNodes: 100`。在这些 bounds 下，饱和协议值测得 108,146 字节，比上游默认值低 79.2%；测得的 fold/view/schema/JSON 路径耗时 0.836 ms，即时 heap 增量为 2.207 MB。

timeline fold 使用字段级 copy-on-write 状态，并标记事件改变了哪些保留集合。已归一的状态仅对 dirty 集合运行 whole-turn 与 archive 裁剪。未识别的检查点会执行一次强制归一，而它的首个协议 view 会把相同 bounds 应用到私有瞬态副本。原始检查点保持不变，空闲会话无法发布尺寸过大的恢复值。

projection 定义会在可见状态输入保持引用相等的 transition 之间传播弱引用 identity token。它的弱引用 view cache 会为仅 Host 私有状态变化返回同一个原始对象，因此 [session projection registry 的两阶段 identity 检查](../../../../packages/session/session-projection/README.zh.md#understand-the-implementation)会跳过 view 校验与发布。可见输入变化或会改变保留数据的强制归一会获得新 identity；事件路径不会对完整 payload 执行结构比较。

`/context` overlay 将 modal-store gate 与数据 body 分开。关闭的 gate 只订阅打开标志。打开时会挂载 projection 与 conversation 钩子以及键盘和布局生命周期；关闭时会释放该子树。

## 备选方案

**只降低 retention bounds。** 拒绝，因为私有 fold 事件仍会复制和发布已保留 payload，关闭的 modal 仍会渲染每次 projection 推送，而空闲的已恢复检查点仍可能提供按旧 bounds 保留的数据。

**提升 projection state version 或删除 projection cache。** 拒绝，因为提升版本会在部署时强制执行完整日志 refold，而删除 cache 属于破坏性的运维工作。wire-time clamp 可在不改变存储数据的情况下限制首个 view，后续相关事件会持久化有界状态。

**深度比较连续协议值。** 拒绝，因为比较本身会随已保留 payload 增长。copy-on-write 所有权使未改变字段保持引用稳定后，字段 identity 能以常量时间证明相同条件。

**保留 modal body 挂载并隐藏。** 拒绝，因为隐藏的 projection 与 conversation 钩子会保留本次改动要消除的订阅与渲染开销。

## 影响

`contextTimeline` key、所有 projection 响应字段、持久状态 schema 与 `stateVersion`、会话事件词汇均保持不变。较低的部署 bounds 会保留较少的历史细节，而当前组成、whole-turn 裁剪、hard step 限制、event tail 与 archive coverage floor 保持既有含义。

关闭 `/context` 会释放其数据订阅与本地 browser 组件状态；重新打开会从当前 projection 重建这些瞬态 UI。Context 标签页不受影响。框架释放相关对象后，WeakMap 不会继续留存 Session 或 projection 状态。

针对性 Host 测试覆盖字段所有权、dirty trimming、稳定与更新的协议 identity、恢复 view bounds、archive floor 与 plain-JSON 不变性。Client 组件测试覆盖关闭时 projection 或 conversation 钩子调用为零，以及正常的重新挂载与释放行为。
