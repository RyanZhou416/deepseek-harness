---
description: "进程本地后台任务注册表，供组合、容量评估或排查进程内任务的用户与维护者阅读：按所有者的准入、生命周期与销毁。"
kind: "package-reference"
---

# @deepseek-ai/dsh-jobs-local

[English](README.md) | 中文

## 概述

`dsh-jobs-local` 在 harness 进程内运行后台任务：工作会在 agent 继续推进的同时保持运行，拥有它的 agent 可以读取、等待、列出和取消它；同时挂载 `dsh-tool-jobs` 时，完成以会话内通知送达。它用内存记录实现 `dsh-jobs` 约定，并且只交出全新快照，从不交出实时状态。按所有者的并发上限（默认 10）约束一个 agent 同时处于运行或停止中的任务数量；可选的终态记录 TTL 与数量策略在不触碰存活工作的前提下约束已完成历史。任务会随 harness 进程终止而消失，无法跨重启持久。

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

当组合需要进程内后台任务时加载本插件：长时间运行的工具注册其工作，拥有它的 agent 在不阻塞自身轮次的情况下读取、等待、列出和取消。它实现 [`dsh-jobs`](../jobs/README.zh.md) 约定；模型侧的 `job_output`、`job_list` 与 `job_kill` 工具来自 [`dsh-tool-jobs`](../tool-jobs/README.zh.md)。

### 何时选择

当任务应存活于 harness 进程内、并随进程终止时选择它。当工作必须跨重启存活或跨进程存在时避免它：记录保存在内存中，持久或跨进程后端必须以不同方式实现同一约定。

### 最小配置

加载插件即注册 `ctx.jobs`；`maxConcurrentJobsPerOwner` 可选，默认为 `10`。终态保留策略需要显式启用，因此省略两个保留字段会继续把记录保存到所有者或服务释放。

发布的 `dsh-base` 组合会启用一小时终态 TTL，以及每个精确所有者 100 条终态记录的目标；这些策略不会改变存活 job 的准入。

```yaml
- name: '@deepseek-ai/dsh-jobs-local'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxConcurrentJobsPerOwner` | `10` | 每个精确所有者，或共享的无主桶中，`running` 加 `stopping` 任务的最大数量 |
| `terminalJobRetentionMs` | 禁用 | 每条终态记录的墙钟生存期；到期也会移除尚未报告的结果 |
| `maxRetainedTerminalJobsPerOwner` | 禁用 | 每个精确所有者或共享无主桶的终态记录目标数量；数量裁剪只移除已报告记录 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-jobs-local)是每个受支持字段的穷尽式真源。

### 每个所有者得到什么

上限统计精确所有者的 `running` 与 `stopping` 记录；所有无主任务共享另一个独立的服务级桶。终止历史不占用容量，只有生产方的 `done` 结算才释放一个停止中任务的名额。达到上限时，`start()` 会在生产方运行前失败，错误会指出上限并告诉 agent 终止一个不需要的任务、等它结束后再重试——注册表既不排队也不抢占。

### 生命周期

任务属于其所有者和后端，而非生产方工具，因此重载生产方或控制器不会停止任务。可选保留策略只移除 `completed`、`killed` 或 `failed` 记录；`running` 与 `stopping` 工作永远不是保留策略候选。拥有任务的 agent 被释放时，其任务会被取消、生产方会被等待、快照会被移除；服务释放对每个剩余任务执行同样的操作。销毁期间抛出的取消会强制失败记录并警告工作可能成为孤立工作，因此销毁永远不会死锁。

### 可能出什么问题

