# Agent Note: 上下文 projection 开销控制

Status: implemented

[English](2026-09-04-context-projection-cost-controls.md) | 中文

## 问题

`dsh-context` timeline 会保留 request、event、surface、archive、文件操作、timing 与 pending-call 状态。若只改变一个字段的事件仍复制全部集合，长会话的分配量就会随保留历史增长。若连续状态不能证明所有可见输入都未变化，Host-only transition 也会重新构建并校验 wire value。

关闭的 `/context` overlay 可能继续保留 timeline、detail、history、token-meter、header 与 conversation 订阅，即使它不渲染 DOM。若 retention 仅在相关事件后运行，按较大 retention bounds 创建的检查点也可能在降低 bounds 后先提供一次较大的数组。

## 决策

本 fork 将上游 `dsh-context` `v0.49.0` 的 `40bb97c5633eabbdf1c22c77a3a0f1e10c6d8108` vendored 到 [`fork-plugins/dsh-context`](../../../../fork-plugins/dsh-context/FORK_MAINTENANCE.md)，并发布私有包版本 `0.49.0-dsh015rc1.1`。部署配置使用 `maxRequestSteps: 300`、`maxKeptTurns: 60`、`maxEvents: 100`、`maxNodes: 400`、`maxArchiveNodes: 100` 与 `maxFileOps: 100`。

本 fork 采用上游的 V0/V2/V3 日志 fold、Host 侧 File Activity 账本、右侧 Sidebar 面板与拆分式 timeline 传输。projection value 携带精简 head，打开的 Context 标签页或 modal 通过 detail channel 取得大型集合。导入的 `TimelineState` schema 使用 `stateVersion: 15`；不兼容的插件检查点会从不可变 Session 日志重新派生，而不是原地迁移。

timeline fold 使用字段级 copy-on-write 状态，并标记事件改变了哪些保留集合。已归一的状态仅对 dirty 集合运行 whole-turn、event、archive 与文件操作裁剪。未识别的检查点会执行一次强制归一，而它的首个精简 head、inline value 或 detail response 会把相同 bounds 应用到私有瞬态副本。原始检查点保持不变，空闲会话无法发布尺寸过大的恢复集合。

projection 定义会在可见状态输入保持引用相等的 transition 之间传播弱引用 identity token。独立弱引用 cache 会保留 inline 与 slim value，因此 [session projection registry 的两阶段 identity 检查](../../../../packages/session/session-projection/README.zh.md#understand-the-implementation)会为 pending call、打开的 step slot 与已缓冲 Code-Mode 操作跳过 view 校验与发布。可见输入变化或会改变保留数据的强制归一会获得新 identity；事件路径不会对完整 payload 执行结构比较。

`/context` overlay 将 modal-store gate 与数据 body 分开。关闭的 gate 只订阅打开标志。打开时会挂载 projection、detail、history 与 conversation 钩子以及键盘和布局生命周期；关闭时会释放该子树。

## 备选方案

**直接使用不带 fork 代码的上游 `v0.49.0`。** 拒绝，因为上游 fold 会在每个有变化的事件上复制全部已保留集合，关闭的 modal 仍挂载数据钩子，并且恢复的检查点不会在提供首个 value 前执行 bounds clamp。

**只降低 retention bounds。** 拒绝，因为 Host-only 事件仍会复制已保留集合，关闭的 modal 仍会收到 projection 与 detail 活动，而空闲的已恢复检查点仍可能提供按旧 bounds 保留的数据。

**在安装时删除 projection cache。** 拒绝，因为删除 cache 是没有必要的破坏性运维操作。registry 会处理导入的上游 `stateVersion: 15`，view-time clamp 会在不改变存储数据的情况下限制首个 value，后续相关事件会持久化有界状态。

**深度比较连续 wire value。** 拒绝，因为比较本身会随已保留 payload 增长。copy-on-write 所有权使未改变字段保持引用稳定后，字段 identity 能以常量时间证明相同条件。

**保留 modal body 挂载并隐藏它。** 拒绝，因为隐藏的 projection 与 conversation 钩子会保留本次改动要消除的订阅与渲染开销。

## 影响

`contextTimeline`、`contextHeaders` key 与 Session event vocabulary 保持不变。插件采用上游 version-15 projection state 与兼容的 inline/slim wire schema；插件检查点可能重新 fold，但 Session artifact 不会被转换或覆盖。较低的部署 bounds 会保留较少的历史细节，而当前组成、whole-turn 裁剪、hard step 限制、event tail、archive coverage floor 与文件操作 floor 保持既有含义。

关闭 `/context` 会释放其数据订阅与本地 browser 组件状态；重新打开会从当前 projection 重建这些瞬态 UI。Context 标签页不受影响。框架释放相关对象后，WeakMap 不会继续留存 Session 或 projection 状态。

针对性 Host 测试覆盖字段所有权、dirty trimming、稳定与更新的 inline/slim identity、恢复 view bounds、archive 与文件操作 floor、V0/V2/V3 folding、detail 传输和 plain-JSON 不变性。Client 组件测试覆盖关闭时 projection 或 conversation 钩子调用为零，以及正常的重新挂载与释放行为。
