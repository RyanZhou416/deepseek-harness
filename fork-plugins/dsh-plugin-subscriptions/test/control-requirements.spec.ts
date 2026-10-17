/**
 * The control-obligation core, on synthetic inputs only: the tri-state one adopted
 * `policy_limits` document states for `require_trusted_devices` and
 * `enforce_web_search_mcp_isolation`, the classification that keeps exactly those two keys out of
 * the operation-permission namespace, and the active ones this build provides no capability for.
 *
 * The module is pure, so the static assertions below read its own source text: importing it
 * cannot prove it reaches no registry, transport or HTTP client, and a verdict that arrives as
 * `unknown` instead of refusing a malformed document is invisible from a single return value.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  controlRequirements,
  isKnownControlKey,
  KNOWN_CONTROL_KEYS,
  parsePolicyLimitsDocument,
} from '../src/claude-core/index.js'
import type { PolicyLimitsDocument } from '../src/claude-core/index.js'
import { sourceUrl } from './source-url.js'

const SOURCE_URL = sourceUrl('claude-core/control-requirements.ts')

/**
 * One document the envelope's own parser accepted.
 *
 * The fixtures go through the real parser rather than a hand-built literal: the control reader
 * must be exercised on exactly the value production hands it, and the parser is what refuses a
 * malformed verdict before this module ever sees it.
 * @param restrictions - the server's per-key verdicts.
 * @returns the accepted document.
 */
function accepted(restrictions: Record<string, { allowed: boolean }>): PolicyLimitsDocument {
  const parsed = parsePolicyLimitsDocument({ restrictions })
  if (parsed.ok) return parsed.document
  throw new Error(`the synthetic body must be an accepted document (${parsed.failure.code})`)
}

test('the verdict is the document own boolean, and a missing control is unknown', () => {
  assert.deepEqual(controlRequirements(accepted({
    require_trusted_devices: { allowed: true },
    enforce_web_search_mcp_isolation: { allowed: true },
  })), {
    trustedDevices: 'active',
    webSearchMcpIsolation: 'active',
    unsupportedActiveControls: ['trusted-devices', 'web-search-mcp-isolation'],
  })

  assert.deepEqual(controlRequirements(accepted({
    require_trusted_devices: { allowed: false },
    enforce_web_search_mcp_isolation: { allowed: false },
  })), {
    trustedDevices: 'not-enforced',
    webSearchMcpIsolation: 'not-enforced',
    unsupportedActiveControls: [],
  })

  // A document that answers one control leaves the other unanswered, which is not a refusal
  // and not a statement that the requirement was dropped.
  assert.deepEqual(controlRequirements(accepted({ require_trusted_devices: { allowed: true } })), {
    trustedDevices: 'active',
    webSearchMcpIsolation: 'unknown',
    unsupportedActiveControls: ['trusted-devices'],
  })
  assert.deepEqual(controlRequirements(accepted({ enforce_web_search_mcp_isolation: { allowed: false } })), {
    trustedDevices: 'unknown',
    webSearchMcpIsolation: 'not-enforced',
    unsupportedActiveControls: [],
  })
})

test('a document that answers neither control reports no requirement at all', () => {
  // Answering `unknown` for both would present "the server said nothing" as an observation, and
  // a caller could not tell it apart from a requirement that was read.
  assert.equal(controlRequirements(accepted({})), undefined)
  assert.equal(controlRequirements(accepted({ allow_web_fetch: { allowed: false } })), undefined)
})

test('the unsupported list is distinct, ordered, and carries only controls in force', () => {
  const both = controlRequirements(accepted({
    require_trusted_devices: { allowed: true },
    enforce_web_search_mcp_isolation: { allowed: true },
  }))
  assert.deepEqual(both?.unsupportedActiveControls, ['trusted-devices', 'web-search-mcp-isolation'])
  assert.equal(new Set(both?.unsupportedActiveControls).size, both?.unsupportedActiveControls.length)

  // A control that is not in force contributes no member, whether it was refused or unanswered.
  const mixed = controlRequirements(accepted({
    require_trusted_devices: { allowed: false },
    enforce_web_search_mcp_isolation: { allowed: true },
  }))
  assert.deepEqual(mixed, {
    trustedDevices: 'not-enforced',
    webSearchMcpIsolation: 'active',
    unsupportedActiveControls: ['web-search-mcp-isolation'],
  })
  assert.deepEqual(controlRequirements(accepted({ require_trusted_devices: { allowed: true } }))
    ?.unsupportedActiveControls, ['trusted-devices'])
})

