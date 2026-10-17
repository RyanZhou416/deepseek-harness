/**
 * Activity-state selection contract: a legacy request keeps the panel's full
 * payload, a scoped request selects only its own teams, and malformed scope
 * rejects instead of silently scanning every team.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ActivityQueryError, parseActivityQuery } from '../src/activity-query.ts'

const BASE = 'http://verify/plugins/dsh-agent-teams/state'

const parse = (search = '') => parseActivityQuery(new URL(`${BASE}${search}`))

test('legacy requests keep full detail and inbox previews', () => {
  for (const search of ['', '?archived=1']) {
    const query = parse(search)
    assert.equal(query.archived, search.includes('archived=1'))
    assert.deepEqual(query.options, { includeDetails: true, includeCaptainInbox: true })
  }
})

test('a captain-scoped request selects that captain and a slim payload', () => {
  const query = parse('?captainSessionId=captain-a')
  assert.deepEqual(query.options, {
    captainSessionId: 'captain-a',
    includeDetails: false,
    includeCaptainInbox: false,
  })
})

test('explicit team targets pair a captain with its team id', () => {
  const query = parse('?teamCaptainSessionId=captain-a&teamId=team-a')
  assert.deepEqual(query.options.targets, [{ captainSessionId: 'captain-a', teamId: 'team-a' }])
  assert.equal(query.options.includeDetails, false)
})

test('detail=1 opts a scoped request back into staged authoring fields', () => {
  const query = parse('?captainSessionId=captain-a&detail=1')
  assert.equal(query.options.includeDetails, true)
  assert.equal(query.options.includeCaptainInbox, false)
})

test('malformed scope rejects instead of scanning every team', () => {
  for (const search of [
    '?captainSessionId=',
    '?teamId=team-a',
    '?teamCaptainSessionId=captain-a',
    '?teamCaptainSessionId=&teamId=team-a',
    '?detail=1',
    '?captainSessionId=captain-a&detail=0',
    '?captainSessionId=one&captainSessionId=two',
  ]) {
    assert.throws(() => parse(search), ActivityQueryError, search)
  }
})
