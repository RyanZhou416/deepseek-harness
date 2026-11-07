import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  renderFrpcConfig,
  relayRunDirectory,
  writeRelayRunFiles,
} from '../../src/frpc-config.ts'
import type { RelayTunnel } from '../../src/protocol.ts'

const TUNNEL: RelayTunnel = {
  frpVersion: '0.71.0',
  serverAddr: '203.0.113.10',
  serverPort: 80,
  websocketPath: '/~!frp',
  tlsServerName: '203.0.113.10',
  caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
  sharedToken: 'shared-token',
  user: 'ryan',
  frpToken: 'user-token',
  remotePort: 13080,
}

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('frpc configuration', () => {
  it('renders the established websocket + TLS profile from the tunnel only', () => {
    const config = renderFrpcConfig({
      tunnel: TUNNEL,
      username: 'ryan',
      localPort: 3080,
      sharedTokenPath: '/run/frp-shared-token',
      caCertificatePath: '/run/frp-ca.crt',
    })
    expect(config).toContain('serverAddr = "203.0.113.10"')
    expect(config).toContain('serverPort = 80')
    expect(config).toContain('user = "ryan"')
    expect(config).toContain('metadatas.frpToken = "user-token"')
    expect(config).toContain('auth.tokenSource.file.path = "/run/frp-shared-token"')
    expect(config).toContain('transport.protocol = "websocket"')
    expect(config).not.toContain('websocket.path')
    expect(config).toContain('transport.tls.enable = true')
    expect(config).toContain('transport.tls.trustedCaFile = "/run/frp-ca.crt"')
    expect(config).toContain('transport.tls.serverName = "203.0.113.10"')
    expect(config).toContain('name = "dsh-ryan"')
    expect(config).toContain('localIP = "127.0.0.1"')
    expect(config).toContain('localPort = 3080')
    expect(config).toContain('remotePort = 13080')
    expect(config.endsWith('\n')).toBe(true)
  })

  it('escapes TOML strings', () => {
    const config = renderFrpcConfig({
      tunnel: { ...TUNNEL, frpToken: 'quote" and \\ backslash' },
      username: 'ryan',
      localPort: 3080,
      sharedTokenPath: '/run/token',
      caCertificatePath: '/run/ca',
    })
    expect(config).toContain('metadatas.frpToken = "quote\\" and \\\\ backslash"')
  })

  it('writes owner-only run files', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-relay-config-'))
    const runDirectory = relayRunDirectory(root)
    const files = await writeRelayRunFiles(runDirectory, { tunnel: TUNNEL, username: 'ryan', localPort: 3080 })
    expect(files.runDirectory).toBe(runDirectory)
    expect(await readFile(files.sharedTokenPath, 'utf8')).toBe('shared-token\n')
    expect(await readFile(files.caCertificatePath, 'utf8')).toBe(`${TUNNEL.caPem}\n`)
    const config = await readFile(files.configPath, 'utf8')
    expect(config).toContain(`auth.tokenSource.file.path = ${JSON.stringify(files.sharedTokenPath)}`)
    expect(config).toContain('remotePort = 13080')
    if (process.platform !== 'win32') {
      expect((await stat(files.configPath)).mode & 0o777).toBe(0o600)
      expect((await stat(files.sharedTokenPath)).mode & 0o777).toBe(0o600)
      expect((await stat(runDirectory)).mode & 0o777).toBe(0o700)
    }
  })
})

describe('frpc websocket path', () => {
  it('refuses a relay that expects a path frpc cannot dial', () => {
    expect(() => renderFrpcConfig({ tunnel: { ...TUNNEL, websocketPath: '/custom' }, username: 'ryan', localPort: 3080, sharedTokenPath: '/t', caCertificatePath: '/c' })).toThrow(/frpc always uses/u)
  })
})
