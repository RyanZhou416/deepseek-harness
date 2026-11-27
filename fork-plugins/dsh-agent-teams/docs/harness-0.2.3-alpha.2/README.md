# Harness 0.2.3-alpha.2 适配

目标宿主为 merge 后的 `dsh-v0.2.3-alpha.2` 工作树（`apps/cli` 版本 `0.2.3-alpha.2`，vendor Cordis `4.2.0-alpha.1`，Schemastery `3.20.0-alpha.1`，zod `4.6.6`）。插件起点为上游 `v0.1.31`（面向 `0.2.2-rc.2`–`0.2.2-rc.5`），适配版本为 `0.1.31-dsh023a2.1`，发布渠道 npm `dsh023a2`。

## 已核实的变化及处理

- **树管理器与扁平激活参数。** 上游 `v0.1.31` 已适配 0.2.2-rc.2+ 的树管理器（`rootOf`、`manager.deliverToMember`、`manager.dispose`）与扁平 `SubagentActivationSpec`：`harness-compat.startMember` 在 `treeBoundary(runtime)` 存在时提交顶层任务字段（0.2.3-alpha.2 属于该代际），否则提交嵌套 `request`；`drainMemberChildren` 只 join 所选创建分支并 dispose 其驻留 activation，不调用宿主的树级 drain。fork 原有的扁平 spec 与 cancel+interrupt 补丁因此退役；cancel+interrupt 只保留给既无定向 drain、又无树管理器的主机。
- **AgentTeams 成员创建入口。** 成员创建优先走宿主 `Symbol.for('dsh.subagent.startAgentTeamsMember')`，因为它是唯一不套用用户全局子代理模型覆盖的创建路径，而成员路由是用户声明的例外。该 symbol 的存在即代际判断；0.2.2 及更早没有它，继续走 `startActivation`。宿主的树级 drain 不能用于停止成员：它关闭整棵树的准入直到根离开注册表，会连带停掉队长下无关的委派并让该会话此后无法再 spawn。
- **Core registry 不再记录运行时归属**（`packages/core/agent/src/index.ts`）：`isOwnedBy`/`roots()` 与 `enter(agent, owner)` 的 owner 参数移除，子代理血缘改读 Session header。插件从未使用这两个方法，只走 `session.header.parentSession` 与 team 记录。
- **路由鉴权换接口**（`packages/client/connection/src/rpc-host.ts`）：`requestRejection`、`authorizeIndex`、`authenticatedUrl`、`admitConnection` 与 peers 表移除；`admit(request)` 返回 `PeerAdmission`（`{peer}` 或 `{rejection: 401|403|503}`）。0.2.3 的 WebServer 自身按路由 `auth`（默认 `required`）先鉴权，因此 `src/web-routes.ts` 的包装给路由声明 `auth: 'required'`，把准入交给宿主；`admit()` 不能替代 `requestRejection`：Cordis 4.2.0-alpha.1 会把服务方法体内的 `this.<sub-service>`（`admit` 读 `this.authentication`）按**调用方 fiber** 的 `inject` 解析，未注入 `connection.authentication` 的插件上下文调用它会抛 `cannot get property "connection.authentication" without inject`，WebServer 的兜底处理器再把逃逸异常回成空响应体 400。`BrowserRequestGate` 因此只保留可选的 `requestRejection`：0.2.2 及更早仍由插件返回面板自己的 `401/403/503` JSON，0.2.3 及以后交给宿主。`scripts/web-routes-verify.mjs` 把 Connection 挂在真实的插件 fiber 上，并用宿主的 `webserver/authorize` 瀑布复现路由鉴权。
- **Subagent provider 列表移除**：`SubagentRuntime.list()` 不再存在，缺失 provider 的诊断只在仍有该枚举的宿主上附带可用 provider 名。
- **PTC 程序格式默认改为 scoped REPL**（`packages/ptc-runtime/ptc-runtime-node/src/config.ts`、`execution.ts`）：`ptc-runtime-node` 的 `executionMode` 默认仍是 `persistent-in-memory`，但 `replScoped` 现在按 `resolvePersistentExecution()` 解析，`programFormat` 因此是 `scoped-repl`：程序不再允许顶层 `return`，模型可见的工具结果来自 `inspect()`/控制台输出而不是最后一个表达式。插件产品代码不解析程序文本；`scripts/capabilities.test.mjs` 与 `scripts/fixtures/harness-runtime-protocol.mjs` 改为按 `ctx.ptcRuntime.programFormat` 生成程序，普通工具调用在两种格式下都写成纯语句序列，因此仍覆盖 0.2.2 及更早宿主。
- **活动面板取数。** 宿主仍接受 fork 的 `captainSessionId`、成对 `teamCaptainSessionId`+`teamId`、`detail=1` 与非法 scope 的 `400`；同时接受上游客户端（`v0.1.31`）的 `session=` 与 `summary=1`，未变化的轮询由 `writeJsonWithEtag` 以 `304` 复核。`collectTeamsActivity`/`collectArchivedTeamsActivity` 统一收一个 options，`includeDetails` 保留为 `summary` 的 fork 别名；staged 计划即使请求 summary 也保留长说明与执行提示词。
- **npm 开发闭包**：`devDependencies` 全部 DSH 包锁到 `0.2.3-alpha.2`，Cordis `4.2.0-alpha.1`，Schemastery `3.20.0-alpha.1`（与宿主 vendored 版本一致，避免同一宿主包解析出两份实例），`pnpm-workspace.yaml` 的 303 个 override 同步；`compatibility.json` 把 `0.2.3-alpha.2` 列为 preview 目标（alpha 不能作为 recommended），`0.2.2-rc.1` 仍是 recommended，`0.2.1-rc.2` 及更早目标保留为 legacy；peer 范围逐条枚举同一组目标，`engines.dsh` 同步。上游 `v0.1.31` 改成 `"*"` peer 加最低宿主 `engines.dsh`，fork 不采用该模型：本矩阵没有 0.2.3-alpha.2 以外的上游新增目标，且 fork 要求精确、已审计的宿主集合。

