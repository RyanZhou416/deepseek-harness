---
description: "Add optional native AetherShell queries, persistent interpreter sessions and background jobs alongside existing DSH shell tools."
kind: "package-bundle"
---

# @ryanzhou416/dsh-plugin-aether-shell

English | [中文](README.zh.md)

## Summary

Let an agent query AetherShell operations, evaluate typed programs, keep one interpreter's native state alive across calls, or run a program in the background. This optional bundle keeps the existing PowerShell and Bash tools unchanged and adds no durable session format. Every interpreter process is a real host process under the calling Session's DSH file policy. AetherShell is an external prerequisite; the plugin does not install or redistribute it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Prerequisites and installation

The plugin targets DSH `0.1.7-rc.1`. The default `legacy` data mode supports the native AetherShell `12.0.2` protocol; `typed-v1` requires the typed-data capabilities provided by the personal `12.0.2+ryan.2` build. Install AetherShell separately and configure its absolute executable path when the Host's existing PATH does not include it. Windows system-level installation can use `C:\Program Files\AetherShell\ae.exe`; changing PATH does not update an already-running Host's environment.

Build and pack from the checkout without installing dependencies:

```powershell
pwsh -NoProfile -File fork-plugins/dsh-plugin-aether-shell/scripts/run-local.ps1 build
pwsh -NoProfile -File fork-plugins/dsh-plugin-aether-shell/scripts/run-local.ps1 pack
```

From the checkout, install the generated tarball with `pnpm dsh plugin --profile <profile> add <tarball> --ignore-scripts` in an isolated Harness home before activating it in the real profile. The bundle inserts one `aether-shell` plugin row and does not disable other shell rows. Back up profile configuration before activation; do not replace an installed artifact while the Host is using it.

### Choose the appropriate tool

| Tool | Input | Lifespan | Purpose |
|---|---|---|---|
| `aether_discover` | Optional exact category or flat builtin name, plus pagination | One call | Retrieve the native category index, a category's operations, or one operation's signature and examples. |
| `aether_call` | Flat builtin name and positional JSON argument array | One call | Invoke one operation without generating AetherShell source. |
| `aether_pipeline` | Ordered native steps and optional JSON input | One call | Filter, project and aggregate typed values in one execution. |
| `aether_eval` | AetherShell source | One call | Evaluate expressions, lambdas and module calls in a fresh process. |
| `aether_session_open` | Optional directory, label and deadline | Until closed | Start one persistent interpreter process and return an opaque session id. |
| `aether_session_eval` | Session id and AetherShell source | One call | Evaluate a program in that process, where variables, functions, the current directory and the environment persist. |
| `aether_session_read` | Session id | One call | Drain output a session wrote while no call was in flight, delivering it once. |
| `aether_session_list` | Optional counters | One call | List this agent's handles with their state and file-policy mode. |
| `aether_session_close` | Session id | One call | Ask the native session to close and terminate its process. |
| `aether_job_start` | AetherShell source, optional label, directory and deadline | Until done or killed | Start one background interpreter process and return its job id immediately. |

The four query tools are stateless and start a fresh interpreter each call. They stay registered whenever the plugin is active, and none of them offers a background flag. The five session tools register while the live-agent registry is mounted, because a handle must belong to a calling agent; `aether_session_read` drains output written between calls, and a call in flight refuses a read because that output belongs to the call. `aether_job_start` registers while the job registry is mounted, with `job_output`, `job_list` and `job_kill` providing the read and stop controls.

Use `aether_discover` before relying on an unfamiliar builtin. Call arguments are positional: `{"builtin":"len","args":[[1,2,3]]}` returns `3`; an array argument occupies one position. Named argument objects are not exposed; pass a record inside the positional array so its fields remain one argument.

A structured pipeline can use `{"input":[{"size":1},{"size":5},{"size":9}],"steps":[{"builtin":"where","predicate":"size > 2","select":"size"}]}` to return `[5,9]`. A predicate supplies the step's lambda instead of positional arguments; a selector appends a projection stage. Use `aether_eval` for explicit module syntax such as `str.upper("hello")` or `[1,2,3] | map(fn(x) => x * 2)`.

### Structured-data compatibility

Set `structuredDataMode: typed-v1` only for an interpreter implementing the typed-data protocol. Before each structured request, the plugin probes `capabilities` under the same DSH file policy and requires protocol version `1` with all three typed-data features. Probe and request share one deadline. A missing, unsupported or failed capability response stops the call before user data is sent; there is no automatic fallback. The default `legacy` mode keeps the interpolation, record-key and null-seed refusals needed by older interpreters.

In verified `typed-v1` mode, `${...}` in JSON strings and non-identifier record keys remain literal data, and an explicit `input: null` seeds a native null. Builtin names remain flat; `predicate` and `aether_eval` are still executable AetherShell source. Unsafe-range integers remain refused in both modes. On the personal runtime, `byte_len("你好")` is `6` and `char_len("你好")` is `2`; `char_len` counts Unicode scalar values, not grapheme clusters, while `len` retains its existing string byte count.

