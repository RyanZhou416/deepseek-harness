/**
 * Real Windows ACL confinement, when this host can run it.
 *
 * The other sandbox suites replace `ctx.sandbox` with a recording provider,
 * because the platform runner is an external, host-dependent boundary. This
 * suite is the one place that mounts the REAL `dsh-sandbox-local` provider —
 * which selects the ACL restricted-token runner on Windows — and proves the
 * boundary actually denies the interpreter: the same file write succeeds inside
 * the session workspace and fails outside it, and the denied file does not
 * exist afterwards. It self-skips where the runner cannot be constructed (a
 * non-Windows host, or a checkout without the provider's FFI dependency).
 *
 * Availability is probed through the provider package's OWN module resolution:
 * the runner loads `koffi` relative to
 * `packages/sandbox/sandbox-windows-acl`, so resolving from this test directory
 * would report a dependency missing that the provider can in fact load.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as AetherShell from '../src/index.ts'
import { AETHER_FIXTURE, installedInterpreter, sessionAgent, valueOf } from './helpers/harness.ts'

/** The provider manifest the ACL runner resolves its FFI dependency from. */
const ACL_PROVIDER_MANIFEST = fileURLToPath(
  new URL('../../../packages/sandbox/sandbox-windows-acl/package.json', import.meta.url),
)

/**
 * Whether the ACL runner's FFI dependency resolves where the provider loads it.
 * @returns true when the real Windows restricted-token runner can be constructed.
 */
function aclRunnerAvailable(): boolean {
  if (process.platform !== 'win32') return false
  try {
    createRequire(ACL_PROVIDER_MANIFEST).resolve('koffi')
    return true
  } catch {
    return false
  }
}

const available = aclRunnerAvailable()
const interpreter = installedInterpreter()

let context: Context | undefined
const cleanup: string[] = []

afterEach(async () => {
  const owned = context
  context = undefined
  await owned?.fiber.dispose()
  while (cleanup.length > 0) {
    const path = cleanup.pop()
    if (path !== undefined) await rm(path, { recursive: true, force: true })
  }
})

/** A private directory this suite owns and removes. */
async function ownedDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

/** How one mounted ACL harness spawns its interpreter. */
interface AclInterpreter {
  /** Absolute interpreter path, or the bare `ae` name. */
  executable?: string
  /** Trusted argv between the interpreter and its subcommand. */
  executableArgs?: readonly string[]
}

/** Mount the plugin over the REAL local sandbox provider under one policy mode. */
async function setup(
  mode: SandboxMode,
  workspace: string,
  interpreterOptions: AclInterpreter = {},
): Promise<{ call(name: string, args: unknown): Promise<ToolExecutionResult> }> {
  const { default: LocalSandboxProvider } = await import('@deepseek-ai/dsh-sandbox-local')
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
  await ctx.plugin(LocalSandboxProvider)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(AetherShell, {
    executable: interpreterOptions.executable ?? process.execPath,
    executableArgs: [...(interpreterOptions.executableArgs ?? [AETHER_FIXTURE])],
    graceMs: 2_000,
  })
  const agent = sessionAgent(workspace)
  return {
    call: (name, args) => ctx.tools.execute({
      callId: ToolCallId(`acl-${name}`),
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: agent as never,
    }),
  }
}

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(() => true, () => false)

describe.skipIf(!available)('aether-shell under real Windows ACL confinement', () => {
  it('allows a workspace write and denies a write outside it', async () => {
    const workspace = await ownedDir('dsh-aether-acl-ws-')
    const outside = await ownedDir('dsh-aether-acl-out-')
    const mounted = await setup('workspace-write', workspace)

    const allowed = await mounted.call('aether_call', {
      builtin: 'write_probe',
      args: [join(workspace, 'inside.txt'), 'inside'],
    })
    expect((valueOf(allowed)['value'] as { ok: boolean }).ok).toBe(true)

    const deniedTarget = join(outside, 'blocked.txt')
    const denied = await mounted.call('aether_call', {
      builtin: 'write_probe',
      args: [deniedTarget, 'blocked'],
    })
    const deniedValue = valueOf(denied)['value'] as { ok: boolean; error?: string }
    expect(deniedValue.ok).toBe(false)
    // Verify the world, not the self-report: the denied file must not exist.
    expect(await exists(deniedTarget)).toBe(false)
  })

  it('permits the same outside write under danger-full-access', async () => {
    const workspace = await ownedDir('dsh-aether-acl-free-ws-')
    const outside = await ownedDir('dsh-aether-acl-free-out-')
    const mounted = await setup('danger-full-access', workspace)

    const target = join(outside, 'allowed.txt')
    const result = await mounted.call('aether_call', {
      builtin: 'write_probe',
      args: [target, 'allowed'],
    })
    expect((valueOf(result)['value'] as { ok: boolean }).ok).toBe(true)
    expect(await exists(target)).toBe(true)
  })
})

describe.skipIf(!available || interpreter === undefined)('the installed interpreter under real Windows ACL confinement', () => {
  it('writes inside the workspace and is refused outside it', async () => {
    const workspace = await ownedDir('dsh-aether-acl-ae-ws-')
    const outside = await ownedDir('dsh-aether-acl-ae-out-')
    const mounted = await setup('workspace-write', workspace, {
      ...interpreter === undefined ? {} : { executable: interpreter },
      executableArgs: [],
    })

    const insideTarget = join(workspace, 'native-inside.txt')
    const inside = await mounted.call('aether_call', {
      builtin: 'file_write',
      args: [insideTarget, 'native-content'],
    })
    expect(inside.isError).toBe(false)
    const insideValue = valueOf(inside)
    expect(insideValue['kind']).toBe('value')
    // The native write result carries its own facts, not a generic `ok` flag.
    expect(insideValue['value']).toMatchObject({ bytes: 14, path: insideTarget, success: true })
    expect(await readFile(insideTarget, 'utf8')).toBe('native-content')

    const outsideTarget = join(outside, 'native-blocked.txt')
    const refused = await mounted.call('aether_call', {
      builtin: 'file_write',
      args: [outsideTarget, 'native-content'],
    })
    // A confinement denial is not a runner failure: the interpreter ran and the
    // file effect was refused. The ACL runner surfaces that refusal inside the
    // Agent API envelope, so it arrives as the interpreter's own failure; the
    // `denied` arm appears only when the backend's stderr dialect names it.
    expect(refused.isError).toBe(false)
    const refusedValue = valueOf(refused)
    expect(['denied', 'error']).toContain(refusedValue['kind'])
    // The inside write above and the danger-full-access write below both prove
    // the same path shape is writable, so this refusal is the confinement.
    expect(await exists(outsideTarget)).toBe(false)
  })

  it('permits the same native write under danger-full-access', async () => {
    const workspace = await ownedDir('dsh-aether-acl-ae-free-ws-')
    const outside = await ownedDir('dsh-aether-acl-ae-free-out-')
    await writeFile(join(workspace, 'seed.txt'), 'seed')
    const mounted = await setup('danger-full-access', workspace, {
      ...interpreter === undefined ? {} : { executable: interpreter },
      executableArgs: [],
    })

    const target = join(outside, 'native-allowed.txt')
    const result = await mounted.call('aether_call', {
      builtin: 'file_write',
      args: [target, 'native-content'],
    })
    const value = valueOf(result)
    expect(value['kind']).toBe('value')
    expect((value['value'] as { success?: boolean }).success).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('native-content')
  })
})