## 宿主前提（0.2.3-alpha.2）

上游 0.2.3-alpha.2 删除了 `packages/subagent/subagent/src/internal.ts`，该模块携带插件进行 durable mailbox 确认所依赖的宿主专用 prompt 协议（`Symbol.for('dsh.subagent.deliverPrompt')` 的 queue/steer 投递），也没有任何成员创建入口。fork 重建该模块并新增 `startAgentTeamsMember`，插件通过 `Symbol.for` 查找使用，不需要导入该子路径。在未经 fork 重建的上游 0.2.3-alpha.2 宿主上，插件会在挂载时显式失败（`unsupported Harness subagent contract (missing continuable setup and modern host queue)`），不会把成员投递降级为模型侧 steering。

## 验证与边界

在 `fork-plugins/dsh-agent-teams` 内执行 `pnpm typecheck`、`pnpm build`、`pnpm verify`（含 compatibility/doctor/capabilities/harness-contract/lifecycle/stress/quality-gates 等全部子项）。上游 `v0.1.31` 新增的树管理器回归（`harness-compat-tdd.mjs` 的 0.2.2-rc.2 树 ABI、定向 teardown 与 HMR 用例）与 `issue-234`/`issue-272`/`issue-336` 等上游回归均在本宿主闭包内运行；后者的工具装配改用 0.2.2+ 的「`ToolRuntime` + 独立原生执行器 + `session-projection`」组合与批量 `tools.execute({ calls })`。

未在本次执行：真实模型服务、交互式浏览器、Electron 桌面安装、其他操作系统，以及 `scripts/harness-runtime-verify.mjs` 的打包产物 × 多宿主 CLI 矩阵（需真实宿主 CLI 与隔离 profile）。0.2.3-alpha.2 目标要求宿主为 fork 重建版本；更早宿主仍保留兼容分支，结论以其各自的迁移记录为准（[0.2.2-rc.1](../harness-0.2.2-rc.1/README.md)）。

`lib/` 由版本管理，已用适配后源码重新构建并提交。
