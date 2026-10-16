# claude-core — 共享纯单账号协议核心

[English](README.md) | 中文

`src/claude-core/` 是 `policy_limits`、组织 pin 校验与 quota 观测的**纯单账号协议实现**，供 DSH 订阅插件与 Mac 池 VM 共用。它**不依赖 DSH/Cordis**，不导入 `src/providers/**`，不自建凭据库、账号池或代理，不写会话数据，也不启动任何定时器。

## 模块职责

| 模块 | 唯一的职责 |
|---|---|
| `policy-limits.ts` / `policy-limits-client.ts` / `no-live-policy.ts` / `policy-registry.ts` / `eligibility.ts` | `policy_limits` 文档的规范化、verdict 表与有界读取 |
| `control-requirements.ts` | 已采纳文档的 control 义务三态：只读 `restrictions`，只回答"该义务是否生效"，不回答"是否放行" |
| `org-pin.ts` | 组织 pin 的三态解析与校验（有 pin 才发 bodyless POST） |
| `quota-observation.ts` | 一份原始来源的一次读取与两条 projection：header 家族 → legacy 报告 / strict 观测；raw usage JSON → legacy 窗口 / strict 观测。**它是这两个来源唯一的解析 owner**，插件与 Mac 侧都不再各留一份规则 |

control 义务来自服务端 `enforce_`/`require_` 族的 `restrictions`，**不是 34 键 allow 注册表里的键**：`controlRequirements(document)` 只读 `restrictions`，给出三态（`allowed:true` ⇒ `active`、`false` ⇒ `not-enforced`、缺键 ⇒ `unknown`；非布尔由 envelope parser 整份 `parse_failed`，**不得**降级为 `unknown`），并把本构建无 consumer 的生效项列进 `unsupportedActiveControls`（distinct、固定顺序）。本构建没有设备 enrollment / cloud-create / link 操作，也没有已证的 web_search / MCP connector 执行器，因此生效的 control 只产出这一条状态事实：**它自身不产生拒绝、不 park、不改变任何已有限制路径**；真实执行绑定属 P6-host。

`KNOWN_CONTROL_KEYS` / `isKnownControlKey(key)` 是**同一份**分类：这两个已证义务键从**操作权限键命名空间**中排除（owner 的实时 `restrictionKeys` 与持久化投影的 unknown-key 计数共用它），因此它们不会被当成未知操作键而拒绝 Messages/工具；**不是前缀规则**——非这两个键的 `require_`/`enforce_` 键、以及其它真正未知键，仍按既有保守路径拒绝并计数。已持久化记录不保留 control 状态，恢复后 control 保持 `unknown`（不显示为 `false`）；只有计数、无法归因到原键的旧快照**保持原保守状态**，直到既有读取路径取得新的真实文档。

`quota-observation.ts` 的 port 边界（Mac 侧复用同一 strict 输出时必须连带登记）：

