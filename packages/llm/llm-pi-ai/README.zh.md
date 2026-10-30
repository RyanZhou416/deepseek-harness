---
description: "面向用户与维护者的 pi-ai 多提供方适配器说明：通过 pi-ai 目录与手工声明网关路由 harness LLM（大语言模型）服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-pi-ai

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-llm-pi-ai` 通过一份配置把模型请求路由到多个 pi-ai 提供方、OpenAI 兼容网关或自托管服务器。已安装的 pi-ai 提供方会提供端点、协议和模型目录默认值；自定义路由可以直接声明这些值，无需修改代码。profile 与凭据按请求解析，因此设置变更会在下一个请求生效，无需重启。受支持的提供方可以使用已存储的 OAuth 或交互式密钥登录，并通过跨进程锁刷新凭据。本包可以在没有路由时启动，并在用户设置添加路由后将其激活。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当组合需要通过 pi-ai 的提供方目录、或通过 pi-ai 已安装目录未描述的网关路由模型请求时挂载本插件。`providers` 字典就是整个配置面：每个键都是请求用 `GenerateOptions.provider` 选择的提供方路由名。

适配器接受 LLM 服务的[仅供请求使用的 user 输入](../llm/README.zh.md#use-this-package)，并可将其与持久历史混用。user 身份与来源不会进入 pi-ai 内容；assistant 回放元数据和工具调用关联仍由持久消息携带。

### 何时选择

当同一组合服务多个提供方、某条路由需要 pi-ai 目录默认值并修正少数字段、或必须通过自有端点与协议到达手工声明网关时，选择本适配器。当部署不需要其他提供方时，选择 `dsh-llm-deepseek` 直连 DeepSeek 路由。两个适配器可以同时挂载，因为它们的路由名不冲突；注册其他适配器已拥有的路由会导致插件加载失败。

### 配置提供方路由

每个 profile 都可以设置 `retryPolicy`；省略时使用 normal mode、最多重试五次，并覆盖 harness 暂时性错误码与本适配器分类的 pool 错误码；显式配置 `retryableCodes` 时完全按配置使用。`apiKeyEnv` 是按请求经 harness 凭据 seam 解析的凭据引用，因此配置文件绝不包含密钥；解析为空的引用会让请求以 `MISSING_CREDENTIAL` 失败。省略它会让路由保持已配置但无密钥（configured-but-keyless）状态，对已安装目录路由而言即交由 pi-ai 提供方原生的环境发现。

```yaml
- name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      openai:
        apiKeyEnv: OPENAI_API_KEY
        baseURL: https://proxy.example.com:8443
        reasoning: high
        requestImagePixelBudget: 4194304 # total pixels; 2048 by 2048 default
        requestImageMaxBytes: 1048576    # raw bytes before base64 expansion
        maxRequestImageBytes: 20971520   # accumulated base64 payload
        retryPolicy:
          mode: normal
          maxRetries: 3
      anthropic:
        apiKeyEnv: ANTHROPIC_API_KEY
        models:
          - id: claude-sonnet-4-5
            contextWindow: 200000
      acme-gateway:
        displayName: Acme Gateway
        apiKeyEnv: ACME_GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.acme.example/v1
        compat:
          thinkingFormat: deepseek
        models:
          - id: acme-think
            name: Acme Think
            contextWindow: 262144
            reasoningEfforts:
              off:
              medium: medium
              high: high
            reasoning: medium
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKeyEnv` | 无 | 按请求解析的凭据引用；省略时交由 pi-ai 环境发现 |
| `displayName` | 提供方名 | 选择器界面显示的标签 |
| `api` | 目录协议 | 协议格式；仅目录不提供的路由需要 |
| `baseURL` | 目录端点 | 路由上所有模型的端点 |
| `models` | 已安装目录 | 整体替换路由目录；每个条目从已安装模型取默认值 |
| `modelOverrides` | 无 | 重塑个别已安装目录模型，而不替换其余模型 |
| `compat` | 目录检测 | 无法识别端点的协议兼容开关 |
| `defaultContextWindow` | `262,144` | 未描述模型的容量回退 |
| `defaultMaxTokens` | `32,768` | 未描述模型的输出上限回退 |
| `requestImagePixelBudget` | `4,194,304` | 每张确定性请求图片的总像素预算 |
| `requestImageMaxBytes` | `1 MiB` | 每张请求图片在 base64 扩展前的编码字节目标 |
| `maxRequestImageBytes` | `20 MiB` | base64 图片载荷总上限，保留图片超过时请求以 `IMAGE_OFFLOAD_REQUIRED` 失败 |
| `retryPolicy` | normal，5 次重试 | 由 `dsh-llm-retry` 执行的提供方自有重试策略；默认集合还会加入本适配器分类的 pool 错误码 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-pi-ai)是每个受支持字段及其 JSDoc 的穷尽式真源。

`sessionHeaders` 指定哪些提供方路由的请求必须携带会话感知端点读取的 Claude Code 会话身份：`X-Claude-Code-Session-Id` 取请求自身的 `sessionId`（原样）；`x-cc-session-name` 取所属 Session 的显示名，按字段需要做百分号编码，名字为空、过长或只剩不可发送字符时不发；`x-client-request-id` 每次有意尝试一个，因此 retry 会呈现全新的 ledger id，而不是端点已关闭的 id，而同一次尝试的重复分派沿用同一个 id。这类路由上这三个名字归适配器所有：profile `headers` 中任意大小写拼写的同名项会被移除，而不是与适配器值并排发送。名字在编码前先清洗到 pool 接受的展示集合：丢弃 C0/DEL/C1 控制字符与 U+2028/U+2029，以及双向与零宽格式标量（U+061C、U+200B–U+200F、U+202A–U+202E、U+2060–U+2064、U+2066–U+2069、U+FEFF）；清洗后为空、或去除首尾空白后等于保留占位词 `空闲`/`未知` 的名字整头不发。编码器随后只对清洗后的名字做百分号编码——RFC 3986 未保留字符保持字面——因此这三类拒绝值不会到达 pool。可以写一个路由名或一个列表；不在其中的路由这些头都不发。会话 id 必须是端点接受的、1 到 256 个字符的可打印 ASCII，其他取值会让请求在发生任何网络 I/O 前以 `INVALID_REQUEST` 失败。名字若不匹配任何已配置路由则不产生效果，因为路由集合可能在本组合层之后由设置提供。该开关用于按此头绑定会话及其 prompt 身份的共享账号池；它不改变提供方请求的其他部分。

`requestLog` 为 logger 记录的同一批请求诊断增加一个持久 NDJSON 文件。未配置时，被 `sessionHeaders` 命名的路由会把记录写到 `$DSH_HOME/logs/llm-pi-ai-requests.jsonl`；`enabled: true` 持久化每个路由，`enabled: false` 完全关闭该文件。每行携带时间戳、记录类型、路由、模型、端点、Session id、ledger id、尝试序号、流式标志，以及响应的状态、pool request id 与失败 code——绝不包含 messages、请求体、凭据、token 计数、Session 标题或提供方失败文本。端点会缩减为 origin 与 path，因此 userinfo 与 query 秘密不会进入文件；失败的 message 与 cause 链仍由进程 logger 承载，但该 sink 保留的路由其进程行也做同样的缩减。`path` 可移动文件位置，`maxFileBytes`（默认 16 MiB）决定滚动阈值，`maxFiles`（默认 8）决定保留文件数；滚动先删除最旧文件，保留集合始终不超过 128 MiB。在 POSIX 上，文件与该写入器创建的目录为所有者私有（`0600` 与 `0700`）；已存在活动文件的 group/other 位会在下次追加前修复为 `0600`，进程无法完成的修复会拒绝这次写入并只报告一次。Windows 没有 POSIX mode 位，写入器在那里继承文件的 ACL，无法收窄既有文件。写入失败只通过插件 logger 报告一次，绝不让请求延迟或失败。Loader 配置在插件挂载时读取，因此更改在下次启动时生效。

Anthropic Messages 路由还会把每张图片的长边限制为 8,000 像素；完整请求保留超过 20 次图片出现时，长边上限为 2,000 像素。用户图片、工具结果和重复附件均计数，日志标记已卸载的图片不计数。上下文窗口不超过 200,000 token 的模型最多接收 100 张图片，更大窗口接收 600 张。这些协议上限也约束自定义像素预算。其他协议继续使用各自配置的预算，切换路由时从保存的规范化附件重新计算目标。

### 登录提供方

pi-ai 提供登录的提供方可以通过 harness 授权 seam 登录：流程提供 OAuth 或交互式密钥提示（密钥键入 pi-ai 自己的登录提示，而非设置表单），得到的凭据存储在 harness 凭据存储的 `llm-pi-ai/<provider id>` 记录中。存储的登录在其路由的 `apiKeyEnv` 覆盖之下完成认证，并在存储的跨进程锁下自行刷新；退出登录即删除存储记录。落在记录文法之外——小写连字符标识符——的手工声明路由键无法登录，因为对它的记录写入会以 `LlmError('UNSTORABLE_PROVIDER_ID')` 拒绝；这类路由改用 `apiKeyEnv` 或提供方 ambient 设置认证。

### 解析模型目录

profile 的 `models` 列表会替换而非扩展路由的已安装目录；每个条目从同 id 已安装模型取未设置字段的默认值，因此把路由收窄到两个模型、修正一个容量或添加比已安装目录更新的模型都是一行编辑。`modelOverrides` 无需该代价即可重塑个别已安装目录模型——修正一个模型，保留其余三十七个——当它与 `models` 列表并存、位于手工声明路由上、或点名目录未描述的模型时会被拒绝，因为静默不变的模型会成为别人日后寻找的拼写错误。

### 带推理（reasoning）与协议兼容运行

`reasoningEfforts` 声明模型可选择的 thinking 等级：每个键都是选择器提供的等级，其值是分派时在协议中发送的拼写，因此 `max: ultra` 可以为拥有自有词汇的网关重命名等级。省略该字段时保留已安装目录条目的能力；`false` 声明非推理模型。对于 pi-ai 无法识别的端点，`compat` 开关重塑请求——哪个角色携带系统提示词、哪个字段限制输出、thinking 等级如何传递——可逐路由、逐模型配置。条目与已安装目录都没有尺寸的模型，会采用路由的 `defaultContextWindow` 与 `defaultMaxTokens` 回退值。

确切模型元数据将 `reasoning.efforts` 按可选强度从低到高排列，并给出会被 seam 物化进未点名强度请求的 `defaultEffort`。模型条目自身的 `reasoning` 提供该默认值；它必须是该模型提供的等级——`reasoningEfforts` 中声明的等级，或该字段缺席时已安装目录条目声明的等级——非推理模型不得设置，因此在写入处就会拒绝不可能生效的默认值。未点名默认值的模型采用路由级 `reasoning` 作为回退。配置函数可在 `prepareCall()` 校验具体强度前从 `reasoning.efforts` 中选择。适配器只接收解析后的控制项。选择 `off` 不保证禁用推理：以省略推理字段表达该值的协议会沿用网关默认行为。所选等级下产生的推理 token 都计入该请求的输出上限。

对于自托管 Chat Completions 端点，`thinkingTokenBudgetField` 选择推理预算参数，`vllmPriority` 在服务端启用优先级调度时设置整数调度优先级。模板参数接受 `$var: thinking.budget`。`openai-responses` 网关可设置 `supportsMaxOutputTokens: false` 来省略 `max_output_tokens`；Azure 与 Codex 传输会忽略这个共享兼容字段。这些控制均需显式启用；目录拥有的 Anthropic effort 和回退能力不是可配置开关。

`cacheRetention` 选择该路由 pi-ai 实现放置的提示缓存标记——`none`、`short`，或让每个标记携带 `ttl: "1h"` 的 `long`——未设置时跟随 pi-ai 的 `PI_CACHE_RETENTION` 默认值。`extendedCacheBeta: true` 还会在 SDK 序列化 header 之前，把 `extended-cache-ttl-2025-04-11` 追加到 Anthropic Messages 请求的 `betas` 列表；它绝不从 long 存活期推断，且模型都不使用 Anthropic Messages 协议的路由会拒绝该选项。`cacheMarkerPolicy: cc3` 则接管标记放置与 system 前缀：适配器先移除 `system`、`tools` 和 `messages` 上的全部 `cache_control`，加入 pinned Claude Code 2.1.288 identity system 块——`You are Claude Code, Anthropic's official CLI for Claude.`——然后只在三个位置放置 `{type: "ephemeral", ttl: "1h"}` 标记：identity 块、harness system 块，以及最后一个可缓存的用户内容块。最后一条 user 消息之前的消息不会被标记，任何工具声明都不会被标记；没有调用方 system prompt 的请求只标记 identity 与最后 user 两个位置。策略还会写 pinned 客户端的顶层字段顺序——`model`、`messages`、`system`、`tools`、`tool_choice`、`metadata`、`max_tokens`、`thinking`，随后是其余字段，`stream` 最后——若 `metadata` 缺失，则在规范位置补一个空对象，好让池的 `metadata.user_id` 拼接保持该位置。`cc3` 优先于 `cacheRetention` 与 `compat.supportsCacheControlOnTools` 选择的放置方式，在模型都不使用 Anthropic Messages 协议的路由会被拒绝，并且本身不声明 extended beta。适配器不添加 `scope` 字段或 scope beta。这些设置都按路由生效，因此包含多条 Anthropic 路由的组合会为每条路由显式声明自己的存活期、beta 与放置方式。

