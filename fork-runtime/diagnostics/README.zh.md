# Windows 内存诊断

[English](README.md) | 中文

## 概要

本 fork 的 `run.cmd` 通过[配置覆盖层](cordis.patch.yml)自动记录内存证据。每个 Host 都写入独立的 `DSH_DIAGNOSTICS/memory-runs/run-*` 目录。探针使用进程内部 Inspector 会话，不开放调试端口。Session 文件和设置保持不变。

## 配置

启动 `run.cmd` 前可编辑覆盖层的完整 `config` 映射。将 `snapshots` 设为 `false` 可保留采样并关闭完整快照。正常采样间隔为 30 秒。存活分配剖面的采样间隔为 1 MiB，每两分钟保存一次；四份至多 32 MiB 的文件轮转。事件日志按每次运行四份 16 MiB 文件轮转。这些限制按运行实例计算；旧运行目录不会自动删除。旧 watchdog 和所有权日志使用各自配置。

完整快照会暂停 Host，并临时增加内存占用。每次激活最多尝试两份：30 秒后的基线，以及堆增长 768 MiB 后的增长快照；被追踪的已销毁对象存活至少 60 秒且经历两次已观测 major GC，也能触发增长快照。采集要求已用堆不超过 1.5 GiB、总堆不超过 2 GiB，且可用 RAM 和磁盘空间均至少达到总堆的四倍加 2 GiB。准入检查还限制本探针所有运行目录的快照预算为 8 GiB。该预算使用相同的预留估算，并非 V8 实际快照大小或暂停时长的硬上限。跳过采集时记录原因，失败的采集也消耗一次尝试。

## 证据与解读

`manifest.json` 记录 Node 与平台、配置、代码版本、修改文件数、探针哈希，以及可用的本机 profile 和插件指纹。`events.ndjson` 包含内存、major/minor GC 累计次数、事件循环延迟、活跃资源数量和有上限的 Agent/Session 生命周期观测。追踪 ID 为匿名编号。追踪使用弱引用；采样只保留标量元数据。最多追踪 10,000 个对象及 64 个最早销毁对象的详情。`droppedTracking` 表示计数不完整。活跃 Session 事件数和销毁时事件数描述工作负载，不表示留存字节；Agent 与 Session 计数存在重叠。

使用 Chrome DevTools 的 Memory 面板打开 `allocations-*.heapprofile`，以及可用的 `baseline.heapsnapshot` / `growth.heapsnapshot`。比较存活分配和强引用保留路径，再将快照中的弱引用追踪记录与生命周期 ID、GC 年龄关联。分配剖面提供采样调用栈，堆快照提供引用图。采样元数据与 JSON 序列化的开销不受输出文件大小限制。仅靠弱引用观测和分配调用栈不能识别全部持有者。在早期快照窗口之后才发生的泄漏，可能仍需专门复现。

快照和剖面可能包含私有运行内容与路径，应留在本机，禁止提交。删除原始快照会永久丢失其完整引用图；清理旧证据时应保留报告和删除清单。探针不会重启 Host。

## 验证

运行 `pnpm exec vitest run scripts/fork-memory-lifetime.spec.ts scripts/fork-memory-recorder.spec.ts scripts/fork-windows-launchers.spec.ts`。测试在新子进程中验证真实 GC 和内部 Inspector 采样、资源限制、两次采集上限、生命周期触发采集、退出竞态和 Windows 启动参数传递。完整快照限制使用合成夹具验证。部署验证还需通过受支持的 `dsh web` 入口，在独立数据目录和随机端口上启动并正常退出；仅配置展开不能验证插件激活。
