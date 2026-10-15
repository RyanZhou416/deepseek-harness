#!/usr/bin/env node
/**
 * Deterministic stand-in for the AetherShell interpreter, used as the
 * deployment's `executable` + `executableArgs` (`node ae-fixture.mjs`) so the
 * plugin's real argv, stdin protocol, process lifecycle, and output budgets are
 * exercised without an installed interpreter.
 *
 * It mirrors the installed interpreter's two protocols exactly as observed on
 * `ae.exe` schema version 12.0.2:
 *
 * - `agent execute` reads one JSON request from stdin and writes one envelope
 *   `{success, result?, error?, result_type?, metadata?}` to stdout, exiting 0
 *   even when `success` is false.
 * - `--deterministic -c <code>` writes the bare canonical JSON value to stdout
 *   and reports failure as `error[<CODE>]: <message>` on stderr with a non-zero
 *   exit.
 *
 * Scenario selection is by request content, never by environment, so a test
 * cannot accidentally pass because ambient state chose the branch. Anything the
 * fixture does not recognize fails loudly.
 */

import { readFileSync, writeFileSync } from 'node:fs'

/** Canonical outputs verified against the installed interpreter. */
const EVAL_CASES = new Map([
  ['1 + 1', '2'],
  ['{b: 2, a: 1}', '{"a":1,"b":2}'],
  ['json.stringify({a: 1})', '"{\\"a\\":1}"'],
  ['str.upper("hi")', '"HI"'],
])

/** Flush-and-exit helper that keeps stdout/stderr writes ordered. */
function finish(code) {
  process.exitCode = code
}

/** Write the agent envelope and exit 0, matching the interpreter's own behavior. */
function envelope(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  finish(0)
}

/** One successful Agent API envelope carrying `result`. */
function ok(result, resultType, codeExecuted) {
  return {
    success: true,
    result,
    result_type: resultType,
    metadata: { code_executed: codeExecuted, token_accounting: { estimated: true, tokens_in: 1, tokens_out: 1, tokens_total: 2 } },
  }
}

/** One failed Agent API envelope carrying the interpreter's failure text. */
function failed(error, codeAttempted) {
  return {
    success: false,
    error,
    metadata: { code_attempted: codeAttempted, token_accounting: { estimated: true, tokens_in: 1, tokens_out: 1, tokens_total: 2 } },
  }
}

/** Read the complete stdin request; the interpreter reads one document to EOF. */
function readStdin() {
  return readFileSync(0, 'utf8')
}

/** Never settle, so the plugin's deadline and cancellation paths own the exit. */
function hang() {
  // A referenced interval keeps the event loop alive; the fixture must stay
  // running until the plugin terminates the managed process range.
  setInterval(() => {}, 1_000)
  process.on('SIGTERM', () => { process.exit(0) })
  process.on('SIGINT', () => { process.exit(0) })
}

/** The synthetic manifest: five categories, so an entry budget below five truncates. */
const MANIFEST = {
  categories: [
    { builtins: 3, category: 'Core', effects: ['pure'] },
    { builtins: 9, category: 'FileSystem', effects: ['pure', 'read_local', 'write_local'] },
    { builtins: 4, category: 'String', effects: ['pure'] },
    { builtins: 6, category: 'Network', effects: ['pure', 'network'] },
    { builtins: 2, category: 'Process', effects: ['pure', 'exec'] },
  ],
  effect_legend: ['pure', 'read_local', 'write_local', 'network', 'exec', 'privileged'],
  hint: 'ontology_describe("<category>") lists a category\'s builtins; ontology_describe("<builtin>") returns full detail',
  ontology: 'manifest',
  total_builtins: 24,
}

/** One synthetic category payload. */
const CATEGORIES = {
  Core: { builtins: [{ name: 'len' }, { name: 'pwd' }, { name: 'type_of' }], category: 'Core', hint: 'ontology_describe("<builtin>") returns full detail' },
  FileSystem: { builtins: [{ name: 'ls' }, { name: 'cat' }], category: 'FileSystem', hint: 'ontology_describe("<builtin>") returns full detail' },
}

