# Agent Note: 冷会话辅助目录读取元数据而非日志

Status: implemented

[English](2026-10-19-cold-session-auxiliary-catalog-metadata.md) | 中文

## 问题

打开大体量历史会话时首屏很快，因为历史打开路径读取的是经过校验的窗口；但随对话一起渲染的输入区随后会启动辅助目录工作，而该工作会物化完整的已存储日志。触发点是输入触发控制器的 scope 创建预热：构造按会话的控制器时会调用每个已注册 source 的 `warm()` 钩子。`skills/list` 以默认 projection 模式调用 `sessionQuery.observeSession`，其冷路径会读取完整日志并 hydrate projections。`commands/list` 接收 Agent 参数，因此 Typert Agent lookup 可以在参数解析阶段恢复冷 Agent。在大体量历史上（实测：166 MB、176,508 个事件、82,431 个 zstd frame），这份后台工作会在本来很快的首屏之后耗费数秒。

skill 目录当时只需要两个事实：一个目录，以及记录下来的 preset。目录本来就在不可变 Session header 里，两个值也都作为保留的 projection cache 行存在。两者都不需要读取事件日志。

## 决策

### 只读元数据的 Session observation

`SessionQueryEngine.observeSessionMetadata(sessionId, { signal?, projectionKeys? })` 返回不可变 header 加可选 projection 值，且绝不物化已存储日志：

- 实时 Session 返回所请求键的当前 projection 切点。
- 存储 Session 只付出一次 `sessionPersistence.stat`（header、revision 等廉价元数据），并在挂载 projection cache 时对所保留检查点行做一次零 I/O 的 `cachedSnapshot` 读取。它绝不调用 `open`、绝不读取事件，也不保留 prepared Session。

检查点值可能落后于已存储日志；当该行被丢弃（缓存对超出保留字节预算的记录只保留列表提示行）或属于其他生命周期时会缺席。消费方必须按键回退，而不能把该块当成完整基线。

### skill 目录使用持久化元数据

`SessionSkillCatalog.list` 通过该元数据读取请求 `workingDirectory` 与 `agentPreset`。目录依次解析为保留的当前目录、header 记录的目录、部署默认目录。preset 常驻 scope 只在有可用 projection 值时获取；否则目录回退到全局 skill 注册表。实时 Agent 保留其有效工作目录（`workingDirectory.ensure`）与其 preset 限定的注册表。Remote 能力与访问控制不变：该方法仍按 Session 寻址，请求字段与鉴权相同。

### 名单在首次用户意图时才预热

`InputTriggerController` 不再在构造函数中调用 `warm()`。`ensureWarm()` 只在流水线观察到首次用户意图时运行一次：非空草稿（`track`）、launcher 手势（`toggleSource`）或引用预览（`openReference`）。在该时刻之后注册的 source 立即预热；更早注册的 source 先接入 lexicon 通道，但等待同一时刻。`/` 菜单行为不变，因为每个 source 的候选拉取仍然走菜单自身的获取路径。

## 证据

通过正式后端写入的合成 zstd JSONL 会话，6,000 个事件、12 个独立 append frame，在 Windows、Node 24.13 上测量：

| 路径 | 操作 | 耗时 |
| --- | --- | --- |
| 冷目录 | `SessionSkillCatalog.list`（一次 `stat` + 检查点读取） | 5.5 ms |
| 同一 fixture，旧读取路径 | `sessionQuery.observeSession`（`open` + 完整日志读取） | 36.6 ms |

该 fixture 刻意小于报告中的工作负载；相关结果是比值而非绝对值，并且 Host spec 断言的是因果事实（不调用 `open`、不调用 `observeSession`），而不是对 CI 敏感的比值。报告的 5 秒属于用户的真实 Session；实现与验证期间没有访问该 Session 及其内容。

## 备选方案

**把预热改到空闲时而非 scope 创建时。** 已拒绝。定时器或 idle 回调仍会执行完整日志读取，仍要在后台耗费数秒；它只是把停顿从首屏之后挪走，并没有消除它。

**保留 scope 创建预热，只把 `skills/list` 改成只读元数据。** 已拒绝。`commands/list` 会经 Agent lookup 解析，因此在冷 Session 上挂载输入区仍会恢复冷 Agent。急切的预热本身就是触发点。

**在 skill 目录中跨 Session 缓存 preset 与目录。** 已拒绝。那会引入第二个过期所有者及其失效面。projection cache 已经拥有检查点身份、生命周期匹配与保留策略；以它的行为依据无需新增失效规则。

**只读取已存储日志的尾部来折叠最后的 preset 或目录事件。** 已拒绝。它仍会打开已存储日志、依赖各后端的 frame 索引，并重复 projection 注册表及其缓存已经提供的折叠。

**回退到 header 目录而不使用保留的当前目录。** 已拒绝。会话可能已经更换目录；保留的当前目录是其日志中的真实值，且绝不来自其他生命周期，而 header 只保留原始项目目录。

## 后果

- 冷 skill 目录的成本从 O(log) 变为 O(元数据)。大体量已存储历史只付出一次 `stat` 与一次内存中的检查点读取。
- 当某 Session 的检查点行被丢弃或轻量化时，冷目录会失去 preset 限定与当前目录：它回退到 header 目录与全局注册表。preset scope 只与最后一次持久化检查点同样新鲜，而缓存会在轮次结束、节流写回以及 detach 时写入检查点。
- `commands/list` 仍会经 Typert Agent lookup 解析或恢复冷 Agent。在冷 Session 上打开 `/` 菜单仍要付出该恢复；延后的预热现在会在首次按键或菜单手势时启动它，而不是在挂载时。冷态安全的命令目录需要 preset 限定、且不组合 Agent 的命令注册表；那仍是未完成的工作。
- Client 仍会在发送 `skills/list` 前等待该 Session 的首次历史打开成功（`sessions.using`），[先前的协调笔记](2026-09-20-session-open-read-coordination.zh.md)要求如此。

## 验证

- `packages/api/session-controller/tests/session-skills.host.spec.ts` 覆盖仅 header、保留检查点、实时 Agent、常驻 preset 与回退路径，以及一个多 frame 已存储 Session，断言它不调用 `open` 或 `observeSession`，并以 `observeSession` 作为反向对照。
- `packages/session-query/session-query/tests/observation.spec.ts` 覆盖元数据路径的实时切点、检查点提示、缺席、stat 期间挂载、stat 失败、取消与 projection 失败。
- 触发流水线与 skill source 的 Client 套件覆盖首次意图预热、故障预热的隔离以及延迟 source 注册。
- 仓库 typecheck 对改动包与聚合通过。

## 与既有记录的关系

- [会话首帧读取的缓存身份与调用时序](2026-09-20-session-open-read-coordination.zh.md) 保留 Client 侧等待首次打开以及持久化身份规则。本笔记只替换 Host 侧 `skills/list` 的完整 observation 读取。
- [Session 工作目录](../architecture/2026-09-13-session-working-directory.zh.md) 拥有 working-directory projection。本笔记读取保留的检查点行，既不提交恢复，也不激活 Agent。
- [Session observation 与 projection 所有的 Client 状态](../architecture/2026-08-25-session-observations-and-projection-owned-client-state.zh.md) 拥有精确 observation 的切点规则。元数据 observation 是明确有损的同胞路径，而非精确切点的替代。
