# Fork 维护的插件

[English](README.md) | 中文

此目录存放必须与本 fork 的 DSH API 同步适配、并随 fork 一起分发的插件源码。它与官方 `packages/` 目录分离，避免常规 DSH 上游合并把第三方插件误当成官方 workspace package，也把未来冲突限制在 `fork-plugins/` 内。

## 仓库内构建与安装

Windows 的 `build.cmd` 在普通根构建之后构建源码插件，并把四个 fork 插件（AgentTeams、Context、Subscriptions、AetherShell）与 workspace 的 `@deepseek-ai/dsh-llm-cc-pool` provider bundle 一起链接到选定的 `web` profile。当前格式的 profile 无需第二条命令、私有 registry 或手工提供的 tgz。构建会**修改 profile**，因此必须先停止 Host。`build.cmd` 不带选项地运行 `scripts/fork-plugins-build.ts`，所以守卫只探测默认的 `127.0.0.1:3080`；要守卫其他端点上的 Host，请直接以 `--host`/`--port` 运行该脚本。该端点仍有响应时，守卫会在触碰任何 profile 文件之前失败；守卫无法验证的端点同样使运行失败，绝不假定没有 Host 在运行。

构建只面向当前 profile 格式：没有旧 profile 检测、转换、备份或迁移。仍声明 `llm-pi-ai` `providers.cc-pool` 的旧 profile 必须先运行一次性 [`scripts/migrate-legacy-cc-pool-profile.ts`](../scripts/migrate-legacy-cc-pool-profile.ts)，再运行 `build.cmd`。该脚本备份 profile、seed 文件与 `$DSH_HOME/settings.yaml`，结构移除 legacy 声明，并在“无 profile / 无 package.json”跳过之前清理 `settings.yaml` 中的同名声明——即使 web profile 尚不存在，Home 里的旧声明也会被清理（不写 profile marker）。随后它确保专用 bundle/link、按需 seed、写入 `.dsh-profile-migrations.json` 后退出；其 Host 守卫接受与 `scripts/fork-plugins-build.ts` 相同的 `--host`/`--port` 选项。它是唯一持有 legacy 知识的位置，所有维护中的 profile 迁移完成后可删除。

`scripts/fork-plugins-build.ts` 优先使用 `--dsh-home`，其次 `DSH_HOME`，再其次平台启动器默认 home（Windows 为 `<仓库父目录>\deepseek-harness-data`，macOS/Linux 为 `~/.dsh`；开头的 `~` 会展开），目标是 `profiles/web`。它把每个包 staging 到被忽略的 `.build/fork-plugins/<id>/`，再用 `dsh plugin --profile web add <绝对 staging 目录>` 安装，记录为 pnpm `link:`；源码 key 使未变化的第二次运行既不重建也不重装，全新的 profile 在安装成功后才 seed。不会读取或写入任何 Session、附件、凭据、projection cache 或 `.agent-teams` 数据。

- Subscriptions 从源码编译 `lib/index.js` 与 `lib/client.js`。staged manifest 内联 `@tormentalabs/claude-code-wire-compat`（来自 `fork-plugins/claude-code-wire-compat` 源码，构建时用仓库 TypeScript 编译器生成其 `dist/`）与 `undici`，删除仅类型使用的 `@deepseek-ai/dsh-llm-request-record` peer，且不声明运行时依赖。公开的 optional provider 条目（`@cursor/sdk`、`@oven/bun-*`）保留声明；link 安装不会安装被链接包的 optional 依赖，因此这些 provider 需要另行提供对应包。staged 包不附带声明文件；源码检出仍是类型来源。
- AetherShell 从源码编译 `lib/lifecycle.mjs`，并保持所有 `@deepseek-ai/*` peer 为外部依赖 `0.2.1-rc.2`。
- AgentTeams 与 Context 在 `.build/fork-plugins/work/` 的隔离副本中构建；staging 只读取该副本的构建产物，不读取提交的 `lib/`。Context 保留 `zod` 运行时依赖，由仓库安装解析。
- workspace 的 `@deepseek-ai/dsh-llm-cc-pool` 包从根构建产物复制到 `.build/fork-plugins/llm-cc-pool/`，并作为 provider bundle 与 fork 插件一起链接。

诊断构建时可直接运行该步骤（仍须停止 Host）：

```powershell
$env:DSH_HOME = 'C:\path\to\isolated-home'
pnpm exec tsx scripts/fork-plugins-build.ts
```

## macOS profile setup

`build.command` 准备 macOS 工具链、运行 `pnpm install` 并运行根构建；它**不会**构建或链接 fork 插件。成功之后，停止正在运行的 DSH，并在仓库根目录直接运行 staging 脚本：

```sh
pnpm exec tsx scripts/fork-plugins-build.ts
./run.command
```

脚本在 macOS 上默认使用 `~/.dsh`，把包 staging 到 `.build/fork-plugins/`，并链接进 `profiles/web`；上面的 Host 停止规则同样适用。`setup.command` 与 `setup-profile.mjs` 已于 2026-10-18 退役删除，因此不存在单独安装器或 `--dry-run`。每台机器仍单独管理自己的 marketplace 插件、watchdog、自定义 preset 与 process-worker profile。

## Agent Teams

