# dsh-plugin-subscriptions [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[English](README.md) | 中文

把你的 **ChatGPT(Codex)**、**Claude**、**Grok(X Premium)**、**GitHub Copilot** 和 **Google Antigravity** 订阅当作 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 LLM provider 使用 —— 不需要 API key。Codex、Grok 和 Antigravity 通过 dsh web 界面 OAuth 登录(设置 → 订阅);Copilot 使用 GitHub OAuth 设备码流程;Claude 在存在 Claude Code 会话时直接导入凭据(macOS Keychain 或 `~/.claude/.credentials.json`)并把它当作每次使用时重新读取的只读副本,否则回退到同样的浏览器 OAuth 流程,因此不要求安装 Claude Code CLI。Token 保存在 `~/.dsh/plugins/subscriptions/auth.json`(权限 0600),过期自动刷新。

## 演示

设置 → **订阅**:每个 provider 的登录/退出,无需 API key。Claude 有 Claude Code 会话时导入凭据,否则和 Codex、Grok 一样走 OAuth(以下设置截图使用演示账号与目录数据):

![订阅设置页](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/subscriptions.png)

模型显示、默认推理档和上下文已合并到 **编辑模型列表**，统一保存或取消：

![Model settings](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-settings.png)

按 provider 配置图片生成、视频生成和 X 搜索，工具开关仅影响保存后新建的会话：

![Provider tools](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/provider-tools.png)

已登录的 provider 会带着实时模型目录进入会话模型选择器:

![模型选择器中的订阅模型](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-picker.png)

声明了推理等级的模型会在同一菜单里多出**推理等级**选择 —— Codex 系列模型、Grok 4.6 / 4.5、Copilot 的推理模型,以及 Claude 的模型(档位和默认值来自各 provider 自己的目录,不是硬编码列表:Claude 取自锁定的 Claude Code 目录,其余取自各自的实时目录;Copilot 的 `capabilities.supports.reasoning_effort` 数组会按协议映射为 chat completions 的 `reasoning_effort` 或 Responses 的 `reasoning.effort`)。所选模型的目录未声明的档位不会出现在选项里,已保存的此类覆盖值会回落到模型自身的默认档位。同时声明两个 Copilot 端点的模型(gpt-5.4、gpt-5-mini)默认走 chat completions,但请求同时携带函数工具和推理等级时会自动改走 `/responses` —— Copilot 在 chat 线路上拒绝这种组合:

![推理等级选择器](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-effort.png)

目录声明了 fast tier 的模型,会在输入框的模型菜单里(模型行与推理档行下方)多出一行**速度**：选中它会在同一张卡片内打开标准 / 快速面板，选项因此始终留在菜单边界之内。快速按各路由自己的优先信号发送:Codex 发 `service_tier: priority`,Cursor 发目录的 `fast` 参数,Claude 发 Claude Code 目录的 `speed: fast` 字段以及声明该档位的 beta。该选择按模型保存,与默认推理档存在一起,因此新会话与重启后仍然保留;「管理」里的模型列表也会在每个支持快速档的模型旁给出同样的标准/快速选择。`/fast` 斜杠命令提供同样的弹窗选择;当前模型不支持快速档时会提示原因。读取速度选择只查询当前服务商的目录，不会因为无关服务商的查询而等待。

![模型菜单里的速度行及其展开的标准/快速选项](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/speed-toggle.png)

输入框下方的统计行会多出一个**订阅用量**胶囊，显示当前会话所选模型对应服务商的剩余额度窗口（选 GPT 模型时显示 Codex，选 Grok 模型时显示 Grok，以此类推）。点击即可展开查看所有已登录服务商及其全部账号 —— 默认账号带星标，当前服务商排在最前：

![订阅用量胶囊展开后显示所有服务商与账号](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/usage-badge.png)

`image_generate` 工具生成的图片直接内联显示在对话里:

![image_generate 内联显示生成的图片](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/image-generate-inline.png)

`provider` 参数可选择生图后端——同一条提示词分别走 GPT(`gpt-image-2`,上)和 Grok(`grok-imagine-image-2.0`,下):

![image_generate 的 provider 参数对比 gpt 与 grok](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/image-generate-providers.png)

`video_generate` 工具生成的视频直接内联播放:

![video_generate 内联播放生成的视频](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/video-generate-inline.png)

请求从保存的规范化附件生成图片版本，不替换主附件。Claude 的长边上限为 8,000 像素；保留的用户图片与工具结果图片超过 20 次出现时，上限降为 2,000，重复附件分别计数。模型的上下文档位决定 100/600 张图片的数量上限。提交前按确切 JSON 请求体检查 32 MB 的 Messages 限制。图片数量或请求字节超限会请求有日志记录的历史图片卸载；无法容纳的文本和工具会明确报错。切换路由可以恢复保存的清晰度，已卸载图片继续省略，直到显式重新读取。图片引用元数据仍指向保存的附件，旁边的请求预览尺寸说明模型实际收到的版本。

## Provider 一览

| 路由     | 订阅             | 模型 |
|----------|------------------|------|
| `codex`  | ChatGPT Plus/Pro | 从 `chatgpt.com/backend-api/codex/models` 实时获取 |
| `claude` | Claude Pro/Max   | 订阅内所有可用模型(Opus、Sonnet、Haiku、Fable —— 静态目录,随插件更新) |
| `grok`   | X Premium (xAI)  | 从 `api.x.ai/v1/models` 实时获取(仅对话模型);推理等级来自 Grok CLI 目录(`cli-chat-proxy.grok.com/v1/models`) |
| `copilot` | GitHub Copilot  | 从 `api.githubcopilot.com/models` 实时获取(两种 wire 的对话模型,含按模型的视觉标记与推理等级);登录使用 OAuth 设备码流程(在 `github.com/login/device` 输入页面显示的验证码) |
| `antigravity` | Google Antigravity | 从 Antigravity `v1internal:fetchAvailableModels` 实时获取;请求使用 `generateContent` / `streamGenerateContent`,支持文本、图片、流式推理与工具调用转换 |

只有已登录的 provider 才会出现在会话模型选择器里;登录/退出后列表自动刷新。支持视觉的模型会声明 `['text', 'image']` 输入模态,图片内容会被翻译成各 provider 的 wire 格式。

已登录的卡片还会显示**订阅用量**——按限额窗口(5 小时会话窗、每周窗,以及计划包含的按模型每周窗)展示已用百分比、进度条和重置时间,并带刷新按钮(该按钮会向服务商重新读取该账号的用量;仍在冷却中的失败读取不会被绕过)。普通读取只返回账号已缓存的窗口。失败的读取会记录安全分类以及观测到的 HTTP status 与固定 OAuth error code；卡片因此可以显示 `刷新失败：unauthorized（HTTP 401 invalid_grant）`，而不会持久化服务商消息、响应正文或 token。显式刷新会向 `plugins/subscriptions/usage-refresh.log` 追加一行安全 JSON，记录开始/结果、耗时、缓存状态、分类、稳定 errorCode/cause、HTTP status 和固定 OAuth code，不包含 token、请求正文或服务商消息。日志默认关闭；创建 `plugins/subscriptions/usage-refresh.enabled` 即开启，删除该文件即停止，无需重启 Host。Codex 用量来自 `chatgpt.com/backend-api/wham/usage`(同时报告计划类型),Claude 用量来自 `api.anthropic.com/api/oauth/usage`,Grok 用量来自 Grok Build CLI 代理的 `cli-chat-proxy.grok.com/v1/billing`(即 CLI `/usage` 面板的数据源,报告共享每周额度和订阅档位)。Antigravity 会在上游字段存在时从 `loadCodeAssist` 与 `fetchAvailableModels` 显示订阅档位、积分及按模型限额。Copilot 没有用量接口,其卡片不显示用量区块。账号无法提供服务时，卡片会显示一条红字提示：数据来自本机发出的 Messages 响应上的 `anthropic-ratelimit-unified-*` 响应头，优先于用量百分比，并分别说明是账号本身超额或需要重新登录，还是账号池已改用其他账号提供服务。 Claude 账号的会话窗用量达到或超过一半、或每周窗达到或超过 89% 时，会被排除在池选号之外，直到窗口重置（两个阈值都可在 `pool.scheduling` 配置）。当只有这些阈值挡住了池时，报告的等待时间取最早的一次窗口重置。若已启用的池对某个模型没有任何条目，路由会**明确提示一次**，并改由单个账号提供服务，而不是静默降级。

在 **订阅 → ChatGPT → 管理** 中，**额度耗尽时自动使用重置卡** 默认关闭，点击 **保存更改** 后生效。该设置适用于 Codex LLM 请求，包括独立账号入口。当前账号的会话窗或周额度耗尽时，只有所有已登录 ChatGPT 账号中都没有更早到期的可用卡，才会使用当前账号最早到期的可用 `codex_rate_limits` 卡。退出账号池的账号也参加比较；其他账号仍有额度不影响用卡，并列最早到期也符合条件。仅调用图片或搜索工具不会触发该功能。

自动恢复直接获取最新用量和重置卡列表。缺少到期时间、列表不完整、查询失败或重置类型未知时，会保留卡并继续正常的故障切换。额度耗尽的粘性账号会在换号前检查恢复；Codex 请求被拒绝后，可以在输出前使用同一账号重试一次。同一 Host 内的手动和自动用卡串行执行。`plugins/subscriptions/auto-reset-claims/` 下的持久记录阻止同一张卡被自动重复提交，并在用卡结果不确定时阻止该账号再次自动用卡，直到最新用量确认已经恢复。测试使用注入的模拟操作，不消耗真实卡；手动用卡仍保留确认窗口。

随 provider 启用自动注册的工具:

