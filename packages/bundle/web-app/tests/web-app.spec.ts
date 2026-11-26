/** Web runtime dist ownership, advertised addresses, exposure warnings, shell context, and browser handoff. */
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { bindUrlHost, type WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, Config, internals } from '../src/index.ts'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}))

let dist: string | undefined
const originalResolve = internals.resolveDistIndex
const originalOpenBrowser = internals.openBrowser

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(spawn).mockReset()
  vi.unstubAllEnvs()
  internals.resolveDistIndex = originalResolve
  internals.openBrowser = originalOpenBrowser
  if (dist !== undefined) {
    if (!isAbsolute(dist) || dirname(dist) !== resolve(tmpdir()) || !basename(dist).startsWith('dsh-web-app-')) {
      throw new Error(`refusing unexpected fixture cleanup path: ${dist}`)
    }
    rmSync(dist, { recursive: true, force: true })
  }
  dist = undefined
})

type BrowserLauncher = ChildProcess & { stderr: PassThrough; unref: ReturnType<typeof vi.fn> }

/** Minimal browser-launcher process for the native handoff adapter. */
function launcher(): BrowserLauncher {
  return Object.assign(new EventEmitter(), { stderr: new PassThrough(), unref: vi.fn() }) as BrowserLauncher
}

/** Supply a distribution owned by this test without invoking a frontend build. */
function stageDist(): void {
  dist = mkdtempSync(join(tmpdir(), 'dsh-web-app-'))
  mkdirSync(join(dist, 'dist'))
  const index = join(dist, 'dist', 'index.html')
  writeFileSync(index, '<head></head><body>shell</body>')
  internals.resolveDistIndex = () => index
}

/** Web carrier without a network listener; address formatting follows production. */
function fakeHttpServer(host = '127.0.0.1', protocol: 'http:' | 'https:' = 'http:'): WebServer {
  const server: Pick<WebServer, 'host' | 'port' | 'protocol' | 'getOrigin' | 'registerFallback' | 'renderIndex'> = {
    host, port: 4567, protocol,
    getOrigin() { return `${protocol}//${bindUrlHost(host) ?? ''}:${String(this.port)}` },
    registerFallback: () => () => {},
    renderIndex: (html: string) => html,
  }
  return server as WebServer
}

interface BashContribution {
  name: string
  variables: Record<string, { description: string }>
  resolve: () => Record<string, string>
}

function context(host = '127.0.0.1', protocol: 'http:' | 'https:' = 'http:'): Context {
  stageDist()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('webServer', fakeHttpServer(host, protocol))
  return ctx
}

function shellContributions(ctx: Context): BashContribution[] {
  const contributions: BashContribution[] = []
  ctx.provide('shellEnv', {
    register(contribution: BashContribution) {
      contributions.push(contribution)
      return () => { contributions.splice(contributions.indexOf(contribution), 1) }
    },
  } as never)
  return contributions
}

