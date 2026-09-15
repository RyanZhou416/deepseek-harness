# Agent Note: Background job completion wakes an idle owner

Status: implemented

[English](2026-08-11-background-job-completion-wakes-an-idle-owner.md) | 中文

## 问题

`tool-jobs` 对模型承诺「任务完成时你会在会话内收到通知——不要忙轮询，也不要 sleep 等待」。这个承诺只在模型仍在工作时成立。完成经由 `agent.inject()` 交付，它只向 next-step inbox 追加而不预留 driver，因此在轮次结束之后才结算的任务会把通知搁在那里，直到某件无关的事情唤醒 agent。最常见的形态恰恰就是会失效的那一种：模型启动一条长命令，告诉用户已经启动，结束轮次，而命令完成后进入了一个无人领取的 inbox。提示词让模型不要轮询，然后什么也没到。

这个缺口被记为一条限制，而不是被推敲过，于是退路成了 `job_output(wait: true)`——同一段提示词并不鼓励的阻塞等待。

本决策取代[后台任务运行时决策](../architecture/2026-06-20-generic-long-running-tool-runtime.zh.md)中的一条事实——完成永不唤醒空闲所有者——并把 teardown 加为 `reported` 的置位方。那份 note 仍拥有其余全部任务运行时决策，因此就地更新而非替换。

交付机制从来不是障碍。自[统一 send 决策](../../archived/architecture/2026-07-22-unified-send-and-coalesced-user-messages.md)起，`Agent.send(message, target, wakeup)` 就覆盖了 `target` × `wakeup` 矩阵，`wakeDriver()` 也已经处理 idle、maintenance 和已取消未收敛三种相位。缺的是「一次完成走哪条通道」这一策略选择，以及该选择所需的界。

## 决策

尚未报告的完成按所有者当时在做什么来选择通道。繁忙的所有者走注入。空闲的所有者在连续预算允许时用 `followup()` 唤醒；阻塞读取若返回该 owner 所属的 live job，则为它的下一次完成保留唤醒权。AgentLoop 会重放运行中 driver 作出最终 inbox 决定后接纳的所有输入，因此两条投递通道都不会在退休期间搁置工作。

这采纳了[延续管理器](2026-08-06-manager-owned-subagent-settlement-delivery.zh.md)已经为 subagent 结算所采用的交付规则，那里写着「用 steer 而非 inject 是刻意的……这是一条正确性规则，不是部署偏好」。两条路径不重叠：`tool-subagent` 只为一次性后台子 agent 注册 Task，而 continuable 分支在抵达那段代码之前就已返回，因此一个子 agent 恰好由两种机制中的一种交付。

### 繁忙的所有者保留注入

对于仍在运行且仍接纳步骤的 driver，`steer()` 与 `inject()` 是同一次交付：循环会从 next-step inbox 领取二者。最终一次空 inbox 决定之后，两种投递都会为待处理输入锁存一个替代 driver。二者在轮次已取消但尚未收敛的所有者上仍有区别，此时 steer 会重定向到下一轮并在收敛时重放唤醒。

在那里注入才是对的。轮次被取消意味着用户按了停止，替他们重新开一轮等于把一次中断洗成了他们没有要求的模型请求。普通情形已由轮次循环覆盖：只要 next-step inbox 还有内容，轮次就无法结束，因此在该检查之前抵达的通知会延长当前轮次，同时结算的多个任务只花掉一步而不是各占一轮。

### 退休保留已接纳输入

轮次循环作出最终一次空 inbox 决定后，运行相位会把自身标为 retiring。`send()` 在该相位接纳输入时设置既有的收敛唤醒 latch。driver 先发布 idle，然后只在 inbox 仍含锁存工作时启动替代 driver。该机制不增加公开相位或会话事件；在 idle 发布之后调用的 `inject()` 仍然不会唤醒。

### 唤醒有界，且该界不是时间

`maxConsecutiveWakes`（默认 3）限制本插件为一个所有者连续开启的轮数；超出后，无保留通知会降级为注入并等待下一轮。不是由本次投递引发的 driver 启动会重置计数，因此 subagent 结算、steering 或其他输入来源都会打断这条链。领取用户撰写的消息也会在该消息加入已运行 driver 时恢复预算。本插件自己排队的通知永远不会补充它。

设界是因为这条链会自激，而 subagent 结算不会。结算受限于模型派生了多少子 agent；被唤醒的一轮却可能启动某个后台任务，而它的完成又会唤醒同一个所有者，且无人旁观。`dsh run` 会为没有显式等待的 job 花掉同一份连续预算；一次阻塞 live 读取会刻意让一个确切完成重新获得唤醒权。

一次阻塞 `job_output` 若返回仍在运行的 owner 所属 job，就会为该 job id 记录一项一次性保留。即使连续计数已耗尽，它稍后的完成也可以唤醒空闲所有者，因为模型已经明确声明下一步依赖该任务。即使另一等待方已经报告结果，结算也会消费这项保留；终态读取或 kill 同样会清除它。

`completionDelivery: quiet` 为空闲所有者恢复旧通道。它的存在是为了确定性 transcript；后台任务完成会独立保留 `quiet | wakeup`，因为其有界的所有者轮次策略不同于 next-step subagent 报告。

### 销毁自行认领报告

