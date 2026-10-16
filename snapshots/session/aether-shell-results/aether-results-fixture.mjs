/**
 * Stand-in for an AetherShell interpreter that implements the typed Agent API.
 *
 * Only the external interpreter is replaced: the plugin, the subprocess seam, the
 * file-effect policy, session persistence, and the replayed model script all stay
 * real. This scenario's patch selects `structuredDataMode: typed-v1`, so the plugin
 * asks the interpreter through the `capabilities` action before it sends any
 * argument as data.
 *
 * The modelled surface is exactly what the recorded task exercises: the
 * `capabilities` action and `ls` over this fixture's own listing. `ls` reports the
 * interpreter's directory entries, so the value travels from the interpreter
 * rather than from the request; generating that listing here is what makes one
 * complete result larger than the deployment's `maxResultBytes` budget without a
 * large request. The listing is fixed, so paging it has exactly one answer per
 * page. Every other request is refused with a coded native failure rather than
 * answered with a fabricated value, and a command line other than `agent execute`
 * fails the process before any protocol response, because the source surface is
 * not part of this scenario.
 */

const [first, second] = process.argv.slice(2)

/** The one directory this fixture lists; any other subject is refused. */
const LISTING_ROOT = '.'

/**
 * The entries `ls` reports for {@link LISTING_ROOT}, in the interpreter's own
 * order. The complete value is larger than the deployment's result budget, so a
 * successful call is retained rather than returned inline.
 */
const LISTING = Array.from({ length: 64 }, (_, index) => {
  const ordinal = String(index + 1).padStart(2, '0')
  return {
    name: `retained-record-${ordinal}.jsonl`,
    kind: 'file',
    size: 1024 + index,
    modified: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }
})

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
    error: JSON.stringify({ error: { code, message, hint: 'this scenario records the retained-result tools only', retryable: false } }),
    result_type: 'Error',
    metadata: { ...metadata(action, subject), code },
  })
}

/** Whether a decoded JSON value is a non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Answer one `ls` call: the fixture's own listing, and nothing else. */
function callLs(args) {
  if (args.length !== 1 || args[0] !== LISTING_ROOT) {
    refuse(
      `this fixture lists only ${JSON.stringify(LISTING_ROOT)}, got ${args.length} argument(s)`,
      'E_FIXTURE_SCOPE',
      'call',
      { builtin: 'ls' },
    )
    return
  }
  ok(LISTING, 'Array', 'call', { builtin: 'ls' })
}

/** Answer one `call` request. */
function handleCall(request) {
  const args = Array.isArray(request.args) ? request.args : []
  switch (request.builtin) {
    case 'ls':
      callLs(args)
      return
    default:
      // An unknown builtin is the interpreter's own reply, not a stand-in limit.
      refuse(`unknown builtin: ${JSON.stringify(request.builtin)}`, 'E_UNKNOWN_BUILTIN', 'call', { builtin: String(request.builtin) })
  }
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
