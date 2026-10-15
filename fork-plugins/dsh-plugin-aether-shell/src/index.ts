/**
 * AetherShell tools for DeepSeek Harness.
 *
 * This plugin is optional and additive: it registers native query tools,
 * owner-scoped persistent interpreter sessions, and background jobs beside the
 * harness's own shell tools. An agent that already has `pwsh` gains typed,
 * structured execution without replacing that binding. It is
 * not a PowerShell wrapper and not an MCP server — it speaks the interpreter's
 * own Agent API and command line directly.
 *
 * | Tool | Native request |
 * |---|---|
 * | `aether_discover` | `call ontology_manifest` / `call ontology_describe` |
 * | `aether_call` | `call <builtin>` |
 * | `aether_pipeline` | `pipeline` |
 * | `aether_eval` | `ae --deterministic -c <code>` |
 *
 * The deployment owns the permission decision, and the DSH sandbox is the
 * authority behind it. Every child runs under the calling session's resolved
 * policy, receives an environment in which all ambient `AETHER_*`/`AE_*` control
 * settings are cleared, and never relies on the interpreter's own workspace
 * jail. The interpreter's `sh` switch starts off as a convenience default, not
 * a boundary: an interpreted program can change its own environment and reach
 * the process builtins whatever that default is, and this plugin does not
 * attempt to blacklist them — raw `aether_eval` is deliberately broad.
 *
 * That policy is a file-effect policy: it constrains what the confined child
 * may write or delete under the resolved mode, and it does not isolate file
 * reads, network access, or process control. A denial is the only answer this
 * release gives; there is no in-turn escalation path.
 *
 * Activation requires `tools`, `subprocess`, `sandbox`, and `sandboxPolicy`;
 * the loader starts this plugin only once all four exist. `shellEnv` is
 * optional and read per call, so the managed `DSH_*` facts are present exactly
 * when that registry is mounted.
 *
 * The four query tools use fresh processes under hard deadlines. Persistent
 * tools exist while the live-agent registry is mounted; each handle owns one
 * long-lived interpreter and its native in-memory state, without command replay
 * or restart recovery. Background execution exists while the job registry is
 * mounted, with ownership and output retrieval supplied by that registry.
 * Every managed range is terminated and awaited on its lifetime's cleanup.
 * When the provider cannot prove quiescence, the plugin reports cleanup failure
 * rather than claiming the interpreter or its descendants stopped.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.ts'
import type { Config } from './config.ts'
import { AetherProcesses, createExecutableResolver } from './exec.ts'
import { createAetherTools } from './tools.ts'
import { createAetherBackgroundTool } from './background.ts'
import { createAetherSessionTools } from './session-tools.ts'

/** Plugin identity registered with the Cordis loader. */
export const name = 'aether-shell'

/**
 * Required services. The loader keeps this plugin pending until every one is
 * mounted, so a composition without confinement or a subprocess provider never
 * registers these tools at all.
 */
export const inject = ['tools', 'subprocess', 'sandbox', 'sandboxPolicy']

export { Config } from './config.ts'

/**
 * Load native query tools and conditionally add owned sessions and background
 * jobs while their required services are mounted.
 * @param ctx - the plugin context that owns every registration.
 * @param config - deployment configuration; omitted fields take their defaults.
 * @throws Error when a configured budget or path cannot be run with.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const processes = new AetherProcesses((message: string) => { ctx.logger.warn(message) })
  // Session disposers register later so they close their streams before this
  // final process-range cleanup runs.
  ctx.effect(() => () => processes.dispose(resolved.graceMs), 'aether-shell.processes')
  const dependencies = {
    ctx,
    config: resolved,
    processes,
    resolveExecutable: createExecutableResolver(ctx.subprocess, resolved.executable),
  }
  for (const tool of createAetherTools(dependencies)) ctx.tools.register(tool)

  ctx.inject(['agents'], (scope) => {
    const { sessions, tools } = createAetherSessionTools({ ...dependencies, ctx: scope }, {
      maxSessionsPerOwner: resolved.maxSessionsPerOwner,
      sessionIdleTimeoutMs: resolved.sessionIdleTimeoutMs,
      sessionStartupTimeoutMs: resolved.sessionStartupTimeoutMs,
    })
    scope.effect(() => () => sessions.dispose(), 'aether-shell.sessions')
    for (const tool of tools) scope.tools.register(tool)
  })

  ctx.inject(['jobs'], (scope) => {
    scope.tools.register(createAetherBackgroundTool({ ...dependencies, ctx: scope, jobs: scope.jobs }, {
      ...resolved.maxBackgroundRuntimeMs === 0 ? {} : { maxRuntimeMs: resolved.maxBackgroundRuntimeMs },
    }))
  })
}

export { callTimeout, resolveConfig } from './config.ts'
export { AETHER_MODES } from './config.ts'
export type { AetherMode, ResolvedConfig } from './config.ts'
export { projectOntology } from './discovery.ts'
export type { AetherDiscoverOutcome, AetherDiscovery, AetherDiscoveryShape, AetherOntologyPage } from './discovery.ts'
export { describeError, toolAborted } from './errors.ts'
export { AETHER_TIMEOUT_CODE, aetherEnvironment, AetherProcesses as AetherProcessRegistry, createExecutableResolver as createAetherExecutableResolver, runAether } from './exec.ts'
export type { AetherExecDeps, AetherInvocation, AetherPreparation, AetherRunRequest } from './exec.ts'
export { applyResultLimit, RESULT_LIMIT_CODE } from './limit.ts'
export { jsonKindOf, stripRequestEcho } from './outcome.ts'
export type {
  AetherDeniedOutcome,
  AetherDiagnostics,
  AetherErrorOutcome,
  AetherFailure,
  AetherInterruptedOutcome,
  AetherOutcome,
  AetherProcessFacts,
  AetherSandboxFacts,
  AetherValueOutcome,
} from './outcome.ts'
export { AetherProtocolError, decodeEnvelope, decodeEvalOutcome, decodeFailure, toOutcome } from './protocol.ts'
export type { AetherNativeEnvelope } from './protocol.ts'
export { renderDiscovery, renderOutcome } from './render.ts'
export {
  assertEvalCode,
  assertFlatBuiltin,
  assertPredicate,
  assertRequestBytes,
  assertSafeData,
  assertSelectPath,
  callRequest,
  encodeRequest,
  evalArgv,
  ontologyDescribeRequest,
  ontologyManifestRequest,
  pipelineRequest,
} from './request.ts'
export type { AetherPipelineStep, AetherRequest } from './request.ts'
export { createAetherTools } from './tools.ts'
export type { AetherToolDependencies } from './tools.ts'
