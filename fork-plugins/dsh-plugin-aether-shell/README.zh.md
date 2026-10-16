---
description: "在现有 DSH shell 工具旁加入可选的原生 AetherShell 查询、持久解释器会话和后台任务。"
kind: "package-bundle"
---

# @ryanzhou416/dsh-plugin-aether-shell

[English](README.md) | 中文

## 摘要

让 agent 查询 AetherShell 操作、求值类型化程序、跨调用保留一个解释器的原生状态，或在后台运行程序。这个可选 bundle 不改动现有 PowerShell 和 Bash 工具，也不新增持久化会话格式。每个解释器进程都是真实 Host 进程，受所属 Session 的 DSH 文件策略约束。AetherShell 是外部前置条件；插件不安装或重新分发它。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发笔记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 前置条件与安装

插件面向 DSH `0.1.7-rc.1`。默认的 `legacy` 数据模式支持原生 AetherShell `12.0.2` 协议；`typed-v1` 需要个人构建版 `12.0.2+ryan.2` 提供的类型化数据能力。单独安装 AetherShell；如果 Host 已继承的 PATH 中没有它，配置解释器绝对路径。Windows 系统级安装可使用 `C:\Program Files\AetherShell\ae.exe`；修改 PATH 不会更新已运行 Host 的环境。

从 checkout 构建并打包，无须安装依赖：

```powershell
pwsh -NoProfile -File fork-plugins/dsh-plugin-aether-shell/scripts/run-local.ps1 build
pwsh -NoProfile -File fork-plugins/dsh-plugin-aether-shell/scripts/run-local.ps1 pack
```

从 checkout 运行 `pnpm dsh plugin --profile <profile> add <tarball> --ignore-scripts`，先在隔离的 Harness home 中安装生成的压缩包，再在真实 profile 中启用。bundle 插入一个 `aether-shell` 插件条目，不禁用其他 shell 条目。启用前备份 profile 配置；不要在 Host 使用已安装产物时替换它。

### 选择合适的工具

| 工具 | 输入 | 生命周期 | 用途 |
|---|---|---|---|
| `aether_discover` | 可选的精确类别或平面内置操作名，以及分页参数 | 单次调用 | 获取原生类别索引、某类别的操作，或某操作的签名和示例。 |
| `aether_call` | 平面内置操作名和位置 JSON 参数数组 | 单次调用 | 不生成 AetherShell 源码即可调用一个操作。 |
| `aether_pipeline` | 有序原生步骤和可选的 JSON 输入 | 单次调用 | 一次执行中完成类型化值的过滤、投影和聚合。 |
| `aether_eval` | AetherShell 源码 | 单次调用 | 在新进程中求值表达式、lambda 和模块调用。 |
| `aether_result_page` | 保留结果的 id、偏移、格式，以及可选释放标志 | 直到释放 | 分页读取完整结果，不重复执行原操作。 |
| `aether_session_open` | 可选目录、标签和期限 | 直到关闭 | 启动一个持久解释器进程并返回不透明会话 id。 |
| `aether_session_eval` | 会话 id 和 AetherShell 源码 | 单次调用 | 在该进程中求值程序，变量、函数、当前目录和环境都会保留。 |
| `aether_session_read` | 会话 id | 单次调用 | 取走无调用在途时会话写入的输出，且只交付一次。 |
| `aether_session_list` | 可选计数器 | 单次调用 | 列出本 agent 的句柄及其状态和文件策略模式。 |
| `aether_session_close` | 会话 id | 单次调用 | 请求原生会话关闭并终止其进程。 |
| `aether_job_start` | AetherShell 源码，可选标签、目录和期限 | 直到完成或被终止 | 启动一个后台解释器进程并立即返回其任务 id。 |

四个查询工具每次调用都启动新解释器；保留的 JSON 结果独立存在有容量上限的插件内存中。结果分页工具只在 live-agent 注册表挂载时注册。插件启用期间它们始终注册，且都不提供后台标志。五个会话工具在 live-agent 注册表挂载时注册，因为句柄必须属于某个调用 agent；`aether_session_read` 取走调用之间写入的输出，而调用在途时读取会被拒绝，因为那段输出属于该调用。`aether_job_start` 在任务注册表挂载时注册，读取和终止控制由 `job_output`、`job_list` 和 `job_kill` 提供。

使用不熟悉的内置操作前先调用 `aether_discover`。调用参数按位置传递：`{"builtin":"len","args":[[1,2,3]]}` 返回 `3`；数组参数占据一个位置。不提供命名参数对象；把记录放在位置数组内，使其全部字段保持为一个参数。