test('a verdict that is not a boolean refuses the whole document instead of reading as unknown', () => {
  // Every one of these is a malformed verdict, `allowed: null` included. The envelope's parser
  // refuses the document, so no adopted document can carry one and this module can never be
  // handed a value it would have to downgrade into "nothing was required".
  for (const entry of [{ allowed: null }, { allowed: 'true' }, { allowed: 1 }, { allowed: {} }, {}, null, 'true']) {
    const parsed = parsePolicyLimitsDocument({
      restrictions: { require_trusted_devices: entry, allow_web_fetch: { allowed: true } },
    })
    assert.equal(parsed.ok, false, `the malformed control verdict refused the document: ${JSON.stringify(entry)}`)
    assert.equal(parsed.ok === false ? parsed.failure.code : undefined, 'parse_failed')
  }
})

test('a key outside the control family contributes no requirement', () => {
  // A key the pinned registry happens to know, and one it does not, are both outside this
  // module's two controls: neither adds a member, and neither becomes a refusal here.
  const requirements = controlRequirements(accepted({
    require_trusted_devices: { allowed: true },
    allow_web_fetch: { allowed: true },
    allow_something_new: { allowed: true },
  }))
  assert.deepEqual(requirements, {
    trustedDevices: 'active',
    webSearchMcpIsolation: 'unknown',
    unsupportedActiveControls: ['trusted-devices'],
  })
  assert.equal(JSON.stringify(requirements).includes('allow_web_fetch'), false)
  assert.equal(JSON.stringify(requirements).includes('allow_something_new'), false)
})

test('the classification is exactly the two evidenced control keys, never a prefix', () => {
  assert.deepEqual(KNOWN_CONTROL_KEYS, ['require_trusted_devices', 'enforce_web_search_mcp_isolation'])
  for (const key of KNOWN_CONTROL_KEYS) assert.equal(isKnownControlKey(key), true, key)
  // A name that merely shares the prefix, a key from the operation-permission family, and an
  // empty name are all outside the classification: the exclusion is a closed list of two keys,
  // so no other `require_`/`enforce_` key loses the conservative answer it has today.
  for (const key of [
    'require_something_else', 'enforce_something_else', 'require_', 'enforce_',
    'require_trusted_devices_v2', 'allow_web_fetch', 'allow_something_new', '',
  ]) {
    assert.equal(isKnownControlKey(key), false, key)
  }
  // The classification covers exactly the keys the derivation reads: stating either one makes
  // the derivation answer, while a prefix lookalike leaves it with nothing to report.
  for (const key of KNOWN_CONTROL_KEYS) {
    assert.notEqual(controlRequirements(accepted({ [key]: { allowed: true } })), undefined, key)
  }
  assert.equal(controlRequirements(accepted({ require_something_else: { allowed: true } })), undefined)
  assert.equal(controlRequirements(accepted({ enforce_something_else: { allowed: true } })), undefined)
})

test('the module reaches no registry, transport or HTTP client', () => {
  // Comment lines may name what the module must not do; the executable text may not.
  const executable = readFileSync(SOURCE_URL, 'utf8')
    .split('\n')
    .filter(line => !/^\s*(?:\/\*|\*|\/\/)/.test(line))
    .join('\n')
  for (const forbidden of [
    'limitsKeysFor', 'PolicyKeyMapping', 'POLICY_KEYS', 'POLICY_KEY_REGISTRY', 'sn(', 'Fzt', 'fetch', 'http',
  ]) {
    assert.equal(executable.includes(forbidden), false, `the module must not reach ${forbidden}`)
  }
})