`cancelForTeardown` 现在会把记录标记为 `reported`，与 `kill()` 在取消之后所做的完全一致。当通知只是一次无害的注入时，这处不对称看不出来；而会唤醒的报告方会把它变成每个 teardown 层级一次模型请求，作用在宿主正要销毁的 agent 上。

`reported` 本来就是正确的那个 bit——「kill、read 或 wait 已报告或承诺报告终止状态」——而 teardown 是一次没有调用方的 kill。用它可以让该结算的每一个观察者都保持完整：`onJobDone` 仍会触发，因此运行时不变量与强制失败路径依旧被覆盖，只有通知报告方会安静下来。

### 完成是最后才宣布的

`settle()` 此前释放等待方、标记记录已结算并发布可见集变更的时机，都排在运行完成监听器**之后**。开启轮次的报告方是同步执行的，因此那个顺序会让被唤醒轮次的 `turn/start` 抢在它所响应的那次结算被提交之前落地，也抢在任何 `onJobsChanged` 观察者看到它之前。把完成放到最后宣布，使报告方成为该结算的最后一个观察者，而其他观察者都已先看到它。

## 被否决的替代方案

**在 `JobStart` 上加生产方声明的唤醒位**，对应 Codex 的 `trigger_turn` 与 Kimi 的 `admission` 枚举。从长期看这是更好的形状——`tail -f` 流与两小时构建想要不同答案——但当前没有任何生产方需要区分它们，而仓库要求公共面必须有当下的所有者与需求。加它的自然触发点，是第一个「要让某个任务唤醒而另一个不唤醒」的生产方出现时。

**一个通用的非请求输入队列**并带优先级通道，正如 Claude Code 用来把后台任务、cron、MCP 推送与 hook 合并进同一次排空。DSH 的 inbox 本身就是那个队列——`next-turn`/`next-step` 之上的持久 `agent/inbox/spliced` splice——因此这等于在既有层之上再加一层，只为决定一个 bit。

**拒绝重开一个已经产出可见答复的轮次**，即 Codex 的 `MailboxDeliveryPhase` 闩锁。那条闩锁正是本决策刻意反转的默认值：在模型已经说完话之后唤醒它就是本特性的全部意义，界由唤醒预算来承担。

**在计数之上再加墙钟窗口**。对交互式 agent 而言，慢的那种情形恰恰是想要的——一小时的构建结束、agent 接着干下去，这就是特性本身——而无人观察的 `dsh run` 链仍受计数限制。阻塞 live 读取是显式例外，与经过时间无关。

**在 owner 排空期间整体压制 `onJobDone`**，与服务级的 `listenersClosed` 对称。它读起来更干净，但会移走一个不只服务于通知的信号：强制失败记录与运行时不变量都会观察 teardown 结算。`reported` 位恰好只否决报告方，别的什么也不否决。

## 影响

- 默认行为改变：只要 `maxConsecutiveWakes` 允许这条连续链，空闲所有者的每次完成就会花掉一次模型请求。其他来源启动 driver 会重置计数，阻塞读取若返回 live job 则会为其保留一次完成唤醒。完全不需要主动轮次的部署设置 `completionDelivery: quiet`。
- `tool-jobs` 的提示词段落无需改动；「任务完成时你会在会话内收到通知」从愿景变成了事实。
- `JobSnapshot.reported` 新增 teardown 作为第四个置位方，记录在 Service Definition 与[子系统参考](../../../../docs/subsystems/jobs.zh.md)中。
- `settle()` 在提交记录并发布可见集变更之后才宣布完成。任何依赖「在释放等待方之前或在 `onJobsChanged` 之前运行」的监听器现在都排在两者之后。
- `tool-bash` 的 real-composition 测试去掉了第二条用户消息：仅靠结算就能把通知带入一个收集输出的轮次。它断言持久结果而非轮次边界，因为命令是否活得比它的轮次久是一场竞态；通道选择改由 `tool-jobs` 单元测试钉住。
- keyless `background-job-wait-wake` 场景会花掉三次连续唤醒，使第四个 owner 所属 job 从阻塞读取返回 live，并记录其保留完成开启最终轮次。
- 单元覆盖钉住：空闲唤醒、繁忙注入、quiet 交付、预算耗尽、用户输入或外部 driver 启动重置预算、同一 driver 内插件通知不重置、显式等待保留、退休重放，以及 teardown 静默。

### 已接受的风险

无人值守 agent 可以通过反复执行返回 live job 的阻塞读取来超过连续计数。每次越界仍绑定到一个确切 owner 与 job id，但要求模型请求硬上限的部署必须使用 `completionDelivery: quiet` 或外部轮次策略。

在 `quiet` 下待领于空闲所有者的通知仍会随该所有者释放而消亡，与此前一致：释放时的取消会清空未领取的 inbox，日志保留插入/取消这一对作为记录。[结算交付 note](2026-08-06-manager-owned-subagent-settlement-delivery.zh.md) 承载这需要的离线信箱讨论。

对短命任务而言，完成究竟是延长运行中的轮次还是开启新轮次是一场真实竞态，因此没有哪份编写的 transcript 能同时容纳两种顺序。组装态覆盖断言结果；通道选择由单元测试钉住。

退休 latch 只在运行中的 driver 作出最终空 inbox 决定后生效。driver 发布 idle 后才注入的上下文保留公开的非唤醒行为，等待 follow-up 或 steering。
