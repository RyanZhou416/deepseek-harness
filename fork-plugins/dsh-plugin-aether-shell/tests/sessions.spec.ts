/**
 * Persistent AetherShell sessions.
 *
 * The framing, encoder, and correlation cases are pure and always run. The
 * session cases run against the real installed interpreter, because the
 * behavior under test is the interpreter's own process-local mutable state: a
 * fixture would prove nothing about whether state actually survives between
 * requests. They self-skip on a host without the interpreter.
 *
 * Every session case observes a real interpreter process. Deadlines are kept
 * short and every harness is disposed in `afterEach`, which terminates and
 * joins the process registry, so a failing assertion cannot leave an
 * interpreter behind for the next case.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createSessionHarness, installedInterpreter, text, valueOf } from './helpers/sessions-harness.ts'
import type { SessionHarness } from './helpers/sessions-harness.ts'
import {
  AetherSessionDecoder,
  classifySessionReply,
  encodeAetherStringLiteral,
  sessionNonceWrapper,
} from '../src/session-protocol.ts'

/** The installed interpreter, or undefined on a host without one. */
const interpreter = installedInterpreter()

let harness: SessionHarness | undefined

afterEach(async () => {
  const owned = harness
  harness = undefined
  await owned?.dispose()
})

/**
 * Mount the session tools against the installed interpreter.
 * @param options - harness overrides; the interpreter is always the real one.
 * @returns the mounted harness.
 */
async function setup(options: Parameters<typeof createSessionHarness>[0] = {}): Promise<SessionHarness> {
  harness = await createSessionHarness({
    ...options,
    config: { ...options.config, ...interpreter === undefined ? {} : { executable: interpreter } },
  })
  return harness
}

/** Open a session through the real tool and return its opaque id. */
async function openSession(mounted: SessionHarness, owner: Agent, args: Record<string, unknown> = {}): Promise<string> {
  const opened = valueOf(await mounted.call('aether_session_open', args, { agent: owner }))
  expect(opened['kind']).toBe('opened')
  return String(opened['session_id'])
}

/** Evaluate one program through the real tool, returning its canonical value. */
async function evaluate(
  mounted: SessionHarness,
  owner: Agent,
  sessionId: string,
  code: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return valueOf(await mounted.call('aether_session_eval', { session_id: sessionId, code, ...extra }, { agent: owner }))
}


/** Run one call that must fail, returning its model-visible failure text. */
async function failure(mounted: SessionHarness, name: string, args: unknown, owner: Agent, signal?: AbortSignal): Promise<string> {
  const result = await mounted.call(name, args, { agent: owner, ...signal === undefined ? {} : { signal } })
  expect(result.isError).toBe(true)
  return text(result)
}

describe('aether session string-literal encoding', () => {
  it('escapes exactly the sequences the interpreter recognizes', () => {
    expect(encodeAetherStringLiteral('plain')).toBe('"plain"')
    expect(encodeAetherStringLiteral('a"b')).toBe('"a\\"b"')
    expect(encodeAetherStringLiteral('a\\b')).toBe('"a\\\\b"')
    expect(encodeAetherStringLiteral('a\nb')).toBe('"a\\nb"')
    expect(encodeAetherStringLiteral('a\rb')).toBe('"a\\rb"')
    expect(encodeAetherStringLiteral('a\tb')).toBe('"a\\tb"')
  })

  it('rewrites every dollar as an interpolation that yields one literal dollar', () => {
    expect(encodeAetherStringLiteral('$')).toBe('"${\'$\'}"')
    expect(encodeAetherStringLiteral('a${b}c')).toBe('"a${\'$\'}{b}c"')
  })

  it('keeps non-ASCII text whole, including a surrogate pair', () => {
    expect(encodeAetherStringLiteral('café 中文 😀')).toBe('"café 中文 😀"')
  })

  it('builds a wrapper whose tokens are escaped and whose call is spliced verbatim', () => {
    expect(sessionNonceWrapper('n1', 'sess_open()')).toBe('try { {nonce:"n1",ok:true,value:sess_open()} } catch e { {nonce:"n1",ok:false,error:e} }')
  })
})

