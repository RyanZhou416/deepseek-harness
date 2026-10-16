import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../src/index.js'
import { DEFAULT_MAX_QUEUED_BYTES } from '../src/transport/bridge.js'
import { configureClaudeTransport, stopBridge } from '../src/transport/claude-fetch.js'

test('Claude unread response limit resolves from plugin config', () => {
  assert.equal(Config({}).claudeTransportMaxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES)
  assert.equal(Config({ claudeTransportMaxQueuedBytes: 4096 }).claudeTransportMaxQueuedBytes, 4096)
})

test('Claude unread response limit rejects invalid config before starting a child', async () => {
  try {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => configureClaudeTransport(value), /positive safe integer/)
    }
    for (const value of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => Config({ claudeTransportMaxQueuedBytes: value }))
    }
    configureClaudeTransport(4096)
  } finally {
    await stopBridge()
    configureClaudeTransport(DEFAULT_MAX_QUEUED_BYTES)
  }
})
