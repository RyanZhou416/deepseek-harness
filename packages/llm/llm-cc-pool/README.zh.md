---
description: "仅供本 fork 使用的 mac 池 provider：一条固定的 cc-pool Anthropic Messages 路由与可配置的模型目录（内置默认值），以可选 profile bundle 安装。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-llm-cc-pool

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-llm-cc-pool` 把 mac 池作为可选 provider 加入组合：提供一条 Anthropic Messages 路由，其端点、凭据与重试策略固定。该路由默认提供内置的四模型目录，部署可用 `models` 整体替换它。其默认提示缓存策略是 CC 2.1.288 的三标记布局：main 与 subagent 请求带显式一小时存活期、identity 块与 extended beta，helper 请求保持 API 默认的五分钟存活期。可选的 `ccWireParity` 请求在成员端点证明该能力后才改用 parity 请求体与 header。插件不注册可配置 provider 目录项，因此只有经校验的配置才能加入模型。

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

本包为 `private: true`：它从本检出链接进 profile，从不发布；发布序列与 npm baseline 都会跳过所有私有包。

把本包安装进某个 profile，或在 profile patch 中挂载它的一行：

```yaml
- id: llm-cc-pool
  name: '@deepseek-ai/dsh-llm-cc-pool'
  config:
    requestLog:
      path: /var/log/dsh/cc-pool-requests.jsonl
    models:
      - id: claude-sonnet-5-5
        name: Claude Sonnet 5.5
        contextWindow: 1000000
        maxTokens: 128000
        defaultReasoning: medium
```

包 manifest 声明了 `dsh.bundle.patch`，因此 `dsh plugin --profile web add ./packages/llm/llm-cc-pool` 会把依赖记入 profile，由 profile loader 应用本包的 patch。fork 的 `build.cmd` 会自动完成同样的事：`scripts/fork-plugins-build.ts` 把这个 workspace 包与 fork 插件一起 staging 并链接进 web profile，便携模板也把 `cc-pool` 留给本 bundle，不再声明 `llm-pi-ai` provider。组合中不需要任何其它 `cc-pool` 配置块：路由事实都在插件源码里，`models` 是部署唯一改动的模型事实。

### 固定路由事实

| 事实 | 值 |
|---|---|
| Provider 路由 | `cc-pool`（显示名 `CC 订阅池`） |
| 线路协议 | `anthropic-messages` |
| 端点 | `https://ccpool.tiancegames.com` |
| 凭据引用 | `CC_POOL_API_KEY` |
| 部署 header | `x-cc-backend: direct` |
| 会话身份 | 请求的 session id 作为 `X-Claude-Code-Session-Id`，所属 Session 的显示名作为 `x-cc-session-name`，每次有意尝试一个 `x-client-request-id` |
| 重试策略 | `normal`，2 次重试，可重试码 `RATE_LIMIT`、`SERVER`、`POOL_REQUEST_CLOSED` 按原样使用；`TIMEOUT` 被排除，因为请求可能已经派发、结果未知 |

`CC_POOL_API_KEY` 每个请求经凭据服务解析，其次读启动环境。解析不到时请求以 `MISSING_CREDENTIAL` 失败并点名该引用，绝不会回退到无关的环境密钥。会话 header 绑定池的会话键与 prompt 身份，因此同一会话的每一轮与工具续写都呈现同一会话。ledger id 属于单次尝试：有意 retry 会发送新 id，因此池不会把它当作已关闭 id 的 replay 来回答，而同一次尝试的重复分派沿用自己的 id。这类路由上这三个 header 名归适配器所有；profile header 中任意大小写拼写的同名项会被移除，而不是并排发送。

池每个会话只允许一个在途 direct 请求；并发请求会被以 `cc_pool_session_busy` 拒绝，而不是排队等待。插件按请求的 session id 排序流：同一会话的第二个请求只在第一个流结束后才到达路由，不同会话仍并行运行，并照常经过池的全局槽位限制。请求只要尚未转发任何内容，被 `cc_pool_session_busy` 拒绝（上一个租约在最后一个 chunk 之后才释放）就会在 1.8 秒内最多重试八次，无论它是否排过队；中止请求会立即释放队列位，且不打开任何上游请求。其它拒绝——全局槽位 `cc_pool_rate_limited` 429、容量限制、provider 限速——原样返回并带上 `Retry-After`，由 `dsh-llm-retry` 处理；点名已关闭 client request id 的拒绝（`cc_pool_request_closed`）在那里可重试，因为下一次尝试携带新 id。本插件不添加跨会话的全局或按 IP 队列，也不添加会话之间的节流。

