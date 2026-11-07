import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FRPC_HASHES,
  FRPC_PLATFORM_KEYS,
  frpcAssetName,
  frpcHashKey,
  resolveRelayConfig,
} from '../../src/config.ts'

describe('relay configuration', () => {
  it('pins every platform of the 0.71.0 release to its official archive hash', () => {
    for (const platform of FRPC_PLATFORM_KEYS) {
      const hash = DEFAULT_FRPC_HASHES[frpcHashKey('0.71.0', platform)]
      expect(hash).toMatch(/^[0-9a-f]{64}$/u)
    }
    expect(DEFAULT_FRPC_HASHES['0.71.0/win32-x64']).toBe('9e5062e3e5cf07e67144a3a4acf175ef6a2486f3605dd6cf288bae34ab39819f')
    expect(DEFAULT_FRPC_HASHES['0.71.0/linux-arm64']).toBe('f33c293c275d8fc68c654b6fba8f10b2551d6463d09a9fc9cffb7227eae82266')
  })

  it('applies every default without sharing the hash table', () => {
    const first = resolveRelayConfig({})
    const second = resolveRelayConfig({})
    expect(first.requestTimeoutMs).toBe(20_000)
    expect(first.reconnectInitialDelayMs).toBe(1_000)
    expect(first.reconnectMaxDelayMs).toBe(60_000)
    expect(first.frpcPath).toBeUndefined()
    first.frpcHashes['0.71.0/linux-x64'] = 'a'.repeat(64)
    expect(second.frpcHashes['0.71.0/linux-x64']).not.toBe('a'.repeat(64))
  })

  it('rejects a malformed pinned hash', () => {
    expect(() => resolveRelayConfig({ frpcHashes: { '0.71.0/linux-x64': 'nope' } })).toThrow()
  })

  it('rejects a reconnect ceiling below the initial delay', () => {
    expect(() => resolveRelayConfig({ reconnectInitialDelayMs: 500, reconnectMaxDelayMs: 100 })).toThrow(/reconnectMaxDelayMs/u)
  })

  it('derives official archive names per platform', () => {
    expect(frpcAssetName('0.71.0', 'win32', 'x64')).toBe('frp_0.71.0_windows_amd64.zip')
    expect(frpcAssetName('0.71.0', 'win32', 'arm64')).toBe('frp_0.71.0_windows_arm64.zip')
    expect(frpcAssetName('0.71.0', 'darwin', 'arm64')).toBe('frp_0.71.0_darwin_arm64.tar.gz')
    expect(frpcAssetName('0.71.0', 'linux', 'x64')).toBe('frp_0.71.0_linux_amd64.tar.gz')
  })
})
