/** Run after the plugin build: declaration-only Host exports must never become runtime imports. */
import assert from 'node:assert/strict'
import { resolveConfig } from '../lib/lifecycle.mjs'

assert.equal(resolveConfig().promoteOnTimeout, true)
assert.equal(resolveConfig({ promoteOnTimeout: false }).promoteOnTimeout, false)
assert.equal(resolveConfig().maxBackgroundRuntimeMs, 0)
console.log('AetherShell built module imports with independent query wait/runtime configuration')
