# Harness 0.2.2-rc.1 适配

目标宿主为 merge 后的 `dsh-v0.2.2-rc.1` 工作树（`package.json` 版本 `0.2.2-rc.1`，vendor Cordis `4.1.0`，`@deepseek-ai/cordis-plugin-group` `1.1.0`）。插件起点为 `0.1.24-dsh021rc2.1`（面向 `0.2.1-rc.2`），适配版本为 `0.1.24-dsh022rc1.1`，发布渠道 npm `dsh022rc1`。

## 已核实的变化及处理

- **按 Agent 持有的模型选择**（`packages/core/agent/src/model-selection.ts`）：`installModelSelection` 只接受 scoped `Context`，`Agent.model` 承载选择，`agent/pre-step` 的 `modelSelection` 在组装前捕获，`agent/request` 不再能改 provider/model/effort（改路由要 `agent.model.select()`，且只在下一步生效）。适配层以 `typeof agent.model?.select === 'function'` 探测新宿主：新宿主只安装切换通知、按需把成员保存的路由记录为选择；旧宿主继续用可变 ref 覆盖请求路由并在同一步重试。`fallback` 在新宿主上的语义随之变化：失败请求不改为在途重试，备用路由写入成员选择并从下一步生效，失败的那次 attempt 仍记为失败。
- **`ToolRuntime` 拆分执行器**（`packages/core/tools/src/index.ts`、`packages/core/tool-executor-*`）：`mode` 配置变为 `z.never()`，`tools.presentAs()` 移除，`tools.setExecutor()` 按 scope 选择 native/PTC 执行器，`tools.execute()` 接受整批 `calls`。插件源码只用 `register`/`restrict`/`view`，无需改动；测试装配改为挂载 `@deepseek-ai/dsh-tool-executor-native` 作为部署默认执行器、按测试代理 scope 挂载 `dsh-tool-executor-ptc` 复现嵌套分发，并以批调用结果取单条结果。
- **投影注册 await/`ProjectionHandle`**：`SubagentRuntime` 现在 `inject` `sessionProjections` 并 `await register(...)`，`dsh-llm-retry` 通过 handle 读状态、并检查 `ctx.fiber.uid`。插件不注册宿主投影；测试装配补齐这两个服务面。
- **session-controller 拆分**（`HistoryController` / `WebController`）：`sessionController` 服务名与 `resolveAgent` 未变，插件只经 `ctx.get('sessionController')` 做能力探测，无需改动。
- **npm 开发闭包**：`devDependencies` 全部 DSH 包锁到 `0.2.2-rc.1`，Cordis `4.1.0`，Schemastery `3.19.0`（与宿主 `~3.19.0` 对齐，避免同一宿主包因 peer 解析出两份实例），`pnpm-workspace.yaml` 的 304 个 override 同步到 `0.2.2-rc.1`，`@deepseek-ai/cordis-plugin-group` 从 `1.0.5` 提到 `1.1.0`（其 peer 现为 Cordis `~4.1.0`、loader `~1.1.0`）。`compatibility.json` 把 `0.2.2-rc.1` 设为 recommended，`0.2.1-rc.2` 及更早目标保留为 legacy；peer 范围逐条枚举同一组目标。
- **与本插件无关但已核实**：`LlmRequestPurposeMap` 声明合并（插件不发起带 `purpose` 的 LLM 请求）、投影帧 `changes[]` 与 `stateOf`/`cachedSnapshot` 弃用（插件不注册、不读取宿主投影）、`session.follow` 不再自动激活 Agent（插件客户端不使用 `follow`，成员导航走 `uiWorkspace.openSession(SubagentAddress)` 或普通会话打开的回退分支）、ui-chat context-menu slot 重构（卡片注册与类型检查均无变化）。

## 验证与边界

在 `fork-plugins/dsh-agent-teams` 内执行 `pnpm typecheck`、`pnpm build`、`pnpm verify`（含 compatibility/doctor/capabilities/harness-contract/lifecycle/stress/quality-gates 等全部子项），三者均通过：25 个 `node:test` 套件共 301 项通过（跳过 4 项），脚本式断言 682 项 PASS，`verify:git-artifact` 确认提交的 `lib/` 与源码一致。doctor 以插件自身安装闭包检查 320 个 DSH 包，要求同版本、单一解析身份。

本次修复的测试漂移：`installModelSelection` 单参签名与 `Agent.model` 选择（`harness-compat-tdd`、`verify.mjs`、`member-failure-tdd`）、工具执行器拆分与批调用（`capabilities.test.mjs`）、`sessionProjections` 的 `ProjectionHandle` 与 `ctx.fiber`（`harness-compat-tdd`、`member-failure-tdd`）。断言按新行为改写并保留原意图：路由仍必须在首个请求前到达成员、冷恢复仍恢复到已保存路由、失败切换仍必须只发生一次、工具呈现切换仍不得改动固定队长前缀。

未在本次执行：真实模型服务、交互式浏览器、Electron 桌面安装、其他操作系统、真实用户数据迁移，以及 `scripts/harness-runtime-verify.mjs` 的打包产物 × 多宿主 CLI 矩阵（需真实宿主 CLI 与隔离 profile，由上级运行时验证承担）。更早的宿主仍保留兼容分支；本次本地只实测 `0.2.2-rc.1` 开发闭包，历史宿主的结论以其各自的迁移记录为准。

`lib/` 由版本管理，已用适配后源码重新构建并提交。