- `QuotaHeaderSource = { get(name): string \| undefined }`：只读来源。`Headers` 可直接传入（`null` 由 adapter 折成 `undefined`，不得反向折成 `''`）。
- `LegacyResetResolver = (rawText: string \| undefined, now: number) => number \| undefined`：legacy projector 的注入 port。**delay / duration（`6m0s`）/ HTTP-date / epoch 秒 / 毫秒五种形态由此 port 决定**，core 不 import 也不复制该算法；`now` 由调用方注入。
- `parseUsageJson(body, now, options?)`：只读取与投影本模块已有证据的形状，**没有任何 caller 注入的身份集合**——显示名不构成身份，因此不需要（也不再接受）一个 approved-id port。header 数值 reset 只按 `epoch-seconds` 转毫秒（strict 唯一一条秒→毫秒），usage JSON 的 `resets_at` 的 strict 判读只认本模块验证的 RFC3339 子集——**数字 reset 在该路径不得按秒解释**。
- 跨次 freshness / watermark / “一窗更新不续期另一窗”归调用方（插件的 `captures`、将来 Mac 的 state）：core 只产出**当次** facts，不建 cache。
- `scopeKind` 是 strict 观测的**必填**维度，取值只有 `'account' | 'model-family' | 'unknown-scope'`，与窗口 token 分开：
  - header：`5h`、`7d` = `'account'`（当前认证上下文的通用窗）；**`7d_oi`、`overage` = `'unknown-scope'`**。`7d_oi` 是 `seven_day_overage_included`，客户端按独立 key 存储、适用性受模型显示名单条件，**不得并入 `7d`、不得覆盖或与 account 周窗求 min/max、各自保留 reset 与 `observedAtMs`**；`overage` 的适用面与周期均未证。
  - usage JSON 顶层：只有已映射的 `five_hour`/`seven_day` 是 `'account'`；**`seven_day_opus`/`seven_day_sonnet` 是 `'model-family'` 并带小写 `family: 'opus' | 'sonnet'`**（源客户端确实按 catalogue family 分类），它只说明这是 family 窗，**不替消费方判定当前请求用哪个模型**，也不是稳定 model id。
  - `limits` 行：`session`/`weekly_all` = `'account'`；`weekly_scoped` 保留 token `7d` 但**无稳定绑定 ⇒ `'unknown-scope'`**；未识别 kind ⇒ `kind:'unknown'` + `'unknown-scope'`。
  - **每一条观测由自己的来源元素产出**：两条 `weekly_scoped` 行即使 label、reset、`scopeKind` 全同也保持两条，**任何按 `(kind, scopeKind)` 去重都不合格**。缺 `family` 绝不等于 account。
- **已识别但未映射的顶层键（`seven_day_oauth_apps`、`cinder_cove`）不产生任何窗口或观测**：它们的适用范围、period 与 channel 都未经取证，“不是模型窗”也不等于“就是当前请求的全账号窗”，因此**既不按 `account` 也不按 `unknown-scope` 出观测**，只在出现时计一次 `window-key-unsupported` 并计入 `rejectedWindowKeys`，legacy 与旧行为一样忽略。

权威来源：`R/phase34/business-followup/policy-limits-implementation/{contract.md,contract.json,evidence.json}`（v3：69 anchors + `derived.policyRegistry` 34 条）与 `../desktop-coverage-closure/round4/final-review/GF-final.{md,json}`。34 键注册表由 `evidence.json` 生成到 [policy-registry.ts](policy-registry.ts)，未手抄。monitoring notice 两个 helper（`LD`、`Aje`）的原始片段、UTF-16 偏移与 chunk hash 记录在同目录新增的 `final-core-fixes-evidence.json`（原证据未改）。quota 的消费者单位事实来自 `R/phase35/completion-evidence/{quota,CONTRACT.md}` 与 `followup/CONTRACT.md`：顶层窗口 `utilization` 按百分比消费、`limits.percent` 文档注明 0–100、`resets_at` 注明 ISO；**所读声明不含 min/max 与 datetime 校验**，因此 finite/range/ISO 由本模块的应用校验补上，不声称服务端强制范围或所有 wire 保证。

## 所有权边界

| 责任 | 归属 |
|---|---|
| 端点构造、base URL、出口代理选择 | 调用方（本核心接收 `url`） |
| 凭据选择、刷新、CAS 提交 | 调用方的凭据 owner（本核心接收 `accessToken`，最多调用一次注入的 `reauthorize`） |
| 调度、轮询、重试预算之外的恢复 | 调用方（本核心返回 `recoveryOwner: 'caller'`） |
| 判定结果如何限制具体操作、是否执行工具 | 调用方（本核心只返回 `allow`/`deny`/`unsupported` 与固定 reason） |
| 远端 flag、taint 来源、HIPAA 证据 | 调用方注入（本核心不读 GrowthBook、不取生产值） |

## 导出 API

