# Harness 0.2.3-alpha.2 适配

目标宿主为 merge 后的 `dsh-v0.2.3-alpha.2` 工作树（`apps/cli` 版本 `0.2.3-alpha.2`，vendor Cordis `4.2.0-alpha.1`，Schemastery `3.20.0-alpha.1`，zod `4.6.6`）。插件起点为 `0.1.24-dsh022rc1.1`（面向 `0.2.2-rc.1`），适配版本为 `0.1.24-dsh023a2.1`，发布渠道 npm `dsh023a2`。

## 已核实的变化及处理

- **Subagent 激活参数扁平化**（`packages/subagent/subagent/src/types.ts` / `index.ts`）：`SubagentActivationSpec` 改为 `extends Omit<SubagentStartRequest,'label'|'signal'>`，`provider`/`label`/`parent`/`prompt`/`agentOptions`/`outputSchema`/`maxDepth`/`delivery` 全在顶层，`start`/`startContinuable` 已移除。`harness-compat.startMember` 现在提交一份同时服务两代的 spec：扁平任务字段给 0.2.3，嵌套 `request` 给 0.2.2 及更早（两代都只读自己用到的字段）。`persona`/`toolFilter` 仍止步于 0.2.1 及更早的创建入口。
- **AgentTeams 成员创建入口**：成员创建优先走宿主 `Symbol.for('dsh.subagent.startAgentTeamsMember')`，因为它是唯一不套用用户全局子代理模型覆盖的创建路径，而成员路由是用户声明的例外。该 symbol 的存在即代际判断；0.2.2 及更早没有它，继续走 `startActivation`。
- **定向 drain 被树级 drain 取代**：`drainChildren(parent, ids)` 不再存在，取而代之的 `drainDescendants(parents)` 会关闭所选子代理树的准入直到根离开注册表。用它停止成员会连带停掉队长下无关的委派、并让该会话此后无法再 spawn。`harness-compat.drainMemberChildren` 在宿主提供定向 drain 时保持不变，否则只对所选成员 `cancel`（清空排队工作）+ `interrupt`（释放宿主执行），宿主在子代理空闲后自行释放 activation；停止后不再工作的保证仍由每步准入检查与 retired-id 投递守卫承担，durable attempt 在调用前已作废。
- **Core registry 不再记录运行时归属**（`packages/core/agent/src/index.ts`）：`isOwnedBy`/`roots()` 与 `enter(agent, owner)` 的 owner 参数移除，子代理血缘改读 Session header。插件从未使用这两个方法，只走 `session.header.parentSession` 与 team 记录。
- **路由鉴权换接口**（`packages/client/connection/src/rpc-host.ts`）：`requestRejection`、`authorizeIndex`、`authenticatedUrl`、`admitConnection` 与 peers 表移除；`admit(request)` 返回 `PeerAdmission`（`{peer}` 或 `{rejection: 401|403|503}`）。0.2.3 的 WebServer 自身按路由 `auth`（默认 `required`）先鉴权，因此 `src/web-routes.ts` 的包装给路由声明 `auth: 'required'`，把准入交给宿主；`admit()` 不能替代 `requestRejection`：Cordis 4.2.0-alpha.1 会把服务方法体内的 `this.<sub-service>`（`admit` 读 `this.authentication`）按**调用方 fiber** 的 `inject` 解析，未注入 `connection.authentication` 的插件上下文调用它会抛 `cannot get property "connection.authentication" without inject`，WebServer 的兜底处理器再把逃逸异常回成空响应体 400。`BrowserRequestGate` 因此只保留可选的 `requestRejection`：0.2.2 及更早仍由插件返回面板自己的 `401/403/503` JSON，0.2.3 及以后交给宿主。`scripts/web-routes-verify.mjs` 把 Connection 挂在真实的插件 fiber 上，并用宿主的 `webserver/authorize` 瀑布复现路由鉴权；此前在根上下文直接 `apply` 会把 `connection.authentication` 变成根 provision，掩盖该缺陷。
- **Subagent provider 列表移除**：`SubagentRuntime.list()` 不再存在，缺失 provider 的诊断只在仍有该枚举的宿主上附带可用 provider 名。
- **PTC 程序格式默认改为 scoped REPL**（`packages/ptc-runtime/ptc-runtime-node/src/config.ts`、`execution.ts`）：`ptc-runtime-node` 的 `executionMode` 默认仍是 `persistent-in-memory`，但 `replScoped` 现在按 `resolvePersistentExecution()` 解析，`programFormat` 因此是 `scoped-repl`：程序不再允许顶层 `return`，模型可见的工具结果来自 `inspect()`/控制台输出而不是最后一个表达式。插件产品代码不解析程序文本；`scripts/capabilities.test.mjs` 与 `scripts/fixtures/harness-runtime-protocol.mjs` 改为按 `ctx.ptcRuntime.programFormat` 生成程序（function body 用 `return`，scoped REPL 用 `inspect`），普通工具调用在两种格式下都写成纯语句序列，因此仍覆盖 0.2.2 及更早宿主。
- **npm 开发闭包**：`devDependencies` 全部 DSH 包锁到 `0.2.3-alpha.2`，Cordis `4.2.0-alpha.1`，Schemastery `3.20.0-alpha.1`（与宿主 vendored 版本一致，避免同一宿主包解析出两份实例），`pnpm-workspace.yaml` 的 303 个 override 同步；`compatibility.json` 把 `0.2.3-alpha.2` 列为 preview 目标（alpha 不能作为 recommended），`0.2.2-rc.1` 仍是 recommended，`0.2.1-rc.2` 及更早目标保留为 legacy；peer 范围逐条枚举同一组目标，`engines.dsh` 同步。

