# Agent Note: Windows 普通子进程使用私有控制台

Status: implemented

[English](2026-09-14-windows-subprocess-console-isolation.md) | 中文

## Problem

Windows 控制台控制事件会送达附着在发送者控制台上的进程，而不受 Job Object 成员关系限制。继承 Harness 控制台的 agent 命令可以向组零广播 `CTRL_C_EVENT`，从而中断 Harness 宿主。现有 Job owner 能约束后代并观察完全停稳，却不能分离控制台。

## Decision

`LocalSubprocessRuntime.spawn()` 要求普通 Windows 命令使用原生 Job runner。受信任的 runner 以 `CREATE_NEW_CONSOLE` 暂停创建目标，通过 `STARTF_USESHOWWINDOW`/`SW_HIDE` 隐藏该控制台，把目标加入关闭即终止成员的 Job，再恢复执行。目标的 stdin、stdout、stderr 继续使用既有继承句柄。runner 自身的 IPC 与标准流留在目标控制台之外。

当目标是非受限的 Windows ACL 沙箱 runner 时，它的受限令牌子进程继承目标控制台。受限子进程不直接使用 `CREATE_NEW_CONSOLE`：该标志在受限令牌下会使 DLL 初始化失败。在 `ctx.subprocess` 之外直接调用 `AclSandbox` 的调用方仍须自行分离父控制台。

如果无法选用原生 Job runner，普通 Windows spawn 会在执行命令前拒绝。直接使用 Node/taskkill 的 fallback 否则会继承宿主控制台。Windows 终端保留独立的 `node-pty` 伪控制台路径，而不改用普通管道语义。

## Alternatives considered

**让 Harness 宿主忽略 Ctrl+C。** 未采用，因为这会改变操作者关闭方式，也不会隔离送往其他宿主控制台进程的事件。

**仅使用 `CREATE_NEW_PROCESS_GROUP`。** 未采用，因为组零 `CTRL_C_EVENT` 仍会送达所有附着进程，而新进程组还会禁用该组接收 Ctrl+C。

**让普通命令脱离控制台或不创建控制台。** 未采用，因为 `pwsh` 使用控制台编码 API，Node 的隐藏 detached 启动经实测没有控制台；受限子进程使用 `CREATE_NO_WINDOW` 也会初始化失败。

**在受限子进程上创建控制台。** 未采用，因为 Windows ACL 令牌的 DLL 初始化会以 `STATUS_DLL_INIT_FAILED` 失败；非受限 runner 可以在应用该令牌前建立控制台。

**保留普通 Windows fallback。** 未采用，因为其较弱的进程树保证不能成为共享控制台路径可能终止 Harness 宿主的理由。

## Consequences

普通 agent 命令的控制台级 Ctrl+C 被限定在命令自己的控制台内，受限子进程继承控制台时亦然。代价是每条普通 Windows 命令有一个隐藏控制台，并在原生 runner 不可用时明确报错。这防止共享控制台事件意外误伤，但不阻止拥有足够 OS 权限的其他进程故意终止 Harness。

## Verification

Win32 单元测试固定创建标志、隐藏启动状态、标准流句柄，以及受限令牌路径不带新控制台标志。Windows 原生测试观察普通与受限目标的控制台身份不同，仅在确认分离后发送真实组零 `CTRL_C_EVENT`，再执行后续命令，并覆盖独立的终端伪控制台。未隔离负控拒绝发信号并以非零码退出。

## Related

[原生子进程 owner 决策](2026-08-28-subprocess-native-containment.zh.md)继续拥有 Job 与范围停稳机制。[Windows ACL 沙箱决策](../feature/2026-08-08-windows-acl-restricted-token-sandbox.zh.md)继续拥有受限令牌与文件写入策略。
