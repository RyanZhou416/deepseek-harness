/** Give every Node test process a private Harness home before plugin imports run. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const previous = process.env.DSH_HOME
const temporaryRoot = realpathSync(tmpdir())
const testHome = realpathSync(mkdtempSync(join(temporaryRoot, 'dsh-subscriptions-test-')))
const leaf = relative(temporaryRoot, testHome)
if (!/^dsh-subscriptions-test-[^\\/]+$/.test(leaf)) throw new Error('test home escaped the temporary root')
process.env.DSH_HOME = testHome

process.on('exit', () => {
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
  rmSync(testHome, { recursive: true, force: true })
})
