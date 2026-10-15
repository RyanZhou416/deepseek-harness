/**
 * Stand-in for an AetherShell interpreter that implements the typed Agent API.
 *
 * Only the external interpreter is replaced: the plugin, the subprocess seam, the
 * file-effect policy, session persistence, and the replayed model script all stay
 * real. This scenario's patch selects `structuredDataMode: typed-v1`, so the plugin
 * asks the interpreter through the `capabilities` action before every request and
 * then sends each `call` argument and pipeline seed as data. The value semantics
 * modelled here are the ones the interpreter's own typed Agent API declares: a
 * request value is never rendered into AetherShell source, so no argument is
 * interpolated, re-parsed, or dropped.
 *
 * The envelopes follow the typed API: metadata reports `structured_data` and the
 * action, and never the `code_executed`/`code_attempted` echo of rendered source.
 *
 * The modelled surface is exactly what the recorded task exercises: the
 * `capabilities` action, `first`, `char_len`, and the `type_of` and `reverse`
 * pipeline steps with an optional `select` field path. Every other request is
 * refused with a coded native failure rather than answered with a fabricated
 * value, and an unsupported command line fails the process before any protocol
 * response.
 */

const [first, second] = process.argv.slice(2)

/** The capability record a typed-channel interpreter reports. */
const CAPABILITIES = {
  protocol: 'aethershell-agent-api',
  protocol_version: 1,
  features: {
    typed_arguments_v1: true,
    typed_pipeline_input_v1: true,
    explicit_null_pipeline_input_v1: true,
  },
}

/** Metadata a request that carries data reports: how it was served and what it cost. */
function metadata(action, subject) {
  return {
    structured_data: 'typed-v1',
    action,
    ...subject,
    token_accounting: { estimated: true, tokens_in: 1, tokens_out: 1, tokens_total: 2 },
  }
}

/** Write one Agent API response envelope: exactly one JSON document on stdout. */
function respond(envelope) {
  process.stdout.write(`${JSON.stringify(envelope)}\n`)
}

/** Answer one request with a value. */
function ok(result, resultType, action, subject) {
  respond({ success: true, result, result_type: resultType, metadata: metadata(action, subject) })
}

/** Refuse one request inside a successful process, which is what the Agent API does. */
function refuse(message, code, action, subject) {
  respond({
    success: false,
    error: JSON.stringify({ error: { code, message, hint: 'this scenario records the typed argument channel only', retryable: false } }),
    result_type: 'Error',
    metadata: { ...metadata(action, subject), code },
  })
}

/** Whether a decoded JSON value is a non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The native type name of a decoded request value. */
function typeName(value) {
  if (value === null) return 'Null'
  if (Array.isArray(value)) return 'Array'
  switch (typeof value) {
    case 'boolean': return 'Bool'
    case 'number': return Number.isInteger(value) ? 'Int' : 'Float'
    case 'string': return 'String'
    default: return 'Record'
  }
}

/** Unicode scalar values in a string, which is what `char_len` counts. */
function scalarCount(text) {
  return [...text].length
}

/**
 * Answer one `first` call: one array in, its first element out.
 *
 * `first` returns the element itself, not a rendering of it, so the record this
 * scenario sends back arrives as the record the request carried. An empty array
 * or a non-positive count answers an empty array, which is what the builtin does.
 */
function callFirst(args) {
  const subject = args[0]
  const count = args[1]
  if (!Array.isArray(subject)) {
    refuse(`first requires an array, got ${typeName(subject)}`, 'E_BAD_ARG', 'call', { builtin: 'first' })
    return
  }
  if (count !== undefined && !Number.isInteger(count)) {
    refuse(`first requires an integer count, got ${typeName(count)}`, 'E_BAD_ARG', 'call', { builtin: 'first' })
    return
  }
  const take = count ?? 1
  if (take <= 0) {
    ok([], 'Array', 'call', { builtin: 'first' })
    return
  }
  if (take === 1) {
    if (subject.length === 0) {
      ok([], 'Array', 'call', { builtin: 'first' })
      return
    }
    ok(subject[0], typeName(subject[0]), 'call', { builtin: 'first' })
    return
  }
  ok(subject.slice(0, take), 'Array', 'call', { builtin: 'first' })
}

