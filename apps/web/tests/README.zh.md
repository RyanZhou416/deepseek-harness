# apps/web 浏览器 e2e

[English](README.md) | 中文

这些测试在进程内启动真实的 web 组合，并用真实浏览器通过真实 HTTP 驱动它。Chromium 运行整个 lane；[模型与推理强度选择场景](declared-reasoning.e2e.ts) 还在 WebKit 中运行，以覆盖原生鼠标焦点行为。该 lane 的运行机制——模式、fixture（测试前置数据）、golden，以及与 `dsh web` 之间刻意保留的组合差异——记录在 [`scaffold.ts`](scaffold.ts) 和 [浏览器 e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.zh.md) 中。

安装工作区依赖后，在仓库根目录安装浏览器及其系统依赖：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend exec playwright install --with-deps chromium webkit
```

在 Linux 上，`--with-deps` 会通过系统包管理器安装依赖。持久化 CI VM 必须通过镜像维护提供这些依赖，CI 只安装浏览器程序，遵循[故障切换手册](../../../.agents/notes/implemented/process/2026-07-26-ci-failover-runbook.zh.md)的要求。

普通场景以没有已登记 Workspace 或 Session、但持久化标记记录默认 Workspace 已被删除的状态启动，使显式文件夹选择场景自行决定 cwd。`launchWebScaffold({ firstUse: true })` 保留初始化资格，供启动场景使用。

## 手动负载诊断

`complex-history.perf.ts` 由 `vitest.web.perf.config.ts` 运行，报告大工作区与历史记录开销、八轮续接和浏览器连续 100 轮运行。合成历史在用户消息之前保留当前格式的 system 头。工作区场景检查全部持久化会话、五行预览和隐藏数量；Trajectory 表格按需挂载行，因此使用逻辑行数计量。实时工具轮次执行平台内置 Shell（Windows 使用 `pwsh`，其他平台使用 `bash`），并断言返回标记。GC 检查点测量浏览器堆、DOM 节点和监听器；测试保留所观察的 Session 事件，因此测试 Host 的 RSS 不能用来判断产品内存留存。

`../stress-tests/subagent-reconnect.stress.ts` 由 `vitest.web-stress.config.ts` 运行：八个真实可续接子代理按节奏生成合成输出，同时关闭并恢复真实 WebSocket。它检查草稿与标题保留、完整持久化子代理输出、唯一生命周期事件和子代理释放，并报告真实键盘输入及恢复耗时，不新增时间预算。两项诊断都使用私有临时数据、从源码加载的 Host 和已构建 Client 产物，不包含远程模型延迟。

可设置 `DSH_PERF_CAPTURE=1`，单独诊断默认窗口或完全展开的续接场景。第一轮会把浏览器 CPU 剖面、Chrome 时间线、Host CPU 剖面及可用源码映射写入 `tmp/runtime-profiles/`。采集使用进程内 Node inspector 会话，不开放监听端口。录制前先定位发送按钮，录制时只检查最近消息节点；启用剖面的耗时包含诊断开销，必须与普通基准样本分开。

## 完成状态观察

插件配置测试选择当前平台启用的 Shell，并验证其内置超时默认值、保存后的覆盖值和恢复后的默认值。未启用 Shell 的 Loader 行不能证明实时配置更新生效。

依赖状态的用例使用 Workspace、接纳、附件和模型流屏障，区分可见中间状态与已完成操作。详情关闭等待框架过渡结束；归档验证为 seed Session 设置显式标题，并跨重载跟踪该身份。参见 [CI fixture 同步决策](../../../.agents/notes/implemented/testing/2026-09-08-ci-completion-observations.zh.md)。

显式滚动使用 `support.ts` 的 `scrollIntoView`：旧元素脱离 DOM 时重新解析 locator，并在同一个浏览器任务中检查连接状态、执行原生滚动。各场景保留滚动后的可见性与几何断言。

## 这些是 Host 面的测试

它们在根 `tsconfig.host.json` 中做类型检查，而不在 Client aggregate 中，因为它们直接读取 Host 服务：`ctx.connection`、Host 侧 `SessionStore` 与 `ctx.sessionProjectionCache`。运行时驱动浏览器并不使一个文件成为 Client 程序的一部分——两个 face 在相同的键上以不同服务合并 Cordis `Context`，因此单个程序无法同时看见两者。把这些文件挪进 Client aggregate 会让每一处 Host 服务访问都无法编译。

## 不要在此 import `@deepseek-ai/dsh-client-*`

import 一个 Client 包——无论值还是类型——都会把它整个 TypeScript 工程、以及它引用的每个工程拉进 **Host 构建图**。这已经坑过本 lane 一次：四个 Client 消费方包引用了 `api/remotes` 的 Client face，而该 face 必须等 Host tsdown 生成 `@deepseek-ai/dsh-goal/remote` 之后才能编译，于是 Host 构建阶段变成在等一个由它自己产出的产物。

当某个场景需要 Client 持有的常量或纯函数时，改为在此处镜像一份，并紧挨着一条注释掉的 import 点明源模块。这样漂移会表现为选择器未命中或镜像值陈旧——是响亮的失败，绝不会是静默通过。`scaffold.ts` 按此规则镜像 welcome-notice 的 namespace、确认字段、版本和被断言的中文文案。

built-client harness 是例外。`assembled-boot.ts` import `AppWebEntry`、boot manifest（元数据清单）类型与 `RemoteMock`；`assembled-remote.ts` import Client test runtime 的默认响应与 `RemoteMock`。这些包是显式的工程引用，用于通过测试持有的 carrier 启动真实 shell。chat 场景仍在 `support.ts` 中镜像 `conversationContextKey`，而不 import 其 Client owner。

没有任何机制强制这条规则；靠 review 守住它。
