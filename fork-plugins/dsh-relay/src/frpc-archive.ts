/**
 * Minimal archive readers for the official frp release assets.
 *
 * The project ships zip archives for Windows and `tar.gz` archives elsewhere.
 * Both are read in-process with `node:zlib`, so no external `unzip`/`tar`
 * program is required on any platform.
 *
 * @module dsh-relay/frpc-archive
 */
import { gunzipSync, inflateRawSync } from 'node:zlib'
import { relayError } from './errors.ts'

/** Largest frpc executable this client will extract. */
const MAX_BINARY_BYTES = 256 * 1024 * 1024

const EOCD_SIGNATURE = 0x0605_4b50
const CENTRAL_SIGNATURE = 0x0201_4b50
const LOCAL_SIGNATURE = 0x0403_4b50
const EOCD_MIN_BYTES = 22
const EOCD_MAX_SEARCH = 65_557

let crcTable: Uint32Array | undefined

function crc32(buffer: Buffer): number {
  if (crcTable === undefined) {
    const table = new Uint32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb8_8320 : value >>> 1
      }
      table[index] = value >>> 0
    }
    crcTable = table
  }
  let crc = 0xffff_ffff
  for (const byte of buffer) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] as number)
  return (crc ^ 0xffff_ffff) >>> 0
}

function baseName(path: string): string {
  const trimmed = path.replace(/\\/gu, '/')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

function extractZip(archive: Buffer, executable: string): Buffer {
  let eocd = -1
  const start = Math.max(0, archive.length - EOCD_MAX_SEARCH)
  for (let offset = archive.length - EOCD_MIN_BYTES; offset >= start; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw relayError('frpc-download-failed', 'the frp archive is not a zip file')
  const entries = archive.readUInt16LE(eocd + 10)
  const centralOffset = archive.readUInt32LE(eocd + 16)
  let offset = centralOffset
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw relayError('frpc-download-failed', 'the frp archive has a malformed central directory')
    }
    const flags = archive.readUInt16LE(offset + 8)
    const method = archive.readUInt16LE(offset + 10)
    const expectedCrc = archive.readUInt32LE(offset + 16)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const uncompressedSize = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const localOffset = archive.readUInt32LE(offset + 42)
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength
    if (baseName(name) !== executable) continue
    if ((flags & 0x1) !== 0) throw relayError('frpc-download-failed', 'the frp archive is encrypted')
    if (uncompressedSize > MAX_BINARY_BYTES) {
      throw relayError('frpc-download-failed', 'the frpc executable in the archive is unreasonably large')
    }
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw relayError('frpc-download-failed', 'the frp archive has a malformed local header')
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > archive.length) {
      throw relayError('frpc-download-failed', 'the frp archive entry runs past the archive')
    }
    const data = archive.subarray(dataStart, dataEnd)
    let binary: Buffer
    if (method === 0) binary = Buffer.from(data)
    else if (method === 8) {
      try {
        binary = inflateRawSync(data)
      } catch (error) {
        throw relayError('frpc-download-failed', 'the frpc executable does not inflate', error)
      }
    } else {
      throw relayError('frpc-download-failed', `the frp archive uses unsupported compression ${String(method)}`)
    }
    if (binary.length !== uncompressedSize || crc32(binary) !== expectedCrc) {
      throw relayError('frpc-download-failed', 'the frpc executable fails its archive checksum')
    }
    return binary
  }
  throw relayError('frpc-download-failed', `the frp archive contains no ${executable}`)
}

function extractTarGz(archive: Buffer, executable: string): Buffer {
  let tar: Buffer
  try {
    tar = gunzipSync(archive)
  } catch (error) {
    throw relayError('frpc-download-failed', 'the frp archive is not gzip data', error)
  }
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.toString('utf8', 0, 100).replace(/\0[\s\S]*$/u, '')
    const prefix = header.toString('utf8', 345, 500).replace(/\0[\s\S]*$/u, '')
    const fullName = prefix === '' ? name : `${prefix}/${name}`
    const sizeText = header.toString('utf8', 124, 136).replace(/\0[\s\S]*$/u, '').trim()
    const size = sizeText === '' ? 0 : Number.parseInt(sizeText, 8)
    const type = header.toString('utf8', 156, 157)
    if (!Number.isSafeInteger(size) || size < 0) {
      throw relayError('frpc-download-failed', 'the frp archive has a malformed tar header')
    }
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) {
      throw relayError('frpc-download-failed', 'the frp archive entry runs past the archive')
    }
    if ((type === '0' || type === '\0') && baseName(fullName) === executable) {
      if (size > MAX_BINARY_BYTES) {
        throw relayError('frpc-download-failed', 'the frpc executable in the archive is unreasonably large')
      }
      return Buffer.from(tar.subarray(dataStart, dataEnd))
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  throw relayError('frpc-download-failed', `the frp archive contains no ${executable}`)
}

/**
 * Extract the frpc executable from an official frp archive.
 *
 * The format is detected from the archive bytes: a zip for Windows releases, a
 * gzip-compressed tar elsewhere.
 * @param archive - downloaded release archive.
 * @param platform - Node platform name, selecting `frpc.exe` on Windows.
 * @returns the executable bytes.
 * @throws RelayError `frpc-download-failed` when the archive is malformed or holds no frpc.
 */
export function extractFrpcBinary(archive: Buffer, platform: string): Buffer {
  const executable = platform === 'win32' ? 'frpc.exe' : 'frpc'
  if (archive.length >= 2 && archive[0] === 0x1f && archive[1] === 0x8b) {
    return extractTarGz(archive, executable)
  }
  return extractZip(archive, executable)
}
