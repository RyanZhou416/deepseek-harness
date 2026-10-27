---
description: "仅供本 fork 使用的 mac 池 provider：一条固定的 cc-pool Anthropic Messages 路由与可配置的模型目录（内置默认值），以可选 profile bundle 安装。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-llm-cc-pool

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-llm-cc-pool` 把 mac 池作为可选 provider 加入组合：安装后恰好提供一条 Anthropic Messages 路由，其端点、凭据引用与重试策略固定。该路由默认提供内置的四模型目录，部署可用 `models` 整体替换它，设置服务会把该目录投影为可编辑表单。`cacheTtl` 选择该路由的提示缓存存活时间：默认五分钟、一小时，或完全不发标记。插件不注册可配置 provider 目录项；它的发现读取把池的 `/v1/models` 清单作为候选报告，绝不写目录，因此模型只能经校验过的配置进入本路由。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

把本包安装进某个 profile，或在 profile patch 中挂载它的一行：

```yaml
- id: llm-cc-pool
  name: '@deepseek-ai/dsh-llm-cc-pool'
  config:
    cacheTtl: 5m
    requestLog:
      path: /var/log/dsh/cc-pool-requests.jsonl
    models:
      - id: claude-sonnet-5-5
        name: Claude Sonnet 5.5
        contextWindow: 1000000
        maxTokens: 128000
        defaultReasoning: medium
```

包 manifest 声明了 `dsh.bundle.patch`，因此 `dsh plugin --profile web add ./packages/llm/llm-cc-pool` 会把依赖记入 profile，由 profile loader 应用本包的 patch。组合中不需要任何其它 `cc-pool` 配置块：路由事实都在插件源码里，`models` 是部署唯一改动的模型事实。

### 固定路由事实

| 事实 | 值 |
|---|---|
| Provider 路由 | `cc-pool`（显示名 `CC 订阅池`） |
| 线路协议 | `anthropic-messages` |
| 端点 | `https://ccpool.tiancegames.com` |
| 凭据引用 | `CC_POOL_API_KEY` |
| 部署 header | `x-cc-backend: direct` |
| 会话身份 | 请求的 session id 作为 `X-Claude-Code-Session-Id`，外加每个逻辑请求一个 `x-client-request-id`，其重试沿用同一个 |
| 重试策略 | `normal`，2 次重试，可重试码 `RATE_LIMIT`、`SERVER` 按原样使用；`TIMEOUT` 被排除，因为请求可能已经派发、结果未知 |

`CC_POOL_API_KEY` 每个请求经凭据服务解析，其次读启动环境。解析不到时请求以 `MISSING_CREDENTIAL` 失败并点名该引用，绝不会回退到无关的环境密钥。会话 header 绑定池的会话键与 prompt 身份，因此同一会话的每一轮与工具续写都呈现同一会话，而增加消息的请求会取得新的 ledger id。

池每个会话只允许一个在途 direct 请求；并发请求会被以 `cc_pool_session_busy` 拒绝，而不是排队等待。插件按请求的 session id 排序流：同一会话的第二个请求只在第一个流结束后才到达路由，不同会话仍并行运行，并照常经过池的全局槽位限制。请求只要尚未转发任何内容，被 `cc_pool_session_busy` 拒绝（上一个租约在最后一个 chunk 之后才释放）就会在 1.8 秒内最多重试八次，无论它是否排过队；中止请求会立即释放队列位，且不打开任何上游请求。其它拒绝——全局槽位 `cc_pool_rate_limited` 429、容量限制、provider 限速——原样返回并带上 `Retry-After`，由 `dsh-llm-retry` 处理；本插件不添加跨会话的全局或按 IP 队列，也不添加会话之间的节流。

### 提示缓存 TTL