/** Builtin details, with more examples than a small entry budget keeps. */
const BUILTINS = {
  pwd: {
    aliases: null,
    builtin: 'pwd',
    category: 'FileSystem',
    description: 'Get current working directory',
    effect: 'pure',
    effect_declared: false,
    examples: [
      { code: 'pwd()', description: 'Get current directory' },
      { code: 'pwd() | str.upper', description: 'Uppercase the directory' },
      { code: 'pwd() | len', description: 'Length of the directory path' },
    ],
    parameters: [],
    return_type: 'String',
    signature: 'pwd() -> String',
  },
  ls: {
    aliases: null,
    builtin: 'ls',
    category: 'FileSystem',
    description: 'List directory contents',
    effect: 'read_local',
    effect_declared: true,
    examples: [{ code: 'ls(".")', description: 'List the working directory' }],
    parameters: [{ name: 'path', required: false, type: 'String' }],
    return_type: 'Array<Record>',
    signature: 'ls(path?: String) -> Array<Record>',
  },
}

/** Builtins whose reply carries a nested `{success:false}` value the plugin must not misread as failure. */
const VALUE_BUILTINS = new Map([
  ['value_success_false', { value: { success: false, reason: 'a native value that merely looks like an envelope' }, type: 'Record' }],
])

/**
 * Answer one Agent API request.
 * @param {unknown} request - the decoded stdin request.
 */
function answerAgent(request) {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    process.stderr.write('Error: Invalid JSON request: expected an object\n')
    return finish(1)
  }
  const { action, builtin, args } = request
  if (action === 'call') return answerCall(request, builtin, args ?? [])
  if (action === 'pipeline') return answerPipeline(request)
  if (action === 'eval') return finishEval(request.code)
  process.stderr.write(`Error: Invalid JSON request: unknown action ${JSON.stringify(action)}\n`)
  return finish(1)
}

/** One `call` request: scenario builtins first, ontology builtins second. */
function answerCall(request, builtin, args) {
  const call = `${String(builtin)}(${args.map(arg => JSON.stringify(arg)).join(', ')})`
  switch (builtin) {
    case 'pwd':
      return envelope(ok(process.cwd(), 'String', 'pwd()'))
    case 'echo':
      return envelope(ok(args[0] ?? null, 'String', call))
    case 'fixture_env': {
      const aether = Object.keys(process.env).filter(key => key.startsWith('AETHER_')).sort()
      const ae = Object.keys(process.env).filter(key => key.startsWith('AE_')).sort()
      const dsh = Object.keys(process.env).filter(key => key.startsWith('DSH_')).sort()
      return envelope(ok({
        aeKeys: ae,
        allowSh: process.env.AETHER_ALLOW_SH ?? null,
        aetherKeys: aether,
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        dshKeys: dsh,
        mode: process.env.AETHER_MODE ?? null,
      }, 'Record', call))
    }
    case 'fixture_echo_request':
      return envelope(ok({ argv: process.argv.slice(2), request }, 'Record', call))
    case 'value_success_false': {
      const shaped = VALUE_BUILTINS.get('value_success_false')
      return envelope(ok(shaped.value, shaped.type, call))
    }
    case 'fail':
      return envelope(failed('the builtin refused the request', call))
    case 'unknown_builtin':
      return envelope(failed(JSON.stringify({
        error: {
          builtin: String(builtin),
          code: 'E_UNKNOWN_BUILTIN',
          hint: 'no builtin has a similar name; call ontology_manifest() to list the available categories',
          message: `unknown builtin: ${String(builtin)}`,
          retryable: true,
        },
      }), call))
    case 'big':
      return envelope(ok('x'.repeat(Number(args[0] ?? 0)), 'String', call))
    case 'stderr_big': {
      process.stderr.write('e'.repeat(Number(args[0] ?? 0)))
      return envelope(ok('envelope after a large diagnostic stream', 'String', call))
    }
    case 'stderr_noise': {
      process.stderr.write('warning: native diagnostic\n')
      return envelope(ok('value beside a diagnostic', 'String', call))
    }
    case 'nonzero':
      process.stdout.write(`${JSON.stringify(ok('value from a nonzero process', 'String', call))}\n`)
      return finish(3)
    case 'denied':
      // A confinement backend refuses before the target runs: non-zero exit,
      // no response document, and the backend's own denial dialect on stderr.
      process.stderr.write('the sandbox denied the write: access is denied\n')
      return finish(5)
    case 'malformed':
      process.stdout.write('{not json\n')
      return finish(0)
    case 'empty':
      return finish(0)
    case 'hang':
      return hang()
    case 'write_probe': {
      const [target, content] = args
      try {
        writeFileSync(String(target), String(content ?? 'probe'))
        return envelope(ok({ ok: true, path: target }, 'Record', call))
      } catch (error) {
        return envelope(ok({
          error: error instanceof Error ? error.message : String(error),
          ok: false,
          path: target,
        }, 'Record', call))
      }
    }
    case 'ontology_manifest':
      return envelope(ok(MANIFEST, 'Record', 'ontology_manifest()'))
    case 'ontology_describe': {
      const query = String(args[0] ?? '')
      const described = BUILTINS[query] ?? CATEGORIES[query]
      if (described !== undefined) return envelope(ok(described, 'Record', `ontology_describe(${JSON.stringify(query)})`))
      return envelope(ok({
        error: `'${query}' is not a known category or builtin`,
        hint: 'call ontology_manifest() to see categories',
      }, 'Record', `ontology_describe(${JSON.stringify(query)})`))
    }
    default:
      process.stderr.write(`Error: Invalid JSON request: fixture has no scenario for builtin ${JSON.stringify(String(builtin))}\n`)
      return finish(1)
  }
}

