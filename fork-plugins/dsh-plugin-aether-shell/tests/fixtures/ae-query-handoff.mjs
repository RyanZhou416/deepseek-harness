#!/usr/bin/env node
/**
 * Deterministic external interpreter for foreground-query handoff tests.
 *
 * The fixture is the real process boundary the plugin spawns, so a test can
 * prove that a promoted call keeps running as the original process instead of
 * starting a second one. It answers the Agent API capability probe and one
 * `slow` builtin, one `slow` pipeline step, and a command-line code record.
 *
 * Every invocation appends its pid to `spawns.txt`. A capability probe appends
 * `probe` to `probes.txt`; a user operation appends its marker to `starts.txt`
 * exactly once, then waits for the caller's private release file before it
 * emits its result. All paths come from the explicit `--handoff-root=<dir>`
 * argv marker (the test's private workspace) and the request's JSON record;
 * nothing depends on ambient environment, a global port, or a fixed path.
 *
 * A terminated process exits immediately from its SIGTERM/SIGINT handler, so a
 * killed job can prove its managed range empty without a hanging child.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The fixture-only argv marker naming the private test workspace. */
const ROOT_FLAG = '--handoff-root='

/** Private workspace that receives this invocation's markers. */
let root = ''

/** The exact capability record the typed channel accepts. */
const CAPABILITIES = Object.freeze({
  features: Object.freeze({
    explicit_null_pipeline_input_v1: true,
    typed_arguments_v1: true,
    typed_pipeline_input_v1: true,
  }),
  protocol: 'aethershell-agent-api',
  protocol_version: 1,
})

/** Report an unusable invocation without writing a protocol document. */
function fail(message) {
  process.stderr.write(`error[E_QUERY_HANDOFF_FIXTURE]: ${message}\n`)
  process.exitCode = 2
}

/** Append one diagnostic line to a file under the private workspace. */
function appendLine(path, line) {
  appendFileSync(path, `${line}\n`)
}

/** Write one Agent API envelope and let the event loop close. */
function envelope(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  process.exitCode = 0
}

/** One successful Agent API envelope. */
function ok(result, resultType) {
  return {
    success: true,
    result,
    result_type: resultType,
    metadata: { fixture: 'ae-query-handoff' },
  }
}

/** Read the complete Agent API stdin document. */
function readStdin() {
  return readFileSync(0, 'utf8')
}

/** Reject a request record the fixture does not recognize. */
function asRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  if (typeof value.release !== 'string' || value.release.length === 0) return undefined
  return value
}

/** Run the caller's completion once the private release file exists. */
function waitForRelease(release, done) {
  if (existsSync(release)) {
    done()
    return
  }
  const timer = setInterval(() => {
    if (!existsSync(release)) return
    clearInterval(timer)
    done()
  }, 10)
  const stop = () => {
    clearInterval(timer)
    process.exit(0)
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

/**
 * Record one operation start and wait for its release barrier.
 * @param marker - the one operation row this process may append.
 * @param value - the request's JSON record.
 * @param finish - emits the protocol result after release.
 */
function operation(marker, value, finish) {
  const record = asRecord(value)
  if (record === undefined) {
    fail('the operation requires one record argument with a non-empty "release" path')
    return
  }
  appendLine(join(root, 'starts.txt'), marker)
  waitForRelease(record.release, () => { finish(record) })
}

/** Answer one `call slow` request with a native business value. */
function answerCall(request) {
  if (request.builtin !== 'slow') {
    fail(`unknown builtin ${JSON.stringify(String(request.builtin))}; expected "slow"`)
    return
  }
  operation('call', request.args?.[0], (record) => {
    envelope(ok({ success: false, marker: 'call', value: record.value }, 'Record'))
  })
}

/** Answer one `pipeline` whose only step is the recognized `slow` step. */
function answerPipeline(request) {
  const steps = Array.isArray(request.steps) ? request.steps : []
  if (steps.length !== 1 || steps[0]?.builtin !== 'slow') {
    fail(`expected exactly one "slow" step, got ${JSON.stringify(steps.map(step => step?.builtin))}`)
    return
  }
  operation('pipeline', steps[0]?.args?.[0], (record) => {
    envelope(ok({ success: false, marker: 'pipeline', value: record.value }, 'Record'))
  })
}

/** Answer the capability probe without counting it as a user operation. */
function answerCapabilities() {
  appendLine(join(root, 'probes.txt'), 'probe')
  envelope(ok(CAPABILITIES, 'Record'))
}

/** Answer one Agent API stdin request. */
function answerAgent(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    fail('expected one JSON request object')
    return
  }
  switch (request.action) {
    case 'capabilities':
      return answerCapabilities()
    case 'call':
      return answerCall(request)
    case 'pipeline':
      return answerPipeline(request)
    default:
      fail(`unknown action ${JSON.stringify(request.action)}`)
      return undefined
  }
}

/**
 * Answer one command-line code record. The code is deliberately a JSON record,
 * not an AetherShell program: only the external boundary matters here.
 */
function answerCode(code) {
  let value
  try {
    value = JSON.parse(code)
  } catch {
    fail('the CLI code is not one JSON record')
    return
  }
  const record = asRecord(value)
  if (record === undefined) {
    fail('the CLI code requires one record with a non-empty "release" path')
    return
  }
  const marker = typeof record.marker === 'string' && record.marker.length > 0 ? record.marker : 'cli'
  appendLine(join(root, 'starts.txt'), marker)
  waitForRelease(record.release, () => {
    process.stdout.write(`${JSON.stringify(record.value)}\n`)
    process.exitCode = 0
  })
}

const [, , ...rawArgv] = process.argv
const rootArg = rawArgv.find(argument => argument.startsWith(ROOT_FLAG))
if (rootArg === undefined) {
  fail(`missing ${ROOT_FLAG}<private-workspace> argv marker`)
} else {
  root = rootArg.slice(ROOT_FLAG.length)
  const argv = rawArgv.filter(argument => !argument.startsWith(ROOT_FLAG))
  appendLine(join(root, 'spawns.txt'), String(process.pid))
  if (argv[0] === 'agent' && argv[1] === 'execute') {
    let request
    try {
      request = JSON.parse(readStdin())
    } catch {
      fail('the Agent API request is not one JSON document')
    }
    if (request !== undefined) answerAgent(request)
  } else if (argv.includes('--deterministic') && argv.includes('-c')) {
    const code = argv[argv.indexOf('-c') + 1]
    if (typeof code !== 'string') fail('the CLI argv carries no code string')
    else answerCode(code)
  } else {
    fail(`unsupported argv ${JSON.stringify(argv)}`)
  }
}
