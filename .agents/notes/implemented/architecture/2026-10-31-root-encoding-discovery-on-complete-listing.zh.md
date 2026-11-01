# Agent Note: 根编码发现属于完整列举

Status: implemented

[English](2026-10-31-root-encoding-discovery-on-complete-listing.md) | 中文

## 问题

一个 JSONL 根只属于一种物理编码，因此配置为 `zstd` 的后端不得静默忽略以纯文本存储的会话（反之亦然）。后端用 `ensureRootEncoding()` 执行该约束：每进程一次，在首个 `create`、`open`、`stat`、`readWindow` 或无排除列举之前，遍历每个 Session 目录，并拒绝持有另一后缀的目录。

该预扫描有两项成本。其一，它把全库遍历放在按会话的操作上：一次定向 `stat` 或窗口读取在读取自己需要的那个目录之前，先付出每个 Session 目录一次 `readdir`。其二，`checkRootEncoding()` 经 `mapSessionDirectories` 使用共享的 `listLimit`，与 `list()`、`listHeaders()` 是同一个 FIFO 限流器。在报告的复现场景中（18,985 个 Session 目录；回访用户的 322 MB 会话由窗口读取打开，同时 `session.list` 到达），列表在 3.86 s 内没有发出任何文件系统调用，而编码检查完成了 18,985 次 `readdir` 与 360 次 `stat`；列表自己的目录与 `stat` 工作随后只用了 63 ms。

该遍历还是重复的。每次完整扫描本来就经 `resolveGenerationInDirectory` 选择每个 Session 目录，而该函数会拒绝另一后缀的 generation；因此无排除的列举在刚付出预扫描代价之后，又用扫描证明了同一事实。

## 决策

### 按会话操作只校验它触及的目录

`stat`、`open`、`readWindow` 与 `resolveCurrentLog` 经 `findLog`/`resolveGenerationInDirectory` 定位产物，后者拒绝该会话目录中的相反编码 generation，并给出该目录中最高规范版本。实体化与写租约获取在发布前经 `rejectOppositeArtifact` 校验目标目录。这些路径不再运行预扫描，成本因此是项目目录遍历加上所访问的那一个 Session 目录。

### 完整扫描就是全库检查

`listGenerations` 对每个被访问的 Session 目录应用 `resolveGenerationInDirectory`，因此无排除的 `list()` 或 `listHeaders()` 会遍历整个根，并在第一个持有另一编码的目录处失败。`listArtifacts` 中重复的预扫描被删除；遍历本身就是检查。跳过目录的列举（`excludeSessionIds`/`excludeSubagentSessions`）只证明它访问过的目录，这本来就是该路径的契约。

### 报告点

混合根会在完整列举（启动发现及之后任何完整列举）以及每次访问受影响会话时大声失败。对以已配置编码存储的无关会话的定向读取会成功；它不是根审计。写入新的 Session 目录只校验该目录，因此既有根上的错误 `compression` 设置会在下一次完整列举时暴露，而不是在创建时暴露。跨进程姿态不变：该检查一直是尽力而为的，因为任何检查之后其他进程都可能写入。

## 备选方案

**给编码检查独立限流器。** 这能让并发列表不再排在检查之后，但首次窗口读取仍要等待全库遍历，且该遍历仍争用同一份 I/O。要修的性能在读取路径上，而不只在限流器上。

**把全库检查移到后台。** 发后即忘的拒绝只能记录日志，配置错误的根不会让需要答案的用户可见操作失败；把它称作“大声”只能依赖翻阅日志。后台遍历也仍会付出全库 `readdir`。

**用 `.session-catalog.json` 跳过已知目录。** catalog 记录的是 header 与日志身份，不是物理编码；其他进程可以在它被读取后写入或替换条目，因此信任它做编码判断会静默忽略相反 generation。为 catalog 增加编码字段属于持久化格式变更，而完整扫描本来就能观察到同一事实。

**只在 `create` 上保留全库检查。** 首条消息仍要付出全库遍历，而 `create` 写入的新 Session 目录恰恰是唯一无法揭示根中其他会话编码的目录。

**增加持久化的根编码标记文件。** 这需要新的持久化产物，并为早于它的根做迁移，用来替代一种完整列举本来就能从数据本身完成的检查。

## 后果

- 首次 `stat`、`open` 或 `readWindow` 只读项目目录与所访问的那一个 Session 目录，而不读每个 Session 目录；编码工作不再占用列表限流器，因此并发列表立即开始。
- 混合根仍会大声失败，但失败时机改变：发现阶段报告它，受影响的会话访问立即报告它，无关的定向读取不报告。以另一编码写入的新会话会在下一次完整列举时被报告。
- 持久化格式、catalog 条目、配置字段与跨进程规则均不变；被拒绝目录的诊断仍给出最高规范的相反 generation。

## 验证

`packages/session/session-persistence-jsonl/tests/root-encoding-read-cost.spec.ts` 在包含 60 个未写入 Session 目录的语料上统计 `readdir`：首次 `stat` 与 `readWindow` 只触及根与被访问目录；并发 `listHeaders()` 在被挂起的全库遍历会阻塞的情况下仍完成；混合根会被 `list()` 及对相反编码会话的定向访问拒绝，而同编码目标仍可读取。恢复 `stat`/`readWindow` 上的 `ensureRootEncoding` 预扫描会使四个用例全部失败（触及 62 个 Session 目录、遍历 3 个被挂起目录、列表排队两秒）。

## 相关

[物理编码契约](../../../../packages/session/session-persistence-jsonl/README.zh.md) 陈述面向用户的规则，[已知限制](../../../../packages/session/session-persistence-jsonl/README.zh.md#known-limitations-and-deferred-work) 条目记录错误 `compression` 值的报告时机。