`ccWireParity` 让 Anthropic Messages 路由改用成员端点证明能力后接受的 CC wire parity 请求体与 header，`ccWireParityCache`（`main|off`，默认 `main`）选择其 `main` 与 `subagent` 请求声明的缓存意图；没有 `ccWireParity` 时解析会拒绝该缓存意图，而探测该路由的插件未提供 endpoint 与该路由同源的容量证明时，解析也会拒绝 `ccWireParity` 本身，因此装载配置能请求该线路却不能启用它。适配器用 `GenerateOptions.systemSections` 构建 system——pinned identity 行、重排后的 `stable` section 与会话专属余下部分——并应用 pinned 顶层字段顺序以及 thinking display 与 cache beta 的改写，保留 `eager_input_streaming`，自身不放置任何 `cache_control`。未声明 class 的请求，或没有真实分界的主/子智能体请求，会走该路由的普通线路；helper（`compaction`、`auxiliary`）保留调用方的 system，layout 为 `none` 且不带标记。class 取自 `GenerateOptions.requestClass`（`main|compaction|auxiliary|subagent`），其次取 `purpose`；该字段对模型隐藏，绝不进入 provider 请求体或日志。`x-cc-request-class`、`x-cc-system-layout` 与 `x-cc-cache-intent` 三个 header 在所有路由上都归适配器所有：profile 声明其中之一会在解析时被拒绝，请求构造时也会将其剔除。模型都不使用 Anthropic Messages 协议的路由会拒绝这两个标志。携带 `x-cc-wire-parity-unavailable: 1` 的 `503` 响应会记录在响应诊断中，好让池路由无需重新探测即可丢弃该能力。