- **`web_search`** 搜索提供商(Codex)—— 通过 DSH 原生的 `web_search` 工具和引用界面使用 Codex 托管的网页搜索,复用默认 Codex 账号和插件的代理配置。它只是注册到宿主 `web` 能力位上的候选之一,不会独占:未挂载其他搜索提供商时 DSH 自动选中它,与其他提供商共存时由宿主自己的 `web.searchProvider` 配置决定优先级。在 Codex 的 **Provider tools** 里关闭 **Web search** 只会撤回本提供商,宿主的 `web_search` 工具仍归其余已注册的提供商使用。
- **`x_search`**(Grok)—— xAI 托管的 X 搜索,返回 `{ answer, citations }`。
- **`image_generate`**(ChatGPT 或 Grok)—— 经 Codex 后端调用 `gpt-image-2`,或经 `api.x.ai/v1/images/generations` 调用 `grok-imagine-image-2.0`。`provider` 参数指定首选提供方(`gpt` 为默认值,可选 `grok`);首选方未登录时自动回退到另一方。图片保存到 `~/.dsh/plugins/subscriptions/images/` 并返回路径。Grok 路径上 `size`/`quality` 参数会映射为 Grok 的 `aspect_ratio`/`quality`。
- **`video_generate`**(Grok)—— 经 `api.x.ai/v1/videos` 调用 `grok-imagine-video-1.5`(异步提交 + 轮询);MP4 保存到 `~/.dsh/plugins/subscriptions/videos/` 并返回路径,视频直接在对话里内联播放。支持时长(1–15 秒)、宽高比、分辨率,以及通过 `image_url` 做图生视频。

`image_generate` 也支持编辑：模型在需要修改或参考已有图片时传入可选的 `referenceImages`（1–5 张完整 DSH 附件引用），未传时继续文生图。参考图可以来自用户上传、`read_image` 的结果或之前生成的图片；本地文件需先调用 `read_image`，不能把文件路径当作引用。图片旁的引用文本和工具结构化结果可直接复用。引用顺序对应提示词中的图片顺序，编辑结果保存为新文件并可继续编辑，也可切换 GPT/Grok 使用同一参考图。

Codex 编辑走 `/backend-api/codex/images/edits`，Grok 编辑走 `/v1/images/edits`；沿用现有 provider 偏好、未登录回退及会话工具开关。空数组、重复或无效引用、超过附件限制会报错，不会降级为文生图；编辑需要 DSH 附件服务。

图片生成与编辑共用同 provider 的账号调度：首次优先默认账号，成功后在当前会话优先复用；收到明确的额度或图片能力拒绝时尝试其余账号。401 最多刷新后重试一次；认证类拒绝或被判定为最终拒绝的响应（见下文「等待限流窗口」）会冷却该账号并结束本次尝试，不再换到同级账号。冷却状态仅用于图片请求，并读取服务商返回的重置时间；登录/退出会清理相关状态。网络中断、超时、5xx 和参数错误不会自动重发，避免重复出图。`pool.enabled: false` 或 `pool.autoAccounts: false` 关闭图片自动账号池，恢复默认账号直连。图片调度不使用对话模型目录、对话用量评分、`families` 或 `tiers`。

## 安装

### DSH 兼容性

本 fork 的源码候选为 `0.9.4-dsh021rc2.1`，固定适配 DSH `0.2.1-rc.2` 和 Cordis `4.0.5`。其 V4 工具消息转换、固定到 Claude Code 2.1.288 的 wire 与界面以这一确切版本组合为目标；不要安装到旧版 DSH profile。真实 Web profile 以 `link:` 指向暂存构建 `.build/fork-plugins/subscriptions`，不是本检出；Host 重启不会编译本目录。要生效必须先停 Host、运行 `build.cmd`、再重启 Host。[实现状态说明](docs/claude-implementation-status.md)拥有历史安装状态。上游公开的 `0.9.4` 包声明了更宽的 peer 范围，但不适用于这个私有包。

### 管理账号与 Pool 模型

在 **设置 → 订阅 → 对应 provider → 管理** 中编辑账号别名、自动 Pool 参与范围与独立账号模型入口。每个模型在服务商模型列表中只出现一行，该行携带自己的行设置，以及目录包含该模型的每个账号各自的 Pool 勾选框；`(1M)` 变体各自保留独立行，因为它们是不同的 wire id。默认维持自动 Pool；独立入口固定使用一个账号，失效时不会回退到其他账号。此配置仅约束 LLM 路由，不改变图片、视频和搜索工具的账号策略。详见[账号与模型管理](docs/account-management.md)。

### 模型列表与用量的缓存

发现的目录与用量读数都是 `~/.dsh/plugins/subscriptions/` 下按账号划分的缓存，普通读取只回答本地状态：既不查询服务商，也不会启动任何定时器。`models.json` 按服务商账号保存条目，`usage-cache.json` 保存规范化后的窗口读数及其观测时间与读取冷却；两者都不保存 token。未按账号分键的旧 `models.json` 会被丢弃而不会分配给某个账号，该账号在下次刷新时重新发现。规范 key 改名后，账号缓存的目录、用量读数与冷却会随之移动；仅在更早一次运行中被凭据存储记录下来的改名，会在首次账号读取之前按其自身的别名记录完成一次对账，因此不会有已退役的 key 继续服务会话。

服务商查询只发生在明确的事件上：登录只刷新该账号自己的目录，不读取用量；打开服务商的 **管理** 对话框只会对超过缓存时间范围的目录做一次按需重新校验；**编辑模型列表** 里的 **刷新** 会强制刷新该服务商每个账号的目录（并重新检查 Codex 客户端版本）；展开用量胶囊会对当前服务商的用量做一次按需读取；用量 **刷新** 按钮会强制读取一个账号的用量；消耗一张 ChatGPT 重置卡会重新读取该账号；一次模型请求会确保它即将使用的那一个账号的目录；一次池请求会确保它即将使用的那一个候选账号的目录与用量读数。

其余读取都只走本地、不触达服务商：回合结束、窗口获得焦点、连接代际重建、切换模型、账号名单变化、设置页首次渲染，以及浏览器缓存在遇到未见过的账号时补读一次。池排序只读取已缓存的条目，因此排序从不扫描同级账号。仅存的定时器都属于协议或本地：授权尝试进行期间的登录进度轮询（同时观察设备码授权）、凭据存储的锁续租、胶囊展开面板的倒计时，以及可选的 Claude Code Keychain 同步（`syncClaudeCodeCredentials`，每五分钟一次，且只覆盖本插件以 `legacy-writeback` 方式服务的账号）。

`cache.modelMaxAgeMs`（默认 24 小时）是目录的新鲜度时间范围，`cache.usageMaxAgeMs`（默认 5 分钟）是用量的新鲜度，`cache.retryDelayMs`（默认 60 秒）是服务商未给出重试时间时失败读取的冷却时长。失败的读取会把该冷却写入同一文件，重启后仍然生效，显式刷新也不会绕过仍在生效的冷却。

只有 Claude 路由会读取限流响应头，且只读取可识别的 `anthropic-ratelimit-unified-*` 子集：这类响应只会合并它点名的那些窗口，而每条路由都会合并自己用量接口返回的窗口。响应未点名的窗口保留自己的读数与观测时间，因此用量接口没有报告窗口的账号属于未知，而不是零。

一点限制。HTTP 403/404 可能表示模型已被下线，但不会触发自动重新读取目录：没有插件可以信任的机器可读代码能把它与权限或端点拒绝区分开，该行继续保持上次已知状态，直到手动 **刷新** 或按陈旧度触发的普通重读。

如果显式配置了非空的 `models.<provider>`，仍使用指定列表，不进行在线发现。选择模型时会复用该账号上次获取的能力信息；实际发送请求前仍会校验当前账号的模型资格，没有任何缓存的账号在事件刷新之前提供的是内置条目。

Codex 的目录可见性受请求中的 `client_version` 影响。默认自动读取 npm 官方 `@openai/codex` 包公开元数据中的稳定版本，不安装 CLI，也不向 npm 发送订阅登录凭据。查询成功后在内存缓存六小时；失败后五分钟再试，保留上次成功版本，首次失败则回退到已验证的 `0.153.4`。查询最多等待 5 秒，多账号共用查询，忽略预发布版和低于当前已知版本的结果。插件加载时还会把 Node 的 Happy Eyeballs 单地址建连尝试超时提高到至少 1.5 秒（不会降低宿主已设的更大值），因为默认 250ms 在一次 TCP 握手就超过该值的高延迟链路上会让所有连接失败。手动刷新模型列表也会重新检查版本。显式配置 `codexClientVersion: '0.153.4'` 时优先使用该值，并关闭自动查询；更改配置后需重启 DSH。模型仍以账号实际权限为准，详见[验证记录](docs/codex-catalog-refresh.md)。

### 安装命令

本机已有 `dsh` CLI 时,从 npm 安装(预构建产物,无需构建授权):

```sh
dsh plugin --profile web add dsh-plugin-subscriptions
```

也可以从 GitHub 安装源码:

```sh
dsh plugin --profile web add github:V1ki/dsh-plugin-subscriptions
```

首次安装 pnpm 会要求允许该包的构建脚本(git 安装拉取的是源码而非构建产物);把打印出的包名加进 profile 的 `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-plugin-subscriptions: true
```

然后重新执行 `add`。该授权会在安装时执行包的代码,只授给你信任的来源。

本地检出安装:

```sh
git clone https://github.com/V1ki/dsh-plugin-subscriptions.git
cd dsh-plugin-subscriptions && pnpm install && pnpm build
dsh plugin --profile web add ./dsh-plugin-subscriptions
```