没有服务于所有者的控制器时无法启动工作——加载 `dsh-tool-jobs` 即附加一个，否则 `start()` 会以指出它的消息拒绝。返回但始终未结算 `done` 的生产方取消与缓慢停止无法区分，可能使销毁停滞并持续占用一个容量名额。配置 TTL 后，旧 job id 会在到期后按设计变为未知，因此应选择足以让所有者收集相关结果的生存期。每条剩余记录都会在 harness 进程退出时消失。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释注册表背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **内存记录，全新快照。** `LocalJobRegistry` 为每个任务保存一条 `TrackedTask`，每次调用都投影出新的只读快照；调用方永远不会拿到实时状态。
- **按所有者分层，一个进程级注册表。** 控制器、完成监听器与变更观察者归档到注册方所在的 scope（`ScopedLayers`），读取把全局层与所有者的 scope 链求并集——因此某个 preset 的任务控制绝不会为自身组合未加载任何控制器的 agent 保持 `start()` 可用，一次结算也只会抵达其所有者所属组合注册的监听器。
- **启动前先预检。** `start()` 在调用生产方之前检查控制器服务、spec 有效性、仍存活的所有权与容量，因此拒绝不会留下 job id 或执行资源；注册一旦提交，后续不再有可失败步骤。
- **结算首次优先，完成最后。** 最早的终止结果只记录一次，释放等待方，并只通知监听器一次，各监听器故障单独隔离；完成在记录提交且可见集变更发布之后才宣布，因为报告方可能同步开启一个模型轮次。
- **一个终态到期定时器。** 注册表为最近的终态截止时间设置一个不维持进程存活的定时器，而不是为每条记录保留一个定时器；一次到期扫描按所有者批量发布可见集移除。
- **销毁永不死锁。** 抛出的取消会强制失败记录并报告可能的孤立工作，而不是让释放停滞。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、`LocalJobRegistry`、准入、生命周期、销毁 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件（无运行时不变式；快照检查位于 `dsh-jobs/invariant`） |

### scope 分层

`attachController`、`onJobDone` 与 `onJobsChanged` 注册到调用上下文所在的 scope 层。控制器问题（`servesOwner`）与监听器投递（`listenersFor`、`changedFor`）走同一条链：先是全局层，再沿所有者的链逐层。注册是无名 token，因此重复标签仍可独立释放。

### 准入与结算

`activeTaskCount` 按精确所有者或共享无主桶统计权威记录。`settle` 在存在挂起等待方时把任务标为已报告，解析每个等待方，记录终止快照，宣布可见集变更，然后通知完成监听器。挂起的等待会在监听器运行前把任务标为已报告，因此完成报告方不会重复通知；销毁时的取消出于同样理由标记——面向正在被销毁的所有者的通知不会有人读到。

### 终态保留

`terminalJobRetentionMs` 会在墙钟截止时间移除每条终态记录，包括尚未报告的结果。`maxRetainedTerminalJobsPerOwner` 是更早介入的内存压力目标：一个桶超过它时，注册表先移除最旧的已报告终态记录，把未报告记录留给 TTL 或销毁。精确所有者各有独立桶，所有无主记录则共享一个桶。省略任一字段即禁用对应策略，从而保留本包的历史行为。保留的最终输出继续支持幂等读取，保留的流输出继续采用消费式读取；终态流记录在结算后首次成功读取时释放生产方 reader。

### 销毁

所有者释放（`disposeOwned`）会取消该所有者的任务、等待其结算、移除其记录，并宣布移除——这是任何逐任务记录都无法表达的可见集变更。服务释放（`disposeAll`）会关闭监听器、取消所有存活任务、等待结算、清空存储、向不同的所有者宣布清空，然后分离跨 fiber 的所有者清理 effect。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从注册表约定逐步进入模型侧控制与设计记录。

- [后台任务运行时子系统](../../../docs/subsystems/jobs.zh.md)——任务类型、快照字段与 `ctx.jobs` 的 cordis 接口面。
- [jobs 组映射](../README.zh.md)——同级组页面及其包表格。
- [注册表约定](../jobs/README.zh.md)——本包实现的抽象 `ctx.jobs` 服务。
- [模型侧任务控制](../tool-jobs/README.zh.md)——`job_output`、`job_list` 与 `job_kill` 工具及完成通知。
- [通用长时间运行工具运行时 Agent Note](../../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.zh.md)——后台任务运行时背后的设计。
- [任务注册表 seam Agent Note](../../../.agents/notes/implemented/architecture/2026-07-26-job-registry-seam.zh.md)——按所有者隔离的注册表约定及其理由。

-----

<a id="model-experience"></a>
## 模型体验

通过生产方插件与 `dsh-tool-jobs` 间接影响模型，注册表后端把全部模型渲染委托给它们。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明注册表何时不合适。它们是当前包约束，不是任务积压。

- **任务只存在于进程本地**——记录会随 harness 进程终止而消失；持久或跨重启执行需要一个单独实现该 seam 的后端。
- **终态保留会使收集 id 到期**——配置的 TTL 或已报告记录数量裁剪移除记录后，`job_output`、`job_kill` 与直接注册表读取会把该 id 作为未知 id 拒绝；持久结果查询需要持久后端。
- **静默无效的取消可能使销毁停滞并持续占用容量**——如果 `cancel` 返回后始终未结算 `done`，注册表就无法将其与缓慢停止区分开；该任务会在服务剩余生命周期内持续占用一个桶名额，只有显式抛出异常才能安全地强制标为失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