## 宿主前提（0.2.3-alpha.2）

上游 0.2.3-alpha.2 删除了 `packages/subagent/subagent/src/internal.ts`，该模块携带插件进行 durable mailbox 确认所依赖的宿主专用 prompt 协议（`Symbol.for('dsh.subagent.deliverPrompt')` 的 queue/steer 投递），也没有任何成员创建入口。fork 重建该模块并新增 `startAgentTeamsMember`，插件通过 `Symbol.for` 查找使用，不需要导入该子路径。在未经 fork 重建的上游 0.2.3-alpha.2 宿主上，插件会在挂载时显式失败（`unsupported Harness subagent contract (missing continuable setup and modern host queue)`），不会把成员投递降级为模型侧 steering。

## 验证与边界

在 `fork-plugins/dsh-agent-teams` 内执行 `pnpm typecheck`、`pnpm build`、`pnpm verify`（含 compatibility/doctor/capabilities/harness-contract/lifecycle/stress/quality-gates 等全部子项）。`harness-compat-tdd` 新增三组回归：0.2.3 扁平 spec 的成员创建（含 persona/toolFilter 剥离与深度守卫读顶层 `parent`）、AgentTeams 入口优先于普通创建且吞掉原生结算失败、以及无定向 drain 的宿主只取消并中断所选成员。`scripts/fixtures/harness-runtime-stability.mjs` 与 `scripts/web-routes-verify.mjs` 按新宿主面重写。

未在本次执行：真实模型服务、交互式浏览器、Electron 桌面安装、其他操作系统，以及 `scripts/harness-runtime-verify.mjs` 的打包产物 × 多宿主 CLI 矩阵（需真实宿主 CLI 与隔离 profile）。0.2.3-alpha.2 目标要求宿主为 fork 重建版本；更早宿主仍保留兼容分支，结论以其各自的迁移记录为准（[0.2.2-rc.1](../harness-0.2.2-rc.1/README.md)）。

`lib/` 由版本管理，已用适配后源码重新构建并提交。
