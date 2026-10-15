/**
 * Stand-in for the external AetherShell interpreter, which is not installed on the
 * hosts this snapshot replays on.
 *
 * Only the native binary is replaced: the plugin, the subprocess provider, the
 * sandbox policy, session persistence, and the replayed model script all stay real.
 * The plugin writes one Agent API request to stdin for `agent execute`, and passes one
 * program on the `--deterministic -c` command line for `aether_eval`. Every other
 * request is reported as a native failure — with a structured code — instead of being
 * answered with a fabricated value, and an unsupported command line fails the process
 * before any protocol response.
 */

const [first, second, third] = process.argv.slice(2)

/** Metadata the interpreter attaches to every response; the plugin strips the request echo. */
function metadata(echo) {
  return { mode: 'human', code_executed: echo }
}

/** Write one Agent API response envelope: exactly one JSON document on stdout. */
function respond(envelope) {
  process.stdout.write(`${JSON.stringify(envelope)}\n`)
}

/** Report a native failure inside a successful process, which is what the Agent API does. */
function refuse(message, code, echo) {
  respond({
    success: false,
    error: JSON.stringify({ error: { message, code } }),
    result_type: 'Error',
    metadata: { mode: 'human', code_attempted: echo },
  })
}

/** The recorded category manifest, small enough to stay readable in the transcript. */
function manifest() {
  return {
    ontology: 'aether-shell',
    total_builtins: 3,
    effect_legend: { pure: 'returns data without touching the host' },
    categories: [
      { name: 'Core', builtins: ['len', 'where'], builtin_count: 2, effects: ['pure'] },
      { name: 'Str', builtins: ['str_upper'], builtin_count: 1, effects: ['pure'] },
    ],
    hint: 'Describe one category or builtin with ontology_describe.',
  }
}

/** The recorded builtin detail the ontology describes. */
const BUILTINS = {
  len: {
    name: 'len',
    category: 'Core',
    signature: 'len(value): Number',
    returns: 'Number',
    effects: ['pure'],
    aliases: [],
    description: 'Return the number of elements in an array, characters in a string, or fields in a record.',
    examples: ['len([1, 2, 3]) => 3', 'len("abc") => 3', 'len({a: 1}) => 1'],
  },
}

/** Whether a decoded JSON value is a non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Answer one `ontology_manifest` or `ontology_describe` request. */
function describeOntology(request) {
  const args = Array.isArray(request.args) ? request.args : []
  if (request.builtin === 'ontology_manifest') {
    respond({ success: true, result: manifest(), result_type: 'Record', metadata: metadata('ontology_manifest()') })
    return
  }
  const query = args[0]
  const echo = `ontology_describe(${JSON.stringify(query)})`
  const builtin = typeof query === 'string' ? BUILTINS[query] : undefined
  if (builtin === undefined) {
    // The ontology answers an unknown name with a successful record, not a failure.
    respond({
      success: true,
      result: {
        error: `no category or builtin named ${JSON.stringify(query)}`,
        hint: 'Call ontology_manifest for every category.',
      },
      result_type: 'Record',
      metadata: metadata(echo),
    })
    return
  }
  respond({ success: true, result: builtin, result_type: 'Record', metadata: metadata(echo) })
}

/** Answer one `len` call; every other builtin is outside this fixture's ontology. */
function callLen(request) {
  const value = (Array.isArray(request.args) ? request.args : [])[0]
  const echo = `len(${JSON.stringify(value)})`
  if (Array.isArray(value) || typeof value === 'string') {
    respond({ success: true, result: value.length, result_type: 'Number', metadata: metadata(echo) })
    return
  }
  if (isRecord(value)) {
    respond({ success: true, result: Object.keys(value).length, result_type: 'Number', metadata: metadata(echo) })
    return
  }
  refuse('len expects an array, a string, or a record', 'E_ARGUMENT', echo)
}

/** Answer one `call` request. */
function handleCall(request) {
  if (request.builtin === 'ontology_manifest' || request.builtin === 'ontology_describe') {
    describeOntology(request)
    return
  }
  if (request.builtin === 'len') {
    callLen(request)
    return
  }
  refuse(
    `unknown builtin ${JSON.stringify(request.builtin)}`,
    'E_UNKNOWN_BUILTIN',
    `<call ${JSON.stringify(request.builtin)}>`,
  )
}

/** Answer one single-step `where` pipeline over an array of records. */
function handlePipeline(request) {
  const steps = Array.isArray(request.steps) ? request.steps : []
  const step = steps.length === 1 ? steps[0] : undefined
  const echo = `<pipeline of ${steps.length} step(s)>`
  if (!isRecord(step) || step.builtin !== 'where') {
    refuse('this fixture evaluates only a single-step where pipeline', 'E_PIPELINE', echo)
    return
  }
  const predicate = typeof step.predicate === 'string' ? /^([A-Za-z_][A-Za-z0-9_]*)\s*>\s*(-?\d+(?:\.\d+)?)$/.exec(step.predicate) : null
  if (predicate === null) {
    refuse(`unsupported where predicate ${JSON.stringify(step.predicate)}`, 'E_PREDICATE', echo)
    return
  }
  const select = step.select
  if (select !== undefined && (typeof select !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(select))) {
    refuse(`unsupported select path ${JSON.stringify(select)}`, 'E_SELECT', echo)
    return
  }
  const rows = request.input
  if (!Array.isArray(rows)) {
    refuse('this fixture evaluates a where pipeline only over an array input', 'E_INPUT', echo)
    return
  }
  const [, field, bound] = predicate
  const kept = rows.filter(row => isRecord(row) && typeof row[field] === 'number' && row[field] > Number(bound))
  const result = select === undefined ? kept : kept.map(row => (isRecord(row) ? row[select] : null))
  respond({ success: true, result, result_type: 'Array', metadata: metadata(echo) })
}

/** Answer one decoded Agent API request body. */
function handleAgentApi(request) {
  if (!isRecord(request)) {
    refuse('the request body must be a JSON object', 'E_REQUEST', '<unreadable request>')
    return
  }
  switch (request.action) {
    case 'call':
      handleCall(request)
      return
    case 'pipeline':
      handlePipeline(request)
      return
    default:
      refuse(`unsupported action ${JSON.stringify(request.action)}`, 'E_REQUEST', '<unsupported action>')
  }
}

/** Read the one request document the plugin writes to stdin, then answer it. */
function serveAgentApi() {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { input += chunk })
  process.stdin.on('end', () => {
    let request
    try {
      request = JSON.parse(input)
    } catch {
      process.stderr.write('error[E_REQUEST]: stdin was not one JSON request document\n')
      process.exitCode = 2
      return
    }
    handleAgentApi(request)
  })
}

/** Evaluate the one program this scenario records on the deterministic command line. */
function serveProgram(code) {
  if (code === 'str.upper("hello")') {
    process.stdout.write('"HELLO"\n')
    return
  }
  process.stderr.write(`error[E_EVAL]: this fixture evaluates only the recorded program, not ${JSON.stringify(code)}\n`)
  process.exitCode = 1
}

if (first === 'agent' && second === 'execute') {
  serveAgentApi()
} else if (first === '--deterministic' && second === '-c') {
  serveProgram(third ?? '')
} else {
  process.stderr.write(`error[E_ARGV]: unsupported arguments ${JSON.stringify(process.argv.slice(2))}\n`)
  process.exitCode = 2
}
