/**
 * Regression: a cold captain is attached through the Session Controller's
 * ordinary-Session resolve operation, never through create (which may mint a
 * new Session and leave the recorded captain absent).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { resumeLeadAnchor } from '../lib/tools.js'

const team = { name: 'cold-captain', captainSessionId: 'session-captain' }
const captain = { id: 'session-captain' }

test('cold captain uses resolveAgent and never create', async () => {
  let resolved = 0
  const ctx = {
    agents: { resume: async () => { throw new Error('the fallback must not run') } },
    get: (name) => name === 'sessionController'
      ? {
          create: async () => { throw new Error('create must not run for a non-blank captain') },
          resolveAgent: async (id) => {
            resolved += 1
            assert.equal(id, 'session-captain')
            return { agent: captain }
          },
        }
      : undefined,
    logger: { warn: () => undefined },
  }
  assert.equal(await resumeLeadAnchor(ctx, team), captain)
  assert.equal(resolved, 1)
})

test('a failed resolve is reported without inventing a new captain', async () => {
  const ctx = {
    agents: { resume: async () => { throw new Error('the fallback must not run') } },
    get: (name) => name === 'sessionController'
      ? { resolveAgent: async () => ({ error: { message: 'session not found' } }) }
      : undefined,
    logger: { warn: () => undefined },
  }
  assert.equal(await resumeLeadAnchor(ctx, team), undefined)
})

test('a Host without resolveAgent falls back to Agent resume', async () => {
  let resumed = 0
  const ctx = {
    agents: {
      resume: async ({ resumeSessionId }) => {
        resumed += 1
        assert.equal(resumeSessionId, 'session-captain')
        return { agent: captain, dispose: () => undefined }
      },
    },
    get: () => undefined,
    effect: () => () => undefined,
    logger: { warn: () => undefined },
  }
  assert.equal(await resumeLeadAnchor(ctx, team), captain)
  assert.equal(resumed, 1)
})
