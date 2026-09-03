# Fork 维护的插件

[English](README.md) | 中文

此目录存放必须与本 fork 的 DSH API 同步适配、并随 fork 一起分发的插件源码。它与官方 `packages/` 目录分离，避免常规 DSH 上游合并把第三方插件误当成官方 workspace package，也把未来冲突限制在 `fork-plugins/` 内。

## macOS profile setup

`build.command` 成功后，`setup.command` 会校验并把当前 Agent Teams 与 Context 产物安装到接收 Mac 的 `web` profile，并应用 Context 低开销 bounds。它不会导入其他机器的运行数据，且只备份可能被改动的四个本机 profile 配置文件；可以先在零写入情况下查看精确动作：

```sh
./setup.command --dry-run
./setup.command
./run.command
```

该 setup 会刻意省略 marketplace 插件、subscriptions、watchdog、自定义 preset 和 process-worker profile。这些可选运行时选择由每台机器单独管理。

## Agent Teams

- 源码：`fork-plugins/dsh-agent-teams`
- 当前私有版本：`0.1.15-dsh012rc1.2`
- 上游底座：`NanmiCoder/dsh-agent-teams main@232a338fc9`
- API 迁移：上游 PR #124 `098e4e97eb`
- 安装产物：`fork-plugins/releases/nanmicoder-dsh-agent-teams-0.1.15-dsh012rc1.2.tgz`
- 产物 SHA256：`22312117EE48C46FE00CD5926A9D2B3FFC9788DA4A1098B11DF17E9F4FA520D9`

`.2` 版本同时保护 RC.1 公共 `sendMessage()`、Host Queue 与 fork nearest-step 三条退休成员入口。它的有界 unread-only LRU 也会消除活动面板对未变 mailbox JSONL 文件的每秒全量重读；磁盘格式保持不变。

同事 clone 本 fork、设置好自己的 `DSH_HOME` 并关闭正在运行的 DSH 后，可在仓库根目录执行：

```powershell
$artifact = (Resolve-Path .\fork-plugins\releases\nanmicoder-dsh-agent-teams-0.1.15-dsh012rc1.2.tgz).Path
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add $artifact
```

这只会更新该同事自己的 profile；不会复制或覆盖任何 Session、附件或 `.agent-teams` 数据。

构建和验证：

```powershell
cd fork-plugins\dsh-agent-teams
corepack pnpm@11.7.0 install --frozen-lockfile --ignore-scripts
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 build
corepack pnpm@11.7.0 verify
corepack pnpm@11.7.0 pack --pack-destination ..\releases
```

更新官方 Agent Teams 前，先保证 DSH 已关闭并保留 profile 配置备份，再执行：

```powershell
git subtree pull --prefix=fork-plugins/dsh-agent-teams https://github.com/NanmiCoder/dsh-agent-teams.git main --squash
```

随后重新移植或退役 `FORK_MAINTENANCE.md` 所列 fork 行为、提升私有版本、构建新 tgz，并在隔离 `DSH_HOME` 中验证启动。不得把 npm `@latest` 直接安装到真实 profile。

Agent Teams 的持久数据属于各工作区 `.agent-teams/` 目录；本目录只包含代码和分发产物。插件更新不得扫描、修改、迁移或删除现有 `.agent-teams` 数据、DSH Session 或附件。

## Context

- 源码：`fork-plugins/dsh-context`
- 当前私有版本：`0.41.3-dsh012rc1.1`
- 上游底座：`bowenliang123/dsh-context v0.41.3@dce08e0db3`
- 安装产物：`fork-plugins/releases/dsh-context-0.41.3-dsh012rc1.1.tgz`
- 产物 SHA256：`C260E939F79A52AADC1626180DAA1E25E9119C29FE7E138C0CCFB3EC0E2DE3D4`

该版本保留 `contextTimeline` projection key、wire schema、持久状态 schema 和会话事件词汇。它使用字段级 copy-on-write、dirty retention trim、恢复态首个 view 的 bounds 和引用稳定的 view cache 来降低 Host 分配与发布开销；关闭的 `/context` modal 只保留打开状态订阅。维护与回滚规则见 `fork-plugins/dsh-context/FORK_MAINTENANCE.md`。

低开销部署值为 `maxRequestSteps: 300`、`maxKeptTurns: 60`、`maxEvents: 100`、`maxNodes: 400` 和 `maxArchiveNodes: 100`。修改 profile 前必须确认 DSH 已停止；插件更新过程不得读取、迁移或删除 Session、附件、凭据或 projection cache 数据。