### 运行时更改配置

每次操作捕获当前 `providers` Config 引用。新增或修改的 provider 配置在表单持久化前验证；未更改的目录故障仍可编辑。路由集合或重试策略变化时原子更新注册；如果其他适配器已拥有所请求的路由，则保留先前路由。

### 从端点发现模型

插件会回答「该提供方可以提供哪些模型？」，供配置界面正在编辑或起草的路由使用。已安装目录提供的路由直接由目录回答，不发网络请求，并将其 `input` 数组保留为发现结果的 `inputModalities`；只有目录未描述的路由才会经网络询问。`openai-completions` 与 `openai-responses` 使用带 bearer 鉴权的 `GET {baseURL}/models`，`anthropic-messages` 则以 `x-api-key` 和 `anthropic-version` 使用原生 `GET /v1/models?limit=1000` 语义；其列表 URL 接受带或不带末尾 `/v1` 的 API 根地址，因为网关文档两种写法都会发布，且只有该列表 URL 会归一化这一段，模型请求收到的仍是配置原样的 `baseURL`。已配置且具名的路由会在 Host 内部提供已存凭据与 profile `headers`，因此通过 `cordis.patch.yml` 或 Cordis 配置设置的部署标头可以到达模型发现请求，但不会成为发现请求或 Models 页面的字段；表单中新键入的密钥仍优先于已存凭据。解析器接受标准 `data` 数组或富信息 `models` 对象，并归一化每个候选的 id、显示名、上下文窗口与最大输出 token 数；Anthropic 的 `max_input_tokens` 与 `max_tokens` 会进入相同容量字段，即使对象条目点名了另一个规范 id，对象键仍是请求 id，原始类型的对象属性会被忽略，缺失的显示名则回退到该请求 id。回答是界面可以提供给用户采纳的候选元数据——不存储任何内容，`cordis.patch.yml` 仍然是决定路由服务内容的唯一事实。