`cacheTtl` 声明本路由要求 Anthropic 缓存请求前缀时使用的 `cache_control` 标记存活时间：`5m`（默认）使用 API 默认的五分钟存活期，`1h` 要求延长存活期，`none` 不发送任何标记。它是插件装载时读取的 loader 配置，且只作用于本路由：发往其它 provider 的请求不受影响。

标记由共享的 `anthropic-messages` 传输放置，本插件只选择其值。一个标记位于 system prompt 的文本块，一个位于最后一个工具声明（当请求声明工具时），一个位于最终 user 或 system 消息的最后一个 block（当该 block 是 text、image、`tool_result`、`tool_addition` 或 `tool_removal` 时）；以 assistant 消息结束的对话不携带对话标记。`5m` 发送 `{"type": "ephemeral"}`，`1h` 发送 `{"type": "ephemeral", "ttl": "1h"}`，`none` 省略这些键。请求体的其它字节不变：两个带标记的存活期只在标记值上不同，而 `none` 就是去掉标记键的同一请求，此时单条文本消息保持传输在没有 block 需要标记时使用的紧凑字符串形式。

默认值就是本路由此前已经在使用的存活期，只是被显式声明，因此环境中的 provider 偏好（`PI_CACHE_RETENTION`，其它路由仍可跟随它）无法改变它。三个取值之外的值会在插件装载时被拒绝。

### 模型目录

未配置 `models` 列表时，profile 使用的内置目录：

| 模型 id | 名称 | 上下文 | 输出上限 | 默认档位 |
|---|---|---|---|---|
| `claude-sonnet-5-5` | Claude Sonnet 5.5 | 1,000,000 | 128,000 | `medium` |
| `claude-opus-5-5` | Claude Opus 5.5 | 1,000,000 | 128,000 | `medium` |
| `claude-fable-5-1` | Claude Fable 5.1 | 1,000,000 | 64,000 | `high` |
| `claude-mythos-5-1` | Claude Mythos 5.1 | 1,000,000 | 64,000 | `high` |

每个模型提供 `low`、`medium`、`high`、`xhigh`、`max`；`off`、`minimal`、快速/优先 `speed` 档位以及 context-management 请求字段都不属于该目录。目录打开 `compat.forceAdaptiveThinking`，因此所选档位以 adaptive thinking 下的 `output_config.effort` 发送，而不是 token 预算。模型默认档位会被物化进未点名档位的请求。

profile 可以用 `models` 整体替换该列表。每个条目声明线路 id、显示名、上下文窗口、输出上限与默认档位；档位固定为上述五个，adaptive thinking 始终打开，因此条目无法移除池的档位约定，也无法加入 `off` 或 `speed`。列表必须至少命名一个模型、每个 id 只出现一次，名称非空，容量为正整数。非法列表会让插件在装载时失败，同一检查也会在设置写入持久化之前拒绝它。条目的 `maxTokens` 同时是调用方未点名上限时该模型的每请求输出上限，其 `defaultReasoning` 则是物化进未点名档位请求的 effort。

目录在存入密钥之前就可见，因为它是配置而不是发现结果；下文的池同步读取从不改变路由实际提供的目录。存入密钥才使请求成功；没有密钥时发送请求会以 `MISSING_CREDENTIAL` 响亮失败。

`models` 是实时字段：设置服务把它投影为本路由的配置表单，编辑经活动 profile 的 Cordis patch 持久化，下一个请求与模型列表无需重启即可看到新目录。重置该字段会让路由回到内置目录。token 不属于本配置：`CC_POOL_API_KEY` 留在凭据存储中，设置界面写入凭据存储而不是写进 profile。

### 池模型同步

插件为 `llm-cc-pool` 设置命名空间注册模型发现，因此配置界面可以读取已部署池当前公布的模型。读取使用本路由的固定事实：`GET https://ccpool.tiancegames.com/v1/models`，携带从凭据服务（其次启动环境）解析出的 `Authorization: Bearer <CC_POOL_API_KEY>`。请求中的草稿 `baseURL`、`api` 与一次性 `apiKey` 都不参与，因此该命名空间只会询问本池，且未存凭据时失败而不是借用草稿密钥。