describe('aether session stdout framing', () => {
  /** A decoder with the given budgets, defaulting to roomy ones. */
  const decoder = (maxFrameBytes = 4_096, maxDiagnosticBytes = 1_024): AetherSessionDecoder =>
    new AetherSessionDecoder({ maxFrameBytes, maxDiagnosticBytes })

  it('skips the interactive banner and reads a pretty-printed document', () => {
    const subject = decoder()
    subject.push('🤖 AetherShell Agent API - Interactive Mode\nSend JSON requests (one per line), receive JSON responses\nPress Ctrl+D to exit\n\n')
    subject.push('{\n  "success": true,\n  "result": { "nonce": "n1", "ok": true, "value": 3 }\n}\n')
    expect(subject.takeDocuments()).toEqual([{ success: true, result: { nonce: 'n1', ok: true, value: 3 } }])
    expect(subject.takeDiagnostics().text).toContain('Interactive Mode')
  })

  it('reads a document split across arbitrary chunk boundaries', () => {
    const subject = decoder()
    subject.push('{"success":tr')
    subject.push('ue,"result":{"non')
    subject.push('ce":"n1","ok":true,"value":"a}b"}}')
    expect(subject.takeDocuments()).toEqual([{ success: true, result: { nonce: 'n1', ok: true, value: 'a}b' } }])
  })

  it('keeps a program-printed JSON object as diagnostics beside the reply', () => {
    const subject = decoder()
    // The printed object opens with its own key, so it is not a candidate at
    // all and cannot be mistaken for the interpreter's reply.
    subject.push('{"printed":true,"success":false}\n{"success":true,"result":{"nonce":"n1","ok":true,"value":7}}\n')
    expect(subject.takeDocuments()).toEqual([{ success: true, result: { nonce: 'n1', ok: true, value: 7 } }])
    expect(subject.takeDiagnostics().text).toContain('"printed"')
  })

  it('fails loudly instead of buffering a document past the byte budget', () => {
    const subject = decoder(16)
    subject.push('{"success":true,"result":{"nonce":"n1"')
    expect(subject.failure).toBeDefined()
    expect(subject.failure).toContain('16-byte session budget')
  })

  it('rejects a complete document that exceeds the byte budget in one chunk', () => {
    const subject = decoder(64)
    subject.push(`{"success": true, "result": {"nonce": "n1", "ok": true, "value": "${'x'.repeat(200)}"}}\n`)
    expect(subject.takeDocuments()).toEqual([])
    expect(subject.failure).toBeDefined()
    expect(subject.failure).toContain('64-byte session budget')
  })

  it('measures the complete-document budget in UTF-8 bytes, not characters', () => {
    const subject = decoder(64)
    // 40 four-byte characters: 160 bytes inside a 64-byte budget.
    subject.push(`{"success": true, "result": {"nonce": "n1", "ok": true, "value": "${'😀'.repeat(40)}"}}\n`)
    expect(subject.takeDocuments()).toEqual([])
    expect(subject.failure).toBeDefined()
  })

  it('resynchronizes past an unmatched bracket a program printed before the reply', () => {
    const subject = decoder()
    // An interrupted child can leave a bare `[` on the shared stream. The
    // scanner must not treat it as the start of a document and swallow the
    // interpreter's own reply.
    subject.push('[1,2\n{\n  "success": true,\n  "result": { "nonce": "n1", "ok": true, "value": 5 }\n}\n')
    expect(subject.takeDocuments()).toEqual([{ success: true, result: { nonce: 'n1', ok: true, value: 5 } }])
    expect(subject.failure).toBeUndefined()
  })

  it('resynchronizes past a stray quote and brace before the reply', () => {
    const subject = decoder()
    subject.push('"{\n{\n  "success": true,\n  "result": { "nonce": "n1", "ok": true, "value": 6 }\n}\n')
    expect(subject.takeDocuments()).toEqual([{ success: true, result: { nonce: 'n1', ok: true, value: 6 } }])
    expect(subject.failure).toBeUndefined()
  })

  it('keeps a bare JSON string a program printed as diagnostics, not a frame', () => {
    const subject = decoder()
    subject.push('"just a printed string"\n{"success": true, "result": {"nonce": "n1", "ok": true, "value": 8}}\n')
    expect(subject.takeDocuments()).toEqual([{ success: true, result: { nonce: 'n1', ok: true, value: 8 } }])
    expect(subject.takeDiagnostics().text).toContain('just a printed string')
  })

  it('bounds the diagnostic tail by UTF-8 bytes rather than characters', () => {
    const subject = decoder(4_096, 4)
    subject.push('😀😀')
    const read = subject.takeDiagnostics()
    expect(read.truncated).toBe(true)
    expect(Buffer.byteLength(read.text, 'utf8')).toBeLessThanOrEqual(4)
    expect(read.text).toBe('😀')
  })
})

