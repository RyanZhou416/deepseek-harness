---
description: "dsh Web 客户端上的 CC 订阅池设置页：配置 llm-cc-pool 入口的订阅池凭证和模型列表覆盖。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-cc-pool

[English](README.md) | 中文

## 概述

打开 **设置**，选择 **CC 订阅池**，即可配置 `cc-pool` 路由使用的订阅池凭证和模型列表。页面会暂存所有修改，仅在点击 **保存** 时写入：凭证写入 `CC_POOL_API_KEY` 凭证，模型列表写入 `llm-cc-pool` 设置段。**从池同步模型** 会向订阅池询问它当前提供哪些模型，并把合并结果暂存为草稿，因此保存仍是唯一的写入步骤。该页面仅在 Host 提供该入口时存在，因此未安装 mac-pool 提供方的部署不会显示它。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

凭证字段会显示该凭证是否已配置以及由哪一层提供，并且每次进入页面都从空白开始——已保存的明文不会显示，填入新值即完成轮换。模型列表打开时显示路由当前提供的目录：每个条目一行，包含线上模型 id、显示名、上下文窗口、输出上限和默认 effort。**添加模型** 会追加一行，**删除** 移除一行，**恢复默认** 会暂存一次回到部署目录的操作。空 id、重复 id、空显示名、不是正整数的容量、不属于 `low`、`medium`、`high`、`xhigh`、`max` 的 effort，或空列表都会阻止保存，并指出出错字段。行内文本就是保存会写入的值：id 与显示名会去掉首尾空白，只含空白的已存显示名回退为其 id，因此 Host 接受的带空白条目打开后仍可保存，不会变成无法清除的字段错误。

保存以草稿开始时的修订号为栅栏。若期间有其他改动先写入该设置段，保存会作为冲突而不是“值不合法”被拒绝：草稿保留，页面说明该设置已在别处变更，下一次保存用重新读到的修订号写入。写入被接受后，行内容显示 Host 实际存储的值，因此去空白或带前导零的容量不会残留为未保存修改。Host 拒绝凭证时显示 Host 给出的原因并保留已输入的凭证；已接受的目录则保持在页面上。

**从池同步模型** 会向订阅池询问它提供的模型，并把结果与当前行合并后暂存。表里已有的模型保留自己的全部字段——订阅池的显示名和容量不会覆盖已有编辑——只存在于订阅池的模型会追加为带 *来自订阅池* 标记的新行，容量先用占位安全值（上下文 1M、输出 128k、默认 effort medium）供确认。当订阅池不再提供表中某个模型时，页面先询问是否删除：**删除并同步** 让列表与订阅池一致，**保留并同步** 只暂存新增和更新、不删除。关闭该确认框（关闭按钮、**取消**、遮罩或 Escape）会取消整个同步，既不删除也不暂存新增。合并只是草稿，仍然由 **保存** 写入。同步需要已配置的凭证；空列表、重复 id 或无法读取的结果会显示原因并保持列表不变；订阅池 20 秒内未响应时会报告超时，且不改动任何内容。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现内部细节——点击展开</summary>

Host 半边是空的 `apply`，只为让本包在 Loader 中占一行，供客户端模块系统向浏览器提供另一半。浏览器半边通过 `ctx.configForms.get` 绑定 Host 插件的 profile 入口（`llm-cc-pool`），在 `CcPoolSettingsPage` 中暂存行编辑，并把整个 `models` 数组作为一次带修订号的变更写入；暂存的恢复默认则写入 `unset`，让 Host 的 schema 默认值重新生效。目录写入被拒时会先回读再报告：设置段修订号超出草稿栅栏即为冲突，回读到的修订号成为下一次栅栏，草稿保持暂存。凭证是唯一不写入设置文档的控件：它通过 `ctx.remote.credentials` 写入，其已配置状态、来源和可写性在挂载时以及每次凭证变化后重新读取。同步通过 `ctx.remote.llm.discoverModels('llm-cc-pool', { provider: 'cc-pool' })` 读取 Host 注册的 discovery，由 `sync.ts` 校验结果并按 id 合并进当前行；删除类的合并会先等待确认再暂存。Discovery 请求携带本页的 `AbortSignal` 与期限，因此放弃、确认或离开页面都会取消它，迟到的结果被丢弃。页面通过 `ctx.configForms.whileServed` 注册到 `settings.section`，因此只在 Host 提供订阅池入口时出现。文案属于本包的 `settings.ccPool` 词典；`SettingsForm` 框架的文案通过 props 传入。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [ui-settings](../ui-settings/README.zh.md) —— 页面依赖的共享配置表单和命名空间监听。
- [ui-primitives](../ui-primitives/README.zh.md) —— 页面渲染的设置表单框架、密钥字段和按钮。
- [llm-cc-pool](../../llm/llm-cc-pool/README.zh.md) —— 拥有 `llm-cc-pool` 入口及其目录规则的 Host 插件。

-----

<a id="model-experience"></a>
## 模型体验

无。本包是浏览器端设置界面，不注册任何模型面；它编辑的目录只通过 Host 插件到达模型。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **页面跟随 Host 命名空间** —— 只有部署组合了 `@deepseek-ai/dsh-llm-cc-pool` 时页面才出现；没有该插件的 profile 既没有页面也没有路由。
- **一次保存包含两次写入** —— 凭证存放于凭证域，目录存放于设置段；凭证被拒时会显示 Host 给出的原因，此时目录已经写入，已输入的凭证保留供再次尝试。
- **同步来的模型从占位容量开始** —— 订阅池列表只提供 id 和显示名，同步新增的行先用 1M 上下文、128k 输出和 medium effort，待人工确认；保存前一直保留 *来自订阅池* 标记。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作说明——点击展开</summary>

目录契约（`CcPoolModel`、五个等级、入口 id 和凭证引用名）由 `@deepseek-ai/dsh-llm-cc-pool` 拥有；本包在 `src/client/contract.ts` 中复述这些名称，因为浏览器包不能导入 Host 包的值。

</details>
