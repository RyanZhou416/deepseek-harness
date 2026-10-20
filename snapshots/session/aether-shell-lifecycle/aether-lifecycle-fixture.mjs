/**
 * Stand-in for the external AetherShell interpreter, which is not installed on
 * the hosts this snapshot replays on.
 *
 * Only the native binary is replaced: the plugin, the subprocess provider, the
 * sandbox policy, the jobs registry, session persistence, and the replayed model
 * script all stay real. The plugin reaches this process in two ways, and each is
 * answered on its own terms:
 *
 * - `agent interactive` is the persistent-session transport. The interpreter
 *   prints a banner, then reads exactly one JSON request line at a time and
 *   answers with a multi-line JSON document. The plugin's request is the
 *   nonce-correlated wrapper it generates (`try { {nonce,ok:true,value:…} }
 *   catch e { … }`), so this fixture extracts the nonce and the generated call,
 *   evaluates the recorded session program against per-process state, and echoes
 *   the same nonce back. State lives only in this process, so `n + 1` succeeds
 *   only when the earlier `let n = 41; n` ran in the same process.
 * - `--deterministic -c <program>` is the command-line transport the background
 *   tool uses. Nothing is decoded here: stdout and stderr are the job's output,
 *   so a program that prints logs and then returns a value is an ordinary
 *   completed run. Each recorded program is held open until the scenario's jobs
 *   observer publishes that the model's own wait registered, so a job can never
 *   settle ahead of its reader and become a completion notice instead.
 *
 * Unsupported programs are reported as explicit failures rather than fabricated
 * values, so a wrong replay script fails loudly instead of passing on a guess.
 */

import { readdirSync } from 'node:fs'

/** The interpreter's own session id; one process holds one native session. */
const NATIVE_SESSION = 'sess_fixture_0'

/**
 * The recorded command-line programs, each keyed to how many wait registrations
 * the run must have published before this program may settle.
 *
 * A registry mints a fresh random job id per run, so a program cannot look up
 * its own id in advance. The two recorded jobs run strictly one after the
 * other: the first settles only after the model's first `job_output` wait is
 * registered, and the second only after both waits are, because the first job's
 * registration stays in the run's private control root.
 */
const GATED_PROGRAMS = {
  'print("JOB_STARTED"); 7': 1,
  'no_such_builtin()': 2,
}

/**
 * How long a recorded program waits for its wait registration, in milliseconds.
 *
 * This is the only budget the program has: a registration that never arrives
 * fails the run instead of hanging it.
 */
const WAIT_TIMEOUT_MS = 60_000
/** How often a recorded program rechecks for its registration, in milliseconds. */
const WAIT_POLL_MS = 20

/** The banner the real interactive mode prints before the first reply. */
const BANNER = [
  '🤖 AetherShell Agent API - Interactive Mode',
  'Send JSON requests (one per line), receive JSON responses',
  'Press Ctrl+D to exit',
  '',
].join('\n')