结构化管道可用 `{"input":[{"size":1},{"size":5},{"size":9}],"steps":[{"builtin":"where","predicate":"size > 2","select":"size"}]}` 返回 `[5,9]`。predicate 提供步骤的 lambda，替代位置参数；selector 追加一个投影阶段。显式模块语法 `str.upper("hello")` 或 `[1,2,3] | map(fn(x) => x * 2)` 可使用 `aether_eval`。

### 结构化数据兼容性

只有解释器实现了类型化数据协议，才设置 `structuredDataMode: typed-v1`。每次结构化请求之前，插件在相同的 DSH 文件策略下探测 `capabilities`，要求协议版本 `1` 及全部三项类型化数据能力。探测与请求共用一个期限。能力响应缺失、不受支持或失败时，在发送用户数据前停止调用，不自动回退。默认的 `legacy` 模式保留旧解释器所需的插值、记录键和 null 初值拒绝规则。

在已验证的 `typed-v1` 模式中，JSON 字符串内的 `${...}` 与非标识符记录键保持为字面数据，显式 `input: null` 会设置原生 null 初值。内置操作名仍须为平面名称；`predicate` 与 `aether_eval` 仍是可执行的 AetherShell 源码。两种模式都拒绝超出安全范围的整数。在个人运行件中，`byte_len("你好")` 为 `6`，`char_len("你好")` 为 `2`；`char_len` 计算 Unicode 标量值，不是字素簇，而 `len` 保留既有的字符串字节计数。

### 沙箱与真实环境的关系

这不是虚拟机、模拟 shell 或虚拟文件系统。AetherShell 是本机上的真实程序：其操作就是真实操作系统工作，读写真实文件系统，通过自身内置操作访问真实网络，并启动真实子进程。查询工具、持久会话和后台任务都在同一个真实世界中执行。

DSH 限制的是解释器进程的文件写入和删除，依据所属 Session 的当前文件策略：

- `danger-full-access` 不限制文件写入和删除。
- `read-only` 拒绝写入和删除。
- `workspace-write` 允许在会话工作区和特定平台临时区域内写入和删除，其他地方拒绝。

同一条规则适用于所有 shell 绑定，包括 `pwsh`、Bash 和这些工具；更换工具不会改变权限。一次拒绝对该调用是最终的：改用其他工具或 shell 重试同一效果不是变通办法，本插件也不提供轮内升级字段。

该策略只管辖写入和删除。它不隔离文件读取、网络访问或进程控制能力，也不是对解释器可观察或可执行范围的通用沙箱。

子进程环境是 provider 清洗后的父环境加上插件自身设置。清洗有意移除凭据形状的名称（`*KEY*`、`*SECRET*`、`*TOKEN*`、`*PASSWORD*`）和继承的 `DSH_*` 名称，避免 Harness 凭据泄漏到子进程或其输出。`PATH`、`HOME` 等普通 Host 变量照常保留；因此除非部署配置固定绝对可执行路径，解释器按 Host 的真实 PATH 解析工具。

### 持久会话

会话是一个真实的 `ae agent interactive` 进程，持有原生可变状态：变量、函数、进程级当前目录和进程环境。只要该进程运行，这些状态就在 `aether_session_eval` 调用之间保留；每个句柄独占一个进程，其他句柄无法观察其内存状态。

会话操作真实 Host 文件系统，因此它写入的文件会保留，其他进程也能看到；只有它自身的变量、函数和环境是按进程隔离的。进程本身不落盘任何会话检查点，重新打开会话时不重放任何内容。

会话对打开它的 agent 私有。部署限制单个 agent 可持有的数量，空闲会话会自动关闭。句柄报告打开时的文件策略，每个请求都先重新解析调用方策略。如果该策略在会话打开后发生变化，会话会被关闭，而不是以过期权限继续运行，`aether_session_list` 会把该句柄报告为 destroyed。关闭未知 id 不改变任何状态；其他 agent 的会话会被拒绝。

期限或取消会终止整个会话进程，因为解释器无法放弃正在运行的命令。解释器自行退出的会话会被丢弃。两种情况都不会重新打开或重放会话；请在当前策略下打开新会话继续。程序执行中途失败时，该调用中较早语句已经完成的效果会保留：部分效果和绑定不会回滚。

### 后台任务

`aether_job_start` 为一个程序启动一个新解释器进程并立即返回任务 id。它是 `aether_eval` 的流式对应物：程序走解释器自己的命令行，原始 stdout 和 stderr 流入任务输出环，不读取结果文档，因此只打印日志、混合 JSON 或什么都不打印的程序也能完成。用 `job_output` 读取流；规范退出事实和 spill 文件在结算后的首次读取中返回。`job_kill` 请求停止，结算发生在托管进程清理之后，所以 kill 不阻塞，并可能在它返回后结算。

