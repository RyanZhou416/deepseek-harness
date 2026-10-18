# Fork 维护的插件

[English](README.md) | 中文

此目录存放必须与本 fork 的 DSH API 同步适配、并随 fork 一起分发的插件源码。它与官方 `packages/` 目录分离，避免常规 DSH 上游合并把第三方插件误当成官方 workspace package，也把未来冲突限制在 `fork-plugins/` 内。

## 仓库内构建与安装

Windows 的 `build.cmd` 在普通根构建之后从源码构建两个插件，并把它们链接到选定的 `web` profile。无需第二条命令、私有 registry 或手工提供的 tgz。构建会**修改 profile**，因此必须先停止 Host：Host 端口（`3080`）仍在监听时，构建会在触碰任何 profile 文件之前失败。

`scripts/fork-plugins-build.ts` 使用 `DSH_HOME`（未设置时用 `%USERPROFILE%\.dsh`），目标是 `profiles\web`。它把两个包 staging 到被忽略的 `.build/fork-plugins/`，再用 `dsh plugin --profile web add <绝对 staging 目录>` 安装，记录为 pnpm `link:`。修改前会把 `package.json` 与 `cordis.patch.yml` 备份到 `.build/fork-plugins/backups/`，并记录源码 key，使未变化的第二次运行既不重建也不重装。全新的 `web` profile 会先初始化；不会读取或写入任何 Session、附件、凭据、projection cache 或 `.agent-teams` 数据。

- Subscriptions 从源码编译 `lib/index.js` 与 `lib/client.js`。staged manifest 内联 `@tormentalabs/claude-code-wire-compat`（来自仓库 tgz）与 `undici`，删除仅类型使用的 `@deepseek-ai/dsh-llm-request-record` peer，且不声明运行时依赖。公开的 optional provider 条目（`@cursor/sdk`、`@oven/bun-*`）保留声明；link 安装不会安装被链接包的 optional 依赖，因此这些 provider 需要另行提供对应包。staged 包不附带声明文件；源码检出仍是类型来源。
- AetherShell 从源码编译 `lib/lifecycle.mjs`，并保持所有 `@deepseek-ai/*` peer 为外部依赖 `0.2.1-rc.2`。

诊断构建时可直接运行该步骤（仍须停止 Host）：

```powershell
$env:DSH_HOME = 'C:\path\to\isolated-home'
pnpm exec tsx scripts/fork-plugins-build.ts
```

## macOS profile setup

`build.command` 成功后，`setup.command` 会校验并把当前 Agent Teams、Context 与 Subscriptions 产物安装到接收 Mac 的 `web` profile，移除 `dshmarket`，并应用 Context 低开销 bounds。它不会导入其他机器的运行数据，且只备份可能被改动的四个本机 profile 配置文件；可以先在零写入情况下查看精确动作：

```sh
./setup.command --dry-run
./setup.command
./run.command
```

该 setup 会刻意省略 marketplace 插件、watchdog、自定义 preset 和 process-worker profile。这些可选运行时选择由每台机器单独管理。

## Agent Teams

- 源码：`fork-plugins/dsh-agent-teams`
- 当前私有版本：`0.1.20-dsh017rc1.3`
- 上游底座：`NanmiCoder/dsh-agent-teams v0.1.20`
- 私有宿主目标：`dsh-v0.1.7-rc.1`
- 安装产物：`fork-plugins/releases/nanmicoder-dsh-agent-teams-0.1.20-dsh017rc1.3.tgz`
- 产物 SHA256：`8CCAA66D5E026DBED6363CA569B25BB8D4869E931BD92DC495458175C151980A`

上游 v0.1.20 更新了文档，运行时代码沿用 v0.1.19 的成员启动恢复、repair scope 纠正、原子 roster 创建、next-step 协调、陈旧 attempt 拒绝与任务纠正。私有 RC.1 层保留 awaited `agent/created` 启动，使用 projection 刷新打开冷成员会话，并采用带类型的 `agent-teams-host` 消息来源；冷 Captain 邮箱恢复和有界未读邮箱缓存继续生效，磁盘格式不变。

每条 Team 消息都会先进入持久 Team 邮箱，再尝试 Host 投递。只有 Host 把消息接纳到 DSH 持久收件箱后，插件才会把它标记为已投递；已进入不可中断工具的接收方会在工具结算后消费这条排队输入，而不会被抢占。Host 投递失败会让 Team 记录保持可重试；不活跃的 Captain 会冷恢复并按顺序重投未确认记录。