/** Write one Agent API envelope. Pretty-printed, exactly like the real interpreter. */
function respond(envelope) {
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`)
}

/** A successful correlated reply for one generated wrapper call. */
function reply(nonce, value) {
  respond({
    success: true,
    result: { nonce, ok: true, value },
    metadata: { mode: 'human' },
  })
}

/** A failed correlated reply: the generated call raised, which the wrapper caught. */
function fail(nonce, code, message) {
  respond({
    success: true,
    result: { nonce, ok: false, error: { error: { code, message } } },
    metadata: { mode: 'human' },
  })
}

/**
 * Read one AetherShell double-quoted string literal starting at `start`.
 *
 * The plugin writes an embedded string through its own literal encoder, which
 * escapes the backslash, the double quote, and the three common control
 * characters, and rewrites a dollar sign as the interpolation `${'$'}`. Both
 * spellings are decoded here so the recorded program text reaches the matcher
 * exactly as it was authored.
 * @param text - the generated call text.
 * @param start - index of the opening quote.
 * @returns the decoded literal and the index just past its closing quote.
 */
function readLiteral(text, start) {
  let value = ''
  let index = start + 1
  while (index < text.length) {
    const character = text[index]
    if (character === '\\') {
      const escaped = text[index + 1]
      if (escaped === 'n') value += '\n'
      else if (escaped === 'r') value += '\r'
      else if (escaped === 't') value += '\t'
      else value += escaped
      index += 2
      continue
    }
    if (character === '"') return { value, end: index + 1 }
    if (text.startsWith("${'$'}", index)) {
      value += '$'
      index += 6
      continue
    }
    value += character
    index += 1
  }
  throw new Error('unterminated string literal in the generated call')
}

/** Read one argument list of string literals: `"a","b"`. */
function readArguments(call) {
  const open = call.indexOf('(')
  const close = call.lastIndexOf(')')
  if (open === -1 || close === -1 || close < open) throw new Error(`malformed generated call: ${call}`)
  const inner = call.slice(open + 1, close).trim()
  if (inner.length === 0) return []
  const values = []
  let index = 0
  while (index < inner.length) {
    if (inner[index] !== '"') throw new Error(`expected a string literal in the generated call: ${call}`)
    const literal = readLiteral(inner, index)
    values.push(literal.value)
    index = literal.end
    if (inner[index] === ',') index += 1
    else if (index < inner.length) throw new Error(`unexpected text after a literal in the generated call: ${call}`)
  }
  return values
}

/** Per-process session state: only the recorded programs are understood. */
function createSessionState() {
  return { vars: new Map(), functions: new Map(), evals: 0 }
}

/** One native session handle, mirroring `sess_open`'s reply record. */
function openSession(sessions) {
  if (!sessions.has(NATIVE_SESSION)) sessions.set(NATIVE_SESSION, createSessionState())
  return { active: true, session: NATIVE_SESSION }
}

/**
 * Evaluate one recorded session program against this process's state.
 *
 * The fixture understands exactly the programs the scenario records; anything
 * else is an explicit failure. `n + 1` requires the earlier binding, so a plugin
 * that ran the two evaluations in different processes would fail here.
 * @param state - the native session's mutable state.
 * @param code - the decoded program text.
 * @returns the program's value.
 * @throws Error naming the unsupported program.
 */
function evaluateProgram(state, code) {
  const source = code.trim()
  state.evals += 1
  if (source === 'let n = 41; n') {
    state.vars.set('n', 41)
    return 41
  }
  if (source === 'n + 1') {
    const n = state.vars.get('n')
    if (typeof n !== 'number') throw new Error('n is not bound in this interpreter process')
    return n + 1
  }
  if (source === 'let double = fn(x) => x * 2; double(21)') {
    state.functions.set('double', 2)
    return 42
  }
  throw new Error(`this fixture evaluates only the recorded session programs, not ${JSON.stringify(source)}`)
}

/** Answer one `sess_*` call generated by the plugin. */
function dispatchSessionCall(sessions, call) {
  if (call === 'sess_open()') return openSession(sessions)
  const name = call.slice(0, call.indexOf('('))
  const args = readArguments(call)
  if (name === 'sess_eval') {
    const [sessionId, code] = args
    const state = sessions.get(sessionId)
    if (state === undefined) throw new Error(`unknown native session ${JSON.stringify(sessionId)}`)
    return evaluateProgram(state, code)
  }
  if (name === 'sess_usage') {
    const [sessionId] = args
    const state = sessions.get(sessionId)
    if (state === undefined) throw new Error(`unknown native session ${JSON.stringify(sessionId)}`)
    return { evals: state.evals, tokens_in: 0, tokens_out: 0, tokens_total: 0 }
  }
  if (name === 'sess_close') {
    const [sessionId] = args
    const known = sessions.delete(sessionId)
    return { closed: known }
  }
  throw new Error(`this fixture implements only the session builtins, not ${JSON.stringify(call)}`)
}

/** Answer one interactive-mode request line. */
function handleInteractiveLine(sessions, line) {
  const request = JSON.parse(line)
  if (request.action !== 'eval' || typeof request.code !== 'string') {
    respond({ success: false, error: `unsupported interactive request ${JSON.stringify(request.action)}` })
    return
  }
  const nonce = /{nonce:"([^"]+)",ok:true,value:/.exec(request.code)?.[1]
  if (nonce === undefined) {
    respond({ success: false, error: 'the generated request carried no nonce wrapper' })
    return
  }
  const valueStart = request.code.indexOf('value:') + 'value:'.length
  const valueEnd = request.code.lastIndexOf('} } catch e')
  if (valueEnd < valueStart) {
    respond({ success: false, error: 'the generated request carried no evaluable call' })
    return
  }
  const call = request.code.slice(valueStart, valueEnd).trim()
  try {
    reply(nonce, dispatchSessionCall(sessions, call))
  } catch (error) {
    fail(nonce, 'E_MOCK_UNSUPPORTED', error instanceof Error ? error.message : String(error))
  }
}

/** Serve the persistent `agent interactive` transport until the plugin ends it. */
function serveInteractive() {
  const sessions = new Map()
  process.stdout.write(BANNER)
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length > 0) handleInteractiveLine(sessions, line)
      index = buffer.indexOf('\n')
    }
  })
  process.stdin.resume()
}

/**
 * Wait until the scenario's observing jobs provider publishes one wait.
 *
 * The jobs registry mints a random id per job, so the recorded program cannot
 * name its own registration file; it waits for the count it owns instead. The
 * wait is bounded: an unregistered wait is a fixture failure reported on stderr
 * with a non-zero exit, never a silent hang and never a masked success.
 * @param controlRoot - trusted directory the provider publishes registrations in.
 * @param minimum - registrations this program's own wait requires.
 * @returns true once the required registrations exist, false when the budget runs out.
 */
function waitForWaitRegistrations(controlRoot, minimum) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  return new Promise((resolve) => {
    const poll = () => {
      let count = 0
      try {
        count = readdirSync(controlRoot).length
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      if (count >= minimum) {
        resolve(true)
        return
      }
      if (Date.now() >= deadline) {
        resolve(false)
        return
      }
      setTimeout(poll, WAIT_POLL_MS)
    }
    poll()
  })
}

/** Answer one command-line program, which the background tool reads as raw output. */
async function serveProgram(controlRoot, code) {
  const source = code.trim()
  const ordinal = GATED_PROGRAMS[source]
  if (ordinal === undefined) {
    process.stderr.write(`error[E_MOCK_UNSUPPORTED]: this fixture evaluates only the recorded programs, not ${JSON.stringify(source)}\n`)
    process.exitCode = 1
    return
  }
  if (!await waitForWaitRegistrations(controlRoot, ordinal)) {
    process.stderr.write(`error[E_MOCK_WAIT]: the scenario's jobs observer never published the wait for recorded program ${ordinal} under ${JSON.stringify(controlRoot)}\n`)
    process.exitCode = 3
    return
  }
  if (source === 'print("JOB_STARTED"); 7') {
    // The recorded background program prints a log line and then its value, so
    // the job's output mixes prose with the canonical value.
    process.stdout.write('JOB_STARTED\n7\n')
    process.exitCode = 0
    return
  }
  // The recorded failing program: nothing on stdout, the interpreter's own
  // diagnostic on stderr, and a non-zero exit, byte-identical to what the real
  // command line prints for an unknown builtin.
  process.stderr.write('error[E_UNKNOWN_BUILTIN]: unknown builtin: no_such_builtin\n'
    + '  hint: no builtin has a similar name; call ontology_manifest() to list the available categories\n')
  process.exitCode = 1
}

const [controlRoot, ...nativeArgv] = process.argv.slice(2)
const [first, second, third] = nativeArgv

if (first === 'agent' && second === 'interactive') {
  serveInteractive()
} else if (first === '--deterministic' && second === '-c') {
  await serveProgram(controlRoot ?? '', third ?? '')
} else {
  process.stderr.write(`error[E_MOCK_ARGV]: unsupported arguments ${JSON.stringify(process.argv.slice(2))}\n`)
  process.exitCode = 2
}
