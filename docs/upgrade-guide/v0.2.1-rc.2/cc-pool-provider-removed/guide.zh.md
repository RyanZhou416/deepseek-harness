---
kind: upgrade-guide
description: "基础 bundle 不再声明 cc-pool provider 及其模型；请安装 llm-cc-pool 插件，并把自定义模型移到该入口。"
---

# 基础 bundle 的 `cc-pool` provider 与模型已迁入 `@deepseek-ai/dsh-llm-cc-pool`

[English](guide.md) | 中文

## 变更

基础 bundle 的 `llm-pi-ai` 行不再提供 `cc-pool` provider 配置块及其九个模型。mac 池路由现在只由 `@deepseek-ai/dsh-llm-cc-pool` 插件 bundle 拥有：端点、凭据引用、header、重试策略与内置四模型目录都在该包内。仍通过 profile patch、overlay 或已存设置声明 `llm-pi-ai` 下 `providers.cc-pool` 的 profile，在安装插件后会装载失败，因为两个适配器会同时占用 `cc-pool` 路由；只依赖基础声明的 profile 则完全失去该路由。Messages 端点固定为 `https://ccpool.tiancegames.com`；不存在 base URL、gateway 或代理覆盖，`CC_POOL_API_KEY` 必须是该规范主机的成员密钥。为 gateway 或其它主机制作的密钥会在池侧失败，固定端点也无法重定向。

## 迁移

1. 为每个使用该池的 profile 安装该 bundle。该包为私有包、未发布到 npm：Windows 上先停止 Host 再运行 `build.cmd`；macOS 上运行 `build.command`，然后运行 `pnpm exec tsx scripts/fork-plugins-build.ts`。构建会把它 staging 到 `.build/fork-plugins/llm-cc-pool` 并链接进 profile。
2. 从该 profile 的 patch、overlay 与设置文档中删除所有 `llm-pi-ai` 的 `config.providers.cc-pool` 块，包括其中的 `models` 列表。`CC_POOL_API_KEY` 留在原处：插件读取同一个凭据引用，且该密钥必须属于规范主机 `ccpool.tiancegames.com`。
3. 把自定义模型列表移到 `llm-cc-pool` 入口的 `models` 字段。条目仍使用 `id`、`name`、`contextWindow`、`maxTokens` 与 `defaultReasoning`；可选等级为 `low`、`medium`、`high`、`xhigh` 与 `max`。省略 `models` 时提供内置四模型目录（`claude-sonnet-5-5`、`claude-opus-5-5`、`claude-fable-5-1`、`claude-mythos-5-1`），比被移除的列表更小。
4. 启动该 profile 并确认两件事：loader 不再报告重复的 `cc-pool` 注册，模型选择器只列出组合实际提供的目录。未存储 `CC_POOL_API_KEY` 的请求以 `MISSING_CREDENTIAL` 失败，而不是借用其他 provider 的密钥。
5. 回滚时先停止 Host，用 `dsh plugin --profile <profile> remove @deepseek-ai/dsh-llm-cc-pool` 移除链接，恢复迁移前的 profile patch 与设置，再运行同一 staging 命令并重启。不要手工修改链接的 `.build/fork-plugins/llm-cc-pool` 文件。
