#!/usr/bin/env node
/**
 * Deterministic stand-in for the AetherShell interpreter's background path.
 *
 * A background job reaches the interpreter through the command line only
 * (`--deterministic -c <program>`), never through the Agent API, so this fixture
 * implements exactly that one channel and nothing else. Each directive is a
 * program that exercises one lifecycle fact the background tool must report
 * truthfully: raw output on both streams, output written while the process is
 * still alive, a nonzero exit, a program that outlives a deadline, an
 * oversized stream, and the child's own environment.
 *
 * Scenario selection is by program text, never by environment, so a test cannot
 * accidentally pass because ambient state chose the branch. Anything this
 * fixture does not recognize fails loudly.
 */

/** Never settle, so the plugin's deadline and cancellation paths own the exit. */
function hang() {
  // A referenced interval keeps the event loop alive; the fixture must stay
  // running until the plugin terminates its managed process range.
  setInterval(() => {}, 1_000)
  process.on('SIGTERM', () => { process.exit(0) })
  process.on('SIGINT', () => { process.exit(0) })
}

/** Wait one delay, then exit with the given code. */
function later(ms, code) {
  setTimeout(() => { process.exitCode = code }, ms)
}

/** Write text to stdout, then hand control to the continuation once the bytes are out. */
function writeLine(text, next) {
  process.stdout.write(`${text}\n`, () => { next() })
}

/**
 * Answer one `--deterministic -c` program.
 * @param {string} raw - the directive text the plugin passed as one argv element.
 */
function answer(raw) {
  const body = raw.slice(3)
  const separator = body.indexOf(':')
  const verb = separator === -1 ? body : body.slice(0, separator)
  const argument = separator === -1 ? '' : body.slice(separator + 1)
  switch (verb) {
    case 'echo':
      return writeLine(argument, () => { process.exitCode = 0 })
    case 'mixed':
      // A program that prints prose and then a JSON document: neither is a
      // native result envelope, and a job must report it as a completed run.
      return writeLine(argument, () => {
        process.stdout.write('{"ok":true}\n', () => { process.exitCode = 0 })
      })
    case 'stderr':
      process.stderr.write(`${argument}\n`, () => { process.exitCode = 0 })
      return undefined
    case 'logthenhang':
      return writeLine(argument, () => {
        // One diagnostic line before hanging, so a test can prove both streams
        // reached the ring while the process was still alive.
        process.stderr.write('bg-diagnostic\n', () => { hang() })
      })
    case 'ticks': {
      const [countText, delayText] = argument.split(':')
      const count = Number(countText)
      const delay = Number(delayText)
      let index = 0
      const tick = () => {
        if (index >= count) {
          process.exitCode = 0
          return
        }
        index += 1
        writeLine(`tick ${index}`, () => { setTimeout(tick, delay) })
      }
      tick()
      return undefined
    }
    case 'exit':
      process.exitCode = Number(argument)
      return undefined
    case 'slowexit': {
      const [delayText, codeText] = argument.split(':')
      return later(Number(delayText), Number(codeText))
    }
    case 'big':
      process.stdout.write('z'.repeat(Number(argument)), () => { process.exitCode = 0 })
      return undefined
    case 'pwd':
      return writeLine(process.cwd(), () => { process.exitCode = 0 })
    case 'env': {
      const control = new Set(['AETHER_MODE', 'AE_DETERMINISTIC', 'AETHER_ALLOW_SH'])
      const ambient = Object.keys(process.env).filter(name => /^(?:AETHER|AE)_/i.test(name) && !control.has(name))
      const dsh = Object.keys(process.env).filter(name => name.startsWith('DSH_'))
      const facts = [
        `mode=${process.env.AETHER_MODE ?? 'unset'}`,
        `deterministic=${process.env.AE_DETERMINISTIC ?? 'unset'}`,
        `allowSh=${process.env.AETHER_ALLOW_SH ?? 'unset'}`,
        `noColor=${process.env.NO_COLOR ?? 'unset'}`,
        `ambient=${ambient.length}`,
        `dsh=${dsh.length}`,
      ].join(' ')
      return writeLine(facts, () => { process.exitCode = 0 })
    }
    default:
      process.stderr.write(`error[E_BG_FIXTURE]: unknown background directive ${JSON.stringify(verb)}\n`)
      process.exitCode = 1
      return undefined
  }
}

const [, , ...argv] = process.argv
if (argv.includes('--deterministic') && argv.includes('-c')) {
  const program = argv[argv.indexOf('-c') + 1]
  if (typeof program !== 'string' || !program.startsWith('bg:')) {
    process.stderr.write(`error[E_BG_FIXTURE]: expected a bg: directive, got ${JSON.stringify(String(program))}\n`)
    process.exitCode = 2
  } else {
    answer(program)
  }
} else {
  process.stderr.write(`Error: background fixture received an unsupported argv: ${JSON.stringify(argv)}\n`)
  process.exitCode = 2
}
