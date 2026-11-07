/**
 * Stand-in frpc for supervisor tests. It prints the markers the real client
 * prints and keeps running until it is killed.
 */
const mode = process.argv[2] ?? 'success'

function keepAlive() {
  setInterval(() => {}, 1_000)
}

function line(text) {
  process.stdout.write(`${text}\n`)
}

switch (mode) {
  case 'success':
    line('login to server success')
    line('start proxy success')
    keepAlive()
    break
  case 'fail':
    line('login to server failed: unit test refusal')
    process.exitCode = 1
    break
  case 'crash':
    line('login to server success')
    line('start proxy success')
    setTimeout(() => { process.exit(3) }, 20)
    break
  case 'silent':
    keepAlive()
    break
  case 'slow':
    setTimeout(() => {
      line('login to server success')
      line('start proxy success')
    }, 80)
    keepAlive()
    break
  case 'priority':
    // Report the scheduling priority after the supervisor had time to adjust it.
    setTimeout(async () => {
      const { getPriority } = await import('node:os')
      line(`priority ${String(getPriority())}`)
      line('login to server success')
      line('start proxy success')
    }, 200)
    keepAlive()
    break
  default:
    line(`unknown fake frpc mode ${mode}`)
    process.exitCode = 2
}