在本 fork 的检出中，`build.cmd` 会在普通构建之后从源码构建该包并链接到选定的 `web` profile；不需要转交 tarball，也不查询私有 registry。该路径要求先停止 Host，从源码编译 node 半区与 client bundle，内联固定版本的 `@tormentalabs/claude-code-wire-compat` 包与 `undici`，并从 staged manifest 删除仅类型使用的 `@deepseek-ai/dsh-llm-request-record` peer。见 [fork 插件构建说明](../README.zh.md#repo-integrated-build-and-install)。

不装进 profile 的 headless 用法(先在 web 界面登录过 —— token 文件是共享的):

```sh
cp overlay.example.yml overlay.yml   # then edit the name: to this checkout's absolute lib/index.js path
dsh --profile headless --patch <checkout>/overlay.yml "your task"
```

## 更新

npm 安装的:

```sh
dsh plugin --profile web update --latest dsh-plugin-subscriptions
```

GitHub 安装的:重新执行一遍 `add github:V1ki/dsh-plugin-subscriptions` —— 会重新拉取源码并构建。link 的本地检出只需在检出目录里 `git pull && pnpm build`。

无论哪种方式,更新后都要重启 `dsh web` 才会加载新版本。

## 使用

1. `dsh web`,打开打印的 URL。
2. **设置 → 订阅**:点对应 provider 的「连接」。若先运行过 `claude` 并登录,Claude 会即时导入凭据;没有凭据时,Claude 也和其他 provider 一样在浏览器里授权。Codex、Grok 和 Antigravity 在打开的标签页里授权;Copilot 会显示 GitHub 设备码,需在 `github.com/login/device` 输入;无浏览器环境下可展开手动兜底,粘贴回调 URL 或授权码。
3. 在任意会话里打开模型选择器(`/model`),选择 **ChatGPT (Codex)** / **Claude (Subscription)** / **Grok (Subscription)** / **GitHub Copilot** / **Google Antigravity** 下的模型。

未登录时:该 provider 不出现在选择器里;直接请求会报 `MISSING_CREDENTIAL` 并提示去设置页登录,不影响其他功能。

浏览器 OAuth 回调无论报告成功还是授权错误，都必须携带当前登录尝试的 `state`。缺失或不匹配的 `state` 会收到 HTTP 400，登录仍等待属于本次尝试的回调；只有匹配的回调才能完成或拒绝该次登录。

### 多账号

每个 provider 可以登录多个账号:连上第一个之后,卡片会出现「添加账号」按钮(Claude 拆分为「浏览器授权」和「导入 Claude Code」两种)。账号按身份(邮箱/用户名)归档——重复登录同一账号是覆盖更新,不同账号才是新增。浏览器授权以浏览器当前登录的账号为准,要添加不同账号请先在浏览器切换账号,或用无痕窗口走手动授权码。★ 默认账号服务直连路由;池路由会使用所有账号。从 Claude Code 导入的 Claude 账号是只读的:插件每次使用都重新读取该存储,既不刷新也不写回,账号行可在风险确认后把它改为旧的写回模式;OAuth 添加的 Claude 账号独立刷新,多个账号不会互相覆盖 Keychain。

### 编辑模型列表、上下文与工具

在 **设置 → 订阅 → 对应 provider → 编辑模型列表** 中搜索并勾选要显示的模型，再点击 **保存更改**。默认自动显示全部模型；手动勾选、全选或清空后会保存明确的显示列表，以后发现的新模型不会自动加入。重新勾选「自动显示全部模型」即可恢复。隐藏仅影响模型选择器和默认推理档列表，已有会话仍可使用隐藏模型；编辑器始终保留完整目录，可随时恢复显示。刷新目录不会覆盖选择。对话框只有一组 **保存更改 / 取消**：保存会把模型列表与上方的账号设置一起提交，取消会同时丢弃两者并关闭对话框。

Codex 模型还可填写上下文 token 数，留空跟随服务商。插件读取每个账号的 `context_window` 与 `max_context_window`，实际使用 `min(配置值, 账号最大值)`；未返回最大值时，保守地以上下文默认值为上限。账号池按实际成员分别解析并取最小窗口。这只调整 DSH 的本地上下文预算与压缩时机，不向 API 发送扩大容量的参数。更长的上下文可能增加响应延迟。

Claude 模型没有上下文预算字段：上下文大小按 Claude Code 客户端自己的方式选择 —— 在模型 ID 上带请求期 `[1m]` 标记，编辑器把它列成模型旁边单独的 **1M** 行。选择器按行报告模型自身的容量：文档点名的模型取自 Claude API 文档（当前为 1M 上下文 / 128K 输出，`claude-haiku-4-5` 是唯一的 200K / 64K 条目），其余模型取自锁定的 Claude Code 目录。只有该标记会组合 `context-1m-2025-08-07` beta、且目录为该模型声明了该 beta 时，才出现 1M 行；目录未声明该 beta 的带标记 ID 会回落到目录的 200K 窗口，两个来源都未点名的模型回退为保守的 200K 上下文与 32K 输出上限。

同一区块可开关 Codex 的图片生成，以及 Grok 的图片生成、视频生成和 X 搜索。工具策略只影响保存后新建的会话；已有会话及其重启后的恢复保留创建时的策略。图片生成是共享工具，只有 Codex 与 Grok 均关闭或未配置时才完全隐藏；调用时也不会回退到该会话已禁用的 provider。Claude 和 Copilot 当前没有本插件提供的独立工具开关。

设置和工具策略历史独立存于 `~/.dsh/plugins/subscriptions/provider-settings.json`（权限 0600），不受上述模型列表与用量缓存影响。原有非空 `models.<provider>` 配置仍决定基础目录；界面显示选择在该目录上生效。

### 编辑模型的默认推理档

默认推理档已合并进 **编辑模型列表**：每个支持推理档的模型在同一处配置显示、推理档和上下文，统一点击对话框底部的 **保存更改** 后生效。隐藏模型也可以设置推理档；没有推理档的模型不显示下拉框。选择「跟随服务商」清除覆盖，取消会恢复尚未保存的编辑。选项取自模型实时能力目录，账号池使用成员共同支持的档位；自定义池别名不提供无效的推理档覆盖。

原有推理档配置继续从 `~/.dsh/plugins/subscriptions/model-defaults.json`（权限 0600）读取并保存。若保存中途失败，界面会保留未完成的草稿，明确提示已经保存的推理档，并可重试完成。

## 配置

```yaml
- id: llm-subscriptions
  name: dsh-plugin-subscriptions
  config:
    providers: [codex, claude]        # subset; default all five
    streamIdleTimeoutMs: 300000
    rateLimit:
      wait: true                       # wait out a closed rate-limit window (default)
      maxWaitMs: 21600000              # ceiling on one wait; 6 h, covers a 5-hour session window
    cache:
      modelMaxAgeMs: 86400000          # catalogue freshness horizon (default 24 h)
      usageMaxAgeMs: 300000            # usage freshness horizon (default 5 min)
      retryDelayMs: 60000              # failed-read cooldown when the provider names none
    models:                            # override the discovered/built-in catalogs
      codex:
        - { id: gpt-5.6-sol, name: GPT-5.6 Sol, contextWindow: 272000, inputModalities: [text, image] }
      copilot:                         # manual entries disable Copilot catalog discovery
        - { id: gpt-5.6-sol, wire: responses }   # copilot only: force the upstream protocol
```

`wire`（仅 copilot 条目）把模型固定到 `chat-completions` 或 `responses`。不加该字段手工条目照常工作——它存在的原因是:实时目录不认识的手工模型否则会默认走 `/chat/completions`，而 responses-only 系列（gpt-5.5/5.6 等）会拒绝该端点。固定为 `chat-completions` 也会退出上文所述 tools+effort 的自动改道。

Antigravity 未内置 OAuth 客户端身份：需先设置 `antigravity.clientId` 及其可选的 `antigravity.clientSecret`，或 `ANTIGRAVITY_CLIENT_ID` 及其可选的 `ANTIGRAVITY_CLIENT_SECRET`，然后点击「登录」才能进入 Google 授权。插件配置优先于环境变量。ID 与 secret 必须来自同一来源：自定义 ID 不会继承其他来源的 secret，单独提供 secret 会报错。可选的 `antigravity.baseURL`、`antigravity.userAgent` 和 `antigravity.onboard` 分别控制 API 地址、客户端标识和账号初始化。此路由使用 Antigravity OAuth 与 v1internal 项目封装，独立于 Gemini CLI。

Antigravity 为 Gemini 使用 `parametersJsonSchema`，为 Claude/GPT-OSS 使用兼容的 `parameters` 子集；本地 schema 引用会先展开，不修改 DSH 工具注册表。无法解析、循环引用及无法表达的自定义工具联合类型会在发送前报错。已识别的模型系列会在模型设置中提供推理等级，并转换为对应的推理预算；文本、推理和工具调用签名仅回放给相同 provider/model。兼容映射参考 [pi-antigravity](https://github.com/Rahularya01/pi-antigravity/tree/697858cafcf1faddf2ae898d2f053b2ff26c05e6)，离线测试不代表账号资格或在线 API 验收通过。

未配置 `antigravity.baseURL` 时，生成请求及目录/项目查询先访问 daily；发生传输错误或 HTTP 404/502/503/504 时，在返回任何流内容前尝试 production。显式配置的地址保持固定。HTTP 400/401/403/429 和已取消请求不触发端点回退；账号初始化不会跨端点重复执行。

## 模型池

同一订阅下登录了**两个及以上账号**时,选择器显示该 provider **所有账号目录的并集**(按模型 id 去重)。照常在 Claude 组选 `claude-sonnet-5`、在 ChatGPT 组选 `gpt-5.4`——不会多出一个池分组,也不会换 model id。

- **共有模型**：至少两个账号的目录都列出的模型,在这些账号之间 failover(粘性、可按配额调度)。每个账号各自做一次目录发现,Plus 不会被拿去打 Pro 才有的模型。
- **单账号模型**：只有一个账号目录里有的模型,请求就打到那个账号。即使它不是默认账号,选择器里也会出现。
- **显式账号列表(`families`)**：覆盖某个目录模型的自动成员(仅同一 provider;跨 provider 的成员会被忽略)。可钉 `account`,省略则用默认账号。
  `account` 填 `status` 接口返回的稳定账号 key——Claude 是邮箱,Grok / Copilot / Antigravity 是登录名。两者都没有的账号使用随机 `account-…` id,重启后保持不变。Codex 的 key 同时包含 workspace 和用户(`["<workspace-id>","user","<user-id>"]`),因此 Codex 也可以直接填登录邮箱,或在该 workspace 只登录了一个用户时填 workspace ID;有歧义的引用不会解析到任何账号,以免打到别人的账号。
- **档位额外项(`tiers`,可选)**：额外的选择器条目,failover 可以跨模型;出现在首个成员所在的 provider 分组。不会自动创建。

一个会话的各个 turn 绑定在同一个账号上。`priority` 保留配置的健康成员顺序;默认 `quota_aware` 在各可用性分组内归一化原有的“剩余额度 / 距重置时间”评分，再为 Claude、ChatGPT 的临近重置，以及 ChatGPT 的少量余额收尾增加有限权重。ChatGPT 的周窗口重置不足 24 小时，且有可用重置卡将在三天内到期时，只获得有限加分，不拥有绝对优先级。自动用卡须单独开启上文所述的设置。

Claude 和 ChatGPT 在已用量低于 100% 时仍留在主要候选组，其他提供方保留 95% 阈值。任一适用窗口耗尽，都会把成员放入最后的候补组。模型专属窗口只影响匹配的模型。缓存中的重置时刻经过后，过期窗口不再贡献紧迫度或“额度已满”判定，并在下次需求时重新读取；接口持续返回同一个过期时间时，不会形成反复查询循环。

进入 ChatGPT 收尾范围后，偏向余量充足账号的基础分按剩余比例减弱，收尾加分逐渐增强。因此，所有账号都只剩几个百分点时，也会更倾向收尾余量较少的账号。临近重置加分随截止时间接近而增加，但有明确上限，每类窗口均有可配置的观察范围。

合并后的评分除以 `1 + loadPenalty * 活跃请求数`。请求在等待首个流块前预约账号负载，在完成、失败、取消或迭代器清理后释放。因此，同一提供方和账号下不同模型的并发池请求可以分散负载。

**会话-账号亲和。** 只要绑定的账号可用,会话在各 turn 之间保持同一账号,即使另一个账号评分更高。只有在 **turn 开始时**(会话日志里的 `turn/start`)才可能重新匹配(rematch),而且仅当绑定账号的窗口耗尽或账号被拒。每个 turn 最多重匹配一次,打开的 turn 内任何请求都不会发到第二个账号:普通 429、5xx 或传输失败会让本轮在该账号上失败,再由重试策略重试同一账号。新一轮若没有健康账号,会返回带类型的 `no_available_account`(`NO_AVAILABLE_ACCOUNT`),且不联系任何账号。首个流块输出后不会切换账号。

### 账号并发

每个订阅账号同时最多服务两个会话(`pool.concurrency.maxSessionsPerAccount`)。每个会话同一时间只发一个请求,所以同一会话的第二个 turn 会排在第一个请求之后。同一账号的第三个会话按 FIFO 等待空位;等待超过 `queueTimeoutMs` 会以带类型的 `rate_limited` 拒绝,而不是无限排队。turn 结束会立即释放槽位;未观察到 turn 结束的会话在 `sessionIdleMs` 后由空闲回退释放。

每个账号还有一份由所有会话共享的请求限制器:令牌桶(`requestsPerMinute` 按该速率补充,`burst` 个令牌可一次性使用)加上最小间隔(`minGapMs`)。默认即生效:每分钟 20 次、突发 2 个令牌、请求间至少 1.5 秒;按套餐允许的速率调参或置零关闭。

普通 429 只让收到它的那个会话退避(`backoff`,或 provider 披露的等待时长);该账号的其他会话在共享限制器下继续发送。一个会话连续退避达到 `backoff.maxRetries` 次后,本轮停止重试(返回带硬停止的 `rate_limited`);下一 turn 重新开始预算。窗口/额度 429 会把账号冷却到披露的重置时刻,该账号的所有会话都看到同一冷却。

### 错误分类

成员上报的每个失败都只对应一种调度效果。任何效果都不会在 turn 内换号,429 也绝不会重放到同池的其他账号。

| 类别 | provider 信号 | 效果 |
|---|---|---|
| 瞬态 | 408、409、普通 429、500/502/503/504/529、网络、TLS、超时、交付前的 malformed | `session-backoff`:同一账号在披露或本地延迟后重试,上限为 `backoff.maxRetries` |
| 账号冷却 | 429 窗口/额度(claim/reset);账号级 403(声明最终拒绝、计费/额度、账号被禁用) | 账号冷却至 reset,所有会话共享;仅下一 turn 重匹配,最多一次 |
| 刷新 | 401、指明凭证/账号被吊销的 403 | 在同一账号上刷新并重试;超过 `maxRefreshAttempts`(2)次后冷却账号 |
| 模型级 | 指明某个模型的 403、404 model not found、指明模型的带内拒绝 | 只让该模型失败;账号既不被冷却也不换号 |
| 终止 | 400 `invalid_request`(上下文溢出除外)、413、版本/策略/内容拒绝、用户取消、交付后的 malformed/不完整流、非 403/429 上的 `x-should-retry: false` | 以 provider 错误结束本轮,不记录账号状态 |
| 带内 `error` 事件 | 按 `error.type` 映射(`authentication_error`、`permission_error`、`policy_blocked`、`not_found_error`、`invalid_request_error`、`rate_limit_error`、`overloaded_error`、`api_error`、`timeout_error`) | 按其类型对应的类别处理;绝不换号 |

硬停止字段优先于错误码:路由已声明该逻辑请求不可重放时,即使错误码看似瞬态也按终止处理。带 `x-should-retry: true` 的普通 429 仍属瞬态,同一账号可以重试。

凭据刷新失败的错误消息只携带安全事实：HTTP status、provider 返回的 OAuth `error` code（存在时），以及披露的 `retry-after` 秒数。provider 响应正文、token 值和自由文本细节不会进入消息。明确的 `403`/`invalid_grant` 表示账号或授权被拒绝；仅有泛化的 `AUTH` 而没有这些字段时，不能据此认定封号。

负载计数覆盖当前 Host 的自动账号池与配置的 tiers。独立账号入口、其他 Harness 进程和外部客户端不在该计数范围内。没有用量数据的账号仍排在已测量账号后面作为备选；整组都没有可用紧迫度时，相同基础分仍可按负载分散。

可选的 `pool.scheduling` 字段在插件加载时解析和校验。权重设为零可关闭对应的额外偏好或负载惩罚，`codexDrainBelowPercent` 设为零可关闭收尾。时间范围必须是正整数毫秒，百分比必须在 0 到 100 之间，权重必须有限且非负。

| 字段 | 默认值 | 用途 |
|---|---|---|
| `sessionResetHorizonMs` | `3600000` | 短期窗口的最后一小时 |
| `weeklyResetHorizonMs` | `86400000` | 周窗口的最后一天 |
| `otherResetHorizonMs` | `86400000` | 其他窗口的最后一天 |
| `resetWeight` | `2` | 临近重置的最大额外权重 |
| `codexDrainBelowPercent` | `10` | ChatGPT 余额收尾范围 |
| `codexDrainWeight` | `2` | 收尾的最大额外权重 |
| `freshCreditWeight` | `0.5` | 周窗口刚重置且卡将到期的最大加分 |
| `loadPenalty` | `1` | 账号每个活跃池请求的负载惩罚 |

可选的 `pool.concurrency` 字段同样在插件加载时校验。

| 字段 | 默认值 | 用途 |
|---|---|---|
| `maxSessionsPerAccount` | `2` | 一个账号同时服务的会话数 |
| `queueTimeoutMs` | `120000` | 等待会话槽位或请求令牌的最长时间 |
| `sessionIdleMs` | `600000` | 未观察到 turn 结束时的槽位回退释放 |
| `requestsPerMinute` | `20` | 账号共享速率上限;零表示关闭 |
| `burst` | `2` | 突发可一次使用的令牌数 |
| `minGapMs` | `1500` | 账号两次请求之间的最小间隔 |
| `maxRefreshAttempts` | `2` | 冷却账号前允许的凭证刷新次数 |
| `backoff.initialDelayMs` | `1000` | 会话首次本地退避 |
| `backoff.maxDelayMs` | `60000` | 会话退避上限 |
| `backoff.jitterRatio` | `0.2` | 每次退避的对称抖动比例 |
| `backoff.maxRetries` | `10` | 会话停止重试前可消耗的退避次数 |

```yaml
- id: llm-subscriptions
  name: dsh-plugin-subscriptions
  config:
    pool:
      enabled: true                   # default; needs ≥2 accounts of one provider
      strategy: quota_aware           # or priority
      autoAccounts: true              # pool each catalog model across that provider's accounts
      concurrency:                    # account concurrency and 429 policy
        maxSessionsPerAccount: 2
        requestsPerMinute: 20         # shared account cap; 0 disables
        burst: 2
        minGapMs: 1500                # minimum spacing between account requests
      families:                       # explicit account list for one catalog model (same provider)
        claude-sonnet-5:
          - { provider: claude, model: claude-sonnet-5 }                   # default account
          - { provider: claude, account: bob@example.com, model: claude-sonnet-5 }
      tiers:                          # optional extra picker rows
        smart:
          - { provider: claude, model: claude-sonnet-5 }
          - { provider: codex, model: gpt-5.6-sol }
          - { provider: grok, model: grok-4.6 }
```

### 等待限流窗口

订阅套餐天然是按限流窗口计费的 —— 5 小时会话窗口、周窗口，部分套餐还有按模型的周窗口 —— 所以普通的 429 并不是终点：窗口会在 provider 自己告知的时刻重开。每条路由从自己的 429 里读出这个时刻，把它变成该会话的本地退避(`pool.concurrency.backoff`)；窗口/额度类拒绝则升级为账号冷却，而不是固定猜测的 5 分钟。

provider 声明为最终拒绝的响应既不等待也不重试，模型池也不会换一个账号去回答它。`x-should-retry: false`、unified 状态（`-status` 或 `-overage-status`）为 `rejected`、组织/席位/成员被禁用的原因、计费或额度类措辞，以及完全未披露重开时刻的 429，都会归类为 `ENFORCEMENT`：在 429 上账号按已披露的重开时刻冷却(未披露时为 5 分钟)且本轮立即失败;其他状态上则该拒绝终止本轮。两种情况都不会联系模型池中的其他账号 —— 换个身份重放这种拒绝，正是它要阻止的流量。

只有能指明「是哪个窗口拒绝了这次请求」的信号才会被读取：Anthropic 的 `anthropic-ratelimit-unified-reset`、Codex 在 `usage_limit_reached` 上给出的秒数、xAI 在错误体里给出的延迟，或通用的 `retry-after`。各分桶的滚动快照（`anthropic-ratelimit-{requests,tokens,…}-reset`、`x-codex-*-reset-after-seconds`、`x-ratelimit-reset-*`）每个响应上都有，说不出是哪个桶拒绝的 —— 其中最早的那个往往正是还有余量的桶 —— 所以只带这些的 429 同样属于拒绝：告警回调仍会打印出相关 header 与响应体开头，而本轮就此结束，不再照着猜测挂起。

读取只发生在 429 上。其他失败仍走各自的短本地退避:同样这些 header 也会出现在瞬时 500 上,在那里照办等于为一次一秒就恢复的过载把本轮挂满整个窗口。

有模型池时，真正做等待的是会话级退避：收到 429 的会话本地退避，本轮带着该账号自己的 `retry-after` 提示失败，`dsh-llm-retry` 再重试**同一账号**。请求不会改发到同池的其他账号；该账号的其他会话继续在共享请求限制器下发送。窗口/额度拒绝会把账号冷却到重置时刻，账号的所有会话都看到同一冷却；401 或指明凭证被吊销的 403 先在同一账号上刷新,超过 `maxRefreshAttempts` 次失败后才冷却账号。下一 turn 再重匹配到健康账号。若已无健康账号，下一 turn 返回带类型的 `no_available_account`，并附带已知的最早恢复时刻作为提示。单账号（没配池，或该 provider 只登了一个号）时，同样的披露时刻会被直接上报。

真正执行这段等待的是 [`@deepseek-ai/dsh-llm-retry`](https://www.npmjs.com/package/@deepseek-ai/dsh-llm-retry)，六条路由的重试策略都是为它写的：把它加进编排，否则不会有任何等待，关闭的窗口仍旧直接让本轮失败。Copilot 当前使用通用的 `retry-after` 信号；GitHub 未识别的限流 header 会通过插件告警回调暴露出来，后续再添加 provider 专用解析器。

```yaml
- name: '@deepseek-ai/dsh-llm-retry'
```

```yaml
- name: dsh-plugin-subscriptions
  config:
    rateLimit:
      wait: true            # default; false keeps the previous seconds-scale behaviour
      maxWaitMs: 21600000   # 6 h — covers a 5-hour session window with slack
```

重开时刻超过 `maxWaitMs`(比如几天后才重置的周窗口,或者整个池的冷却时间超过这个上限)会立即失败并带上重开时刻,而不是把会话挂上好几天。`wait: false` 则只保留本地退避。

六条路由共用 Claude Code 自己的重试形状:首次尝试之后重试 10 次,从 1 秒开始退避,带 20% 抖动,上限 60 秒。这些都是面向消费者的订阅端点,过载时按突发丢流量,而 dsh-llm 默认值(5 次重试,500 毫秒到 10 秒)约 15 秒就放弃,对这种场景偏短。这份预算覆盖的是普通限流(带重开时刻的 429)与瞬时类错误;未披露重开时刻的 429 属于拒绝,会立即让本轮失败,而不是盲目重试冲进同一道封锁。

一个需要知道的取舍:延迟上限与这份本地退避共用,调高 `maxWaitMs` 同时也抬高了无关瞬时失败(`TRANSPORT`、`SERVER`、`TIMEOUT`)在有限重试预算耗尽前的退避时长 —— 第 10 次重试最长会从 60 秒上限变成 512 秒。

账号管理路由会为账号池与独立账号保留底层提供方的重试策略。网络传输失败不会取消该账号再次尝试的资格；所有已尝试账号都失败后，仍可请求的账号会把原始错误交给重试执行器，不附加其他账号的额度或认证冷却时间。只有全部账号都处于冷却时，账号池才报告下一次恢复时间。`rateLimit.wait: false` 下，瞬时失败仍会最多重试十次，按 1 秒到 60 秒的指数退避并加入 20% 抖动；该设置阻止长时间等待额度恢复，不会关闭网络重试。Agent 循环重试失败的模型步骤，包括输出中断的步骤，不重复执行已完成的工具；用户取消会停止等待。携带 `retryDisposition: 'forbid'` 的失败是例外：Agent 循环与重试执行器都不会重发，因为循环跳过自身的请求错误恢复派发，执行器也不安排等待（见下文源码段）。

## Claude 流生命周期

Claude Messages 共用一个 Bun 传输子进程。活跃响应不会阻塞后续请求或取消帧。每个请求独立拥有中止控制器，取消一个响应不会取消其他流。终止事件、错误或消费者 return 导致读取在 HTTP EOF 前结束时，SSE reader 会取消源；正常 EOF 后只释放锁，不重复取消。子进程输入关闭或失败时，会中止其请求并等待所属任务结束。

`claudeTransportMaxQueuedBytes` 设置每条响应的未读字节上限（正安全整数，默认 33554432）。已消费字节不计入，因此及时读取的响应可以超过这个总大小。超过未读上限时，只取消该请求的上游读取，并以 `backpressure` 使其响应体失败；其他流保持可用。此限制需在共享子进程启动前配置；活跃子进程或尚未完成的启动会拒绝不同的限制值。子进程死亡后，后续请求可启动替代实例。传输层不重放失败请求，也不回退到 Node。

这些保证针对请求生命周期，不代表 TLS 或线上报文等价。请求字段和代理拒绝行为保持不变。运行中的 Host 使用已安装的插件制品；源码改动需要重新构建，并在 Host 停止后显式部署该制品。

## Claude 响应上限与用量

流式响应以 `model_context_window_exceeded` 结束时，使用 DSH 已有的 `max-tokens` 结果：保留部分文本，省略截断回合中的工具调用。它不被视为正常完成，也不转成触发压缩／重试的请求输入过长错误。原有 prompt-too-long 错误映射保持不变。

新产生的生成上限响应会按保留的文本／思考块重新定位服务器工具块，省略本地工具调用不会改变这些回放块的相对位置。旧记录仍按已存位置回放，不猜测修正。`pause_turn`、`compaction`、无法识别的非空停止原因，以及普通完成但只有服务器工具块的响应均以 `UNSUPPORTED_RESPONSE` 失败。生成上限和拒绝仍保留各自的结束类型。默认订阅策略不重试或切换账号处理该代码，也不自动续接服务器管理的回合。真正的空响应仍使用 `EMPTY_RESPONSE`。

用量按字段合并 `message_start` 和 `message_delta`。后续数字（包括零）替换先前计数，缺席或 null 字段保留旧值。输入与缓存计数保持互斥，累计输出不重复相加，最终只在终止结果前发出一次用量。

Claude 身份补全会保留 profile 查询期间刷新的凭据。保存时比较先前会话，再读取存储中的获胜版本；并发轮换或重新登录不会被旧令牌对覆盖。无法确认身份的账号变化会失败，而不是混合账号身份；Messages 和文件上传使用选定的刷新后凭据。

## Claude 认证与对齐边界

[Claude 请求可靠性](docs/claude-reliability-design.md)与[账号和策略维护](docs/claude-account-maintenance-design.md)记录明确拒绝、账号状态、流完整性和活会话维护的设计。下文描述已实现行为及其限制。运行中 Host 的行为由已安装包的版本决定，不由源码修改决定。

请求会先固定账号，再选择凭据、身份和请求链状态。Messages、profile 和 usage 在刷新并重发前释放被拒绝的 401 响应体。刷新成功后返回的是条件保存完成时存储中的会话，而不是未提交的 grant；会话已不存在时抛出 `MISSING_CREDENTIAL`，该次刷新不会复活它。刷新永久失败时绝不删除已存凭据：账号保留在存储中并报告 `reauth_required`；若期间已有新登录替换它，则改为返回该新登录。已轮换但无法写入存储的凭据报告为 `CREDENTIAL_NOT_PERSISTED`，且绝不会退回到刷新前的会话。存储旁的待处理刷新日志（pending-refresh journal）会在花费 grant 前记录意图、在写入存储前记录新会话；崩溃后只在存储仍持有本次轮换起点的凭据时才应用，恢复过程绝不删除凭据。

本地导入要求 OAuth 会话包含 `accessToken`、`refreshToken` 和以 epoch 毫秒表示的数值 `expiresAt`。在 Windows/Linux 上，登录操作读取 `CLAUDE_CONFIG_DIR` 或 `~/.claude` 下的 `.credentials.json`，不会在启动时自动导入。畸形 JSON 根被视为凭据不可用，以便继续 OAuth 回落。单独一段 access token、setup-token 或 API key 不属于此会话格式。`syncClaudeCodeCredentials` 仍为显式选择开启；导入已有会话本身不会启用向 Claude Code 凭据库写回。源凭据变化后，只有存在匹配的账号信息或相同 refresh-token 关系，且没有已知身份冲突时才采纳。否则以 `CLAUDE_CREDENTIAL_SOURCE_CHANGED` 提示重新导入或浏览器登录，默认策略不将账号冷却或重试。同步路径上的提前刷新仍可保留自身尚有效的令牌，而不采纳无法确认的来源。同步锁协调的是合作的 DSH 进程，未证明与 Claude Code 共用同一把锁。

DSH 用账号 UUID 和在本地哈希的稳定 OS 标识派生 64 位十六进制设备 ID：Windows 使用 `MachineGuid`，Linux 使用 machine-id，macOS 使用 `IOPlatformUUID`。同账号、同 OS 安装无需 DSH 缓存即可重建相同 ID；换账号或换 OS 标识则派生不同 ID。原始机器标识不存入账号数据，也不发送到请求中。OS 标识缺失或不可用时以 `CLAUDE_DEVICE_IDENTITY_UNAVAILABLE` 失败，不回落到仅账号或随机 ID。

Messages 发出前，会按条件将旧的仅账号 ID 或从另一台机器复制的 ID 替换为本机绑定；令牌、过期时间、scope 和账号 UUID 不变。因此升级后的第一次请求可能使用不同设备 ID，但不需要仅为此次迁移而重新导入或登录。重装系统可能改变 OS 标识，克隆机器可能共享它，这不是不可变的硬件指纹。CC 按配置根保存随机 ID 仍是不同策略；客户端对比关注请求值与条件，不要求克隆 CC 的本地存储或 Keychain 实现。

### 凭据所有权

已存 Claude 凭据的 `credentialOwnershipMode` 在记录自己声明该字段时取自该字段，否则按兼容推断解析：`keychainBound === true` 读作 `legacy-writeback`，其余读作 `independent-oauth`。三种模式分别是 `independent-oauth`（真实的、本插件自有的 OAuth 授权，刷新 grant 归本插件）、`read-only-import`（凭据留在 Claude Code 存储中，本插件只读取）、`legacy-writeback`（凭据留在 Claude Code 存储中，沿用原有的同步路径）。取值是封闭集合：本构建不实现的值使读取失败并拒绝整次存储写入，而不是静默回退到推断模式。未声明该字段的记录不做迁移，且没有后台批量改写、删除或重新授权已有账号。

`read-only-import` 账号每次使用都由 Claude Code 存储服务，绝不使用预取保留或缓存的副本：该次使用重新读取来源并采用当前 winner，要求来源为这个账号声明未过期的凭据（记录邮箱，或记录 refresh token 自身的关系），并要求来源自己声明的 scope 含 `user:inference`，否则停止。来源缺失、过期或缺 scope 时以携带 `retryDisposition: 'forbid'` 的 `INVALID_CREDENTIAL` 失败，账号池将其视为认证失败，因此账号报告 `reauth_required`；来源无法确认为本账号时以 `CLAUDE_CREDENTIAL_SOURCE_CHANGED` 失败，既不冷却账号也不重试；刷新窗口打开期间来源失败时报告同样带 forbid 的 `MISSING_CREDENTIAL`——唯一不带着已存副本地到达调用方的失败。这些失败都不花费共享刷新 grant、不写该存储，也不删除已存授权或宣称令牌被清空。

只有本插件自有的 OAuth 授权产生 `independent-oauth`：交互式浏览器登录及其手动粘贴授权码的回退属于同一次授权，导入的凭据永远不能被改名为它。设置通道对这次改名以 `independent-requires-login` 拒绝，对把本插件自授权账号移入外部模式以 `account-is-not-external` 拒绝。允许的 `read-only-import` ↔ `legacy-writeback` 转换按存储中的凭据 revision 写入，因此期间发生的轮换或重新登录不会被覆盖，旧模式下的缓存被丢弃而凭据本身不变。

选择 `legacy-writeback` 需要显式风险确认：服务器拒绝未声明 `riskAcknowledged: true` 的真实转换，设置按钮在发送前先询问。该模式是兼容行为而非协调：它可能花费外部持有者同样使用的共享 grant，且只有在 `syncClaudeCodeCredentials` 启用时才同时保留服务商的按需同步并把轮换写回；该开关让五分钟的 Claude Code 同步为 `legacy-writeback` 账号继续运行且仍可能触发按需 grant，而 `read-only-import` 账号从不属于该 sweep，只在每次使用时核对来源。只要账号按该模式服务，就报告 `external-coordination-unproven`，而不是安全的 single writer。只有 `independent-oauth` 启用本插件自己的主动续期定时器。

mode 从不决定资格：本路由的凭据按构造就是一方 OAuth，组织政策仍按固定路由、凭据实际 scope 与已确认订阅元数据判定，两种外部模式都不会跳过政策。账号列表与状态读取保持本地——只投影存储记录，既不读 Claude Code 存储也不发请求——只有凭据使用才读取该来源。Claude 账号的状态携带 `credentialOwnership`，含 `mode`、`external`（两种外部模式都为 true）以及仅 `legacy-writeback` 出现的 `coordinationUnproven: true`；在有维护绑定后，其 `credential` 维度对该模式报告 `external-coordination-unproven`，对只读账号报告 `maintenance-unsupported`。

只要后端报告 revision，身份补全就以 profile 读取前取得的凭据 revision 为条件：期间发生 mode 变更、登出或同令牌重登录时以 `CLAUDE_IDENTITY_CHANGED` 停止该请求，不在新模式下列定身份也不发送请求；后端不报告 revision 的只读账号以 `CLAUDE_IDENTITY_UNVERIFIABLE` 拒绝该写入，而不是降级条件。

这些模式的 fork 保留规则与聚焦验证见[插件自己的 FORK_MAINTENANCE.md](FORK_MAINTENANCE.md#claude-credential-ownership-modes)；本小节描述当前 `src/` 源码树。

## Claude 客户端元数据与传输默认值

Claude 优先读取 `retry-after-ms`，再读取 `retry-after`，接受不超过 2147483647 毫秒的正等待值。429 上已披露的账号重置时间仍优先；明确禁止重试与账号拒绝信号仍终止重试。其他提供方保留原有头部规则。

每个账号的 wire-session 跨度在首次请求时，从最近一次成功 bootstrap 读取中固定 `x-cc-atis`，也会固定“不发送头”的空值；初始身份先于该 bootstrap 读取被采纳而持久化，因此 pin 冻结自一个持久事实，而不是迟到的回答。后续 bootstrap 值只作用于新跨度。登出或身份失效会清理账号的 pin，而在 pin 被恢复或冻结之后到达的候选值绝不会复活旧值。此机制不新增轮询或额外请求；pin 由本插件的私有续接状态文档（salt、spans 与 identity generation）拥有，每账号最多保留 256 个跨度，按最早进入顺序淘汰，因此淘汰后的跨度可重新固定值，恢复时若事实缺失则从空开始。

普通 OAuth 请求只有在授权 scope 包含 `user:inference`，且账号已捕获的限流报告并非 `rejected` 配合 overage 的 `allowed` 或 `allowed_warning` 时，才声明一小时 prompt-cache TTL。辅助调用（`compaction`、`session-title`）及其他情况省略 TTL 和扩展 TTL beta，使用提供方默认的五分钟。套餐名称不参与判定；overage 状态来自已有的账号级报告，不另发请求。本路由不发送仅针对特定子代理的顶层缓存淘汰字段。

Bun 子进程使用 `--no-env-file` 启动，工作目录中的 `.env` 文件不能在继承环境白名单之外添加传输设置。启用 bridge 时，证书与主机名校验保持开启，支持的 CA 环境变量显式传入。`SSL_CERT_DIR` 要求按证书主题哈希命名的目录，不读取任意文件名。覆盖指定的 Bun 必须支持 `--no-env-file`，否则启动失败，不静默丢弃该选项。关闭 bridge 时，改由 Host fetch 及其配置的传输策略处理。

## Claude 失败恢复与账号维护（源码树）

本节描述已实现的请求和维护规则。[实现状态说明](docs/claude-implementation-status.md)记录源码级验证、仍存在的限制及上次核实的安装状态；单凭源码或包版本，不能确定运行中的 Host 已加载哪个版本。只有当 Host 声明 `ctx.llm.failureRecoveryVersion` 为 `1` 时 Claude 才会注册 —— 该契约保证失败的 `retryDisposition` 能穿过适配器归一化、Session 日志和每一条自动重发路径；其他 Host 上该路由不会注册，卡片报告 `CLAUDE_HOST_INCOMPATIBLE`，而不是运行一个该 Host 无法兑现的重试保证。Claude 还要求 `@deepseek-ai/dsh-llm-request-record`：既不提供该失败恢复版本、也不提供该记录服务的 Host 只会不注册 Claude 路由，其他 provider 的注册不受影响。

所有 Claude 拒绝都由同一份有序分类决定，无论它以失败状态还是以 `200` 内的 `error` 事件到达。声明的客户端版本下限（`CLIENT_VERSION_UNSUPPORTED`）、提供方声明为最终的拒绝（`ENFORCEMENT`）、裸 403（`PERMISSION_DENIED`）、本路由未映射的结构化错误类型（`UNCLASSIFIED_PROVIDER_ERROR`）、本路由无法服务的请求（`INVALID_REQUEST`），以及未到达业务终态就结束的流（`STREAM_INCOMPLETE`）都携带 `retryDisposition: 'forbid'`：重试执行器不安排等待，Agent 循环不重发该步骤，已声明的拒绝也不会改用账号池中的另一个账号应答。只要已有输出交付，任何代码都成为硬停止。403 是本路由上的权限拒绝，既不刷新也不清除已存凭据，也绝不会被渲染成登录过期；其他提供方保留原有的状态与头部处理。一次认证拒绝在单个逻辑请求内最多获得一次受控刷新与重发，该次重发之后到达的拒绝同样携带硬停止，因此「刷新、重发、再刷新」不会重复；Messages POST 已发出但尚未收到任何响应时抛出的失败保留 Host 的有界传输重试路径，并接受服务端可能已经执行过该请求；发送前抛出的失败、已交付输出与上下文超限则保留各自声明的恢复路径。

账号名单按相互独立的维度报告，而不是一行状态：`credential`（`ready`、`refreshing`、`reauth_required`、`missing`、`unknown-expiry`、`maintenance-unsupported`、`external-coordination-unproven`）、`availability`（`available`、`cooling`、`transient`、`refused`）、`protocol`（`current`、`upgrade_required`、`unsupported_response`）、`profile`（`fresh`、`stale`、`missing`、`unavailable`）与 `policy`（`ineligible`、`loading`、`current`、`stale`、`unavailable`、`consent-required`、`blocked`）。每个维度都由各自的拥有者计算：凭据维度始终报告，因为账号名单本身就证明存在凭据；其余维度在其拥有者无内容可报时被省略，而不是默认成健康。因此冷却不会被渲染成登录过期，版本拒绝也不会因重新登录或额度重置而被清除。卡片原先的自由文本 `detail` 由 `lastError` 取代，其中带固定 `code` 与该失败所属的 `operation`；客户端按该代码本地化文案，而状态读取自身抛出时只报告固定 `UNKNOWN` 代码，抛出的文本留在服务端。

维护只绑定真实流量。适配器的请求前钩子是会话建立绑定的唯一位置；它先等待上一次运行保存的状态安装完成再作任何判断；流结束、回合空闲或响应完成都不会释放该绑定 —— 只有会话销毁、用户停止、登出或账号移除才会，且该释放只等待本会话拥有的工作，不会取消另一会话共享的工作。同一绑定下运行三项工作：到期前主动续期凭据、资料新鲜度与托管设置读取；不带 session 的请求在流的最前即被拒绝，早于任何凭据、文件或 Messages 工作，而不是在没有续接绑定的情况下被服务；只有已绑定会话自己的工作在该绑定下运行。

已存资料在 `claudeMaintenance.profileMaxAgeMs` 内保持新鲜，默认 24 小时；与基线相等的年龄已经算陈旧，该记录会被重新读取而不是继续复用。响应只有在同时带有 `account.uuid`、`account.email` 与 `organization.uuid` 时才会被采纳，而 reader 只按 pinned 客户端自己的证据判定完整：`organization.billing_type` 已声明、`account.created_at` 存在、`organization.subscription_created_at` 已声明，以及 `cc_onboarding_flags` 存在；该字段缺席时按 `{}` 处理，不会因此判定不完整。订阅类型刻意不在该判定内：未知或 `null` 套餐是完整答案，而不是每次请求都重读的理由，响应未涉及的属性保留已知值。写入于该证据契约之前的记录不带 `completenessVersion`，因此被读作不完整并由一次有界读取替换；同一文件中已存的策略状态会保留。

托管设置读取以已确认的元数据为条件：没有已存凭据的账号、以及不由本插件自身 OAuth 路径服务的账号都不会发起读取，已确认的 `pro` 或 `max` 订阅不读取，`team` 或 `enterprise` 组织以及未知或 `null` 订阅会读取。这就是 `null` 与 `pro` 的区别 —— 只有 pinned 客户端自己视为个人 pro/max 的值才算已确认。执行以拒绝实现保守：无法校验的文档、不支持或未映射的键、没有已注册消费者的限制，以及无法证明不受影响的检查，都会拒绝该操作而不是放行；工具守卫在每次执行时按该会话实际路由过的账号判定，因此 Agent 创建之后才采纳的限制仍会拦截调用。每个 `claudeMaintenance` 值都在加载时校验：零或负值是配置错误，而不是关闭某项能力的方式，且 `failureBackoffMs` 不得超过 `maxFailureBackoffMs`。只有端点空成功完整陈述的记录才算作策略 —— checksum 与 revision 为空、无 key、无 blocker 且 `enforced: false` —— 其恢复不增加 settings 或组织请求；其余恢复记录由符合条件且已绑定的账号在下次请求时完整读取一次、不发送 validator，而已确认 `pro`/`max` 的账号仍不读取，真实组织不匹配继续拒绝。见 [FORK_MAINTENANCE.md](FORK_MAINTENANCE.md#claude-account-maintenance-for-live-sessions)。

托管设置读取发送自己的角色头部 —— 纯 `claude-code/2.1.288` user agent、`oauth-2025-04-20` beta，以及 `cache-control: no-cache` 与 `pragma: no-cache`，使端点前方的代理或网关无法用缓存的策略文档应答 —— 并使用自己的十秒期限，该期限不被下面的 token 期限覆盖。这些是受检客户端分支在这一固定、非网关配置下选用的值；它们不构成"所有客户端分支、提供方策略行为或风控判定都等价"的声明。

每次 token 端点 POST（授权码交换与刷新）都以 30 秒为整个交换的期限：包括 fetch 以及读取和解析应答（成功文档或错误体），而不只是响应头。超过该期限的 POST 会被中止，并报告为 `TIMEOUT`，其 cause 是本插件自己的到期错误，而不是端点返回的响应体；该 helper 不重放 grant，且超时不属永久刷新失败，因此会保留已存凭据。任何刷新结果都不会删除账号：永久拒绝只会使其停用待重新登录，只有显式登出才会删除。该期限是其包裹组件上的明确墙钟期限，不构成"各适配器超时等价"的声明。本路由所用的传输层自己不施加任何期限，这正是该期限存在的原因。

默认值取自当前配置 schema 及其解析器：

| 字段 | 默认值 | 用途 |
|---|---|---|
| `refreshLeadMs` | `300000` | 凭据到期前启动续期的提前量；未配置时取本路由自身的到期提前量 |
| `profileMaxAgeMs` | `86400000` | 已接受资料保持新鲜的时长 |
| `policyPollMs` | `3600000` | 账号处于绑定期间托管设置的轮询周期 |
| `readTimeoutMs` | `10000` | 单次资料或设置读取的上限 |
| `failureBackoffMs` | `30000` | 维护周期失败后的首次重试延迟 |
| `maxFailureBackoffMs` | `900000` | 失败退避加倍所能达到的上限 |
| `minRefreshDelayMs` | `30000` | 两次凭据检查之间的最小间隔 |

## Claude 续接状态（源码树）

本路由的续接状态是持久且私有的，不驻留进程内存：`salt.json`、`spans.json` 与 `identity-generation.json` 位于 `$DSH_HOME/plugins/subscriptions/claude-continuation/`。它们不保存 token、邮箱或明文账号键，但它们保存的派生账号引用与会话身份仍可关联，按私有身份状态保管；salt 材料不构成匿名保证，记录服务写入的 system 文本可能含部署自行配置的秘密，保密等级等同 session 日志。

链只有一个定义：保留的 assistant 消息中，其 trusted v1 metadata 声明了引用种类与版本、`ref`、`spanEpoch`、harness 与 wire 身份，以及可重放的 role 与 blocks，且其账号引用与本次请求一致。在合格的 assistant 续接记录内，`requestId` 缺失或为空时向前扫描上一条可信记录；账号引用缺失的记录整体跳过；被选中的 `requestId` 若为真值但校验失败则丢弃该次选择，不回溯到更早记录。换模型本身不阻断链，而 thinking replay 仍受既有模型门约束。

本地身份或 span 准备失败会在任何凭据使用、Files 或 Messages 工作之前拒绝该请求：存储不可信或写入失败以 `LOCAL_CONTINUATION_STATE_UNAVAILABLE` 与 `retryDisposition: 'forbid'` 结束；状态等待则一直持续到其操作真正结束，只有调用方取消或插件销毁才会结束。维护之后的一次 epoch 核对失败、或 pin 持久化失败，会阻止其后的 Files 与 Messages 工作，但不撤销此前已经发生的维护或刷新。记录 flush 失败则只禁止 Messages 发送，对可能已经发生的 Files 工作不作承诺；不带 session 的请求在任何凭据、文件或 Messages 工作之前即被拒绝。

| 字段 | 默认值 | 用途 |
|---|---|---|
| `continuationStateDeadlineMs` | `5000` | 每个请求一份的建议性计量，取值 100–10000 毫秒，用于该请求的续接状态各阶段：它从不结束等待，也从不拒绝请求 —— 等待会持续到其工作真正结束或调用方取消。解析后的值仍至少为 `continuationStateLockTimeoutMs` + 2000 毫秒，因此既有配置仍得到它原本解析到的值 |
| `continuationStateLockTimeoutMs` | `2000` | 一次续接状态锁的退避与租约输入，取值 100–10000 毫秒；活着的持有者会被等待，只有无法创建的锁路径才会拒绝该操作，而不是无主运行 |

身份变化在「使其成真的凭据提交」之前设门：token 轮换不推进身份代际，未知的 active 身份不能自动接管，被记录为失败的身份只能通过显式授权恢复；请求从不伪造一个已修复的身份。

## Claude 策略限制与可抽取组件（源码树）

`policy_limits` 文档是第二个、独立的 Claude 策略来源：它有自己的缓存文件、校验器与单飞读取，与托管设置文档相互独立，互不替代。它按活绑定的自身节奏读取，且只对符合条件的账号读取 —— 本插件自身的一方 OAuth 路径、固定端点基址、inference scope 与已存令牌。读取失败时保留上次采纳的文档作为过期值，而不是丢掉已知限制；从持久存储恢复的记录未经本次运行验证 —— 其已知限制继续生效，无法安全恢复的项保持阻断，且在新的 fresh 读取之前不发送 validator —— 而无法信任的存储会拒绝它本可能限制的操作。

判定在两个位置执行，且使用同一套键与同一份映射，因此不存在一个路径遵守而另一个路径忽略的限制：绑定账号的模型推理，以及执行阶段的工具守卫 —— 后者按会话实际路由过的账号逐个判定。被已采纳文档拒绝的键以 `POLICY_LIMITS_DENIED` 停止该操作；本构建无法精确映射的键、不可信状态与读取失败都以拒绝而非放行处理，分别报告 `POLICY_LIMITS_UNSUPPORTED` 与 `POLICY_LIMITS_UNAVAILABLE`。拒绝信息中只允许出现固定注册表自己的键名：未知键保留其拒绝结果，但以固定占位符报告，因此远端键文本不会进入模型、错误投影或 Session 日志。其执行属于本提供方不具备的表面的键（客户端 transcript 扫描、仓库探测）在此为不适用，而不是假定无害；读取失败与未映射键同样脱敏：只出现固定代码与计数，绝不出现文档、其 defaults、taint 或键名。

服务端的 `enforce_`/`require_` 控制族不属于固定的 allow 键注册表：control 声明的是义务而不是对某个操作的判定，因此 `require_trusted_devices` 与 `enforce_web_search_mcp_isolation` 被从操作权限键集合及其未知键计数中分类排除，账号状态在 `controlRequirements` 中把二者分别报告为 `active`、`not-enforced` 或 `unknown`。本构建不执行设备注册（enrollment / cloud-create / link）类操作，也不存在带描述符标记的 web_search 或 MCP connector 执行器，因此 `active` 的 control 只以一行由 locale 持有的警示说明本客户端未提供该能力（文案写明仅观察到该要求、未声称已执行），并且不拒绝任何操作：两项 control 单独或同时出现都不会被误判为未知操作键，也不会阻断 Messages。`false` 或缺失的 control 不新增警示；非布尔 `allowed` 仍由 envelope 解析器使整份文档失败，而不是降级为 `unknown`；其它真正未知的操作键保留既有保守判定；固定 allow 键注册表不新增键、资格规则不变 —— 该分类不会让未知 allow 键变成 fail-open。

control 观察结果不持久化：恢复的快照不保存 control 键，因此重启后该警示可以暂时消失，此时两项 control 为 `unknown` 而不是 `not-enforced`，也不会显示为已满足或已执行；等既有策略读取流程取得新文档后再显示。分类之前的旧快照保留其记录的未知键计数，因为该计数无法归因到这两项 control，本改动既不擅自清零也不迁移它。不新增任何 HTTP 请求、轮询节奏或 UI 开关；状态面只新增固定的 `controlRequirements` 投影。

账号名单把该维度作为独立条目报告，带固定代码与计数 —— 被拒键数、taint 数、未映射键数，以及本构建不提供的能力数 —— 并在服务商给出时报告规范化后的组织监控通知。该通知是服务商自己的文字：其文本按文本渲染，其 `https` URL 是用户主动打开的链接，客户端绝不抓取。通知不限制任何键，也不是阻断状态；从持久存储恢复的、只知"存在通知"的快照会显示为等待下一次确认读取，而不是显示为没有通知，且它不阻断任何无关操作，而未知的真实权限仍会阻断它触及的操作。

已确认的数据处理 taint 会为该账号的构建抑制三个固定的 mid-conversation beta，同时保留顶层 system 提示与普通 Messages，途径是调用方带外声明的受信 request-policy 输入：原始请求 DTO 无法设置它，顶层 system 提示本身不会触发抑制。不受支持的 mid-conversation-system 输入会在任何 Files 或 Messages 请求之前被拒绝，且不记录协议块。在实际适配器上该拒绝报告为 `POLICY_UNSUPPORTED` 并禁止自动重发；`CLIENT_VERSION_UNSUPPORTED` 只用于上游版本证据，此处不复用。

有三个源码目录可供本 harness 之外的调用方抽取，且既不导入 harness，也不导入本插件的 provider 层。`src/claude-core` 是纯单账号协议核心 —— `policy_limits` 解析、校验、判定顺序与组织 pin 校验 —— 凭据、flag、传输与调度都由调用方注入。`src/claude-engine` 从原始 Anthropic Messages DTO 构建一次线上请求，并在注入的传输上运行单账号回合；它支持调用方持有的续接链，把合法的上一请求 id 拼接进 billing 块，并按调用方自己的选择序列化 ATIS 头，自身从不派生请求 id。`src/claude-account-client` 提供令牌交换与刷新、严格 profile 与托管设置 reader，各自带自己的响应体上限与期限。这些模块刻意不承担链路中调用方那一侧：从保留的历史中选择可用的上一请求、以及持久化 ATIS 状态都归调用方，抽取可以带上它所需的纯 selector 与账号引用。该私有续接状态存储不进入 Mac 侧打包，且本轮 Mac 工作暂停：本节任何内容都不表示池调用方或 Mac 后端已实现。每个目录自己的 README 陈述其合同。

不要把本节读作 HIPAA 合规，也不要读作与 Desktop 托管客户端的等价。其执行属于客户端 transcript 扫描或仓库探测的键在本提供方没有对应表面，因此这些键在此不适用，拒绝也不会扩大为 transcript 读取或传输。本构建未映射的键以保守拒绝处理，而不是翻译。flag 来源由调用方注入且可关闭，不新增任何 flag；主动最低版本下限未实现 —— 对 flag 来源的源码分析表明，其可关闭、未被 await、fail-open 的检查默认值为 `0.0.0` 且没有来源或证据支撑，因此不携带可靠的 scope 或 revision，无法提供逐请求的强预判，现存的只是记录已见拒绝的 latch。由另一台 DSH host 施加的策略不在本插件范围内 —— 公共池 worker 在此不执行工具 —— 因此跨 DSH 的策略交接尚未完成。平台身份声明需要部署的真实 manifest 与真实平台运行；某一平台的合成 fixture 不能作为另一平台的证据，本工作记录的检查均为合成检查，且池调用方的双向证据尚未交付。

该路由不发送可选的启动预热 `HEAD /api/hello`。Messages 在需要时建立传输；这一明确取舍不增加心跳或周期连接流量。源码和测试构建不会更新已安装插件；部署须在 Host 停止时安装经过验证的版本固定包。

## 代理

DSH `v0.1.3-alpha.1` 新增宿主统一代理支持。建议在启动环境或 `$DSH_HOME/.env` 中配置 `HTTP_PROXY` / `HTTPS_PROXY`(或 `ALL_PROXY`)以及 `NO_PROXY`,重启 DSH,然后**关闭插件代理**。参见 [DSH 网络代理指南](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/docs/user/guide/network-proxy.md)。环境变量中的代理凭据会被子命令继承,与插件私有配置文件的凭据边界不同;不会自动删除或迁移已有设置。

插件代理作为可选覆盖设置保留,用于仍受支持的旧版 DSH 以及仅订阅请求使用独立代理的场景。所有订阅相关请求 —— token 交换、模型 API 流式调用、用量查询、模型目录发现,以及 `x_search` / `image_generate` / `video_generate` 工具 —— 都可以使用。在 **设置 → 订阅 → 代理 → 配置…** 中设置:勾选启用,填写代理地址(`http://127.0.0.1:7890`)、可选用户名/密码,以及可选的逗号分隔绕过列表(如 `127.0.0.1`、`localhost`、`*.example.com`)。关闭或绕过插件代理后使用 DSH 的全局 fetch 路由,**不一定直连**;要求直连时还应配置宿主的 `NO_PROXY`。密码保存在 `~/.dsh/plugins/subscriptions/proxy.json`(权限 0600),不会回传给浏览器;「测试」按钮会用当前配置探测一次端点,显示 HTTP 状态码与耗时。

保存后立即对后续请求生效,无需重启。OAuth 授权页在浏览器中打开,走浏览器/系统自身的代理设置,不受此配置影响;不支持 socks 代理。

## 相关插件

本插件只提供模型路由,审批策略由其他插件负责:

- [`dsh-plugin-auto-review`](https://github.com/delef/dsh-plugin-auto-review) —— 面向 DSH 工具审批的 provider 原生自动审查。它在本插件注册的 `codex` / `grok` 路由(或其他 DSH LLM adapter 的兼容路由)之上,通过 `ctx.llm.stream()` 复现 Codex Guardian 与 Grok 提权审查逻辑,不接触账号与凭据。安装:`dsh plugin --profile web add dsh-plugin-auto-review`。

## 开发

```sh
pnpm install   # devDependencies link into a local deepseek-harness checkout — edit the paths first
pnpm build     # tsc (lib/) + tsdown (lib/client.js browser bundle)
pnpm test      # compile to lib-test, then node --test in a private DSH_HOME
```

`prepare`(git 安装时触发)执行 `tsdown.prepare.config.ts`:自包含打包两个面,所有 `@deepseek-ai/*` 依赖外部化 —— 运行时从 dsh 安装解析,保证不会引入第二份 cordis。

改了代码后 `pnpm build` 并重启 `dsh web` 生效。

## 目录结构

- `src/index.ts` —— 插件入口:配置 schema（缓存时间范围由 `cache-policy.ts` 解析）、adapter 注册、登录态变更通告、RPC 接线
- `src/auth/` —— PKCE/JWT 工具、token 存储、OAuth 流程引擎(临时本地回调服务)、Claude Code 凭据读取器(Keychain/文件)、`/subscriptions-auth` RPC 通道
- `src/auth/claude-credential-ownership.ts` —— `credentialOwnershipMode` 的唯一权威:三种模式、其中哪种可以花费共享刷新授权或运行插件自己的续期定时器,以及设置通道允许持久化的转换
- `src/providers/` —— 各 provider 的 OAuth 常量/换发/刷新 + `LlmAdapter` 实现，多账号 token 管理（`accounts.ts`），模型池（`pool.ts` + `pool-health.ts` / `pool-usage.ts` / `pool-family.ts`），`rate-limit.ts`（限流重开时刻解析 + 重试策略），以及按账号持久化的元数据缓存（`catalog-store.ts` / `usage-store.ts`，`cache-identities.ts` 在加载时对账已记录的账号改名）
- `src/translate/` —— dsh `Message[]` 与 OpenAI Responses / Anthropic Messages 格式互转,SSE → `StreamChunk`
- `src/providers/codex-search.ts` —— 为 DSH 原生 `web_search` 能力提供 Codex 搜索实现
- `src/tools/` —— `x_search`、`image_generate` 与 `video_generate`
- `src/client/` —— 设置 → 订阅页面（浏览器面，中英文，跟随明暗主题），以及用量胶囊与设置页共用的同一份订阅缓存（`subscriptions-cache.ts`）
