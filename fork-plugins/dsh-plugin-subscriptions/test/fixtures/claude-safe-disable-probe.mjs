/**
 * The no-egress guard and the one-line observation for the safe-exit wake.
 *
 * That wake is the resumed run whose private overlay disables the whole subscription plugin row,
 * so the fetch guard the subscription probe installs is not mounted there. This fixture takes that
 * job: its `apply` replaces the process-global `fetch` with a counter that refuses every use, under
 * `ctx.effect`, and restores the exact previous property descriptor when the composition is
 * disposed, so the entire wake runs with every process-global egress path closed rather than merely
 * unobserved.
 *
 * It is a guard and a reporter, nothing else: it registers no adapter, provides no service, answers
 * no request, reads no credential store or Keychain, and imports no product module, so it observes
 * the same composition on the source and artifact planes alike. The guard lands while the Loader
 * mounts this entry, and the shipped one-shot runner awaits that whole Loader tree before it
 * creates its Agent, so no request can precede the guard.
 *
 * Exactly one `CLAUDE_SAFE_DISABLE` line is written at the end of this wake's own turn, carrying
 * what the wake must show: how many times the guarded fetch was reached, whether any adapter serves
 * the route the run asked for, and whether the composition still provides the persistence reader
 * the restored records are read through. Every value comes from a public service, and the line
 * states no expected value.
 */

export const name = 'claude-safe-disable-probe'

/** The public services this fixture reads: the route list and the Session persistence reader. */
export const inject = ['llm', 'sessionPersistence']

/** Prefix of the one line this fixture writes. */
const MARKER = 'CLAUDE_SAFE_DISABLE'

/** The route the resumed run asks for. */
const ROUTE = 'claude'

/**
 * Refuse every process-global fetch for the rest of this composition's life.
 *
 * The exact previous property descriptor is captured first and returned as the restoration, so a
 * host that already stated its own fetch keeps it.
 * @param counter - the call counter the report reads.
 * @returns the restoration, idempotent so a failure path may also run it.
 */
function installEgressGuard(counter) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  globalThis.fetch = async (input) => {
    counter.calls += 1
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? input)
    throw new Error(`claude-safe-disable-probe: the resumed composition reached the process-global fetch (${url})`)
  }
  return () => {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'fetch')
    else Object.defineProperty(globalThis, 'fetch', previous)
  }
}

/**
 * Write this wake's one observation line.
 * @param ctx - composition context carrying the public route list and persistence reader.
 * @param counter - the process-global fetch call counter.
 */
function report(ctx, counter) {
  process.stdout.write(`${MARKER} ${JSON.stringify({
    pid: process.pid,
    fetchCalls: counter.calls,
    claudeRoutePresent: ctx.llm.listProviders().some(provider => provider.id === ROUTE),
    recordReaderAvailable: ctx.get('sessionPersistence') !== undefined,
  })}\n`)
}

/**
 * Install the guard, then report once when this wake's own turn ends.
 * @param ctx - composition context carrying the public route list and persistence reader.
 */
export function apply(ctx) {
  const counter = { calls: 0 }
  const restoreFetch = installEgressGuard(counter)
  ctx.effect(() => restoreFetch, 'claude-safe-disable-probe: process-global fetch guard')
  let reported = false
  ctx.on('session/event', (_session, event) => {
    if (reported || event.type !== 'turn/end') return
    reported = true
    report(ctx, counter)
  })
}