### 提示缓存策略

本路由的默认策略是 CC 2.1.288 的三标记布局，带显式一小时存活期：`cacheMarkerPolicy: cc3`、`cacheTtl: 1h`、`extendedCacheBeta: true`。三者都不配置的 profile 就使用这套策略。这些字段是插件装载时读取的 loader 配置，只作用于本路由，并且只经本路由的 profile 到达请求。`cacheTtl` 命名 main 或 subagent 请求声明的标记存活期，`extendedCacheBeta` 声明该一小时存活期所需的 `extended-cache-ttl-2025-04-11`，`cacheMarkerPolicy: cc3` 掌管放置。helper 请求（`compaction`、`auxiliary`）不属于该存活期：它保持 API 默认的五分钟存活期，不带 `ttl`，也不声明 extended beta。

不可能成立的组合会在插件装载时被拒绝，设置写入也走同一校验，绝不会拖到请求时才失败：`cacheTtl: 1h` 缺少 `extendedCacheBeta: true` 是错误，`cacheMarkerPolicy: cc3` 还要求 `cacheTtl: 1h`。`cacheTtl: none` 是受支持的关闭缓存状态：解析时会移除 `cacheMarkerPolicy`、强制 `extendedCacheBeta: false`，路由不写任何标记，也不带该策略拥有的布局。`cacheTtl: 5m` 仅供编程调用：loader schema 只提供默认 `cc3` 策略能服务的两种存活期（`1h` 与 `none`），而省略 `cacheMarkerPolicy` 的编程 profile 仍可选择 `5m`。helper 存活期同样不是 loader 取值：它跟随请求类别，任何配置字段都不会把 helper 变成一小时。schema 接受其策略能服务的存活期取值，但由解析后的策略决定它们如何服务，因此路由不会留下来不带其标记所需 beta 的状态。

使用 `cc3` 时，放置由本路由的适配器接管：先移除 `system`、`tools` 和 `messages` 上共享传输或调用方放置的全部 `cache_control`，然后只给三个位置加标记——pinned identity 块、harness system 块，以及最后一个可缓存的用户内容块。main 或 subagent 请求在每个位置写入 `{"type": "ephemeral", "ttl": "1h"}`；helper 请求（`compaction`、`auxiliary`）保持 API 默认的五分钟存活期，写入 `{"type": "ephemeral"}`、不带 `ttl`，也不声明 extended beta。identity 块——`You are Claude Code, Anthropic's official CLI for Claude.`——排在整个 system 数组最前，因此本路由转发的顺序是 identity、harness；mac 池在其前面发送的 billing 块属于池本身，最终顺序为 billing、identity、harness。策略会给 identity 块加标记；池插入的 billing 块不带标记，最后一条 user 消息之前的消息与任何工具声明也都不带。identity 行最多出现一次，因为与它逐字节相等的调用方块会在策略加入自己的块之前被丢弃。

唯一的消息位置是最后一条 user 消息的末尾块；没有调用方 system prompt 的请求标记 identity 与最后 user 两个位置，只有一条消息的请求仍带三个标记。请求体还遵循 pinned 客户端的顶层字段顺序——`model`、`messages`、`system`、`tools`、`tool_choice`、`metadata`、`max_tokens`、`thinking`，随后是其余字段，`stream` 最后——若 `metadata` 缺失，则在规范位置补一个空对象，好让池的 forward-body 编辑器就地把 `metadata.user_id` 写入其中，而不是在 `stream` 之后追加成员；转发后的请求体保持一个 `metadata` 成员，且仍在原位置。beta 走请求的 `anthropic-beta` header，且只随 main 或 subagent 请求发送，helper 不声明；转发的请求体不增加 `scope` 字段，也不声明 scope beta。

由于策略显式落在 profile 上，环境中的 provider 偏好（`PI_CACHE_RETENTION`，其它路由仍可跟随它）无法改变它。其它每一条 pi-ai Anthropic Messages 路由都会显式声明自己的 `cacheRetention`，因此本路由的策略无法到达它们，它们也都不声明 extended beta。

### CC wire parity