每个 `data[]` 条目只贡献 `id` 与取自 `display_name` 的 `name`（缺失时回退为 id）。池不公布上下文窗口、输出上限、默认档位或模态，因此这些值一律不臆造：采纳候选时仍需补齐它们，加入目录仍是一次显式的设置写入，并经过与手工编辑相同的目录校验。

成功读取按池顺序返回候选，重复列出的 id 保留首个条目。空清单就是空候选列表。缺少凭据、端点不可达或拒绝、回复不是 JSON `data` 数组都返回 typed failure（`MISSING_CREDENTIAL`、`DISCOVERY_FAILED`），绝不回退到内置或已配置目录。读取不写任何东西：不采纳模型、不持久化 profile、不注册路由，也不进入通用 Models 页面。

### 请求诊断

每次尝试在开始时写一条结构化日志记录，在结束时再写一条：路由、模型、端点、session id、ledger id、尝试序号、响应状态、响应带有的池 `x-cc-pool-request-id`，以及失败的 code、message 与 cause 链。排过队的请求若在池释放上一租约时被拒绝，会作为同一逻辑请求的下一次尝试重试，因此其记录沿用同一 ledger id，尝试序号为 2、3……。记录绝不包含消息、请求体、凭据、token 数或会话标题。

`requestLog` 把同样的记录持久化为 NDJSON。未配置时池路由写入 `$DSH_HOME/logs/llm-pi-ai-requests.jsonl`——沿用通用 pi-ai 适配器的路径，使既有证据收集在插件拆分后仍然有效。`path` 移动文件，`maxFileBytes`（默认 16 MiB）设定轮转点，`maxFiles`（默认 8）设定保留数量；轮转先删除最旧文件，保留集合不超过 128 MiB。写入排在请求路径之外，首次失败经插件 logger 报告一次，且不会使请求失败。

<a id="understand-the-implementation"></a>
## 理解实现

本包是 named Cordis function plugin（`name`、`inject`、`Config`、`apply`），没有 default export。`apply` 用 `dsh-llm-pi-ai` 的通用 profile resolver 解析生效目录，因此畸形的目录会在插件装载时失败而不是等到首个请求，然后把它注册到 `ctx.llm`。该 profile 同时把配置的 `cacheTtl` 作为 pi-ai 的 `cacheRetention` 档位携带，因此存活期无需本插件改写任何请求体即可到达请求。解析出的目录与 profile 按原始 `models` 值做记忆化，未变化的配置保持同一快照，而设置写入产出下一个快照。

适配器是 `dsh-llm-pi-ai` 的 `PiAiAdapter`，覆盖两个方法：`listModels` 直接回答生效目录，而不先解析凭据；`stream`/`prepareCall` 把每次派发送入按会话串行门。通用适配器的 HTTP/SSE 传输、上下文转换、流投影、pool-error 分类与 replay 处理都被复用而非复制。插件自身贡献路由事实、目录、固定重试策略、会话 header、会话排序、日志与持久化 sink。

所有注册都随 Cordis fiber 释放：dispose 插件会撤掉路由与模型发现，关闭请求日志，并结清仍在会话队列中等待的请求。插件不注册可配置 provider 目录项，因此没有通用 Models 页面可以自行草拟路由；它自己的发现只把池清单作为候选提供，不写任何内容。它的 `models` 字段是 volatile 字段，设置服务正是据此把它投影为路由表单；插件注册自己的呈现策略，使专用页面成为唯一的设置呈现。

<a id="further-exploration"></a>
## 进一步探索

- [dsh-llm 服务](../llm/README.zh.md)——本插件注册所在的 provider 中性服务。
- [llm-pi-ai 适配器](../llm-pi-ai/README.zh.md)——本插件复用的通用 pi-ai 适配器与 pool-error 分类。
- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md)——`StreamChunk` 协议与适配器约定。
- [Fork 维护](../../../FORK_MAINTENANCE.md)——mac 池 fork 为本插件记录的保留规则。