### How the sandbox relates to the real environment

This is not a virtual machine, an emulated shell, or a virtual filesystem. AetherShell is a real program on this host: its operations run as real operating-system work, read and write the real filesystem, reach the real network through their own builtins, and start real child processes. A query tool, a persistent session and a background job all execute in that same real world.

What DSH confines is the interpreter process's file writes and deletes, under the calling Session's current file policy:

- `danger-full-access` leaves file writes and deletes unconfined.
- `read-only` refuses writes and deletes.
- `workspace-write` permits writes and deletes under the session workspace and specific platform temporary areas, and refuses them elsewhere.

The same rule applies to every shell binding, including `pwsh`, Bash and these tools; changing the tool never changes the permission. A denial is final for that call: retrying the same effect through another tool or shell is not a workaround, and this plugin offers no in-turn escalation field.

The policy governs writes and deletes only. It does not isolate file reads, network access, or process-control capabilities, and it is not a general sandbox for what the interpreter may observe or do.

The child environment is the provider's scrubbed parent environment plus the plugin's own settings. That scrub intentionally removes credential-shaped names (`*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`) and inherited `DSH_*` names so harness credentials cannot leak into a child or its output. Ordinary host variables such as `PATH` and `HOME` are expected to survive; the interpreter therefore resolves tools by the Host's real PATH unless deployment configuration pins an absolute executable path.

### Persistent sessions

A session is one real `ae agent interactive` process holding native mutable state: variables, functions, the process-global current directory, and the process environment. That state persists between `aether_session_eval` calls for as long as the process runs, and each handle owns exactly one process whose in-memory state other handles cannot observe.

A session operates on the real host filesystem, so files it writes persist and other processes can observe them; only its own variables, functions and environment are per-process. The process itself keeps no session checkpoint on disk and nothing is replayed when a session is reopened.

Sessions are private to the agent that opened them. The deployment caps how many one agent may hold, and an idle session is closed automatically. The handle reports the file policy it was opened under, and every request re-resolves the caller's policy first. If that policy changed since the session opened, the session is closed rather than run with stale privileges, and `aether_session_list` reports that handle as destroyed. Closing an unknown id changes nothing; another agent's session is refused.

A deadline or cancellation terminates the whole session process, because the interpreter cannot abandon a running command. A session whose interpreter exits on its own is dropped. Neither case reopens or replays the session; open a new one to continue under the current policy. A program that fails partway leaves what earlier statements in that call already did in place: partial effects and bindings are not rolled back.

### Background jobs

`aether_job_start` starts one fresh interpreter process for one program and returns its job id immediately. It is the streaming counterpart of `aether_eval`: the program travels the interpreter's own command line, its raw stdout and stderr stream into the job's output ring, and no result document is read, so a program that prints logs, mixed JSON, or nothing at all still completes. Read the streams with `job_output`; the canonical exit facts and any spill file arrive with the first read after settlement. `job_kill` requests a stop and settlement follows managed-process cleanup, so a kill does not block and may settle after it returns.

The job belongs to the session that started it and is stopped when that session's agent is disposed or the plugin unloads. Its job uses the DSH file policy as it stood when the job started, whereas a persistent session re-evaluates the policy on every command and is invalidated by a change. A job's process is fresh and separate from any persistent session: variables, functions and directory changes never carry between them, and no combined session-plus-background mode is offered.

A job runs without a deadline unless the deployment caps job runtime or the call supplies `timeoutMs`. The default deployment imposes no ceiling, so a program that never finishes runs until `job_kill` or the owner's disposal stops it. Output a program's own children produce through the interpreter's process builtins may be captured by the interpreter until it returns that output, so realtime child logs are not promised.

### Execution and permissions

Query calls and session commands have explicit working directories and deadlines; background jobs have a deadline only when the call or deployment supplies one. The plugin clears inherited `AETHER_*` and `AE_*` control variables and uses its own configured runtime settings; DSH remains the permission authority. `sh()` starts disabled unless deployment configuration enables it. This startup setting is not a process-execution security boundary: other process builtins and expression code can change interpreter state, while DSH file policy still governs their file effects.

The response distinguishes a value, a native error, a file-sandbox denial, and an interruption. Interpreter exit facts and bounded stderr remain separate. Native API failures can occur with process exit zero. A returned application record containing `success:false` is ordinary data, not automatically a tool failure. AetherShell's child-program result remains inside that value; the interpreter's exit code is not the child's exit code.

### Configuration

Override the bundle's `aether-shell` row in the profile patch. The executable may be an absolute path or a bare PATH name; relative paths containing separators are rejected.