成员每次更新任务都要带上当前 `attempt_id`。遗漏它会得到包含当前 id 的可重试错误，且不会撤销 attempt；提供不同 id 才是真正的陈旧更新，并会在接管或重新分配后被拒绝。

同事 clone 本 fork、设置好自己的 `DSH_HOME` 并关闭正在运行的 DSH 后，可在仓库根目录执行：

```powershell
$artifact = (Resolve-Path .\fork-plugins\releases\nanmicoder-dsh-agent-teams-0.1.20-dsh017rc1.3.tgz).Path
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add $artifact
```

这只会更新该同事自己的 profile；不会复制或覆盖任何 Session、附件或 `.agent-teams` 数据。

构建和验证：

```powershell
cd fork-plugins\dsh-agent-teams
corepack pnpm@10.30.2 install --frozen-lockfile --ignore-scripts
corepack pnpm@10.30.2 typecheck
corepack pnpm@10.30.2 build
corepack pnpm@10.30.2 verify
corepack pnpm@10.30.2 pack --pack-destination ..\releases
```

更新官方 Agent Teams 前，先保证 DSH 已关闭并保留 profile 配置备份，再执行：

```powershell
git subtree pull --prefix=fork-plugins/dsh-agent-teams https://github.com/NanmiCoder/dsh-agent-teams.git <tag> --squash
```

随后重新移植或退役 `FORK_MAINTENANCE.md` 所列 fork 行为、提升私有版本、构建新 tgz，并在隔离 `DSH_HOME` 中验证启动。不得把 npm `@latest` 直接安装到真实 profile。

Agent Teams 的持久数据属于各工作区 `.agent-teams/` 目录；本目录只包含代码和分发产物。插件更新不得扫描、修改、迁移或删除现有 `.agent-teams` 数据、DSH Session 或附件。

## Context

- 源码：`fork-plugins/dsh-context`
- 当前私有版本：`0.55.0-dsh017rc1.3`
- 上游底座：`bowenliang123/dsh-context v0.55.0`
- 安装产物：`fork-plugins/releases/dsh-context-0.55.0-dsh017rc1.3.tgz`
- 产物 SHA256：`255BA7AA6B84DA2F1301CD7786A2DDBC39AEE0A69BC731547B464B5D32B7B27D`

私有价格表覆盖 GPT-6 Astra/Sol、Claude Opus 5.5/Fable 5.1，以及 Cursor 下的 Grok 4.7。Agent 汇总按标准速度的 API 等值价格和单次请求的长上下文阶梯估算；投影版本 21 从已有日志重新折叠，不修改 Session 数据。详见[价格与估算条件](dsh-context/docs/model-pricing.md)。

该构建采用 v0.55.0 的 V4 折叠、Context Insights、余额展示、增量 turn 计数、选择性工具参数保留与按需语料回填。字段级 copy-on-write、dirty retention trim、恢复态首个 view bounds、引用稳定的 inline/slim cache、关闭 modal 后释放订阅，以及 V3/V4 system node 的 header 计价仍由私有层维护。维护与回滚规则见 `fork-plugins/dsh-context/FORK_MAINTENANCE.md`。

低开销部署值为 `maxRequestSteps: 300`、`maxKeptTurns: 60`、`maxEvents: 100`、`maxNodes: 400`、`maxArchiveNodes: 100` 和 `maxFileOps: 100`。修改 profile 前必须确认 DSH 已停止；插件更新过程不得读取、迁移或删除 Session、附件、凭据或 projection cache 数据。

## Subscriptions

- 源码：`fork-plugins/dsh-plugin-subscriptions`
- 当前私有版本：`0.9.4-dsh017rc1.24`
- 上游底座：`V1ki/dsh-plugin-subscriptions v0.9.4`
- 私有宿主目标：`dsh-v0.1.7-rc.1`
- 安装产物：`fork-plugins/releases/dsh-plugin-subscriptions-0.9.4-dsh017rc1.24.tgz`
- 产物 SHA256：`7E34837EAD0066B61F0226CADED2194A4657DCBA286A9E938D413DB737E020AF`

该私有构建保留上游多账号 provider、用量 UI、Codex 搜索、图片／视频工具与凭据格式。RC.1 适配转换 V4 工具角色消息，同时保留调用身份和图片结果，并固定精确的 DSH 依赖版本组合；不会迁移 Session 或凭据。Cursor 登录与用量、本地 SDK 的上下文限制、ChatGPT 重置券，以及 ChatGPT 池以 100% 为满，都是私有行为。每次导入上游后，按 `fork-plugins/dsh-plugin-subscriptions/FORK_MAINTENANCE.md` 的「Reapply after an upstream import」逐项补回。
