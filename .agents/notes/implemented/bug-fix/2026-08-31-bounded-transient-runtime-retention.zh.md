# Agent Note: 有界的瞬态运行时留存

Status: implemented

[English](2026-08-31-bounded-transient-runtime-retention.md) | 中文

## 问题

每个曾被选择的 Client Session 都会在导航切走后继续保持 history follow。每条 Host follow 都会留存对应 Session 并阻止空闲 Agent 逐出，因此一个浏览器标签页会随查看过的无关会话不断累积 Host 驻留。进程内 job registry 也会保留每条终态记录及其输出、生产方闭包和所有者，直到所有者释放。

这些瞬态所有者使 live heap 随导航历史和已完成后台工作增长，尽管持久 Session 历史已经存在磁盘上。

## 决策

只有 staged Client Session 保持 history follow 打开。选择其他 Session 或显式清空选择会同步摘掉上一条 stream，同时保留其 Session scope、binding、当前 window、projection、queue 与功能状态。再次选择时会从持久历史打开新 stream。临时 list masked gap 会保留 stage，因为它属于 transport 状态而不是用户导航。

`dsh-jobs-local` 接受可选的 `terminalJobRetentionMs` 与 `maxRetainedTerminalJobsPerOwner` 策略。TTL 到期会移除任意终态记录；数量裁剪会在每个精确所有者桶和共享无主桶中移除最旧的已报告终态记录。运行中和停止中的 job 永远不是留存策略候选。基础组合启用一小时 TTL 与每个所有者 100 条终态记录的目标。

可续传 subagent 保持既有生命周期：continuation manager 会立即释放 settled Activation，并在后续投递时冷恢复。这里不增加外部 idle timer，也不增加 Agent 并发限制。

## 备选方案

**限制 Agent 并发。** 拒绝，因为它会改变调度容量，并且无法处理已完成记录或浏览器导航造成的留存。

**删除整个 off-stage Client Session scope。** 拒绝，因为 scope 释放还会丢弃草稿、功能局部状态与稳定 binding。只暂停 history transport 就能在不改变这些所有者的前提下释放 Host follower。

**达到数量目标时立即裁剪所有终态 job。** 拒绝，因为新完成但尚未报告的结果可能在所有者收集前消失。因此数量裁剪只选择已报告记录，TTL 则是未报告结果的显式截止时间。

**依赖 watchdog 重启。** 拒绝将其作为稳态机制，因为重启只有在中断服务后才能释放整个 heap。watchdog 可以停止不安全的后端，但 supervisor 不会自动重新启动它。

## 影响

Session persistence、事件词汇、AgentTeams 状态与并发语义均不改变。off-stage 详细历史会停止更新直到再次选择，而独立 control stream 会继续投影 running 状态、queue、job 与完成标记。保留的终态 job id 会在配置的 TTL 或已报告记录数量逐出后变为未知；持久 job 结果查询需要持久后端。

Session Controller 针对性测试覆盖 stage 切换、显式清空、masked gap、进行中的 open、binding 保留与 teardown quiescence。jobs-local 测试覆盖省略配置时的旧行为、精确所有者数量裁剪、未报告结果保护、所有终态、活动 job 保留、timer 释放与真实 Loader 配置。