### 失败与恢复

pi-ai 不提供的路由需要 `api`、`baseURL` 与非空 `models` 列表；无法服务的 profile 会在写入处被拒绝，并点名路由与模型。失败携带稳定 code：无法使用的凭据以 `INVALID_CREDENTIAL` 失败并点名路由与引用，`apiKeyEnv` 引用解析为空的路由以 `MISSING_CREDENTIAL` 失败，未配置模型以 `UNKNOWN_MODEL` 失败，终止性提供方失败则区分 `QUOTA` 与暂时性 `RATE_LIMIT`。`GenerateOptions.stop` 以 `UNSUPPORTED_OPTION` 被拒绝，因为 pi-ai 的通用流式 UI 无法跨提供方保证它。

前置多个账号的共享账号池会在相同的 Anthropic 风格 envelope 中返回自己的 `cc_pool_*` code、`origin` 与重试事实。适配器读取这些字段而不是 HTTP 状态，因此 pool 拒绝永远不会变成 Claude 的 `RATE_LIMIT`：`POOL_CAPACITY`、`POOL_RATE_LIMITED` 与 `POOL_NO_ACCOUNT` 在有限重试预算内可重试，并遵守提供方的 `Retry-After`；`POOL_SESSION_BUSY` 禁止自动重发，因为另一个轮次正占用该 Session；`POOL_REQUEST_CLOSED` 要求再试一次，因为适配器会给该次尝试盖新的 ledger id，所以重发是新的条目而不是对已关闭条目的 replay。pool 的 `terminal` 标记拒绝的是同一 request id 的 replay，而不是这条新条目，因此在 envelope 仍把该 code 标为可重试时不会否决目录的 `retry_same` 动作；`retryable: false` 无论 `terminal` 是否出现都禁止它，而该标记对其余已知与无法识别的失败保持权威。无法识别的可重试 pool code 变为 `POOL_TRANSIENT`，无法识别的不可重试 code 变为 `POOL_ERROR` 并禁止重发。拿不到捕获响应或消息前缀时，`error.status` 提供 HTTP 状态。readiness 拒绝两者都不携带：pool 在 body 中写入 `pool_request_id`，并在 `retryable: false` 旁给出 lease 未验证的 egress 路径（`capability_not_ready`）。由于 pool 现在把 `pool_request_id` 写进每个错误 body（包括原生 provider 失败），仅凭该 id 已不能识别 readiness 拒绝；识别依据是该 lease 详情。同一批 pool 标记只在原生 5xx 上带决定：body 带 `pool_request_id`（或 `origin: pool`）且声明 `retryable: false` 时禁止重发，不再让文本分类把它当作可重试 5xx。原生 400/413 context-overflow body 仍交给文本分类以触发 compaction；没有这两个标记的 body 保留文本分类与原措辞。失败行直接显示池返回的 `error.message`，但会先压成单行、限制在 1,024 个字符内，并拒绝标记、实体和凭据样式文本，同时保留 pool 自己的 `[redacted]` 占位符（`api_key=[redacted]`、`?token=[redacted]`）；消息缺失或不安全时改用带失败码的通用池拒绝文案。生成目录只提供机器语义，不提供显示文案。`claude` origin 保留原有分类与措辞，除非 pool 自己撤回了重试。账号选择、冷却与 Session 绑定仍由 pool 负责。