/** Answer one `char_len` call: one string in, its scalar-value count out. */
function callCharLen(args) {
  if (args.length !== 1 || typeof args[0] !== 'string') {
    refuse('char_len takes one string', 'E_BAD_ARG', 'call', { builtin: 'char_len' })
    return
  }
  ok(scalarCount(args[0]), 'Int', 'call', { builtin: 'char_len' })
}

/** Answer one `call` request. */
function handleCall(request) {
  const args = Array.isArray(request.args) ? request.args : []
  switch (request.builtin) {
    case 'first':
      callFirst(args)
      return
    case 'char_len':
      callCharLen(args)
      return
    default:
      // An unknown builtin is the interpreter's own reply, not a stand-in limit.
      refuse(`unknown builtin: ${JSON.stringify(request.builtin)}`, 'E_UNKNOWN_BUILTIN', 'call', { builtin: String(request.builtin) })
  }
}

/** Read one literal field path out of a record, refusing a missing field rather than inventing null. */
function selectField(record, path) {
  let current = record
  for (const segment of path.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return { missing: segment }
    current = current[segment]
  }
  return { value: current }
}

/** Apply one `select` path to a step result, which must be an array of records. */
function applySelect(result, select) {
  if (!Array.isArray(result)) {
    return { error: { message: `select requires an array subject, got ${typeName(result)}`, code: 'E_BAD_ARG' } }
  }
  const projected = []
  for (const item of result) {
    const selected = selectField(item, select)
    if (selected.missing !== undefined) {
      return { error: { message: `no field ${JSON.stringify(selected.missing)} in the selected path ${JSON.stringify(select)}`, code: 'E_UNKNOWN_FIELD' } }
    }
    projected.push(selected.value)
  }
  return { value: projected }
}

/** Answer one single-step `pipeline` request over its seed. */
function handlePipeline(request) {
  const steps = Array.isArray(request.steps) ? request.steps : []
  const step = steps.length === 1 ? steps[0] : undefined
  if (!isRecord(step)) {
    refuse(`this scenario records a one-step pipeline, got ${steps.length} step(s)`, 'E_FIXTURE_SCOPE', 'pipeline', {})
    return
  }
  const subject = { builtin: String(step.builtin) }
  // An explicit null seed and an omitted seed are different requests; the typed
  // channel is what carries that difference, so it is read rather than inferred.
  if (!Object.hasOwn(request, 'input')) {
    refuse(`${String(step.builtin)} has no value to read: the request carries no seed`, 'E_BAD_ARG', 'pipeline', subject)
    return
  }
  const seed = request.input
  let result
  switch (step.builtin) {
    case 'type_of':
      result = typeName(seed)
      break
    case 'reverse':
      if (!Array.isArray(seed)) {
        refuse(`reverse requires an array, got ${typeName(seed)}`, 'E_BAD_ARG', 'pipeline', subject)
        return
      }
      result = [...seed].reverse()
      break
    default:
      refuse(`unknown builtin: ${JSON.stringify(step.builtin)}`, 'E_UNKNOWN_BUILTIN', 'pipeline', subject)
      return
  }
  if (step.select !== undefined) {
    if (typeof step.select !== 'string') {
      refuse('select must be a field path', 'E_BAD_ARG', 'pipeline', subject)
      return
    }
    const selected = applySelect(result, step.select)
    if (selected.error !== undefined) {
      refuse(selected.error.message, selected.error.code, 'pipeline', subject)
      return
    }
    result = selected.value
  }
  ok(result, typeName(result), 'pipeline', subject)
}

/** Answer one decoded Agent API request body. */
function handleAgentApi(request) {
  if (!isRecord(request)) {
    refuse('the request body must be a JSON object', 'E_REQUEST', 'unknown', {})
    return
  }
  switch (request.action) {
    case 'capabilities':
      ok(CAPABILITIES, 'Capabilities', 'capabilities', {})
      return
    case 'call':
      handleCall(request)
      return
    case 'pipeline':
      handlePipeline(request)
      return
    default:
      refuse(`unsupported action ${JSON.stringify(request.action)}`, 'E_REQUEST', 'unknown', {})
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

if (first === 'agent' && second === 'execute') {
  serveAgentApi()
} else {
  // `--deterministic -c` is the source surface, which this scenario does not record.
  process.stderr.write(`error[E_ARGV]: this fixture answers the Agent API only, not ${JSON.stringify(process.argv.slice(2))}\n`)
  process.exitCode = 2
}
