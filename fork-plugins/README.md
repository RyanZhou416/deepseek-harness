# Fork-maintained plugins

此目录存放必须与本 fork 的 DSH API 同步适配、并随 fork 一起分发的插件源码。
它与官方 `packages/` 分离，避免常规 DSH 上游合并把第三方插件误当成官方 workspace
package，也把未来冲突限制在 `fork-plugins/` 内。

## Agent Teams

- 源码：`fork-plugins/dsh-agent-teams`
- 当前私有版本：`0.1.15-dsh012rc1.2`
- 上游底座：`NanmiCoder/dsh-agent-teams main@232a338fc9`
- API 迁移：上游 PR #124 `098e4e97eb`
- 安装产物：`fork-plugins/releases/nanmicoder-dsh-agent-teams-0.1.15-dsh012rc1.2.tgz`
- 产物 SHA256：`22312117EE48C46FE00CD5926A9D2B3FFC9788DA4A1098B11DF17E9F4FA520D9`

`.2` 同时保护 RC.1 公共 `sendMessage()`、Host Queue 与 fork nearest-step
三条退休成员入口，并用有界 unread-only LRU 消除活动面板对不变 mailbox JSONL
的每秒全量重读；磁盘格式保持不变。

同事 clone 本 fork、设置好自己的 `DSH_HOME` 并关闭正在运行的 DSH 后，可在
仓库根执行：

```powershell
$artifact = (Resolve-Path .\fork-plugins\releases\nanmicoder-dsh-agent-teams-0.1.15-dsh012rc1.2.tgz).Path
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add $artifact
```

这只更新同事自己的 profile；不会复制或覆盖任何 Session、附件或
`.agent-teams` 数据。

构建和验证：

```powershell
cd fork-plugins\dsh-agent-teams
corepack pnpm@11.7.0 install --frozen-lockfile --ignore-scripts
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 build
corepack pnpm@11.7.0 verify
corepack pnpm@11.7.0 pack --pack-destination ..\releases
```

更新官方 Agent Teams 时，先保证 DSH 关闭并保留 profile 配置备份，再执行：

```powershell
git subtree pull --prefix=fork-plugins/dsh-agent-teams https://github.com/NanmiCoder/dsh-agent-teams.git main --squash
```

随后重新移植 `FORK_MAINTENANCE.md` 所列 fork 行为、提升私有版本、构建新 tgz，
并在隔离 DSH_HOME 中启动验证。不得把 npm `@latest` 直接装进真实 profile。

Agent Teams 的持久数据属于各工作区 `.agent-teams/`；本目录只含代码和分发产物。
插件更新不得扫描、修改、迁移或删除现有 `.agent-teams`、DSH Session 或附件。