每次请求尝试都通过插件 logger 记录两条结构化记录（开始一条、结算一条）：路由、模型、端点 URL、Session id、本次尝试的 ledger id、该逻辑请求内的尝试序号与响应状态；响应带回 pool 自己的 request id 时一并记录，失败时记录 code。有意 retry 会推进尝试序号并发送新的 ledger id。ledger 身份只在会把它作为会话头发送或持久化它的路由上派生；其他路由的请求路径不做消息哈希、复制或尝试记账，其记录也不带 ledger id 与尝试序号。被 `sessionHeaders` 命名的路由以 INFO 级记录，部署默认 sink 会保留它们，并把同样的记录持久化到请求日志；这些行沿用持久记录的端点缩减（仅 origin 与 path），并略去失败的 provider message 与 cause 链，因为两者都可能回显凭据或请求内容。其他路由保持 DEBUG 级，失败时仍以 WARN 带上提供方的实时 message 与原始错误的 cause 链（pi-ai 自身只保留 message 文本）；显式启用请求日志后它们也会被持久化。任何记录都不包含 messages、请求体、凭据或 token 计数。

Config 更新严格验证发生变化的 provider。初始加载将已存储的目录故障保留为可编辑的 provider 诊断；未更改的故障 provider 不阻止其他编辑。可用模型仍可选择，无法解析的模型在网络 I/O 前失败。修复或删除问题配置会清除其诊断。

只修改 `displayName`、`apiKeyEnv` 或 `baseURL` 而未解决提供方的模型配置错误时，保存仍会被拒绝。例如，OpenRouter 路由的模型 `111` 缺少 `api` 时，不能单独保存路由名称的修改：需要在同一份编辑草稿中修复或删除该模型，再保存完整的提供方配置。中间修复状态保留在草稿中，直到整条提供方配置通过校验；其他提供方可以独立保存。

模型发现会解析各路由的凭据配置。缺少必需凭据时返回空目录；其他解析错误继续抛出。使用原生认证或无需密钥的路由保留其配置的目录。此检查不会探测推理端点。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释适配器背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

适配器建立在不可变快照与按操作解析之上。每个操作都会在第一次 `await` 前捕获整个快照——profile 加一个持有每条路由所构建 `Provider` 的 `createModels()` 集合——配置变更会构建新集合而非修改使用中的集合，因此在一个配置下开始的请求绝不会在另一个配置下结束。路由自己的凭据引用经 harness seam 解析，并以请求 `apiKey` 选项传入，pi-ai 将其视为优先级最高的 auth 覆盖——这正是明确失败引用语义的所在。该覆盖未覆盖的一切都经集合自身的 auth 到达 pi-ai：凭据存储持有登录写入、刷新轮换的记录（以 `llm-pi-ai/<provider id>` 寻址），auth context 回答提供方解析时提出的 ambient 问题。两者跨快照保持稳定，因此配置变更重建集合时不会忘记谁已登录。运行时 import 使用 pi-ai 的 provider、API 与 utility 入口；`src/models.ts` 提供本适配器所需的少量 model helper，而不会求值 pi-ai 聚合入口。

初始提示词文本和可用工具分别使用 pi-ai 的 `Context.systemPrompt` 与 `Context.tools`；后续系统消息和工具更新保留在 `Context.messages` 中。pi-ai 负责规范化这些字段，并应用所选协议的序列化规则。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Config 快照、目录及路由注册 |
| [`src/auth.ts`](src/auth.ts) | 覆盖 harness 凭据平面的凭据存储与 ambient auth context |
| [`src/login.ts`](src/login.ts) | 面向提供登录的已安装提供方的授权流程 |
| [`src/config.ts`](src/config.ts) | Profile schema、解析与可服务性校验 |
| [`src/catalog.ts`](src/catalog.ts) | 已安装目录集成与漂移门禁 |
| [`src/provider-data.ts`](src/provider-data.ts) | 配置界面使用的认证与端点生成数据 |
| [`src/models.ts`](src/models.ts) | 基于 pi-ai 窄入口的 model collection、静态 provider 与 reasoning level |
| [`src/provider.ts`](src/provider.ts) | 受支持协议表与提供方构建 |
| [`src/context.ts`](src/context.ts) | Harness 到 pi-ai 的上下文转换、图片处理、回放恢复 |
| [`src/stream.ts`](src/stream.ts) | 把 pi-ai 事件转换为 harness `StreamChunk` 值 |
| [`src/replay.ts`](src/replay.ts) | 带版本的 `ReplayEnvelope` 存储与校验 |
| [`src/request-log.ts`](src/request-log.ts) | 按体积滚动的持久 NDJSON 请求诊断 |
| [`src/discovery.ts`](src/discovery.ts) | 面向配置界面的端点询问 |
| [`src/reuse.ts`](src/reuse.ts) | 供其他 provider 插件挂载固定路由集合的复用面：严格 profile 解析、auth 注入、请求日志 sink 与诊断回调 |