/** One `pipeline` request: `hang` and `malformed` scenarios are honored inside a step. */
function answerPipeline(request) {
  const steps = Array.isArray(request.steps) ? request.steps : []
  const names = steps.map(step => step?.builtin)
  if (names.includes('hang')) return hang()
  if (names.includes('malformed')) {
    process.stdout.write('not an envelope\n')
    return finish(0)
  }
  if (names.includes('unknown_builtin')) {
    return envelope(failed(JSON.stringify({
      error: {
        builtin: 'unknown_builtin',
        code: 'E_UNKNOWN_BUILTIN',
        hint: 'call ontology_manifest() to list the available categories',
        message: 'unknown builtin: unknown_builtin',
        retryable: true,
      },
    }), `pipeline(${names.join(' | ')})`))
  }
  if (names.includes('pwd')) {
    return envelope(ok({ steps: names, value: process.cwd() }, 'Record', `${JSON.stringify(request.input ?? null)} | ${names.join('() | ')}()`))
  }
  process.stderr.write(`Error: Invalid JSON request: fixture has no pipeline scenario for ${JSON.stringify(names)}\n`)
  return finish(1)
}

/**
 * Answer one `--deterministic -c` evaluation.
 * @param {unknown} code - the program text the plugin passed as one argv element.
 */
function finishEval(code) {
  if (typeof code !== 'string') {
    process.stderr.write('error[E_FIXTURE]: fixture eval requires a program string\n')
    return finish(1)
  }
  const known = EVAL_CASES.get(code)
  if (known !== undefined) {
    process.stdout.write(`${known}\n`)
    return finish(0)
  }
  if (code.startsWith('fixture:')) return directiveEval(code)
  process.stderr.write(`error[E_UNKNOWN_BUILTIN]: unknown builtin: ${code.slice(0, 40)}\n  hint: call ontology_manifest() to list the available categories\n`)
  return finish(1)
}

/** Parameterized eval scenarios a real expression cannot express deterministically. */
function directiveEval(code) {
  const body = code.slice('fixture:'.length)
  const separator = body.indexOf(':')
  const verb = separator === -1 ? body : body.slice(0, separator)
  const argument = separator === -1 ? '' : body.slice(separator + 1)
  switch (verb) {
    case 'silent':
      return finish(0)
    case 'value':
      process.stdout.write(`${argument}\n`)
      return finish(0)
    case 'big':
      process.stdout.write(`${JSON.stringify('y'.repeat(Number(argument)))}\n`)
      return finish(0)
    case 'malformed':
      process.stdout.write('{not json\n')
      return finish(0)
    case 'stderr':
      process.stderr.write(argument)
      process.stdout.write('"value beside a diagnostic"\n')
      return finish(0)
    case 'sleep':
      return hang()
    case 'fail':
      process.stderr.write('error[E_FIXTURE_DIRECTIVE]: the fixture was told to fail\n  hint: this directive exists to pin interpreter failure text\n')
      return finish(1)
    case 'exit':
      process.stdout.write('null\n')
      return finish(Number(argument))
    default:
      process.stderr.write(`error[E_FIXTURE]: unknown fixture directive ${JSON.stringify(verb)}\n`)
      return finish(1)
  }
}

const [, , ...argv] = process.argv
if (argv[0] === 'agent' && argv[1] === 'execute') {
  const raw = readStdin()
  let request
  try {
    request = JSON.parse(raw)
  } catch {
    process.stderr.write('Error: Invalid JSON request: invalid JSON body\n')
    finish(1)
  }
  if (request !== undefined) answerAgent(request)
} else if (argv.includes('--deterministic') && argv.includes('-c')) {
  finishEval(argv[argv.indexOf('-c') + 1])
} else {
  process.stderr.write(`Error: fixture received an unsupported argv: ${JSON.stringify(argv)}\n`)
  finish(2)
}