describe('web-app runtime glue', () => {
  it.each([
    { mode: 'omitted', enabled: true },
    { mode: 'disabled', enabled: false },
  ])('publishes and opens entries with $mode startup flags', async ({ enabled }) => {
    const ctx = context()
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const open = vi.spyOn(internals, 'openBrowser').mockResolvedValue(undefined)
    ctx.on('webserver/entry-url', (baseUrl, entries) => {
      entries.push({ label: 'dsh web', url: `${baseUrl}/?token=fixture`, open: true })
    })
    const config = enabled ? new Config() : new Config({ surfaceContext: false, printUrl: false, openBrowser: false })
    expect(config).toMatchObject({ printUrl: enabled, openBrowser: enabled })
    apply(ctx, config)
    expect(log).toHaveBeenCalledTimes(enabled ? 2 : 0)
    expect(open).toHaveBeenCalledTimes(enabled ? 1 : 0)
    if (enabled) {
      expect(log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:4567/?token=fixture')
      expect(open).toHaveBeenCalledWith('http://127.0.0.1:4567/?token=fixture', expect.any(AbortSignal))
      await open.mock.results[0]!.value
    }
  })

  it.each([
    { bind: '127.0.0.1', advertised: '127.0.0.1' },
    { bind: '::1', advertised: '[::1]' },
    { bind: '::ffff:127.0.0.1', advertised: '127.0.0.1' },
    { bind: '::ffff:7f00:1', advertised: '127.0.0.1' },
    { bind: '0:0:0:0:0:ffff:7f08:a', advertised: '127.8.0.10' },
    { bind: '::ffff:127.0.0.1%lo', advertised: '127.0.0.1' },
    { bind: '::0.0.0.1', advertised: '[::1]' },
    { bind: '::0.0.0.1%lo', advertised: '[::1]' },
    { bind: '::1%lo', advertised: '[::1]' },
  ])('advertises $bind and publishes the same clean address to shell context', async ({ bind, advertised }) => {
    const ctx = context(bind)
    const contributions = shellContributions(ctx)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    apply(ctx, new Config({ printUrl: false, openBrowser: false, surfaceContext: true }))
    const url = `http://${advertised}:4567`
    expect(ctx.webApp.getAdvertisedUrl()).toBe(url)
    await vi.waitFor(() => {
      expect(contributions.find(item => item.name === 'web-runtime')?.resolve()).toEqual({ DSH_WEB_URL: url })
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('advertises the configured public root behind a prefix-stripping proxy', async () => {
    const ctx = context()
    const contributions = shellContributions(ctx)
    apply(ctx, new Config({ printUrl: false, openBrowser: false, surfaceContext: true, publicUrl: 'https://proxy.example:8443/web' }))
    expect(ctx.webApp.getAdvertisedUrl()).toBe('https://proxy.example:8443/web/')
    await vi.waitFor(() => {
      expect(contributions.find(item => item.name === 'web-runtime')?.resolve()).toEqual({
        DSH_WEB_URL: 'https://proxy.example:8443/web/',
      })
    })
  })

  it('skips shell context registration when surface context is disabled', async () => {
    const ctx = context()
    const contributions = shellContributions(ctx)
    apply(ctx, new Config({ printUrl: false, openBrowser: false, surfaceContext: false }))
    const available = Promise.withResolvers<undefined>()
    ctx.inject(['shellEnv'], () => { available.resolve(undefined) })
    await available.promise
    expect(contributions).toEqual([])
    expect(ctx.webApp.getAdvertisedUrl()).toBe('http://127.0.0.1:4567')
  })

  it.each([
    { bind: '10.1.2.3', advertised: '10.1.2.3' },
    { bind: '::127.0.0.1', advertised: '[::127.0.0.1]' },
  ])('warns about plaintext exposure and advertises the $bind bind address', ({ bind, advertised }) => {
    const ctx = context(bind)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    apply(ctx, new Config({ printUrl: false, openBrowser: false, surfaceContext: false }))
    expect(ctx.webApp.getAdvertisedUrl()).toBe(`http://${advertised}:4567`)
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `dsh web: listening on ${bind} over plain HTTP; restrict this port to a trusted proxy or network`,
    )
  })

  it('keeps the plaintext warning when an HTTPS public URL fronts an HTTP listener', () => {
    const ctx = context('10.1.2.3')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    apply(ctx, new Config({ printUrl: false, openBrowser: false, surfaceContext: false, publicUrl: 'https://proxy.example/ui/' }))
    expect(warn).toHaveBeenCalledOnce()
    expect(ctx.webApp.getAdvertisedUrl()).toBe('https://proxy.example/ui/')
  })

  it('advertises listener TLS without a plaintext warning', () => {
    const ctx = context('10.1.2.3', 'https:')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    apply(ctx, new Config({ printUrl: false, openBrowser: false, surfaceContext: false }))
    expect(ctx.webApp.getAdvertisedUrl()).toBe('https://10.1.2.3:4567')
    expect(warn).not.toHaveBeenCalled()
  })

  it.each(['fe80::1%lo', '::127.0.0.1%lo'])('requires publicUrl when %s cannot form an advertised URL', (bind) => {
    const ctx = context(bind)
    expect(() => { apply(ctx, new Config({ printUrl: false, openBrowser: false, surfaceContext: false })) })
      .toThrow(/carries an interface zone id, which no URL can express; pass --public-url/u)
    const declared = new Context()
    onTestFinished(() => declared.fiber.dispose())
    declared.provide('webServer', fakeHttpServer(bind))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    apply(declared, new Config({ printUrl: false, openBrowser: false, surfaceContext: false, publicUrl: 'https://app.example/ui/' }))
    expect(declared.webApp.getAdvertisedUrl()).toBe('https://app.example/ui/')
  })

  it('uses the bind address when publicUrl is explicitly null', () => {
    const ctx = context()
    apply(ctx, new Config({ printUrl: false, openBrowser: false, surfaceContext: false, publicUrl: null as never }))
    expect(ctx.webApp.getAdvertisedUrl()).toBe('http://127.0.0.1:4567')
  })

  it('anchors the dist index on the frontend package manifest without requiring a built dist', () => {
    expect(originalResolve()).toMatch(/dist[/\\]index\.html$/)
  })

  it('scrubs the non-Windows helper environment and reports helper spawn or exit failures', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.stubEnv('DEEPSEEK_API_KEY', 'must-not-reach-browser')
    vi.stubEnv('DSH_HOME', '/must-not-reach-browser')
    const completed = launcher()
    vi.mocked(spawn).mockReturnValueOnce(completed)
    const completion = originalOpenBrowser('http://127.0.0.1:4567')
    const [command, args, options] = vi.mocked(spawn).mock.calls[0]!
    expect(command).toBe(process.execPath)
    expect(args).toEqual([
      '--input-type=module',
      '--eval', expect.stringContaining('await import('),
      '--', 'http://127.0.0.1:4567',
    ])
    expect(args?.[2]).toContain('await open(process.argv[1])')
    expect(args?.[2]).not.toContain('win32')
    expect(options?.env).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(options?.env).not.toHaveProperty('DSH_HOME')
    expect(options?.env?.PATH).toBe(process.env.PATH)
    expect(options?.stdio).toEqual(['ignore', 'inherit', 'pipe'])
    expect(completed.unref).not.toHaveBeenCalled()
    completed.emit('close', 0)
    await expect(completion).resolves.toBeUndefined()
    expect(completed.listenerCount('error')).toBe(0)

    const completedWithStderr = launcher()
    vi.mocked(spawn).mockReturnValueOnce(completedWithStderr)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const completionWithStderr = originalOpenBrowser('http://127.0.0.1:4567')
    completedWithStderr.stderr?.write('launcher note\n')
    completedWithStderr.emit('close', 0)
    await expect(completionWithStderr).resolves.toBeUndefined()
    expect(stderr).toHaveBeenCalledWith('launcher note\n')

    const failedWithReason = launcher()
    vi.mocked(spawn).mockReturnValueOnce(failedWithReason)
    const reasonFailure = originalOpenBrowser('http://127.0.0.1:4567')
    const reasonAssertion = expect(reasonFailure).rejects.toThrow('desktop unavailable')
    failedWithReason.stderr?.write('Error: desktop unavailable\n    at fixture')
    failedWithReason.emit('close', 1)
    await reasonAssertion

    const failed = launcher()
    vi.mocked(spawn).mockReturnValueOnce(failed)
    const failure = originalOpenBrowser('http://127.0.0.1:4567')
    const failureAssertion = expect(failure).rejects.toThrow('exited with code 3')
    await Promise.resolve()
    failed.emit('close', 3)
    await failureAssertion

    const errored = launcher()
    vi.mocked(spawn).mockReturnValueOnce(errored)
    const error = originalOpenBrowser('http://127.0.0.1:4567')
    const errorAssertion = expect(error).rejects.toThrow('spawn failed')
    await Promise.resolve()
    errored.emit('error', new Error('spawn failed'))
    await errorAssertion
    expect(errored.listenerCount('close')).toBe(0)
  })

  it('hands a token URL to the Windows shell handler as one argv element without a shell', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('SystemRoot', 'D:\\Windows')
    const url = 'http://127.0.0.1:4567/?token=ab%2Fcd&scope=a+b&x=1,2==&y=%25pct'
    const handoff = launcher()
    vi.mocked(spawn).mockReturnValueOnce(handoff)
    const completion = originalOpenBrowser(url)
    const [command, args, options] = vi.mocked(spawn).mock.calls[0]!

    // The shell handler resolves the default browser a double-click uses; the
    // URL stays one argv element so `&`, `%`, `=`, and `,` cannot be rewritten.
    expect(command).toBe(join('D:\\Windows', 'System32', 'rundll32.exe'))
    expect(args).toEqual(['url.dll,FileProtocolHandler', url])
    // No command shell sits between this process and the shell handoff.
    expect(options?.shell).toBeUndefined()
    expect(options).toMatchObject({
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'pipe'],
    })
    expect(handoff.unref).toHaveBeenCalledOnce()

    handoff.emit('close', 0)
    await expect(completion).resolves.toBeUndefined()
    expect(handoff.listenerCount('error')).toBe(0)
  })

  it('keeps Harness credentials out of the Windows shell handoff and reports its failure reason', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    // A host without SystemRoot still resolves the helper under the system drive.
    vi.stubEnv('SystemRoot', '')
    vi.stubEnv('DEEPSEEK_API_KEY', 'must-not-reach-browser')
    vi.stubEnv('DSH_HOME', '/must-not-reach-browser')
    const failed = launcher()
    vi.mocked(spawn).mockReturnValueOnce(failed)
    const failure = originalOpenBrowser('http://127.0.0.1:4567')
    const assertion = expect(failure).rejects.toThrow('url.dll could not be loaded')
    const options = vi.mocked(spawn).mock.calls[0]![2]
    expect(options?.env).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(options?.env).not.toHaveProperty('DSH_HOME')
    expect(options?.env?.PATH).toBe(process.env.PATH)
    failed.stderr?.write('Error: url.dll could not be loaded\n    at fixture')
    failed.emit('close', 1)
    await assertion
    expect(failed.listenerCount('close')).toBe(0)
  })
})