任务属于启动它的会话，并在该会话的 agent 被释放或插件卸载时停止。任务使用启动时的 DSH 文件策略，而持久会话在每条命令前重新求值策略，并因变化而失效。任务进程是全新的，与任何持久会话分离：变量、函数和目录变化不会在两者间传递，也不提供会话加后台的组合模式。

除非部署限制任务运行时长，或调用提供 `timeoutMs`，任务没有期限。默认部署不设上限，因此永不结束的程序会一直运行，直到 `job_kill` 或 owner 释放将其停止。程序自身子进程通过解释器进程内置操作产生的输出，可能由解释器在其返回该输出前捕获，因此不承诺实时子进程日志。

### 执行与权限

查询调用和会话命令有明确的工作目录与期限；后台任务只有在调用或部署提供期限时才受期限限制。插件清除继承的 `AETHER_*` 和 `AE_*` 控制变量，再使用自己的运行配置；权限真源仍是 DSH。除非部署配置启用，否则 `sh()` 启动时关闭。这个启动设置不是进程执行安全边界：其他进程内置操作和表达式代码可以改变解释器状态，其文件副作用仍受 DSH 文件策略限制。

响应区分值、原生错误、文件沙箱拒绝和中断。解释器退出事实与有界 stderr 分开保留。原生 API 可能在进程退出零时报告失败。应用返回记录中的 `success:false` 是普通数据，不会自动变成工具失败。AetherShell 的子程序结果仍在该值中；解释器退出码不是子程序退出码。

### 大结果与错误数据

当完整且成功的调用、管道或 eval 值超过内联上限，并且存在有效的所属 Agent 和保留容量时，工具会返回独立的保留结果通知。用其 id 调用 `aether_result_page`，持续传回 `nextOffset`，直到 `complete` 为 true。`items` 按完整数组元素或记录字段分页；`json` 返回规范 JSON 值的 UTF-8 字节片段，按顺序拼接 `data` 字符串后再解析，也能取回单个超大元素。页不会静默切断元素或字符。`drop:true` 释放结果。分页不运行代码，也不重复副作用。

结果只属于原 Agent，不按工作目录共享。数量、单 Agent 字节和全局字节上限共同限制保留容量；字节按编码后的 JSON 计量，不代表 V8 堆大小。容量耗尽时拒绝新结果，不驱逐已有结果。空闲到期、Agent 释放、插件卸载或 Host 重启都会释放结果；不承诺恢复，也不写磁盘缓存。只有完整且通过保真检查的捕获结果才会保留；缺少完整捕获、数值不安全、缺少 owner 或容量耗尽均明确失败，不返回半截结果。

原生失败中的 `metadata.error` 以对象保留，并以 JSON 错误数据呈现，包括可用的预期／实际值及阶段、效果事实；旧错误文本仍兼容。`safe_to_retry:false` 禁止自动重放，旧有的可恢复提示不代表较早效果已撤销。业务返回记录中的 `success:false` 仍是普通数据。

### 配置

在 profile patch 中覆盖 bundle 的 `aether-shell` 条目。解释器可以是绝对路径或 PATH 名称；包含分隔符的相对路径会被拒绝。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `executable` | `ae` | 原生解释器路径或名称。 |
| `executableArgs` | `[]` | 受信任的 argv 前缀；离线测试用它加载外部运行时 fixture。 |
| `mode` | `human` | `human` 保留类型化原生 JSON；`agent` 显式启用 AECON 和 AetherShell 额外的原生审批规则。 |
| `structuredDataMode` | `legacy` | `legacy` 保留旧数据保护；`typed-v1` 仅在能力探测成功后转发类型化 JSON 数据。 |
| `allowShell` | `false` | 启用解释器的 `sh()` 内置操作，不改变 DSH 文件策略。 |
| `timeoutMs` / `maxTimeoutMs` | `120000` / `600000` | 默认及最大单次调用硬期限。 |
| `maxRequestBytes` | `1048576` | 编码请求或源码的字节上限。 |
| `maxOutputBytes` / `maxSpillBytes` | `262144` / `8388608` | 每个流的内存和完整流 spill 上限。 |
| `maxResultBytes` | `65536` | 完整内联结果、保留通知及分页响应的上限。 |
| `maxResultsPerOwner` | `8` | 单个 Agent 可持有的保留结果数。 |
| `maxStoredResultBytesPerOwner` | `16777216` | 单个 Agent 保留的 JSON 编码字节数。 |
| `maxStoredResultBytes` | `67108864` | 全部 Agent 保留的 JSON 编码字节数。 |
| `resultIdleTimeoutMs` | `1800000` | 空闲这么久后释放结果；`0` 禁用到期。 |
| `graceMs` | `3000` | 托管进程清理宽限期。 |
| `maxManifestEntries` | `64` | 发现结果的页大小上限。 |
| `maxExpressionChars` | `4096` | 每个步骤的 predicate 长度上限。 |
| `maxSessionsPerOwner` | `4` | 单个 agent 可持有的活动持久会话数。 |
| `sessionIdleTimeoutMs` | `1800000` | 空闲这么久后关闭会话；`0` 禁用空闲到期。 |
| `sessionStartupTimeoutMs` | `30000` | 创建并握手一个持久解释器的期限。 |
| `maxBackgroundRuntimeMs` | `0` | 单个任务总运行时长上限；`0` 不设上限。 |

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节——展开阅读</summary>