<a id="model-experience"></a>
## 模型体验

### 经 mac 池的 provider 请求

#### What the model sees

所选池模型收到共享 pi-ai 传输组装出的 system prompt、会话历史与工具声明，并附带池的 `x-cc-backend` 与 Claude Code 会话 header；模型默认档位以 `thinking: {type: "adaptive"}` 下的 `output_config.effort` 发送。

#### Token effect

调用方未点名上限时，生效目录中的 `maxTokens` 成为该请求的输出上限，所选档位的推理 token 也计入其中。插件其它部分不增加输入 token：路由事实与 header 不是模型可见文本。

#### KV Cache effect

固定目录、端点与 header 跨请求稳定，因此不扰动 provider 可复用的前缀。会话身份由请求会话与其对话位置派生：重试沿用同一身份，而带新内容的请求开启新的会话键。`cacheTtl` 决定 provider 保留该前缀的时长：默认五分钟、配置后一小时，或完全不发缓存标记；标记集合对一份配置固定，不会在请求之间变化。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **池失败分类仍位于 `dsh-llm-pi-ai`**——本插件复用通用适配器的 pool-error 分类器与 `dsh-llm-retry` 的执行器，因此没有 `dsh-llm-pi-ai` 的组合无法挂载该路由。把 mac 池专属分类移入本包属于后续工作；迁移不得向通用包加入 mac 池分支。
- **持久化日志沿用通用文件名**——未配置 `path` 时记录写入 `$DSH_HOME/logs/llm-pi-ai-requests.jsonl`，使既有证据收集继续有效。希望使用池命名文件的部署应设置 `requestLog.path`。
- **目录经本插件自己的字段编辑**——部署通过 `models` 改动自己的模型集，而池同步只报告候选：采纳需要一次显式的设置写入并经过目录校验，绝不会静默覆盖，该读取也无法采纳进通用 Models 页面。新增档位、移除 adaptive thinking 或修改路由事实都随插件版本发布。
- **只公布生效目录中的 id**——服务层仍接受未列出的模型 id，但选择器表面展示该列表，配置后的目录是唯一事实来源。
- **图片模态是声明而非探测**——每个目录条目都会得到 `text` 与 `image`；拒绝图片的池端点会在轮次中途以 provider 拒绝的形式浮现。
- **默认产品不安装本包**——只有安装了该 bundle 的 profile 才存在该路由。base bundle 中 `llm-pi-ai` 的既有预设属于独立组合决策，必须与安装本插件的 profile 变更一起移除，否则两个适配器都会占用 `cc-pool`。
- **同会话排序仅限单个 Host 进程**——队列属于一个插件实例，因此另一个 DSH 进程或其它 CC 客户端使用同一池会话时并不受协调。有界重试只能吸收稍晚释放的租约；若该会话仍在别处活跃，调用方会看到 `POOL_SESSION_BUSY`。

<a id="dev-note"></a>
### 开发备注

- 路由事实、部署未配置的容量或档位集合都随插件版本发布。本包拥有这些值，因此任何 profile 编辑都无法偏离已部署的池；部署自己的模型集属于配置，而不是版本事实。
- 会话忙碌重试计划属于池行为事实，而不是部署可调项：租约在流结束后很快释放，固定的 100-250 ms 步进限定等待时间，既不拖慢正常请求，也不让卡住的会话挂住整轮。这里只重试 `POOL_SESSION_BUSY`；全局槽位限制与 provider 限速仍归 `dsh-llm-retry` 处理。
- 插件的 `Config` 有三个字段：`requestLog` 是安装事实，`models` 是部署的目录，`cacheTtl` 是本路由的提示缓存存活期。三者都不接受档位映射、compat 开关、重试计划或凭据字面量。
