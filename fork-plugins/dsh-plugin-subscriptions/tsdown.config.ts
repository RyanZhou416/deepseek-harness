/**
 * Standalone tsdown config for the browser client bundle, replicating the
 * deepseek-harness closure-factory recipe (packages/client/tsdown.client.ts,
 * function clientConfig) for this out-of-tree plugin: the bundle calls
 * window.__ModuleLoader__.load({id, factory}) and resolves externals through
 * the injected require (the shell's loader module table). The node half
 * (lib/index.js) is emitted by tsc, not here — `clean` stays off so this
 * bundle never wipes it.
 *
 * The shared option object lives in `tsdown.client.options.mjs` so repository
 * staging builds can apply the same client recipe with the root toolchain.
 */
import { defineConfig } from 'tsdown'
import { clientBuildOptions } from './tsdown.client.options.mjs'

export default defineConfig(clientBuildOptions)
