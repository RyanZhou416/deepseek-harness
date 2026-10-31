import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'vitest'
import { BASELINES } from '../baselines'
import { BASELINE_DSH_VERSION, meetsBaseline } from '../../src/shared/version'

const REPO = new URL('../..', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, REPO), 'utf8')

interface Manifest {
  engines: { dsh: string }
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
  dsh: { compatibility: { dshReleases: Record<string, string> } }
}
const manifest = JSON.parse(read('package.json')) as Manifest
const versions = BASELINES.map(baseline => baseline.version)
const floorsOf = (range: string): string[] => range.split('||').map(term => term.trim().replace(/^>=/, ''))

describe('supported-set lockstep', () => {
  test('dshReleases, baselines and the CI tag fetches name the same releases', () => {
    assert.deepEqual(manifest.dsh.compatibility.dshReleases, Object.fromEntries(versions.map(version => [version, 'compatible'])))
    for (const artifact of ['.github/workflows/pr-checks.yml', '.github/workflows/release.yml']) {
      const tags = [...read(artifact).matchAll(/refs\/tags\/(dsh-v[0-9a-z.-]+)/gi)].map(match => match[1])
      assert.deepEqual([...new Set(tags)].sort(), BASELINES.map(baseline => baseline.tag).sort(), artifact)
    }
  })

  test('engines.dsh and the dsh peer floors admit every baseline and refuse the dropped 0.1.7 line', () => {
    for (const range of [manifest.engines.dsh, ...['@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-session'].map(name => manifest.peerDependencies[name])]) {
      const floors = floorsOf(range)
      for (const version of versions) {
        assert.ok(floors.some(floor => meetsBaseline(version, floor)), `${version} inside ${range}`)
      }
      for (const floor of floors) {
        assert.equal(meetsBaseline('0.1.7-rc.2', floor), false, `${floor} refuses 0.1.7-rc.2`)
        assert.equal(meetsBaseline('0.1.7', floor), false, `${floor} refuses 0.1.7`)
      }
    }
  })

  test('the runtime floor is the lowest engines floor and the compiled dsh pins', () => {
    const floors = floorsOf(manifest.engines.dsh)
    const lowest = floors.reduce((min, floor) => (meetsBaseline(min, floor) ? floor : min))
    assert.equal(BASELINE_DSH_VERSION, lowest)
    for (const name of ['@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-util-code-language', '@deepseek-ai/dsh-util-workspace-path']) {
      assert.equal(manifest.devDependencies[name], lowest, `${name} is pinned to the floor surface`)
    }
  })
})