describe('aether session reply correlation', () => {
  it('accepts the matching nonce and reads a captured failure', () => {
    const reply = classifySessionReply({
      success: true,
      result: { nonce: 'n1', ok: false, error: { error: { code: 'E_UNKNOWN_BUILTIN', message: 'unknown builtin: nope' } } },
    }, 'n1', 'wrapper')
    if (reply.kind !== 'reply' || reply.ok) throw new Error('expected a correlated captured failure')
    expect(reply.error.code).toBe('E_UNKNOWN_BUILTIN')
    expect(reply.error.message).toContain('unknown builtin')
  })

  it('treats a program-printed failure-shaped object as foreign output', () => {
    expect(classifySessionReply({ success: false, error: 'printed by the program' }, 'n1', 'wrapper').kind).toBe('foreign')
  })

  it('recognizes the interpreter rejecting the generated request by its echoed program', () => {
    const reply = classifySessionReply({
      success: false,
      error: 'Parse error: found 1 error(s)',
      metadata: { code_attempted: 'wrapper' },
    }, 'n1', 'wrapper')
    expect(reply.kind).toBe('desync')
  })

  it('keeps a nonce-less failure that echoes anything else as foreign output', () => {
    // Only the exact program this plugin generated proves the document answers
    // this request; a child or a program printing a failure-shaped object with
    // some other echoed source must not be able to close the session.
    expect(classifySessionReply({
      success: false,
      error: 'Parse error: found 1 error(s)',
      metadata: { code_attempted: 'some other program' },
    }, 'n1', 'wrapper').kind).toBe('foreign')
    expect(classifySessionReply({ success: false, error: 'no metadata at all' }, 'n1', 'wrapper').kind).toBe('foreign')
  })
})