### 复用面

`src/reuse.ts` 导出另一个 provider 插件在本传输之上挂载固定路由集合所需的通用部件：`resolvePiAiProfiles` 做一次性的严格解析，`piAiAuthFrom` 提供 `Models` collection 所需的凭据存储与 ambient auth 组合，`createPiAiRequestLog` 提供持久 sink，`piAiDiagnosticHooks` 生成请求/响应日志记录。它们都不读取 settings 命名空间、不注册路由、也不提供发现；这些决定属于挂载方插件。mac 池插件是首个消费者。

### 注册与目录

插件会在可配置提供方目录中声明它能认证的每个已安装目录提供方，并加入当前 profile 声明的每条路由，因此配置界面可以在任何路由存在之前提供完整目录。目录列出了模型却没有聊天模型的提供方（例如只有分类器模型）不进入目录，也不注册登录流程，因为本适配器只分派聊天请求。每个条目都携带 `declared`——pi-ai 是否在该键下不提供任何内容——因为只有适配器能区分手工声明路由与收窄目录路由。目录条目以 `defaultBaseURL` 表示提供方的固定端点或全部模型共用的固定端点，以 `baseURLEnv` 表示端点配置变量，以 `nativeAuth` 表示认证变量和 OAuth 可用性。不同模型的端点和未展开的 URL 模板不会显示为单一固定默认值。路由注册具有原子性：与其他适配器冲突的候选集合会让此前路由继续服务。零路由的裸挂载即休眠姿态：settings 分节提供 profile 前不注册任何内容，分节清空时路由随之消失。

<a id="generated-provider-metadata"></a>
### 生成的提供方元数据

[`scripts/gen-provider-data.ts`](scripts/gen-provider-data.ts) 负责生成 [`src/provider-data.generated.ts`](src/provider-data.generated.ts)。它通过公开 resolver 和模拟的 `AuthContext` 回答，探测空配置、单个变量及变量后缀组合下的环境读取。resolver 失败时使用临时兼容入口的 `findEnvKeys`。当前所有认证变量都来自 resolver，无需认证变量补充。生成器会报告回退；缺少回退数据时生成失败。它不读取真实凭据，不启动登录流程，也不发送模型请求。探测覆盖已安装的 resolver，不能证明所有依赖具体变量值的分支。

端点数据来自公开的提供方及模型目录，以及 URL 中的大写变量占位符。Azure、Vertex 和 Bedrock 需补充认证上下文之外读取的变量。运行时读取目录不执行探测。依赖范围保持不变。用户安装的新版本新增提供方时，重新生成之前不显示其认证变量提示。已有提供方的环境变量名和端点发生变化时，也会继续使用生成快照，直到重新生成。环境提示只检查列出的凭据引用，不检查 AWS profile 或 Google 应用默认凭据等提供方管理的文件。

更新 pi-ai 或修改生成器后，先按更新的锁文件安装依赖，再从仓库根目录运行以下命令：

```sh
pnpm run gen-provider-data
pnpm run verify-provider-data
git add packages/llm/llm-pi-ai/src/provider-data.generated.ts
```

检查生成的 diff，并一同暂存依赖或生成器的改动。不要手工编辑生成文件。生成失败时，先解决错误再提交。

暂存 `pnpm-lock.yaml`、本包的 `package.json`、生成器或生成文件时，`pre-commit` 钩子会直接运行 `node_modules/.bin/tsx packages/llm/llm-pi-ai/scripts/gen-provider-data.ts --check --cached`，无需 Git 客户端的 PATH 中有 `pnpm`。它将暂存的生成文件与基于已安装依赖和当前生成器计算的预期数据比较，不改写或暂存文件。只更新工作区文件还不够；生成文件也必须暂存。检查报告元数据过期时，请重新运行上述命令，再尝试提交。即使本地钩子未触发，CI 仍会基于检出文件和按锁文件安装的依赖运行 `pnpm run verify-provider-data`。

### 回放与词汇

成功 assistant 响应会存储带版本的、无损 JSON 回放状态，与产生它们的提供方和模型放在一起——响应级事实加每个流式块一条逐块条目。请求时，`LlmRuntime` 仅当同一适配器实例拥有两条路由时才传递回放状态；适配器校验它并恢复原生响应 id、提供方签名与可选的 `providerThinkingLevel` effort 元数据，缺失的 effort 元数据仍保持缺失。回放会对照 assistant 来源校验请求模型身份，并用它保留同模型签名；提供方报告的响应模型仅作为诊断元数据。回放状态缺失或无法使用时会降级为提供方无关内容，并保留 assistant 来源中必需的提供方和模型。pi-ai 工具调用参数是解析后的对象，因此适配器解析输入并重新字符串化输出，以符合 harness 原始 JSON 约定；pi-ai 流内错误事件映射为终止 `finish` 分片。 协议转换仅作用于请求副本。从 A 切换到 B 再切回 A 时，存储的内容保持完整，包括空文本块、工具 id、原始块顺序和原生回放元数据；不受支持的签名仅从发给其他协议的请求中省略。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从服务约定逐步进入孪生适配器与共享类型。

