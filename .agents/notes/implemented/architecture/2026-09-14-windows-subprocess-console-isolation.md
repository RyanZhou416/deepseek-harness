# Agent Note: Windows ordinary subprocesses use private consoles

Status: implemented

English | [中文](2026-09-14-windows-subprocess-console-isolation.zh.md)

## Problem

A Windows console-control event targets processes attached to the sender's console, independently of Job Object membership. An agent command that inherits the Harness console can broadcast `CTRL_C_EVENT` to group zero and interrupt the Harness host. The existing Job owner contains descendants and observes quiescence but does not separate consoles.

## Decision

`LocalSubprocessRuntime.spawn()` requires its native Windows Job runner for ordinary commands. The trusted runner creates the target suspended with `CREATE_NEW_CONSOLE`, hides that console through `STARTF_USESHOWWINDOW`/`SW_HIDE`, assigns the target to its kill-on-close Job, and resumes it. Target stdin, stdout, and stderr retain their existing inherited handles. The runner keeps its own IPC and standard streams outside the target console.

When the target is the unrestricted Windows ACL sandbox runner, its restricted-token child inherits the target console. The restricted child does not receive `CREATE_NEW_CONSOLE`: that flag under the restricted token fails DLL initialization. A direct `AclSandbox` caller outside `ctx.subprocess` remains responsible for its own parent-console separation.

If the native Job runner cannot be selected, an ordinary Windows spawn rejects before executing the command. The direct Node/taskkill fallback would otherwise inherit the host console. Windows terminals retain their separate `node-pty` pseudoconsole path rather than adopting ordinary pipe semantics.

## Alternatives considered

**Ignore Ctrl+C in the Harness host.** Rejected because it changes operator shutdown and does not separate signals sent to other host-console processes.

**Use only `CREATE_NEW_PROCESS_GROUP`.** Rejected because group-zero `CTRL_C_EVENT` still reaches every attached process, while a new process group disables Ctrl+C delivery to that group.

**Detach ordinary commands or remove their console.** Rejected because `pwsh` uses console encoding APIs and Node's detached hidden launch was observed without a console; the restricted child also fails initialization with `CREATE_NO_WINDOW`.

**Create the console on the restricted child.** Rejected because the Windows ACL token's DLL initialization fails with `STATUS_DLL_INIT_FAILED`; the unrestricted runner can establish the console before applying that token.

**Retain the ordinary Windows fallback.** Rejected because its weaker process-tree guarantee cannot justify a shared-console path that can stop the Harness host.

## Consequences

An ordinary agent command's console-wide Ctrl+C stays inside that command's console, including when a restricted child inherits it. The cost is one hidden console per ordinary Windows command and a fail-closed error when the native runner is unavailable. This prevents accidental shared-console control events, not deliberate termination of the Harness process by another process with sufficient OS authority.

## Verification

Win32 unit tests pin the creation flags, hidden startup state, stdio handles, and restricted-token path without a new-console flag. Native Windows tests observe distinct console identities for ordinary and restricted targets, send real group-zero `CTRL_C_EVENT` only after confirming separation, run a follow-up command, and exercise the independent terminal pseudoconsole. The unisolated negative control refuses to send the event and exits nonzero.

## Related

The [native subprocess owner](2026-08-28-subprocess-native-containment.md) retains Job and range-settlement ownership. The [Windows ACL sandbox decision](../feature/2026-08-08-windows-acl-restricted-token-sandbox.md) retains restricted-token and file-write policy ownership.
