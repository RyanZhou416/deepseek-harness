import { readFileSync } from 'node:fs'

const { packageManager } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const match = /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageManager)
if (match === null) {
  console.error(`Expected package.json packageManager to pin pnpm x.y.z, got ${JSON.stringify(packageManager)}.`)
  process.exitCode = 1
} else {
  console.log(match[1])
}
