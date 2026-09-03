# Agent Note: 可移植的 macOS fork 启动器

Status: implemented

[English](2026-09-04-portable-macos-fork-launchers.md) | 中文

## 问题

本 fork 的 macOS 启动器要求 `node` 和 `corepack` 必须位于 `/usr/local/bin`，因此无法使用常见的 Apple Silicon Homebrew 与版本管理器安装。运行启动器也没有 Windows 启动器使用的有界 heap 和诊断报告策略，而 Git 中已有的 fork 维护 Agent Teams 与 Context 产物不会进入新机器的 profile。

复制 Windows Harness home 不是部署机制。其 profile 包含机器路径，同一 home 还存放凭据、Session、附件、派生缓存和其他用户数据；源码 checkout 绝不能分发或改写这些内容。

## 决策

`build.command` 和 `run.command` 会 source `scripts/fork-macos-runtime.sh`。该 helper 会从 `PATH`、`/opt/homebrew/bin` 或 `/usr/local/bin` 发现 Node；接受 Node `22.19+` 或 `24+` 并拒绝 Node 23；仅在每用户私有临时目录安装固定的 Corepack fallback `0.34.5`；并强制使用仓库 `packageManager` 字段中的精确 pnpm 版本。

`build.command` 仍然只执行安装和构建。`run.command` 按 Harness 路径规则解析空白、带 tilde 前缀、相对和绝对 `DSH_HOME` 值，创建模式为 `0700` 的非符号链接 diagnostics 目录，并加入 fatal 和 uncaught Node 报告，但不监督或重启 Host。其默认 V8 old-space 预算为物理内存的一半，并限制在 4 GiB 至 16 GiB；`DSH_MAX_OLD_SPACE_MIB` 是显式且会被校验的覆盖值。

`setup.command` 是独立、显式的 profile 修改操作。它会通过 SHA-256 和 package identity 校验已提交的 Agent Teams 与 Context 产物，仅备份现有 web profile 的 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 和 `cordis.patch.yml`，初始化缺失的 web profile，把该 profile 固定到仓库 pnpm 版本，安装两个本地产物，在保留其他 patch 行的同时合并 Context 低开销 bounds，并校验已安装版本、bundle 成员、lock 引用与组合配置。重复执行已收敛的 setup 不会修改 package 或 patch；`--dry-run` 既不创建 Harness home，也不创建 package-manager 目录。

该 setup 不处理凭据、settings、Session、附件、projection cache、diagnostics、工作区 `.agent-teams` 数据、marketplace 插件、subscriptions、watchdog、自定义 preset 或 process-worker profile。它们仍属于各机器，必须单独显式配置。

## 备选方案

**在现有写死目录旁补上 `/opt/homebrew/bin`。** 拒绝，因为 nvm、asdf、Volta 和用户管理的 Node 安装仍不受支持，脚本也仍会与仓库 engine 范围不一致。

**每次 `run.command` 启动时安装或修复插件。** 拒绝，因为启动 Host 不得修改 profile、访问 package registry，或与正在运行的 profile package manager 发生竞争。

**把已工作的 Windows `DSH_HOME` 复制到每台 Mac。** 拒绝，因为它把不可移植路径与账户密钥和持久用户数据绑在一起。setup 会围绕接收机器自己的 home 创建新 profile。

**给每台 Mac 分配 16 GiB old-space 预算。** 拒绝，因为 16 GiB 机器可能在 V8 达到该限额前先进入 swap 压力。自适应上限会给至少拥有 32 GiB 物理内存的机器分配 16 GiB，同时为已知部署保留显式覆盖。

## 影响

新 Mac 可以获得可复现的源码工具链和两个 fork 插件产物，不会获得另一台机器的运行数据。构建、profile setup 和 Host 启动是三个分离且可见的操作，因此每个操作只有一个修改范围和失败面。

profile 中的本地产物引用仍与 checkout 路径绑定；移动 checkout 后需要重新运行 `setup.command`。该 setup 不会复制 Windows watchdog、ChatGPT preset、marketplace inventory 或 process worker。POSIX 行为和隔离的真实 profile 安装已在 Windows 开发主机上覆盖，但在宣称主机验证前仍需要一次物理 macOS 冷启动。