- 源码：`fork-plugins/dsh-agent-teams`
- 当前私有版本：`0.1.24-dsh021rc2.1`
- 上游底座：`NanmiCoder/dsh-agent-teams v0.1.24`
- profile 目标：DSH `0.2.1-rc.2`
- profile 安装：`link:` 指向 `.build/fork-plugins/agent-teams`

上游 v0.1.24 把成员创建、停止与恢复适配到 Harness `0.2.1-rc.2`，并在插件重载后保留成员角色与自定义工具限制。私有层保留 awaited `agent/created` 启动、用于打开冷成员会话的 projection 刷新、带类型的 `agent-teams-host` 消息来源、Captain 邮箱恢复，以及有界未读邮箱缓存；磁盘格式不变。

每条 Team 消息都会先进入持久 Team 邮箱，再尝试 Host 投递。只有 Host 把消息接纳到 DSH 持久收件箱后，插件才会把它标记为已投递；已进入不可中断工具的接收方会在工具结算后消费这条排队输入，而不会被抢占。Host 投递失败会让 Team 记录保持可重试；不活跃的 Captain 会冷恢复并按顺序重投未确认记录。

成员每次更新任务都要带上当前 `attempt_id`。遗漏它会得到包含当前 id 的可重试错误，且不会撤销 attempt；提供不同 id 才是真正的陈旧更新，并会在接管或重新分配后被拒绝。

同事 clone 本 fork、设置好自己的 `DSH_HOME` 并关闭正在运行的 DSH 后，可在仓库根目录执行：

```powershell
.\build.cmd
```

这会安装并构建仓库，随后把 fork 插件 staging 并链接进该同事自己的 `web` profile。它不会复制或覆盖任何 Session、附件或 `.agent-teams` 数据。

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

随后重新移植或退役 `FORK_MAINTENANCE.md` 所列 fork 行为、提升私有版本，并重新运行 `build.cmd`（或 `scripts/fork-plugins-build.ts`）staging 新源码。不得把 npm `@latest` 直接安装到真实 profile。

Agent Teams 的持久数据属于各工作区 `.agent-teams/` 目录；本目录只包含代码和分发产物。插件更新不得扫描、修改、迁移或删除现有 `.agent-teams` 数据、DSH Session 或附件。

## Context

- 源码：`fork-plugins/dsh-context`
- 当前私有版本：`0.73.0-dsh021rc2.1`
- 上游底座：`bowenliang123/dsh-context v0.73.0`
- profile 安装：`link:` 指向 `.build/fork-plugins/context`

私有价格表覆盖 GPT-6 Astra/Sol、Claude Opus 5.5/Fable 5.1，以及 Cursor 下的 Grok 4.7。Agent 汇总按标准速度的 API 等值价格和单次请求的长上下文阶梯估算；投影版本 21 从已有日志重新折叠，不修改 Session 数据。详见[价格与估算条件](dsh-context/docs/model-pricing.md)。

该构建采用 v0.73.0 的 `foldState`/`foldMetering`/`foldWire` 拆分、Context Insights、余额展示、增量 turn 计数、选择性工具参数保留与按需语料回填。由维护保留的 fork 行为与回滚规则见 `fork-plugins/dsh-context/FORK_MAINTENANCE.md`。

低开销部署值为 `maxRequestSteps: 300`、`maxKeptTurns: 60`、`maxEvents: 100`、`maxNodes: 400`、`maxArchiveNodes: 100` 和 `maxFileOps: 100`。修改 profile 前必须确认 DSH 已停止；插件更新过程不得读取、迁移或删除 Session、附件、凭据或 projection cache 数据。

## Subscriptions

- 源码：`fork-plugins/dsh-plugin-subscriptions`
- 当前私有版本：`0.9.4-dsh021rc2.1`
- 上游底座：`V1ki/dsh-plugin-subscriptions v0.9.4`
- profile 目标：DSH `0.2.1-rc.2`
- profile 安装：`link:` 指向 `.build/fork-plugins/subscriptions`

该私有构建保留上游多账号 provider、用量 UI、Codex 搜索、图片／视频工具与凭据格式。其 0.2.1 适配转换 V4 工具角色消息，同时保留调用身份和图片结果，并固定精确的 DSH 依赖版本组合；不会迁移 Session 或凭据。Cursor 登录与用量、本地 SDK 的上下文限制、ChatGPT 重置券，以及 ChatGPT 池以 100% 为满，都是私有行为。每次导入上游后，按 `fork-plugins/dsh-plugin-subscriptions/FORK_MAINTENANCE.md` 的「Reapply after an upstream import」逐项补回。

## AetherShell

- 源码：`fork-plugins/dsh-plugin-aether-shell`
- 当前私有版本：`0.1.0-dsh021rc2.4`
- 包：`@ryanzhou416/dsh-plugin-aether-shell v0.1.0`
- profile 目标：DSH `0.2.1-rc.2`
- profile 安装：`link:` 指向 `.build/fork-plugins/aether-shell`

该 bundle 保持所有 `@deepseek-ai/*` peer 为外部依赖 `0.2.1-rc.2`，且是纯 Host 插件，不含客户端资源。它需要外部 AetherShell 解释器——legacy 模式目标 `12.0.2`，typed 模式要求 `12.0.2+ryan.2`——插件不分发该解释器。保留与验证要求见 `fork-plugins/dsh-plugin-aether-shell/FORK_MAINTENANCE.md`。
