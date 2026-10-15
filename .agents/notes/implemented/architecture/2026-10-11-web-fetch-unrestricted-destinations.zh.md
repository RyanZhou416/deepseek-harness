# Agent Note: Web 抓取可到达进程能到达的任何目标

Status: implemented

[English](2026-10-11-web-fetch-unrestricted-destinations.md) | 中文

## Problem

即使请求的是公网网站，TUN 客户端也可能返回并非公网单播的合成 DNS 地址。校验并固定这些地址会把中间路由地址当作最终目标，在 TUN 处理之前拒绝请求。识别某个客户端或 fake-IP 网段无法适应变化的网络配置。公网地址规则也会阻止有意访问本机与私网服务。

## Decision

`@deepseek-ai/dsh-web-fetch-http` 不限制目标地址。提供方经进程的全局 `fetch` 发出每次 `GET`，使用 `credentials: 'omit'`，遵循已安装的代理策略或系统网络。提供方不拒绝 loopback、私有、link-local、unique-local、云 metadata 或 NAT64 转换地址，也不提供地址模式或允许列表。

提供方保留仅 HTTP(S) URL、2,048 字符 URL 上限、内嵌凭据拒绝（`WEB_BLOCKED_URL`）、每跳校验目标的仅同源重定向、匿名请求、字节与字符上限、重定向与超时上限、内容类型校验，以及产品 `User-Agent`。

## 取代与范围

本 note 取代 [web 能力 seam](2026-06-24-web-capability-seam.zh.md) 的公网地址规则，以及[出站代理策略](2026-08-27-outbound-proxy-policy.zh.md) 中代理路径的地址检查例外。两个记录的其余决策保持有效。[FORK_MAINTENANCE.md](../../../../FORK_MAINTENANCE.md#web-fetch-without-destination-restrictions) 记录保留与部署要求。

## Alternatives considered

**识别并豁免 TUN 客户端的 fake-IP 网段。** 否决，因为客户端与配置网段可能变化，单凭地址也无法确定映射目标。这仍依赖特定部署的地址分类，而非正常使用系统网络。

**要求显式 HTTP 代理。** 不作为主要修复，因为它改变应用请求路径，而不是支持运维方已有的纯 TUN 配置。显式代理仍受支持，但不是必需条件。

**丢弃非公网 IPv6 解析结果或强制 IPv4。** 否决，因为合成地址可以使用任一地址族，包括保留 IPv4 网段。过滤 IPv6 可能掩盖一次故障，却既不消除对所选虚拟网段的依赖，也不验证最终目标。

## Consequences

**提供方放弃公网目标隔离。** 模型选定的请求可以读取可达的 loopback、私网与 metadata 服务，或向可达端点发送数据。这是明确接受的代价，而非声称合成地址安全。需要隔离的部署必须通过工具执行策略、网络出站控制或禁用抓取来实现。

**提供方无需 TUN 专属配置。** 进程传输与操作系统决定路由；连接重置、DNS 失败、超时与其他网络错误仍可能发生。

**单一请求路径遵循进程传输。** 提供方既不创建私有 dispatcher，也不自行解析或固定目标地址。

## Testing

`pnpm exec vitest run packages/web/web-fetch-http/tests packages/web/tool-web/tests` 覆盖本机抓取、私网及合成地址交给传输、已配置代理路由，以及保留的限制。[Loader 测试](../../../../packages/web/tool-web/tests/loader-fetch.spec.ts) 加载 [YAML fixture](../../../../packages/web/tool-web/tests/fixtures/cordis.fetch.yml)，观察 loopback 服务器返回的工具渲染输出。源码提供方在报告问题的 TUN 网络下未配置代理，对 `example.com` 与 `github.com` 均得到 HTTP 200。[录制场景](../../../../snapshots/session/web-fetch/snapshot.yml) 使用真实 loopback 传输而不替换 DNS，且已通过 Windows 上的构建产物回放。其测试专用组合排除平台相关的 shell 工具，headless 适配器识别本次运行 workspace 路径的 JSON 引用写法，不放宽其他转录比较。