- [dsh-llm 服务](../llm/README.zh.md)——本适配器注册其上的提供方无关服务。
- [llm-deepseek 适配器](../llm-deepseek/README.zh.md)——`deepseek-official` 路由的 DeepSeek 直连孪生。
- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md)——`StreamChunk` 协议与适配器约定。
- [llm-retry](../llm-retry/README.zh.md)——应用每个 profile `retryPolicy` 的重试执行器。
- [孪生 LLM 适配器](../../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.zh.md)——为什么 DeepSeek 路由交付两个结构不同的适配器。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-pi-ai)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 经 pi-ai 的提供方请求

#### 模型看到什么

所选目录模型会收到系统消息文本、对话历史、工具以及支持的采样字段。适配器按历史顺序保留后续系统消息；pi-ai 负责各协议的消息位置，并为不支持对话中系统消息的模型将它们拼接到开头。单次调用的 `GenerateOptions.system` 放在初始历史提示词之前。重复的系统消息仍会重复发送；空系统消息会被跳过，不会丢弃之前的文本。工具更新能力选择共享的历史声明投影；pi-ai 接收初始可用工具，以及按开发者消息分组的新增和受支持的移除更新。当包含工具更新的 Anthropic 请求中所有投影后的声明均为延迟加载时，初始可用工具为一个占位工具 `DeferredToolPlaceholder`，其描述要求模型永不调用它；若被调用，会得到普通的未知工具结果。Anthropic 在更新消息中以内联方式接收后续工具定义。回放会保留工具调用命名空间，以支持动态加载的 Responses 工具。每张保留图片前都会有文本，注明其完整附件 id 与实际请求尺寸。当前执行文件系统可以映射附件提供方的宿主对象时，该文本还会携带只读规范化对象路径，并警告规范化或请求投影可能缩放或重新编码上传内容。日志中的图片省略决策选中的每个出现位置都会在替换文本中保留自己的身份与当前已解析访问方式，其规范化附件不会读取或变换。当保留的出现位置按精确 base64 载荷仍超过路由的 `maxRequestImageBytes` 时，调用以 `IMAGE_OFFLOAD_REQUIRED` 失败，由 `dsh-compaction-image-offload` 用 `image/offload` 事件记录所选位置并重试步骤。提供方原生回放元数据只在适配器针对历史内容校验通过后恢复。 `imageRequestTarget(provider, model, image)` 向截图调用方提供与模型请求一致的图片尺寸和字节目标；不缩放图片的适配器保留归一化后的原图。

#### Token 影响

提供方分词决定精确输入。保留图片会添加稳定的附件与坐标描述符；卸载占位符会替代省略图片的视觉 token。回放元数据可能让原生 API 复用提供方侧状态。

#### KV Cache 影响

转换保持逻辑请求顺序，图片句柄与卸载占位符则会添加模型可见文本。即使附件身份与请求字节保持稳定，执行世界路径变化也会改写历史句柄，并可能从该图片起阻止复用。更换适配器实例、提供方、模型或其他上游 token 具有相同的后缀影响。一次省略决策会把较早图片换成占位文本，因此复用在该消息处结束；省略永不回退，此后前缀保持稳定。

### 提供方响应

#### 模型看到什么

pi-ai 事件变成 harness 的推理、文本、工具调用、用量与 finish 分片。适配器把解析后的工具参数以原始 JSON 字符串传给 harness。

#### Token 影响

生成内容只在 loop 记录后才影响后续输入。提供方未单独报告推理 token 时，pi-ai 会把推理 token 并入输出用量，并原样保留其精确 `totalTokens` 值。

#### KV Cache 影响

已记录的响应内容会追加到下一个请求，不会使其更早可复用前缀失效。未记录的传输元数据与用量计量不影响缓存标识。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明适配器在哪里停止、由未来工作接续。它们是当前包约束，不是通用 pi-ai 对比或任务积压。

