# Agent Note: 工具调度器故障保留提供方有效历史

Status: implemented

[English](2026-09-18-tool-scheduler-failure-settlement.md) | 中文

## 问题

一条 assistant 消息可以包含多个工具调用。循环会在有序策略与派发前记录每个已启动的 `tool/call`，但意外调度器故障可能在匹配的 `tool/result` 持久化前结束 step。失败 Turn 在结构上仍可读取，但要求工具结果紧随调用的提供方会拒绝此后的每次请求。一次源码启动从 `lib/` 加载 ToolRuntime provider、从 `src/` 加载 AgentLoop consumer，使两者模块局部的调度器 symbol 身份不同，从而触发了这条路径。

取消已经会关闭未派发调用，崩溃恢复则会关闭仍处于开放尾部 Turn 中的调用。这两种机制都不覆盖正常封口的错误 Turn，因此重启无法通过在已完成边界之后追加事件来修复该历史。

## 决策

[源码启动决策](../architecture/2026-07-29-dsh-source-launch-tsx-esm.zh.md)让配置的 workspace provider 与 consumer 保持在源码面。AgentLoop 同时把调度器故障视为一种必须先结算工具组的终态 Turn 错误：停止补充调用，等待每项在途派发，再按模型顺序为 assistant 的每项调用追加一个结果，然后重新抛出原始故障。

工具主体可能已经进入派发的调用获得 `TOOL_OUTCOME_UNKNOWN` 和既有的安全重试提示。派发前被拒绝的调用，包括独占屏障之后的调用，获得 `TOOL_NOT_STARTED`。这些结果陈述执行确定性，而不是把调度器缺陷重新分类成普通工具失败。完成平衡的 step 后，Turn 仍保留原始调度器错误。

对于该规则实施前产生的已封口历史，DeepSeek Messages 会在 wire 边界为每个缺失 id 投影一个空的 `is_error` 工具结果。按协议要求，该投影位于普通用户内容、system 更新、另一条 assistant 消息或请求结束之前。它不修改 Session 日志，也不虚构结果正文。重复调用 id、重复结果以及没有匹配调用的结果仍然无效。

## 验证

精确的 `node --import tsx/esm apps/cli/src/bin.ts` 入口会启动临时的随附 headless profile，并完成一次真实 shell 工具往返。Agent-loop 测试强制并发派发拒绝，在排空期间保持另一项工具主体运行，并验证有序的 `TOOL_OUTCOME_UNKNOWN` 与 `TOOL_NOT_STARTED` 结果先于原始 Turn 错误。DeepSeek Messages 测试覆盖部分结果、用户正文前缺失结果、请求末尾缺失结果、system 更新位置、持久输入不变、重复 id 与无匹配结果。

## 备选方案

**让调度器故障保持终态且不写结果。** 这保留了不确定性，却会留下提供方无效 transcript。显式 unknown/not-started 结果保留相同不确定性，同时让 Session 可继续使用。

**把每项故障都报告为未启动。** 被拒绝的派发可能已经调用带副作用的工具主体。声称它未运行会鼓励不安全重试；`TOOL_OUTCOME_UNKNOWN` 保留该歧义。

**重写受影响的 Session 文件。** 已发布 generation 不可变，原地修改还会抹去事故证据。确定性的提供方投影无需改变持久历史或 Session 格式即可恢复兼容。

**接受任意畸形工具历史。** 只有缺失结果可以无歧义地合成。未知或重复的真实结果仍表示身份冲突，并继续硬失败。

## 结果

- 调度器缺陷仍会使 Turn 失败，但不能再破坏后续提供方请求。
- 在途调用会在提交恢复结果前完全停稳；unknown 结果不声称副作用发生或未发生。
- DeepSeek Messages 可以恢复缺少结果的已封口历史，持久日志仍保留精确事故证据。
- 历史恢复会为每项缺失结果向提供方请求增加一个空错误块，除协议表示外不增加正文 token。
- 并行调度器保留顺序、容量、取消与重新分类规则；本决策只取代原先的故障结算策略。

本决策部分取代[并行工具调用执行](../feature/2026-07-10-parallel-tool-call-execution.zh.md)中的调度器故障章节。