describe.skipIf(interpreter === undefined)('aether session tools against the installed interpreter', () => {
  it('opens a session, reports its policy, and exposes only an opaque id', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-open-owner')
    const result = await mounted.call('aether_session_open', { name: 'work' }, { agent: owner })
    const opened = valueOf(result)
    expect(opened['kind']).toBe('opened')
    expect(opened['name']).toBe('work')
    expect(opened['cwd']).toBe(mounted.workspace)
    expect(opened['policy']).toEqual({ mode: 'danger-full-access', workspace_root: mounted.workspace })
    // The native id is process-local and stays inside the plugin.
    expect(String(opened['session_id'])).toMatch(/^[0-9a-f-]{36}$/)
    expect(text(result)).not.toContain('sess_')
  })

  it('keeps variables and functions alive across separate requests', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-state-owner')
    const sessionId = await openSession(mounted, owner)

    expect((await evaluate(mounted, owner, sessionId, 'let counter = 41; counter')).value).toBe(41)
    expect((await evaluate(mounted, owner, sessionId, 'counter + 1')).value).toBe(42)
    expect((await evaluate(mounted, owner, sessionId, 'let inc = fn(x) => x + 1; inc(9)')).value).toBe(10)
    expect((await evaluate(mounted, owner, sessionId, 'inc(counter)')).value).toBe(42)
  })

  it('keeps each session in its own process and working directory', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-cwd-owner')
    const first = await openSession(mounted, owner)
    const second = await openSession(mounted, owner)

    expect(String((await evaluate(mounted, owner, first, 'cd("C:/Windows"); pwd()')).value).toLowerCase()).toBe('c:\\windows')
    // The second session never saw the first one's `cd`, and the first still holds it.
    expect(String((await evaluate(mounted, owner, second, 'pwd()')).value)).toBe(mounted.workspace)
    expect(String((await evaluate(mounted, owner, first, 'pwd()')).value).toLowerCase()).toBe('c:\\windows')
  })

  it('delivers the exact program text, so the caller keeps its own interpolation', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-encode-owner')
    const sessionId = await openSession(mounted, owner)

    expect((await evaluate(mounted, owner, sessionId, 'let a = "A${1+1}B"; a')).value).toBe('A2B')
    expect((await evaluate(mounted, owner, sessionId, 'let b = "a$b"; b')).value).toBe('a$b')
    expect((await evaluate(mounted, owner, sessionId, 'let c = "a${\'$\'}{1}b"; c')).value).toBe('a${1}b')
    expect((await evaluate(mounted, owner, sessionId, 'let d = "q\\"q b\\\\s\\ttab\\nline $ 😀"; d')).value)
      .toBe('q"q b\\s\ttab\nline $ 😀')
  })

  it('reports a failure with structured detail and keeps the state it already changed', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-error-owner')
    const sessionId = await openSession(mounted, owner)

    expect((await evaluate(mounted, owner, sessionId, 'let kept = 7; kept')).value).toBe(7)
    const failed = await evaluate(mounted, owner, sessionId, 'kept + 1; no_such_builtin_xyz()')
    expect(failed['kind']).toBe('error')
    expect((failed['error'] as { code?: string }).code).toBe('E_UNKNOWN_BUILTIN')
    // A failure is not a rollback: the binding an earlier statement created survives.
    expect((await evaluate(mounted, owner, sessionId, 'kept')).value).toBe(7)
  })

  it('returns program output as bounded logs instead of mistaking it for a result', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-print-owner')
    const sessionId = await openSession(mounted, owner)

    const printed = await evaluate(mounted, owner, sessionId, 'print("hello-from-program"); 5')
    expect(printed['kind']).toBe('value')
    expect(printed['value']).toBe(5)
    expect(JSON.stringify(printed['logs'])).toContain('hello-from-program')
    // The program's own output is never echoed back as the request.
    expect(JSON.stringify(printed['logs'])).not.toContain('nonce')
  })

  it('refuses another agent every operation on a session it does not own', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-owner-a')
    const stranger = await mounted.agent('sess-owner-b')
    const sessionId = await openSession(mounted, owner)

    expect(await failure(mounted, 'aether_session_eval', { session_id: sessionId, code: '1' }, stranger))
      .toContain('E_SESSION_FOREIGN')
    expect(await failure(mounted, 'aether_session_close', { session_id: sessionId }, stranger))
      .toContain('E_SESSION_FOREIGN')
    // A listing is scoped to its caller: the stranger sees only its own (empty) set.
    expect(valueOf(await mounted.call('aether_session_list', {}, { agent: stranger }))['sessions']).toEqual([])
    // The owner's session is untouched by the refused calls.
    expect((await evaluate(mounted, owner, sessionId, '1 + 1')).value).toBe(2)
  })

  it('refuses a caller that is not the live registered agent object', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-live-owner')
    const impostor = { ...owner } as Agent
    expect(await failure(mounted, 'aether_session_open', {}, impostor)).toContain('E_SESSION_OWNER')
  })

  it('reports the agent\'s own handles and never another agent\'s', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-list-a')
    const stranger = await mounted.agent('sess-list-b')
    const sessionId = await openSession(mounted, owner, { name: 'listing' })
    await openSession(mounted, stranger)

    const listing = valueOf(await mounted.call('aether_session_list', {}, { agent: owner }))
    expect(listing['kind']).toBe('listed')
    const sessions = listing['sessions'] as Array<Record<string, unknown>>
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      session_id: sessionId,
      name: 'listing',
      phase: 'ready',
      policy_mode: 'danger-full-access',
      usage: {},
    })

    const withUsage = valueOf(await mounted.call('aether_session_list', { usage: true }, { agent: owner }))
    const counters = (withUsage['sessions'] as Array<{ usage: Record<string, unknown> }>)[0]?.usage
    expect(typeof counters?.['evals']).toBe('number')
  })

  it('closes a session on request and removes it from the agent\'s handles', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-close-owner')
    const sessionId = await openSession(mounted, owner)

    const closed = valueOf(await mounted.call('aether_session_close', { session_id: sessionId }, { agent: owner }))
    expect(closed).toMatchObject({ kind: 'closed', session_id: sessionId, closed: true, native_closed: true })

    const again = valueOf(await mounted.call('aether_session_close', { session_id: sessionId }, { agent: owner }))
    expect(again).toMatchObject({ kind: 'closed', closed: false })
    expect(await failure(mounted, 'aether_session_eval', { session_id: sessionId, code: '1' }, owner))
      .toContain('E_SESSION_UNKNOWN')
    expect(valueOf(await mounted.call('aether_session_list', {}, { agent: owner }))['sessions']).toEqual([])
  })

  it('closes every session when the tools unload, as a plugin reload does', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-reload-owner')
    const sessionId = await openSession(mounted, owner)

    await mounted.unmount()
    // The tools are gone with their fiber, and the process they owned went with them.
    expect(await failure(mounted, 'aether_session_eval', { session_id: sessionId, code: '1' }, owner)).toMatch(/unknown tool|UNKNOWN_TOOL/i)
    expect(await failure(mounted, 'aether_session_list', {}, owner)).toMatch(/unknown tool|UNKNOWN_TOOL/i)
  })

  it('refuses to run new work under a policy that changed after the session opened', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-policy-owner')
    const sessionId = await openSession(mounted, owner)
    expect((await evaluate(mounted, owner, sessionId, '1')).value).toBe(1)

    owner.session.append('sandbox/mode', { mode: 'read-only' })
    expect(await failure(mounted, 'aether_session_eval', { session_id: sessionId, code: '2' }, owner))
      .toContain('E_SESSION_POLICY')
    // The refused call closed the handle instead of reusing the old process.
    expect(await failure(mounted, 'aether_session_eval', { session_id: sessionId, code: '3' }, owner))
      .toContain('E_SESSION_UNKNOWN')
  })

  it('reports a policy-changed session as destroyed when listing rather than as usable', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-policy-list-owner')
    await openSession(mounted, owner)
    owner.session.append('sandbox/mode', { mode: 'read-only' })

    const listing = valueOf(await mounted.call('aether_session_list', {}, { agent: owner }))
    const sessions = listing['sessions'] as Array<Record<string, unknown>>
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ phase: 'destroyed', policy_mode: 'danger-full-access' })
    expect(String(sessions[0]?.['reason'])).toContain('DSH file policy changed')
  })

  it('terminates the process when an evaluation reaches its deadline', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-timeout-owner')
    const sessionId = await openSession(mounted, owner)

    const timedOut = await evaluate(mounted, owner, sessionId, 'sleep(30000); 1', { timeoutMs: 1_500 })
    expect(timedOut['kind']).toBe('error')
    expect((timedOut['error'] as { code?: string }).code).toBe('E_SESSION_TIMEOUT')
    // The whole process is gone, so no unknown command is left running behind
    // an apparently healthy handle.
    expect(await failure(mounted, 'aether_session_eval', { session_id: sessionId, code: '1' }, owner))
      .toContain('E_SESSION_UNKNOWN')
  })

  it('cancels a running evaluation by closing the session process', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-cancel-owner')
    const sessionId = await openSession(mounted, owner)

    const controller = new AbortController()
    setTimeout(() => { controller.abort() }, 300)
    const result = await mounted.call('aether_session_eval', { session_id: sessionId, code: 'sleep(30000); 1' }, {
      agent: owner,
      signal: controller.signal,
    })
    expect(result.isError).toBe(true)
    expect(await failure(mounted, 'aether_session_eval', { session_id: sessionId, code: '1' }, owner))
      .toContain('E_SESSION_UNKNOWN')
  })

  it('drops a handle whose interpreter exited on its own', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-exit-owner')
    const sessionId = await openSession(mounted, owner)

    const gone = await evaluate(mounted, owner, sessionId, 'exit(0)')
    expect(gone['kind']).toBe('error')
    expect(await failure(mounted, 'aether_session_eval', { session_id: sessionId, code: '1' }, owner))
      .toContain('E_SESSION_UNKNOWN')
    expect(valueOf(await mounted.call('aether_session_list', {}, { agent: owner }))['sessions']).toEqual([])
  })

  it('refuses more sessions than the deployment allows one agent', async () => {
    const mounted = await setup({ settings: { maxSessionsPerOwner: 1 } })
    const owner = await mounted.agent('sess-limit-owner')
    await openSession(mounted, owner)
    expect(await failure(mounted, 'aether_session_open', {}, owner)).toContain('E_SESSION_LIMIT')
  })

  it('returns a program\'s printed output exactly once and then reports nothing unread', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-read-owner')
    const sessionId = await openSession(mounted, owner)

    // The startup banner is consumed by the handshake, not by the first read.
    const first = valueOf(await mounted.call('aether_session_read', { session_id: sessionId }, { agent: owner }))
    expect(first['kind']).toBe('read')
    expect((first['logs'] as { stdout: { text: string } }).stdout.text).toBe('')

    const printed = await evaluate(mounted, owner, sessionId, 'print("once-only"); 3')
    expect(JSON.stringify(printed['logs'])).toContain('once-only')
    expect(text(await mounted.call('aether_session_read', { session_id: sessionId }, { agent: owner })))
      .toContain('no unread output')

    // Output a failing program wrote is delivered too, not suppressed.
    const failing = await evaluate(mounted, owner, sessionId, 'print("before-failure"); no_such_builtin_xyz()')
    expect(failing['kind']).toBe('error')
    expect(JSON.stringify(failing['logs'])).toContain('before-failure')
    expect(text(await mounted.call('aether_session_read', { session_id: sessionId }, { agent: owner })))
      .toContain('no unread output')
  })

  it('refuses to read a session that has a call in flight', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-read-busy-owner')
    const sessionId = await openSession(mounted, owner)

    const running = mounted.call('aether_session_eval', { session_id: sessionId, code: 'sleep(30000); 1', timeoutMs: 4_000 }, { agent: owner })
    await expect.poll(() => mounted.sessions.list(owner).then(list => list[0]?.phase), { timeout: 5_000 }).toBe('busy')
    expect(await failure(mounted, 'aether_session_read', { session_id: sessionId }, owner)).toContain('E_SESSION_BUSY')
    await running
  })

  it('reports an unknown handle when reading a session that is not open', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-read-unknown-owner')
    const sessionId = await openSession(mounted, owner)
    await mounted.call('aether_session_close', { session_id: sessionId }, { agent: owner })
    expect(await failure(mounted, 'aether_session_read', { session_id: sessionId }, owner)).toContain('E_SESSION_UNKNOWN')
  })

  it('drains output a spawned child writes between calls, exactly once', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-child-owner')
    const sessionId = await openSession(mounted, owner)

    // The child's control channel is a private directory this test owns; it is
    // created before the spawn so the cleanup below can always remove it.
    const control = await mkdtemp(join(tmpdir(), 'dsh-aether-child-'))
    const releasePath = join(control, 'release')
    try {
      const childSource = [
        "const fs = require('node:fs')",
        `const release = ${JSON.stringify(releasePath)}`,
        "process.stdout.write('CHILD-READY\\n')",
        'const poll = setInterval(() => {',
        '  if (!fs.existsSync(release)) return',
        '  clearInterval(poll)',
        "  process.stdout.write('CHILD-LATE\\n')",
        '  process.exit(0)',
        '}, 10)',
        '// A safety net so a failed test can never leak a polling child.',
        'setTimeout(() => { process.exit(0) }, 60000)',
      ].join('\n')
      // The child runs through the session's own spawn builtin, so it inherits
      // the interpreter's stdout — the stream this plugin frames.
      const spawnCode = `proc_spawn(${encodeAetherStringLiteral(process.execPath)},${encodeAetherStringLiteral('-e')},${encodeAetherStringLiteral(childSource)})`
      const spawned = await evaluate(mounted, owner, sessionId, spawnCode)
      expect(typeof spawned['value']).toBe('number')

      const stdout = async (): Promise<string> => {
        const result = valueOf(await mounted.call('aether_session_read', { session_id: sessionId }, { agent: owner }))
        return (result['logs'] as { stdout: { text: string } }).stdout.text
      }

      // The ready marker arrives after the reply, so nothing is guessed at: the
      // test waits on the observed output, never on a timer.
      await vi.waitFor(async () => { expect(await stdout()).toContain('CHILD-READY') }, { timeout: 20_000, interval: 50 })
      expect(await stdout()).toBe('')

      writeFileSync(releasePath, 'go')
      await vi.waitFor(async () => { expect(await stdout()).toContain('CHILD-LATE') }, { timeout: 20_000, interval: 50 })
      expect(await stdout()).toBe('')
    } finally {
      // Closing the session terminates the interpreter and the range it owns,
      // so the child is gone before the control directory is removed.
      await mounted.call('aether_session_close', { session_id: sessionId }, { agent: owner })
      await rm(control, { recursive: true, force: true })
    }
  })

  it('settles concurrent closes on one teardown and leaves nothing behind', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-double-close-owner')
    const sessionId = await openSession(mounted, owner)

    const results = await Promise.all([
      mounted.call('aether_session_close', { session_id: sessionId }, { agent: owner }),
      mounted.call('aether_session_close', { session_id: sessionId }, { agent: owner }),
    ])
    // Every closer asked for the same thing and every one of them got it: the
    // session is closed once, and no caller is told a session it asked to close
    // is still there.
    for (const result of results) expect(valueOf(result)).toMatchObject({ kind: 'closed', closed: true })
    // Whichever call reported it, both awaited the same join: the handle is gone.
    expect(valueOf(await mounted.call('aether_session_list', {}, { agent: owner }))['sessions']).toEqual([])
    expect(await failure(mounted, 'aether_session_eval', { session_id: sessionId, code: '1' }, owner))
      .toContain('E_SESSION_UNKNOWN')
  })

  it('releases the process when an explicit close races a running evaluation', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-close-busy-owner')
    const sessionId = await openSession(mounted, owner)

    const running = mounted.call('aether_session_eval', { session_id: sessionId, code: 'sleep(30000); 1', timeoutMs: 20_000 }, { agent: owner })
    await expect.poll(() => mounted.sessions.list(owner).then(list => list[0]?.phase), { timeout: 5_000 }).toBe('busy')
    // A busy handle cannot answer a native close, so the process is terminated
    // without asking and the result says the interpreter did not confirm it.
    const closed = valueOf(await mounted.call('aether_session_close', { session_id: sessionId }, { agent: owner }))
    expect(closed).toMatchObject({ kind: 'closed', session_id: sessionId, closed: true, native_closed: false })
    expect(valueOf(await mounted.call('aether_session_list', {}, { agent: owner }))['sessions']).toEqual([])
    await running
  })

  it('lists a busy handle without failing on counters it cannot read', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-list-busy-owner')
    const sessionId = await openSession(mounted, owner)

    const running = mounted.call('aether_session_eval', { session_id: sessionId, code: 'sleep(30000); 1', timeoutMs: 4_000 }, { agent: owner })
    await expect.poll(() => mounted.sessions.list(owner).then(list => list[0]?.phase), { timeout: 5_000 }).toBe('busy')
    const listing = valueOf(await mounted.call('aether_session_list', { usage: true }, { agent: owner }))
    const sessions = listing['sessions'] as Array<Record<string, unknown>>
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ session_id: sessionId, phase: 'busy', usage: {} })
    await running
  })

  it('releases the handle before a policy-changed refusal returns', async () => {
    const mounted = await setup({ settings: { maxSessionsPerOwner: 1 } })
    const owner = await mounted.agent('sess-policy-await-owner')
    const sessionId = await openSession(mounted, owner)

    owner.session.append('sandbox/mode', { mode: 'read-only' })
    expect(await failure(mounted, 'aether_session_eval', { session_id: sessionId, code: '1' }, owner))
      .toContain('E_SESSION_POLICY')
    // The refusal is reported only after the process that held the old policy
    // was joined, so this owner's one slot is already free.
    expect(await openSession(mounted, owner)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('cancels an in-flight start when the tools unload', async () => {
    const mounted = await setup({ mode: 'read-only' })
    const owner = await mounted.agent('sess-race-owner')
    // Hold the start inside confinement so the unload lands on a provably
    // in-flight start instead of racing a timer.
    const gate = mounted.holdConfine()
    const pending = mounted.call('aether_session_open', {}, { agent: owner })
    await gate.reached
    await mounted.unmount()
    gate.release()

    const result = await pending
    expect(result.isError).toBe(true)
    expect(await mounted.sessions.list(owner)).toEqual([])
    // The cancelled start never reached a spawn, so no interpreter exists.
    expect(mounted.liveProcesses()).toBe(0)
  })

  it('confines a non-full-access session under the calling session\'s policy', async () => {
    const mounted = await setup({ mode: 'read-only' })
    const owner = await mounted.agent('sess-confine-owner')
    const sessionId = await openSession(mounted, owner)

    expect(mounted.confineCalls).toHaveLength(1)
    expect(mounted.confineCalls[0]?.argv.slice(-2)).toEqual(['agent', 'interactive'])
    expect(mounted.confineCalls[0]?.policy.mode).toBe('read-only')
    expect((await evaluate(mounted, owner, sessionId, '1 + 1')).value).toBe(2)
  })

  it('reports the backend\'s real enforcement verdict instead of implying a full boundary', async () => {
    const mounted = await setup({ mode: 'workspace-write', enforcement: 'partial' })
    const owner = await mounted.agent('sess-partial-owner')
    const opened = valueOf(await mounted.call('aether_session_open', {}, { agent: owner }))
    expect(opened['policy']).toEqual({
      mode: 'workspace-write',
      workspace_root: mounted.workspace,
      enforcement: 'partial',
    })
    expect(text(await mounted.call('aether_session_list', {}, { agent: owner }))).toContain('workspace-write')
  })

  it('leaves no interpreter process behind a close or a cancelled start', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-quiescence-owner')
    expect(mounted.liveProcesses()).toBe(0)

    const sessionId = await openSession(mounted, owner)
    expect(mounted.liveProcesses()).toBe(1)
    await mounted.call('aether_session_close', { session_id: sessionId }, { agent: owner })
    // The close resolves only after the interpreter actually exited.
    expect(mounted.liveProcesses()).toBe(0)
  })

  it('refuses to reopen a session for an agent whose scope has disposed', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-disposed-owner')
    await openSession(mounted, owner)
    await owner.ctx.fiber.dispose()

    // The registry may still resolve the object, but the lifetime a session
    // would be tied to is gone, so opening again is refused explicitly.
    expect(await failure(mounted, 'aether_session_open', {}, owner)).toContain('E_SESSION_OWNER')
    expect(await mounted.sessions.list(owner)).toEqual([])
  })

  it('closes a session when its owning agent is disposed', async () => {
    const mounted = await setup()
    const owner = await mounted.agent('sess-owner-dispose')
    const sessionId = await openSession(mounted, owner)

    await owner.ctx.fiber.dispose()
    // The owner-scoped effect closed the session with its agent, so the handle is gone.
    expect(await failure(mounted, 'aether_session_eval', { session_id: sessionId, code: '1' }, owner))
      .toContain('E_SESSION_UNKNOWN')
  })
})
