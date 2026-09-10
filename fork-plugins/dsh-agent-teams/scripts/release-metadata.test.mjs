import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { releaseMetadata } from './release-metadata.mjs'
import { policy } from './compatibility.mjs'

const checkedIn = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const fixture = (version, tag) => ({
  ...structuredClone(checkedIn),
  version,
  publishConfig: { ...checkedIn.publishConfig, tag },
})

test('stable latest requires the exact recommended host cohort', () => {
  assert.deepEqual(releaseMetadata(fixture('0.1.16', 'latest')), {
    value: '0.1.16', dist_tag: 'latest', prerelease: false,
  })
  const mixed = fixture('0.1.16', 'latest')
  mixed.devDependencies['@deepseek-ai/dsh-agent'] = '0.1.2-rc.1'
  assert.throws(() => releaseMetadata(mixed), /exact development host/)
})

for (const suffix of ['alpha', 'beta', 'rc']) {
  test(`${suffix} candidates use the fork preview channel`, () => {
    const version = `0.1.16-${suffix}.1`
    assert.deepEqual(releaseMetadata(fixture(version, policy.previewTag)), {
      value: version,
      dist_tag: policy.previewTag,
      prerelease: true,
    })
    for (const tag of [undefined, 'latest', suffix]) {
      assert.throws(() => releaseMetadata(fixture(version, tag)), /publishConfig.tag/)
    }
  })
}

test('fork compatibility releases use their explicit private channel', () => {
  for (const channel of ['dsh012rc1', 'dsh013alpha2', 'dsh015alpha2', 'dsh015rc1']) {
    const version = `0.1.16-${channel}.1`
    assert.deepEqual(releaseMetadata(fixture(version, channel)), {
      value: version,
      dist_tag: channel,
      prerelease: true,
    })
  }
})

test('reject unsupported versions and unbounded peers', () => {
  for (const version of ['0.1.16-dev.1', '0.1.16-alpha.01', '0.1.16-alpha.1\n', 'v0.1.16', '0.1']) {
    assert.throws(() => releaseMetadata(fixture(version, policy.previewTag)))
  }
  const mixed = fixture('0.1.16-dsh015rc1.1', 'dsh015rc1')
  mixed.peerDependencies['@deepseek-ai/dsh-agent'] = '^0.1.5-rc.1'
  assert.throws(() => releaseMetadata(mixed), /enumerate/)
})

test('checked-in candidate has consistent dependency and release metadata', () => {
  assert.equal(releaseMetadata(checkedIn).dist_tag, checkedIn.publishConfig.tag)
})
