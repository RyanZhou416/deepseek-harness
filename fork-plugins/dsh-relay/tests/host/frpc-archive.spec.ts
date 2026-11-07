import { describe, expect, it } from 'vitest'
import { extractFrpcBinary } from '../../src/frpc-archive.ts'
import { buildTarGz, buildZip } from './helpers/archives.ts'

const BINARY = Buffer.from('fake-frpc-binary-\u0000\u00ff')

describe('frpc archive extraction', () => {
  it('extracts frpc.exe from a zip release', () => {
    const archive = buildZip([
      { name: 'frp_0.71.0_windows_amd64/LICENSE', data: Buffer.from('license') },
      { name: 'frp_0.71.0_windows_amd64/frpc.exe', data: BINARY, deflate: true },
    ])
    expect(extractFrpcBinary(archive, 'win32').equals(BINARY)).toBe(true)
  })

  it('extracts frpc from a gzip tar release', () => {
    const archive = buildTarGz('frp_0.71.0_linux_amd64/frpc', BINARY)
    expect(extractFrpcBinary(archive, 'linux').equals(BINARY)).toBe(true)
  })

  it('rejects a corrupt entry checksum', () => {
    const archive = buildZip([{ name: 'frpc.exe', data: BINARY, crc: 0 }])
    expect(() => extractFrpcBinary(archive, 'win32')).toThrow(/checksum/u)
  })

  it('rejects an archive without the executable', () => {
    const zip = buildZip([{ name: 'README', data: Buffer.from('x') }])
    expect(() => extractFrpcBinary(zip, 'win32')).toThrow(/no frpc\.exe/u)
    const tar = buildTarGz('README', Buffer.from('x'))
    expect(() => extractFrpcBinary(tar, 'linux')).toThrow(/no frpc/u)
  })

  it('rejects malformed archives', () => {
    expect(() => extractFrpcBinary(Buffer.from('not a zip'), 'win32')).toThrow(/zip/u)
    const random = Buffer.from([0x1f, 0x8b, 0x00, 0x01])
    expect(() => extractFrpcBinary(random, 'linux')).toThrow(/gzip/u)
  })
})