| Field | Default | Meaning |
|---|---|---|
| `executable` | `ae` | Native interpreter path or name. |
| `executableArgs` | `[]` | Trusted argv prefix; offline tests use it for their external-runtime fixture. |
| `mode` | `human` | `human` preserves typed native JSON; `agent` explicitly opts into AECON and AetherShell's additional native approval rules. |
| `structuredDataMode` | `legacy` | `legacy` keeps older data guards; `typed-v1` requires a successful capability probe before forwarding typed JSON data. |
| `allowShell` | `false` | Enable the interpreter's `sh()` builtin without changing DSH file policy. |
| `timeoutMs` / `maxTimeoutMs` | `120000` / `600000` | Default and maximum per-call hard deadlines. |
| `maxRequestBytes` | `1048576` | Encoded request or source byte cap. |
| `maxOutputBytes` / `maxSpillBytes` | `262144` / `8388608` | Per-stream memory and full-stream spill caps. |
| `maxResultBytes` | `65536` | Complete canonical result and model-rendered response cap. |
| `graceMs` | `3000` | Managed-process cleanup grace. |
| `maxManifestEntries` | `64` | Discovery page-size cap. |
| `maxExpressionChars` | `4096` | Per-step predicate length cap. |
| `maxSessionsPerOwner` | `4` | Live persistent sessions one agent may hold. |
| `sessionIdleTimeoutMs` | `1800000` | Close a session idle this long; `0` disables idle expiry. |
| `sessionStartupTimeoutMs` | `30000` | Deadline for creating and handshaking one persistent interpreter. |
| `maxBackgroundRuntimeMs` | `0` | Cap on one job's total runtime; `0` imposes no ceiling. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [bundle patch](cordis.patch.yml) loads the named Host plugin in [src/index.ts](src/index.ts). Discovery, calls and pipelines use the interpreter's local JSON request API through stdin. Expression evaluation uses deterministic command-line output because that path registers AetherShell's module namespaces. Persistent sessions add the interpreter's own `sess_*` builtins over a long-lived `ae agent interactive` process, and background jobs run one program per fresh process through the job registry. Every path uses DSH subprocess and sandbox services directly rather than registering another `ctx.shell` provider or starting an HTTP/MCP server.

The tool registry owns permission hooks and durable call/result events. The plugin owns request validation, protocol decoding, complete-result bounds, hard deadlines, session and job ownership, and unload cleanup. It does not publish an invariant companion: its requests and returned outcomes are read directly, with no independent persistent state projection.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [AetherShell upstream](https://github.com/nervosys/AetherShell) — interpreter syntax and native operations.
- [DSH tool authoring](../../docs/cookbook/adding-a-tool.md) — canonical results and policy hooks.
- [Fork maintenance](FORK_MAINTENANCE.md) — preservation and verification requirements.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through ten registered tools whose declarations, ownership and policy guidance the model reads on every request.

#### KV Cache effect

The tool declarations and their guidance form a stable request prefix for one composition, so they preserve an already-reusable prefix while the declarations are unchanged. Results append per-call context, and opening a session records durable result metadata carrying the opaque session id, which replays from the log without running the interpreter again. Renaming a tool, changing `inject` gating, or editing a description can change the assembled prefix and invalidate reuse.

## Known Limitations and Deferred Work

- Query calls are foreground-only with hard deadlines. A persistent session is the only way to keep native state between calls, and a background job is the only way to outlive a call's deadline.
- A session's listed working directory is the initial directory its process started in. A program that changes the current directory changes the process's real `pwd()` while the listed value stays the start directory; read the process's own `pwd()` when the current directory matters.
- A session's code state is never durable. A restart, a plugin unload, a deadline, cancellation, or a policy change loses the session's in-memory variables, functions and environment; files the program wrote remain, but there is no automatic reopen, replay, or history. Background jobs share the same no-checkpoint rule.
- A denied call has no in-turn sandbox escalation fields; a user must change the Session's permission policy explicitly if broader file access is intended.
- Older native APIs interpolate `${` strings, emit record keys unquoted and treat a null pipeline seed as omitted. `legacy` refuses those inputs; verified `typed-v1` forwards them as typed data. Session programs retain their caller-written interpolation through encoded source, and background programs use the command line without an added wrapper.
- Calls and pipelines accept flat builtin names, not module expressions. Use `aether_eval` or a persistent session for module syntax. Unsafe-range numeric integers are rejected rather than silently rounded; request large integers as text.
- Printing to stdout or launching children that inherit stdout can contaminate a query tool's single-JSON response; that tool reports a protocol error rather than extracting a plausible result. Background jobs read raw streams and are not affected, but their output is unstructured text.
- Oversized output is not parsed from a truncated tail. A surviving spill file is reported when available; otherwise narrow the query with native projection, filtering or `take`.
- Runtime-specific builtin semantics are separate from typed transport. The personal build preserves JSON null round trips and offers explicit byte/scalar length operations; older releases may retain different builtin behavior.

<a id="dev-note"></a>
### Dev Note

None.
