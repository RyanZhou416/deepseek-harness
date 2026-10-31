import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const entryPath = join(packageRoot, 'lib/client.js')
const terminalPath = join(packageRoot, 'lib/client.terminal.js')
// Minified output may use any string quoting; the specifier and call shape are the contract.
const ASYNC_CHUNK = /require\.async\((["'`])(\.\/client[^"'`]*\.js)\1\)/gu
const SYNC_CHUNK = /require\((["'`])(\.\/client[^"'`]*\.js)\1\)/gu

describe('terminal client artifacts', () => {
  it.skipIf(!existsSync(entryPath))('keeps xterm outside the startup bundle', () => {
    expect(existsSync(terminalPath)).toBe(true)
    const entry = readFileSync(entryPath, 'utf8')
    const terminal = readFileSync(terminalPath, 'utf8')
    expect([...entry.matchAll(ASYNC_CHUNK)].map(match => match[2])).toEqual(['./client.terminal.js'])
    expect([...entry.matchAll(SYNC_CHUNK)].map(match => match[2])).toEqual([])
    expect([...terminal.matchAll(SYNC_CHUNK)].map(match => match[2])).toEqual([])
    // Minified output drops the `//#region` comments that carried module paths,
    // so the xterm CSS class bundled with the library marks its chunk instead.
    expect(entry).not.toContain('xterm-screen')
    expect(terminal).toContain('xterm-screen')
  })
})