- **`maxRequestImageBytes` 只计算 base64 图片载荷**，文本、工具、描述符与 JSON 结构在该上限之外，因此它必须留有余量地低于网关请求体上限。
- **登录只存在于发起它的进程中**——授权尝试不持久，因此登录中途刷新页面会放弃它，用户需要重新开始。退出登录是对已存储记录执行 `deleteRecord`，只在本地忘记它，不会告知签发方。
- **OpenAI 不提供 ChatGPT 登录**——pi-ai 的 Sign in with ChatGPT 用应用提供的稳定 UUID 向 OpenAI 标识安装实例，而 harness 没有用于第三方账号登录的安装 ID；`openai` 路由改用 API key 登录。
- **提供方原生发现经本插件的 ambient context 回答**——不点名凭据的路由交由目录提供方自身解析，它会询问环境值（`AZURE_OPENAI_API_KEY`、`AWS_PROFILE` 及各提供方自有集合）与本地凭据文件。两个问题都在这里得到回答：凭据 seam 先于进程环境被查询，文件存在性则针对宿主进程的文件系统以 `~` 展开后检查。它做不到的是*读取*凭据文件内容——自行解析 `~/.aws/credentials` 的提供方会直接读取，不经该 seam。
- **重置恢复继承配置**——重置下层 profile 提供的路由会恢复该路由。
- **请求日志是尽力而为的持久化**——记录排队后追加，不做 `fsync`，因此崩溃可能丢失进程已接受的日志行。两个进程写同一路径不会协调滚动；日志保护的是机密性（所有者私有、无内容的记录），而不是恰好一次投递。
- **完整替换 Config 可以移除继承的字典条目**——字段重置则恢复其继承值。
- **`headers` 可以携带 redactor 永远看不到的凭据**——profile 解析会拒绝 Fetch 无法表示的名称与值，但该字典仍是纯字符串；以 `apiKeyEnv` 引用存储凭据。
- **发现操作不更改已配置模型**——需显式将发现结果采纳到路由配置中。
- **Anthropic 模型发现最多读取 1,000 个模型**——请求使用 API 的最大页大小，但不会遍历 `has_more`；第一页之外的条目需要手工添加。
- **目录外模型需要明确的协议**——目录路由保留每个模型的协议，包括 `azure` 下的两种 Azure API。混合协议目录中不存在的模型需要显式设置路由级 `api`；该设置覆盖路由上的所有模型，且必须属于受支持的自定义协议。Azure 部署名称应通过 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 设置，模型 ID 保持为目录中的 ID。
- **模态声明不受校验**——声明 `image` 而其网关不支持的模型会在提示词准入后被提供方拒绝。持久图片仍留在历史中，同一误声明模型可能再次失败；切换到纯文本模型仍然可行，因为共享 LLM 运行时会针对该请求把图片引用投影为稳定文本。
- **未认证路由取决于其协议**——不点名凭据的路由解析为已配置但无密钥，但 pi-ai 的 OpenAI 兼容实现仍要求 API 密钥或 `Authorization` 标头，因此无密钥本地服务器需要由 `apiKeyEnv` 引用或 `headers` 中的 `Authorization` 条目提供的占位凭据。
- **不支持 `GenerateOptions.stop`**——pi-ai 的通用流式选项无法跨提供方保证停止序列行为。
- **对话更新支持只来自已安装的 pi-ai 目录**——只有当路由的目录模型声明了对话中 compat 标志时，该路由才会在历史中接收提示词与工具更新，且 profile 不能设置这些标志；手工声明的路由与未标记的模型会在每次请求开头接收拼接后的系统消息与完整的当前工具列表。
- **图片只在 user 与工具结果消息中被接受**——system、developer 或 assistant 历史中的图片在两条转换路径上都会以 `UNSUPPORTED_CONTENT` 失败。
- **pi-ai 不暴露提供方 HTTP 状态**——错误事件只携带文本。适配器在 `anthropic-messages`、`openai-completions` 与 `openai-responses` 上通过请求级 fetch 替换捕获失败响应的状态与 `Retry-After`；其他协议（Google 直接拒绝自定义 fetch）保留按消息文本分类。
- **重试策略由提供方自有，而非 SDK 重试**——pi-ai SDK 重试保持禁用，因此持久 agent（智能体）步骤与 `llm/retry` 事件拥有每个可见尝试，直接 `ctx.llm.stream()` 调用仍是单次尝试。
- **流式 JSON 工具调用参数避免逐 delta 重复解析**——安装的 pi-ai 带有 [`patches/@earendil-works__pi-ai@1.1.0.patch`](../../../patches/@earendil-works__pi-ai@1.1.0.patch)，它移除了每个流适配器中对整段累计参数 JSON 的逐 delta 重新解析（上游 [earendil-works/pi#9265](https://github.com/earendil-works/pi/issues/9265)）；未打补丁时，数 MB 的参数流会在事件循环上消耗 O(n²) CPU，并使进程内所有会话停滞。完成事件提供解析后的参数；Responses 可能在参数完成和输出项完成时分别解析。本适配器只读取 delta 字符串与最终参数。每次升级 pi-ai 时都要重新应用或撤销该补丁。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 提供的协议集合刻意比 pi-ai 的完整 API 集合更窄：Bedrock、Vertex、Azure 与 Codex 通过 profile 无法以密钥、端点与标头完整描述的流程认证；目录路由仍可经自有提供方到达它们，只有显式覆盖会被拒绝。Codex 可经授权流程的 OAuth grant 登录。
- `compat` 开关集合由漂移门禁钉在 pi-ai 的 compat 类型上；上游升级若新增字段、为更多协议赋予 compat 类型或扩大值联合，会在有人分类前让构建失败。

</details>