`ccWireParity` 为本路由请求 CC wire parity 线路，默认 `false`。该请求是偏好而不是授权：标志关闭时插件不发送任何探测；即使打开，路由也只在成员端点用本路由的成员凭据回答 `GET https://ccpool.tiancegames.com/v1/capabilities` 并返回 `{protocol: 2, ccWireParity: 1, buildId}` 之后，才在 profile 上公布该标志。只有携带该精确三元组的 `200` 才能证明能力；`buildId` 是池构建自身的稳定身份（`MacPoolBuildId`），未打包构建不报告它，因而证明不了任何东西。被拒绝、畸形、超时或不可达的回答都会让路由留在默认的三标记线路上，缺少成员凭据同样保持关闭，而不是让装载失败。通用 pi-ai resolver 会拒绝任何没有容量证明的 profile 上的 `ccWireParity`，且该证明的 endpoint 必须与该路由同源；只有本插件会提供这样的证明——取自它对上述端点的探测——因此手写 profile 无法启用该线路。

正面证明只属于作出回答的端点与池构建。插件在 profile 装载时以及 `CC_POOL_API_KEY` 被替换时再次询问，绝不轮询。它也没有重连接缝：新构建上的池重启在其中一个触发器运行之前不会被重新探测，因此路由可能继续为上一个构建证明过的线路服务。池标记为 `x-cc-wire-parity-unavailable: 1` 的 `503` 是对能力的反证，而不是再问一次的理由：插件丢弃证明，下一个请求改用默认线路，且不重新探测。该标记本身也禁止自动重发——即使响应体没有 pool code、`origin` 或重试事实——因此被拒绝的 wire parity 请求绝不会以默认线路重试。

在已证明的路由上，适配器写入 parity 请求体与三个成员 header（`x-cc-request-class`、`x-cc-system-layout`、`x-cc-cache-intent`）；本插件只公布标志与缓存意图，绝不改写请求体或 header。线路自行声明缓存意图：`cacheTtl: none`——本路由的关闭缓存状态——变成意图 `off`，worker 因此不写标记、不写 TTL、不声明 cache beta，而其它存活期都变成 `main`，即 worker 自己的缓存计划；helper 始终声明 `helper`。parity 请求体本身不携带 `cache_control`，因此该线路不要求 `cc3`、`cacheTtl: 1h` 或 `extendedCacheBeta`，关闭缓存的路由仍启用该线路。适配器无法分类的请求，或没有真实静态/动态分界的主/子智能体请求，会改用默认三标记请求体，而不是部分 parity 请求体。

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

每次尝试在开始时写一条结构化日志记录，在结束时再写一条：路由、模型、端点、session id、本次尝试的 ledger id、该逻辑请求内的尝试序号、响应状态、响应带有的池 `x-cc-pool-request-id`，以及失败的稳定 code。本路由的进程日志正是持久 sink 保留的那些行，因此端点缩减为 origin 与 path，并略去 provider 失败的 message 与 cause 链；诊断依赖稳定 code、状态与池 request id。ledger 身份只在会发送或持久化它的路由上派生，门外的路由不支付消息哈希与尝试记账的开销。排过队的请求若在池释放上一租约时被拒绝，会作为同一逻辑请求的下一次尝试重试：尝试序号推进，且重试发送新的 ledger id，因此它是池中新的 ledger 条目而不是 replay。记录绝不包含消息、请求体、凭据、token 数或会话标题。

`requestLog` 把同样的记录持久化为 NDJSON。它默认关闭：池路由携带会话身份并不等于要求写文件。配置 `requestLog`——`enabled: true`，或 `path` 等任一字段——才会启用，`enabled: false` 保持关闭。未配置 `path` 时池路由写入 `$DSH_HOME/logs/llm-cc-pool-requests.jsonl`；这个独立文件保证启用后的 `llm-pi-ai` sink 不会在其默认路径上出现第二个写入者。持久记录把端点缩减为 origin 与 path，因此 userinfo 与 query 秘密不会进入文件，并且完全不持久化 provider 失败文本。`path` 移动文件，`maxFileBytes`（默认 16 MiB）设定轮转点，`maxFiles`（默认 8）设定保留数量；轮转先删除最旧文件，保留集合不超过 128 MiB。在 POSIX 上，文件与写入器创建的目录都是 owner-private（`0600` 与 `0700`）；已存在活动文件的 group/other 位会在下次追加前修复为 `0600`，进程无法完成的修复会拒绝这次写入并报告一次。Windows 没有 POSIX mode 位，写入器在那里继承文件的 ACL。写入排在请求路径之外，首次失败经插件 logger 报告一次，且不会使请求失败。

<a id="understand-the-implementation"></a>
## 理解实现