- `parsePolicyLimitsDocument(raw)` → `{ ok, document } | { ok:false, failure }`：按固定 envelope 规范化；`restrictions`（及其 `allowed`）必填，taint 归一化（小写/trim、`^[a-z0-9_-]{1,64}$`、去重、≤16）、monitoring notice、`defaults`、`core_skills`（≤256×128）；未知键 strip。
- monitoring notice：`text` 先按原值判 `≤500`，再按 `LD(text,'',{keepEmojiJoiners:true})` 归一（孤立代理→U+200B、去 ANSI 转义、删控制/格式/私用/未分配/可忽略类与 `U+2028/U+2029/U+2800`，ZWJ/VS15/VS16 保留，仅删位于文首或空白后的 joiner run）；`url` 在 https/`URL()` 检查后再过 `Aje`（控制、`Cf`、`Default_Ignorable_Code_Point`、`U+2028/U+2029/U+2800`、孤立代理、`U+10EEEE` 任一即不合法），不合法只丢 url、保 `{text,url:null}`。
- `policyValidator(raw)` / `canonicalPolicyJson(value)` / `sha256Hex(text)`：对**原始 body** 的规范化 JSON 求 `sha256:<hex>`（对象键递归排序；WebCrypto 优先，Node crypto 兜底）。
- `PolicyLimitsCache`：单快照内存采纳缓存（`adopt/current/live/validator/clear`），签名只留作诊断，不参与采纳，不落盘。
- `evaluateLivePolicy(key, document, taints, inputs?)`：`Fzt` 顺序（hardBlockUnder → 显式 `allowed` → transcript scan → 合并 taint）；transcript scan 步只在传入 `inputs` 且 `transcriptScan && !transcriptScanIgnoresRegistry` 时生效，省略即保持“taint 后答”的旧行为；未注册键 → `unsupported`。
- `evaluateWithoutLivePolicy(key, inputs)` / `policyDenyKind` / `latchedDeny` / `isPolicySettled`：`sn`/`Ch`/`pwn`/`O4r`，输入全部注入（见 `PolicyVerdictInputs`）。
- `readPolicyLimits(operation)`：有界 GET（role headers + Bearer + 条件 `If-None-Match`）、状态分类、`Retry-After`、5 次重试预算、取消；版本/权限拒绝由注入的 `classifyFailure` 决定并保持 terminal（**先于** 401 重放）。
  - `priorContext: 'live' | 'stale' | 'none'`（`PolicyPriorContext`，与消费方 `PolicyLimitsStatus.fallback` 同三态）：缺省推断为“有 validator ⇒ `live`，否则 `none`”，绝不推断为 `stale`。
  - `failOpenOnMissingRoute`（调用方的 `!rustlingOrbit`）只在 `priorContext === 'none'` 时对 `404` 或无条件的 `304` 返回 `fail_open_empty`（`route_missing_fail_open` / `unsolicited_304_fail_open`）；`live`/`stale` 一律返回 `failure`，调用方保留自有缓存与 stale 文档，本核心不读也不清它。`304` 只有在 `live` 且确实带 validator 时才是 revalidation。
