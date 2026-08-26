# Agent Note: 已结算历史投影与有界浏览器窗口

Status: implemented

[English](2026-08-26-settled-history-browser-window.md) | 中文

## Problem

按消息数分页并不能限制浏览器 history 响应。一条已 finalized 的 Assistant 消息可以通过 `sourceEventSeqs` 引用数十万个持久 `assistant/chunk` 事件，因此 Host 会同时传输全部 chunk 和完整最终消息。JSON 解析、线协议校验、Conversation 匹配和 Context match 驻留都发生在 DOM 虚拟化能够发挥作用之前。即使刷新页面或重启 Host 后持久 Session 完好，一页数据仍可能耗尽浏览器 renderer。

页面保持打开时，同一种增长还会继续。resident Client Session 会在首次尾页之后保留每个 live event、view 和 Conversation match。折叠的 Tool 行也会在读者展开之前派生完整格式化参数、扁平化结果和卡片数组副本。

## Decision

history API 默认继续交付 raw 事件，并接受 Web Runtime 使用的增量请求 `projection: 'settled'`。分页首先照常选择按消息对齐的 raw 区间；settled 投影随后把每个 finalized Assistant step 的 chunk 流替换为 usage 记录、第一个 token delta 和最终 `assistant/message`。usage 记录保留包含重试的计量，第一个 delta 保留首 token 与首次可见时间，最终消息提供完整内容。若最终消息的 provenance 只引用同一步骤的 chunk，响应副本会省略 `sourceEventSeqs`。原事件和持久日志保持不变。

每个 history 响应携带 `range`，表示投影前选择的 raw `{startSeq, endSeq}` 区间。Client Session 以该区间完成旧页相邻性、live 去重、重连 baseline 比较和 gap repair；投影后的 `events` 数组可以稀疏。该字段保持可选，使旧的连续 fixture 或 carrier 可以从首尾返回事件推导区间。

Web Runtime 对普通 Session 与可寻址 subagent 都请求 settled history。`liveWindowRebaseEventThreshold` 是经过校验的 Runtime 插件配置，默认值为 20,000 个驻留 raw event。当 `assistant/message` finalize 一个 model phase 且窗口达到阈值时，一次尾页请求会把过大的 live 后缀替换为 settled 投影。请求期间到达的事件进入既有序列 buffer，并在返回的 raw range 之后拼接。请求失败会恢复全部 buffered event，把重试推迟到后续活动，并且不会进入即时重试循环。rebase 成功时，raw range 位于新尾页之前且与其连续的已加载旧投影页会继续保留。

尚未 finalized 的 model phase 保持精确：它的 chunk 不会被截断或投影删除。这是驻留上限的必要例外，因为此时还没有携带等价完整内容的最终消息。

折叠 reasoning 原本就通过 `DisclosureRow` 只挂载单行摘要；回归测试固定完整 reasoning body 在展开前不存在。Tool 行增加明确的重内容 body 组件。折叠模型只计算标题、摘要、状态和轻量 presence 标记；格式化参数、完整结果扁平化、recovery 文本和大型卡片数组副本改为缓存 getter，只有展开 body 或 details view 首次读取时才执行。

## Verification

Host 测试覆盖 raw 默认兼容、普通／subagent settled 读取、空页与旧页、raw range、compaction 对齐分页、首 token 保留、纯 chunk provenance 省略和输入不可变。Runtime 序列测试覆盖稀疏首屏、旧页相邻性、重连与 gap repair、finalized 阈值 rebase、旧投影保留、live buffer 拼接、rebase 失败恢复、延迟重试以及普通／subagent 请求一致性。UI 组件测试证明折叠 reasoning 不挂载完整 body，折叠 Tool 行不执行重 getter，而展开会执行并缓存每项派生。

本次问题规模的只读页在一个按消息对齐的尾页中包含 256,008 个事件：256,004 个 chunk 占约 39 MiB，最终消息连同 provenance 约 2.4 MiB。存储 Session 始终是事实来源。

## Alternatives considered

**删除或重写已存 chunk。** 不予采纳，因为 chunk 是持久回放与诊断证据。投影属于读取边界，不能修改 Session、JSONL、fork、resume 或 export 数据。

**降低消息数量。** 不予采纳，因为实测只含一条消息的页面仍包含完整的 256,004-chunk 流。消息数量与 raw event 数量不是同一种上限。

**裁剪 raw 页面但不报告覆盖的序列区间。** 不予采纳，因为 Client 会把省略的 seq 解释为传输丢失，重复修复 gap，并破坏旧页相邻性。`range` 明确表达序列覆盖范围。

**轮询或重新加载每个运行 Session。** 不予采纳，因为健康会话也会反复解析 history，成本随 resident Session 数量增长。阈值触发的 single-flight rebase 只在等价 finalized 内容已经存在后运行。

**先实施 DOM 列表虚拟化。** 不作为首个修复，因为超大 JSON 响应、校验、Conversation fold 和 match 驻留都发生在 React 渲染之前。数据与计算有界后，DOM 虚拟化仍有价值，但不能替代前两者。

## Consequences

打开 finalized 长会话时，浏览器传输并驻留的是最终展示，而不是每个 token delta；raw API 调用方和精确 session-log export 仍保留完整保真度。长时间运行的页面跨过可配置阈值后会释放已 finalized chunk 流，读者已经加载的旧投影仍然可用。折叠 Tool 行避免与隐藏详情大小成正比的工作。

新增的 history 请求与响应字段扩展 Web 线协议，但不改变任何 Session event、磁盘版本、压缩产物或存储路径。单个仍在运行的 model phase 可以在最终消息到达前超过配置阈值。完整的可变高度 DOM 虚拟化以及任意行卸载后的滚动锚点保持仍属于独立展示工作。