本包是 named Cordis function plugin（`name`、`inject`、`Config`、`apply`），没有 default export。`apply` 用 `dsh-llm-pi-ai` 的通用 profile resolver 解析生效目录，因此畸形的目录会在插件装载时失败而不是等到首个请求，然后把它注册到 `ctx.llm`。在解析之前它会校验缓存策略的跨字段约束，同一检查也跑在设置写入的 waterfall 上，因此不可能的存活期/beta 组合会在写入处被拒绝。该 profile 把配置的 `cacheTtl` 作为 pi-ai 的 `cacheRetention` 档位、把 `extendedCacheBeta` 作为 profile 的 beta 声明、把 `cacheMarkerPolicy` 作为 profile 的三标记策略携带，因此策略无需本插件改写任何请求体即可到达请求（`cc3` 的 identity 块与标记改写由 `dsh-llm-pi-ai` 的同一个 `onPayload` 钩子完成）。它不声明任何 compat 开关，因为放置归策略所有且不标记工具声明。解析出的目录与 profile 按原始 `models` 值与当前线路证明做记忆化，未变化的配置保持同一快照，而设置写入或新的探测结果产出下一个快照。能力探测在装载时与成员凭据被替换时运行，并只对覆盖本端点与构建的证明在 profile 上公布 `ccWireParity` 标志；同一证明也是通用 resolver 接受该标志的前提，因此标志与证据一起到达 profile。下一个请求与模型列表无需重启即可看到新快照。

适配器是 `dsh-llm-pi-ai` 的 `PiAiAdapter`，覆盖两个方法：`listModels` 直接回答生效目录，而不先解析凭据；`stream`/`prepareCall` 把每次派发送入按会话串行门。通用适配器的 HTTP/SSE 传输、上下文转换、流投影、pool-error 分类与 replay 处理都被复用而非复制。插件自身贡献路由事实、目录、固定重试策略、会话 header、会话排序、能力探测、日志与持久化 sink。

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

所选池模型收到 Claude Code identity 块、共享 pi-ai 传输组装出的 system prompt、会话历史与工具声明，并附带池的 `x-cc-backend` 与 Claude Code 会话 header；模型默认档位以 `thinking: {type: "adaptive"}` 下的 `output_config.effort` 发送。

#### Token effect

调用方未点名上限时，生效目录中的 `maxTokens` 成为该请求的输出上限，所选档位的推理 token 也计入其中。插件其它部分不增加输入 token：路由事实与 header 不是模型可见文本。

#### KV Cache effect