- `parseOrgPin(value)` / `validateOrgPin(request)`：pin 为 string 或非空 string[]；**有 pin 才发** bodyless `POST /api/oauth/validate`（Bearer + UA + JSON content-type，10s）；缺失结果 `org_verify_failed`、不匹配 `org_pin_mismatch`、空集合 `invalid_input` 拒绝。
- `parseRawFacts(get)`：**一次**读取整个 `anthropic-ratelimit-unified-*` 家族（成员名与窗口名由本模块导出，插件 wrapper 的 family gate 复用同一份词表），逐成员记 `presence`（`absent` / `present` / `present-zero` / `invalid`）与 `parsedNumber`。缺失与空白都读 `absent`，`Number('')`/`NaN`/`Infinity` **不得变成 0**；文本存在但非有限数值 ⇒ `invalid` 且无 `parsedNumber`（`parsedNumber` 的存在性是唯一有效性判据）。来源没有 `get` 方法即抛错（内部不变量，不属 wire 容错）。
- `projectLegacy(facts, { resolveReset, now })`：产出与插件既有 `UnifiedRateLimitState` 逐字段相同的报告；reset 由注入 port 解析，core 不复制该算法，`observedAt` 取注入的 `now`。
- `projectStrict(facts, { now })`：仅当 member 为有限数值时产出 `ClaudeQuotaObservation[]`；header `utilization` 是 0–1 ratio，**只换算一次**得到 `normalizedPct` 并保留 `unit: 'ratio'`。header reset 只认**本应用选定的 epoch 秒区间**：纯十进制非负整数且 ≤ `CLAUDE_QUOTA_MAX_EPOCH_SECONDS`（`253402300799` = `9999-12-31T23:59:59Z`，RFC3339 四位年的最后一秒；非部署可调、不是服务端限值）才转毫秒；其余（小数、指数、duration、HTTP-date、超界、13 位毫秒量级）一律 `resetFormat: 'unknown'` 且无 instant，**不自动按毫秒重解释**。缺失/invalid **不 clamp 成 0 或 100**。
- `parseRawFacts` 按 member 类型读取：token 字段（`status`/`overage-status`/`representative-claim`/`fallback`/`overage-disabled-reason`/`overage-in-use`/`overage-scope`）与 reset 字段是 `text`/`reset`，文本存在即 `presence:'present'` 并保留 `rawText`——未知 token 由 status projector 读成 `other`，合法 HTTP-date/duration reset 在 legacy 侧照旧可解析；只有 `numeric` 字段（`*-utilization`、`*-surpassed-threshold`）文本非有限数值才是 `invalid`。**不得对全家族泛用 `Number`**。
- `parseUsageJson(body, now, options?)`：`limits` 非空优先于 flat 顶层键。**窗的三种状态分开**：键缺失或显式 `null` = **未被观测**（不计任何 code、不产行、不伪 0）；键上是对象但 `utilization` 缺失/非有限（含 `{}`）= **读不了的窗**，计一次 `percent-missing` 且不产行；键上是有限数值 = 窗存在，按下述两条规则投影。**percent 范围的应用检查只决定 strict 是否 known**：有限但越界 ⇒ **legacy 窗口照旧保留原值**（旧 `claudeLimitsWindows` 只要求有限数值），`wantsStrict` 时不产 observation 并计一次 `percent-out-of-range`；`?? 0` 禁止。上述口径在 flat 与 `limits` 两个分支**同一语义**（`limits` 行以 percent 是否存在/可用为同一判据）。
- `resets_at` 的两个判读来自**同一次读取**：legacy 侧是 `Date.parse` 可解析即出 instant（HTTP-date、`01/02/2026`、被运行时归一化的非法日历 ISO 全部照旧），strict 侧只认本模块验证的 **RFC3339 子集**（`YYYY-MM-DDThh:mm:ss[.fff]` + 强制 `Z` 或 `±HH:MM`，且做真实日历校验，`2026-02-30`、非闰年 `02-29` 均不成立）——不合格的字符串保持 `resetFormat:'unknown'` 且无 instant，**不因此收窄 legacy**。数字一律不算 instant（模型行的数字秒分支不推广）。**未声明（键缺失或显式 `null`）是缺信息而非坏值**：不计 `reset-shape-invalid`、不伪造 date/0；显式 `0` 是有值（epoch 秒 0 = `1970-01-01T00:00:00Z`，是否仍旧由调用方 freshness 判断），与缺失可分。
- `kind` 的闭合枚举 `5h | 7d | 7d_oi | overage | unknown` 是 **header 家族 token 的枚举**（`7d_oi`/`overage` 只来自 header 窗）；usage JSON 侧只会产出 `5h`、`7d` 与未识别 `limits` kind 的 `unknown`。`scopeKind` 才是“覆盖谁”的维度（见上）。未识别顶层键只计入 `unknownTopLevelKeys`（**不另计 issue code、不回显键名**），`display_name` 不进任何 observation 或错误文本。`issues` 的每个 code 各自计一次、互不重复：`window-shape-invalid`、`percent-missing`、`percent-out-of-range`、`reset-shape-invalid`、`limit-kind-unknown`、`window-key-unsupported`。

## 配置行为声明