[bundle patch](cordis.patch.yml) 加载 [src/index.ts](src/index.ts) 中的具名 Host 插件。发现、调用和管道通过 stdin 使用解释器的本地 JSON 请求 API。表达式求值使用确定性命令行输出，因为这条路径注册 AetherShell 的模块命名空间。持久会话在长驻 `ae agent interactive` 进程上使用解释器自身的 `sess_*` 内置操作，后台任务通过任务注册表为每个程序运行一个新进程。所有路径都直接使用 DSH subprocess 和 sandbox 服务，不注册另一个 `ctx.shell` provider，也不启动 HTTP/MCP 服务器。

工具注册表拥有权限钩子和持久化 call/result 事件。插件拥有请求校验、协议解码、完整结果边界、硬期限、会话与任务所有权，以及卸载清理。它不提供 invariant companion：请求和返回结果直接读取，没有独立的持久化状态投影。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [AetherShell 上游](https://github.com/nervosys/AetherShell)——解释器语法和原生操作。
- [DSH 工具编写](../../docs/cookbook/adding-a-tool.zh.md)——规范结果与策略钩子。
- [Fork 维护](FORK_MAINTENANCE.md)——保留和验证要求。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过模型在每个请求中读取的十一个已注册工具声明、其所有权和策略指引。

#### KV Cache 影响

工具声明及其指引在同一个组合中构成稳定请求前缀，因此在声明未变时保留已可复用的前缀。结果追加单次调用上下文，打开会话会记录携带不透明会话 id 的持久结果元数据，重放时直接读取日志而不再运行解释器。重命名工具、更改 `inject` 门控或编辑描述可能改变组装后的前缀并使复用失效。

## 已知限制与延后工作

- 查询调用仅在前台执行，具有硬期限。持久会话是跨调用保留原生状态的唯一方式，后台任务是超出调用期限继续运行的唯一方式。
- 会话列出的工作目录是其进程启动时的初始目录。改变当前目录的程序会改变进程真实的 `pwd()`，而列出值仍是起始目录；需要当前目录时读取进程自身的 `pwd()`。
- 会话的代码状态从不持久。重启、插件卸载、期限、取消或策略变化都会丢失会话内存中的变量、函数和环境；程序写入的文件仍在，但没有自动重开、重放或历史。后台任务同样不保存检查点。
- 被拒绝的调用没有轮内沙箱升级字段；如需更广的文件访问权限，必须由用户显式修改 Session 权限策略。
- 较旧的原生 API 会插值 `${` 字符串、输出不带引号的记录键，并将 null 管道初值视为省略。`legacy` 拒绝这些输入；已验证的 `typed-v1` 把它们作为类型化数据转发。会话程序通过编码后的源码保留调用方写入的插值，后台程序走命令行而不额外包装。
- 调用与管道接受平面内置操作名，不接受模块表达式。模块语法使用 `aether_eval` 或持久会话。超出安全范围的数值整数会被拒绝，不会静默舍入；大整数应作为文本请求。
- 打印到 stdout 或启动继承 stdout 的子进程可能污染查询工具的单一 JSON 响应；该工具报告协议错误，不从混合输出中挑选看似合理的结果。后台任务读取原始流，不受影响，但其输出是非结构化文本。
- 不把截断尾部当作完整响应解析。provider 的完整 spill 可在 `maxSpillBytes` 范围内解码，超过该捕获上限仍明确失败。成功的大查询结果可在 owner 与插件存活期间分页取回；持久会话与后台输出保留各自既有的限制。
- 运行件特有的内置操作语义与类型化传输相互独立。个人构建版保留 JSON null 往返，并提供明确的字节／标量长度操作；较旧发布版可能保留不同的内置操作行为。

<a id="dev-note"></a>
### 开发笔记

无。
