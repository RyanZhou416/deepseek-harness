# Fork 插件发行产物

[English](README.md) | 中文

此目录保存构建好的插件 tgz 及其 SHA-256 sidecar。当前格式的 `web` profile 不会安装它们：`build.cmd` 从源码构建 fork 插件并链接 staging 后的包，因此干净的检出无需手工提供 tgz。

## 当前代次

| 产物 | 作用 |
| --- | --- |
| `ryanzhou416-dsh-plugin-aether-shell-0.1.0-dsh021rc2.*.tgz` | 早期的 AetherShell 产物，仅用于历史追溯与回滚检查。`build.cmd` 现在从 `fork-plugins/dsh-plugin-aether-shell` 编译该插件。 |
| `tormentalabs-claude-code-wire-compat-0.7.2-dsh14.tgz` | 较早的 wire-builder 产物，仅作历史。 |
| `tormentalabs-claude-code-wire-compat-0.7.2-dsh15.tgz` | 上一代 DSH wire builder，首个保留 `clear_at`；当前源码为 `0.7.2-dsh16`，没有对应 tgz。仅作为历史与回滚证据保留；没有构建会读取或安装它。 |

`dsh-plugin-subscriptions` 在这一代没有 tgz；它从源码 staging。

## Claude wire compat

`@tormentalabs/claude-code-wire-compat` 源码位于 `fork-plugins/claude-code-wire-compat`。它不需要 tgz 发行：

- `packages` 风格的消费者直接使用本地源码包（`file:../claude-code-wire-compat`），其 `prepare` 脚本构建 `dist/`。
- `scripts/fork-plugins-build.ts` 用仓库 TypeScript 编译器从源码编译其 `dist/`，并内联进 subscriptions bundle，因此安装后的 profile 不解析任何 compat 依赖。
- 当前 `@tormentalabs/claude-code-wire-compat` 源码为 `0.7.2-dsh16`，没有对应 tgz。`0.7.2-dsh15` tgz 留在这里只是因为已发布的产物永不删除；它不是构建输入。见 `fork-plugins/claude-code-wire-compat/FORK_MAINTENANCE.md`。

## 退役产物

`archive/` 保存退役的 0.1.7-rc.1 代插件 tgz 与更早的 wire-builder 构建。它们仅作历史；见 `archive/README.txt`。切勿把它们安装到当前 profile，也切勿为了腾出空间而重新打包或删除已发布的 tgz。
