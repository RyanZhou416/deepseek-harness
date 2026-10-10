import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'
import { MIN_CONNECT_ATTEMPT_TIMEOUT_MS, proxyGetConfig, proxySetConfig } from '../src/http.js'

/**
 * The plugin raises the Happy Eyeballs attempt budget on its own undici agent.
 *
 * Raising the Node default instead would change dialing for the host and for
 * every other provider, and no later restoration stays correct while another
 * holder can be live — so nothing this module does may move the process value.
 */
test('the connect budget never touches the process-wide net default', async () => {
  const sentinel = MIN_CONNECT_ATTEMPT_TIMEOUT_MS + 4242
  const original = getDefaultAutoSelectFamilyAttemptTimeout()
  try {
    setDefaultAutoSelectFamilyAttemptTimeout(sentinel)
    await proxySetConfig({ enabled: false, url: '', bypass: [] })
    await proxyGetConfig()
    assert.equal(
      getDefaultAutoSelectFamilyAttemptTimeout(),
      sentinel,
      'the process default is left exactly as the caller set it',
    )
  } finally {
    setDefaultAutoSelectFamilyAttemptTimeout(original)
  }
})