编译默认 `parseFailureIsTerminal=false`、`refuseFailOpenOnMissingRoute=false`（`DEFAULT_POLICY_VERDICT_INPUTS`）表示：解析失败可重试、404/304 无缓存时 fail-open 空策略。这是**本模块的配置行为**，不声称等于线上取值；线上取值由调用方注入。

## 产品防护声明（有意差异）

`POLICY_LIMITS_BODY_LIMIT`（65536）与 `ORG_PIN_BODY_LIMIT`（8192）是本模块**自有**的 body 字节上界，不是被分析客户端的固定源码常量：其响应体读取没有该常量。超界即 terminal——policy 读为 `unsupported/body_over_limit`（`skipRetry:true`，不再对同一份大文档花掉重试预算），org pin 为 `org_verify_failed/body_over_limit`；两种情况下 body 内容都不会进入 failure、日志或 cause。

`LD` 内的 ANSI 去除对应运行时的 `Bun.stripANSI`（原生内建，fixed raw 内没有它的源码）：本模块按 CSI/SGR、OSC/DCS 等转义序列整体去除，而不是只删掉 ESC 后留下可打印尾巴。**这一步不宣称与 `Bun.stripANSI` 完全等价**——在转义序列之外的行为差异未闭合，需要逐字节对齐时应先补上该内建的源码。原始片段与来源记录在 `R/phase34/business-followup/policy-limits-implementation/final-core-fixes-evidence.json`。

quota 侧同类的有意保留与已知限制：

- **legacy label 保持原兼容行为，未加上界**：`limits` 行的 `display_name` 按响应原样进入 legacy `windows[].scope`，本模块**不**去控制字符、不限定字符集或长度。该值由既有 UI 作为文案直出（React 转义，非注入面）并参与 `w.scope === model` 的既有匹配语义；收窄它会改变已验证的 UI 行为与 model 匹配，未获授权，故**不声称 legacy label 已 bounded**。
- **`seven_day_oauth_apps` 与 `cinder_cove` 被识别但不产生窗口**：二者的适用范围、period 与 channel 均未取证，编出单位或按 `account` 出观测都超出证据。它们在 body 中出现时计一次 `window-key-unsupported` 并计入 `rejectedWindowKeys`，legacy 窗口列表与旧 `claudeLegacyWindow` 一样忽略它们。
- **`unknownTopLevelKeys` 与 `issues` 是两组汇总**：前者只数未识别顶层键，其中的事实不进入 `issues`；两者不得相加。
- **strict 的 ISO 判读是本应用选定的子集，不是服务端保证**：被接受的形状为 `YYYY-MM-DDThh:mm:ss[.fff]` + 强制时区（`Z`/`±HH:MM`）并通过真实日历校验；源客户端对 `resets_at` 只声明“ISO 8601”而不做内容校验，因此**不声称 CC 服务端只发该形状**，也不声称非法日历值在服务端不存在——只是本应用不据此产生 known instant。
- **两处保留的 unknown（不影响上述有限实现）**：payload 行 → 稳定模型身份（`scope.model.display_name` 只是显示名，`Fft`/`Hre` 的名单 membership 不构成 row 绑定），以及 `7d_oi` 的精确服务端分组。两者都不靠猜补齐：本模块只输出 `unknown-scope` 与已证的 family，不发明 ID、不合并窗口。
- **只投影 account 窗的消费方**：`5h`/`7d`（header 与 usage JSON 的对应键）之外的 `model-family`、`7d_oi`、`overage`、`weekly_scoped` 都在**内部保留并按需 withhold**，不得因为载体装不下就删 scope 硬塞成 weekly，也不得用缺字段表示它是 account。

## 未实现（明确缺口）

- WIF 与独立 API key 准入臂、父 Desktop keeper 的 token refresh 及其重试、签名缓存 shadow 线、GF/GrowthBook 源链、trusted-device enrollment 本体、`enforce_web_search_mcp_isolation` 的执行器本体。
- 池的凭据提交、代理、持久状态：归调用方的 `CredentialVault` / worker / `EgressBroker`。
- 不声称服务端行为、`loadFor` 的全部调用者，也不声称任何上线或风控结论。
