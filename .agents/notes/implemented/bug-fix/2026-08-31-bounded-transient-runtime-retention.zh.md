# Agent Note: 有界的瞬态运行时留存

Status: implemented

[English](2026-08-31-bounded-transient-runtime-retention.md) | 中文

## 问题

每个曾被选择的 Client Session 都会在导航切走后继续保持 history follow。每条 Host follow 都会留存对应 Session 并阻止空闲 Agent 逐出，因此一个浏览器标签页会随查看过的无关会话不断累积 Host 驻留。进程内 job registry 也会保留每条终态记录及其输出、生产方闭包和所有者，直到所有者释放。

这些瞬态所有者使 live heap 随导航历史和已完成后台工作增长，尽管持久 Session 历史已经存在磁盘上。

## 决策

Client Session generation 仅在带 source 标签的 reference 留存时存在。工作区的 `mainView` reference 拥有已选择的 Session；释放最后一个 reference 会同步撤回 binding 与 Agent-scoped Context，然后异步释放 Session 和 history stream。目录元数据与每个 Session 的 projection value 由 manager 独立持有，不受 instance 替换影响。再次选择时会物化新 generation，并从持久历史打开；旧 generation 的延迟 cleanup 无法撤回或改变替代 generation。

`dsh-jobs-local` 接受可选的 `terminalJobRetentionMs` 与 `maxRetainedTerminalJobsPerOwner` 策略。TTL 到期会移除任意终态记录；数量裁剪会在每个精确所有者桶和共享无主桶中移除最旧的已报告终态记录。运行中和停止中的 job 永远不是留存策略候选。基础组合启用一小时 TTL 与每个所有者 100 条终态记录的目标。

可续传 subagent 保持既有生命周期：continuation manager 会立即释放 settled Activation，并在后续投递时冷恢复。Owned child disposal 与 Job 状态变化会重新评估此前被阻塞的父级 retention timer。Agent eviction 一旦开始，并发 resolver 会等待 teardown 结算，随后才能返回 live Agent 或 cold-resume Session；任何调用方都不会在正在销毁的实例上接受工作。该留存机制不增加外部 idle timer 或第二套容量策略；官方 `maxActiveSubagents` 限制独立生效。

## 备选方案

**把 Agent activation 限制作为留存修复。** 拒绝，因为 activation capacity 无法移除已完成记录或 browser reference。Alpha.2 的官方 `maxActiveSubagents` 设置仍是独立的调度策略。

**保留每个 off-stage scoped Session，只暂停其 history transport。** 拒绝，因为 Alpha.2 为每个 consumer 提供显式 reference owner，并把持久 projection value 放在 instance 之外。保留没有 reference 的 scope 会在不存在 live consumer 时继续占用 browser 与 Host 驻留。

**达到数量目标时立即裁剪所有终态 job。** 拒绝，因为新完成但尚未报告的结果可能在所有者收集前消失。因此数量裁剪只选择已报告记录，TTL 则是未报告结果的显式截止时间。

**依赖 watchdog 重启。** 拒绝将其作为稳态机制，因为重启只有在中断服务后才能释放整个 heap。watchdog 可以停止不安全的后端，但 supervisor 不会自动重新启动它。

## 影响

该留存机制不改变 Session persistence、事件词汇、AgentTeams 状态与 activation capacity 语义。无 reference 的 Client generation 及其详细历史会停止存在，直到另一个 consumer 留存该 Session；独立目录与 control stream 会继续投影 running 状态、queue、job、完成标记与 projection value。保留的终态 job id 会在配置的 TTL 或已报告记录数量逐出后变为未知；持久 job 结果查询需要持久后端。

Session Controller 针对性测试覆盖独立 reference source、final-release 撤回、同 id generation 替换、延迟 teardown、opening 取消、binding 所有权与 disposal quiescence。jobs-local 测试覆盖省略配置时的旧行为、精确所有者数量裁剪、未报告结果保护、所有终态、活动 job 保留、timer 释放与真实 Loader 配置。
