---
description: "告知交互消费方当前无人可回答的实时无人模式开关；供计划任务或远程 agent 运行的部署者与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-unattended-mode

[English](README.md) | 中文

## 概述

`ctx.unattendedMode` 报告当前部署是否在无人可回答的情况下运行。`enabled` 字段是实时配置，默认关闭。`ask_user_question` 是目前唯一的消费方：开关打开时，调用以 `USER_AWAY` 失败，并告诉模型改读工作区指引而不是等待。其他人机交互 seam 保持各自的行为。

## 目录

- [使用本包](#use-this-package)
- [服务约定](#service-contract)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 agent 可能在无人查看对话时运行时挂载此插件；base bundle 默认以关闭状态挂载它。

### 何时选用

适用于会无人值守的计划任务、远程转发或自动化运行。交互式会话中模型仍应持续提问时保持关闭。该开关属于部署配置，不是会话状态：打开它不会改写已记录的历史。

### 最小配置

```yaml
- id: unattended-mode
  name: '@deepseek-ai/dsh-unattended-mode'
  config:
    enabled: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 交互消费方是否必须假定无人可以回答。 |

该字段是 volatile 字段，因此 profile 或 home 配置更新无需重启 Host 即可生效。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-unattended-mode)是可用字段的完整来源。

<a id="service-contract"></a>
## 服务约定

`ctx.unattendedMode.enabled()` 返回当前值。`ctx.unattendedMode.subscribe(listener)` 注册观察者并返回其 disposer；监听器只会收到值变化，注册时不会收到当前值。重复调用 disposer 是安全的，销毁服务 fiber 会停止投递。

消费方在执行时读取开关。只在加载时读取一次的消费方会错过实时更新；该开关刻意保持可选：没有此行的组合保持消费方原有行为。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务定义、Config schema 与变化通知 |

### 变化检测

服务每次调用 `enabled()` 时通过稳定的 volatile 引用读取 `Config.enabled`。`loader/volatile-update` 事件把该值与最后一次投递给订阅者的值比较，只有不同才通知，因此无关的 profile 编辑不会到达任何监听器。fiber 销毁时服务清空监听器集合；事件监听器是 Cordis effect，随同一 fiber 移除。

### 配置界面

`enabled` 声明为 `.volatile()`，因此 Settings 服务会把它投影为该 profile 条目的实时表单。已发布的客户端不会渲染由 Config 驱动的页面，所以部署目前通过 profile patch 或其他设置客户端修改该值；插件清单会从包的 locale 元数据列出此插件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [用户交互子系统参考](../../../docs/subsystems/user-questions.zh.md)——唯一现有消费方背后的问答 seam。
- [tool-ask-user 包](../tool-ask-user/README.zh.md)——`USER_AWAY` 拒绝与模型侧文本。
- [Settings 包](../../settings/settings/README.zh.md)——实时 Config 表单与 `autoGenerate` 策略。
- [交互组映射](../README.zh.md)——相邻的审批、命令与问答表面。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-ask-user`：该开关唯一可见于模型的效应就是它的 `USER_AWAY` 拒绝。

#### KV Cache 影响

不改变请求前缀：该开关不增加提示词小节、工具 schema 或会话事件，因此切换它不会改动工具目录或任何已缓存前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明该开关的作用范围。它们是当前的包约束，不是 UI 积压事项。

- **没有渲染出来的设置开关**：已发布的 Web 客户端不会从 Config schema 渲染页面，因此部署需在 profile patch 中修改 `enabled`；任何读取 `settings.describe()` 的客户端仍能看到该 volatile 字段。
- **只有 `ask_user_question` 读取该开关**：审批提示、计划评审、computer use 以及其他 `ctx.userQuestions` 调用方仍会等待；每个消费方都需要自己的显式检查。
- **该开关不是会话状态**：已记录的会话不携带开关值，因此回放与恢复遵循当前部署配置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

该拒绝使用 `UserQuestionError`，因此工具管线会在模型侧 `Error: ` 文本旁保留 `{ name: 'UserQuestionError', code: 'USER_AWAY' }`。文本先提 `AGENTS.md`、再提 `AGENT.md`，因为模型必须在不提问的情况下于工作区找到用户的长期指引。

</details>