固定目录、端点与 header 跨请求稳定，因此不扰动 provider 可复用的前缀。会话身份由请求会话与其对话位置派生：重试沿用同一身份，而带新内容的请求开启新的会话键。默认的 `cc3` 策略加入 identity 块，对 main 或 subagent 请求用显式一小时存活期、对 helper 请求用 API 默认的五分钟存活期标记 identity 块、harness system 块与最后一个用户内容块，写入 pinned 客户端的字段顺序，并只在采用一小时存活期时声明 extended beta。`cacheTtl` 与 `extendedCacheBeta` 仍是本路由的字段，但策略要求一小时且声明 beta 的组合，并由策略掌管标记集合与字段顺序，因此布局不会在请求之间变化，任何工具声明也都不带标记。一旦证明 `ccWireParity`，parity 请求体反而完全不携带 `cache_control`：它把 prompt 拆成 identity 行、重排后的静态 section 与会话专属余下部分，由 worker 按声明的意图写入缓存计划——`main`，或关闭缓存路由的 `off`——因此该线路的前缀布局与标记放置属于池的 worker，而不属于本路由。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **池失败分类仍位于 `dsh-llm-pi-ai`**——本插件复用通用适配器的 pool-error 分类器与 `dsh-llm-retry` 的执行器，因此没有 `dsh-llm-pi-ai` 的组合无法挂载该路由。把 mac 池专属分类移入本包属于后续工作；迁移不得向通用包加入 mac 池分支。
- **持久化日志需显式启用并使用自己的文件名**——未配置的插件不写任何文件，因为会话 header 本身不隐含 sink。配置 `requestLog` 但未给 `path` 时写入 `$DSH_HOME/logs/llm-cc-pool-requests.jsonl`，从而避开通用 pi-ai 文件，也不会在同一默认路径上出现两个写入者。
- **parity 的 system 改写没有持久记录**——该线路的 `[identity, static, dynamic]` system 文本，以及被丢弃或重排的 section，会到达模型却没有对应的 `llm/request-record` 条目。订阅插件的 Claude 路由会发布该记录；在此照做需要修改 required-on-read 的 `llm/request-record` 持久类型（producer 为字面量、payload 没有 section plan 字段），因此这是对 model-visible⟺logged 规则的有意例外，而不是静默的格式改动。理由与后续工作记录在 `FORK_MAINTENANCE.md`；请求日志只记录尝试、不含请求体，不能替代它。这只是可观测性缺口——请求字节、缓存布局与线路行为均不改变。
- **目录经本插件自己的字段编辑**——部署通过 `models` 改动自己的模型集，而池同步只报告候选：采纳需要一次显式的设置写入并经过目录校验，绝不会静默覆盖，该读取也无法采纳进通用 Models 页面。新增档位、移除 adaptive thinking 或修改路由事实都随插件版本发布。
- **只公布生效目录中的 id**——服务层仍接受未列出的模型 id，但选择器表面展示该列表，配置后的目录是唯一事实来源。
- **图片模态是声明而非探测**——每个目录条目都会得到 `text` 与 `image`；拒绝图片的池端点会在轮次中途以 provider 拒绝的形式浮现。
- **缓存布局是三个真实的 CC 标记，而不是 CC 的完整 planner**——未启用 `ccWireParity` 时，路由转发客户端 identity 块，并按 pinned 客户端的顶层字段顺序标记 identity 块、harness system 块与最后一个用户内容块。它不复制客户端的 `markerIndices`、fork point、compact 断点规划、其静态/动态 prompt 切分，也不复制其前一条消息断点，并且不放置任何工具标记。可选线路只在成员端点证明能力后的请求上加入该切分与 parity header，否则回退到这条默认线路。缺少必需的一小时/beta 组合的策略会在装载时被拒绝，而不是静默回退；`cacheTtl: none` 则解析为合法的关闭缓存策略，不写标记，也不声明 extended beta。
- **线路按池构建证明，且没有重连触发器**——一次证明只覆盖一个成员端点与一个池 `buildId`；插件只在 profile 装载与 `CC_POOL_API_KEY` 被替换时再次询问。因此新构建上的池重启不会被重新探测，路由会继续为上一个构建证明过的线路服务，直到其中一个触发器运行或带标记的 `503` 丢弃证明。
- **base bundle 不包含本包**——只有链接了该 bundle 的 profile 才存在该路由。fork 的 `build.cmd` 会为 web profile 完成链接，但未经过该构建的 profile 没有 `cc-pool` 路由。仍声明 `llm-pi-ai` `cc-pool` provider 的 profile 必须移除它，否则两个适配器都会占用 `cc-pool`，插件装载失败。
- **同会话排序仅限单个 Host 进程**——队列属于一个插件实例，因此另一个 DSH 进程或其它 CC 客户端使用同一池会话时并不受协调。有界重试只能吸收稍晚释放的租约；若该会话仍在别处活跃，调用方会看到 `POOL_SESSION_BUSY`。

<a id="dev-note"></a>
### 开发备注

- 路由事实、部署未配置的容量或档位集合都随插件版本发布。本包拥有这些值，因此任何 profile 编辑都无法偏离已部署的池；部署自己的模型集属于配置，而不是版本事实。
- 会话忙碌重试计划属于池行为事实，而不是部署可调项：租约在流结束后很快释放，固定的 100-250 ms 步进限定等待时间，既不拖慢正常请求，也不让卡住的会话挂住整轮。这里只重试 `POOL_SESSION_BUSY`；全局槽位限制与 provider 限速仍归 `dsh-llm-retry` 处理。
- 插件的 `Config` 有六个字段：`requestLog` 是安装事实，`models` 是部署的目录，`cacheTtl`、`extendedCacheBeta` 与 `cacheMarkerPolicy` 是本路由的提示缓存策略，`ccWireParity` 是可选的 CC wire parity 请求。缓存默认值就是三标记一小时策略（`cacheTtl: 1h`、`extendedCacheBeta: true`、`cacheMarkerPolicy: cc3`），`none` 存活期解析为无标记、无 extended beta，并去掉 cc3 布局（identity 块、pinned 字段顺序、`metadata` 占位符），helper 请求保持 API 默认的五分钟存活期，不可能的组合会在装载时被拒绝，`ccWireParity` 默认 `false`。这些字段都不接受档位映射、任意 compat 开关、重试计划、探测间隔或凭据字面量。
