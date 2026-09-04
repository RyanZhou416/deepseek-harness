import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const helperPath = join(repositoryRoot, 'scripts', 'fork-macos-runtime.sh')
const temporaryRoots: string[] = []

const shellPath = process.platform === 'win32'
  ? [
    'C:\\Program Files\\Git\\bin\\sh.exe',
    'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
  ].find(existsSync)
  : '/bin/sh'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-macos-runtime-'))
  temporaryRoots.push(root)
  return root
}

function quoteForShell(value: string): string {
  const quote = '\''
  const escapedQuote = quote + '\\' + quote + quote
  return quote + value.replaceAll(quote, escapedQuote) + quote
}

function pathForShell(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (process.platform !== 'win32') return normalized
  return normalized.replace(/^([A-Za-z]):\//, (_, drive: string) => `/${drive.toLowerCase()}/`)
}

function runShell(script: string, environment: NodeJS.ProcessEnv = {}) {
  if (shellPath === undefined) throw new Error('A POSIX shell is required for this test.')
  const env = { ...process.env, ...environment }
  delete env.DSH_HOME
  delete env.DSH_MAX_OLD_SPACE_MIB
  return spawnSync(shellPath, ['-c', script], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env,
  })
}

function expectSuccess(result: ReturnType<typeof runShell>): void {
  expect(result.status, result.stderr || result.stdout).toBe(0)
}

function writeExecutable(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join('\n')}\n`)
  chmodSync(path, 0o755)
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('macOS fork launchers', () => {
  it('source the shared helper and keep the Corepack fallback pinned', () => {
    const helper = readFileSync(helperPath, 'utf8')
    const buildLauncher = readFileSync(join(repositoryRoot, 'build.command'), 'utf8')
    const runLauncher = readFileSync(join(repositoryRoot, 'run.command'), 'utf8')

    expect(helper).toContain('DSH_COREPACK_FALLBACK_VERSION=0.34.5')
    expect(helper).toContain('"corepack@$DSH_COREPACK_FALLBACK_VERSION"')
    expect(helper).not.toContain('corepack@latest')
    expect(buildLauncher).toContain('. "$DSH_MACOS_RUNTIME_HELPER"\ndsh_prepare_macos_toolchain "$SCRIPT_DIR"')
    expect(runLauncher).toContain('dsh_prepare_macos_toolchain "$SCRIPT_DIR"\ndsh_prepare_macos_web_runtime')
    expect(runLauncher).toContain('\npnpm dsh web\n')

    if (process.platform !== 'win32') {
      expect(statSync(join(repositoryRoot, 'build.command')).mode & 0o111).not.toBe(0)
      expect(statSync(join(repositoryRoot, 'run.command')).mode & 0o111).not.toBe(0)
      expect(statSync(helperPath).mode & 0o111).not.toBe(0)
    }
  })
})

const describeWithShell = shellPath === undefined ? describe.skip : describe

describeWithShell('fork-macos-runtime.sh', () => {
  it('accepts exactly the repository Node.js engine ranges', () => {
    const result = runShell(`
. ${quoteForShell(pathForShell(helperPath))}
for version in 22.18.9 22.19.0 22.99.1 23.0.0 24.0.0 30.1.2 malformed; do
  if dsh_node_version_supported "$version"; then
    printf '%s=yes\\n' "$version"
  else
    printf '%s=no\\n' "$version"
  fi
done
`)

    expectSuccess(result)
    expect(result.stdout.trim().split('\n')).toEqual([
      '22.18.9=no',
      '22.19.0=yes',
      '22.99.1=yes',
      '23.0.0=no',
      '24.0.0=yes',
      '30.1.2=yes',
      'malformed=no',
    ])
  })

  it('clamps automatic heap sizing and validates explicit overrides', () => {
    const result = runShell(`
. ${quoteForShell(pathForShell(helperPath))}
printf 'small=%s\\n' "$(dsh_heap_mib_from_physical_bytes 4294967296)"
printf 'medium=%s\\n' "$(dsh_heap_mib_from_physical_bytes 17179869184)"
printf 'large=%s\\n' "$(dsh_heap_mib_from_physical_bytes 68719476736)"
DSH_MAX_OLD_SPACE_MIB=6144
printf 'override=%s\\n' "$(dsh_select_heap_mib)"
DSH_MAX_OLD_SPACE_MIB=511
if dsh_select_heap_mib >/dev/null 2>&1; then exit 70; fi
`)

    expectSuccess(result)
    expect(result.stdout.trim().split('\n')).toEqual([
      'small=4096',
      'medium=8192',
      'large=16384',
      'override=6144',
    ])
  })

  it('accepts only an exact three-component pnpm packageManager version', () => {
    const root = fixture()
    const cases = [
      ['exact', 'pnpm@11.7.0', 'yes'],
      ['tag', 'pnpm@latest', 'no'],
      ['range', 'pnpm@^11', 'no'],
      ['short', 'pnpm@11.7', 'no'],
      ['leading-zero', 'pnpm@011.7.0', 'no'],
    ] as const
    for (const [name, packageManager] of cases) {
      const directory = join(root, name)
      mkdirSync(directory)
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ packageManager }))
    }
    const checks = cases.map(([name]) => `
if dsh_read_expected_pnpm_version ${quoteForShell(pathForShell(join(root, name)))}; then
  printf '${name}=yes\\n'
else
  printf '${name}=no\\n'
fi
`).join('')
    const result = runShell(`
. ${quoteForShell(pathForShell(helperPath))}
${checks}
`)

    expectSuccess(result)
    expect(result.stdout.trim().split('\n')).toEqual(cases.map(([name, , expected]) => `${name}=${expected}`))
  })

  it.skipIf(process.platform === 'win32')('starts pinned pnpm without a hidden Corepack prompt', () => {
    const root = fixture()
    const bin = join(root, 'bin')
    const shims = join(root, 'shims')
    const corepackLog = join(root, 'corepack.log')
    const pnpmPath = join(root, 'pnpm')
    mkdirSync(bin, { recursive: true })
    mkdirSync(shims)
    writeExecutable(pnpmPath, [
      '#!/bin/sh',
      'printf \'%s\\n\' \'pnpm startup diagnostic\' >&2',
      'printf \'%s\\n\' \'11.7.0\'',
    ])
    writeExecutable(join(bin, 'corepack'), [
      '#!/bin/sh',
      'printf \'prompt=%s\\nregistry=%s\\n\' "$COREPACK_ENABLE_DOWNLOAD_PROMPT" "$COREPACK_NPM_REGISTRY" > "$DSH_TEST_COREPACK_LOG"',
      'install_directory=',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--install-directory" ]; then shift; install_directory=$1; fi',
      '  shift',
      'done',
      '/bin/ln -sf "$DSH_TEST_PNPM" "$install_directory/pnpm"',
    ])
    const result = runShell(`
. ${quoteForShell(pathForShell(helperPath))}
dsh_prepare_macos_node() { :; }
dsh_read_expected_pnpm_version() {
  DSH_PACKAGE_MANAGER=pnpm@11.7.0
  DSH_EXPECTED_PNPM_VERSION=11.7.0
}
dsh_prepare_macos_private_runtime() {
  DSH_COREPACK_HOME=$DSH_TEST_ROOT/corepack
  DSH_COREPACK_SHIMS=$DSH_TEST_SHIMS
  COREPACK_HOME=$DSH_TEST_ROOT/cache
  npm_config_cache=$DSH_TEST_ROOT/npm-cache
  export COREPACK_HOME npm_config_cache
  /bin/mkdir -p "$DSH_COREPACK_HOME" "$DSH_COREPACK_SHIMS" "$COREPACK_HOME" "$npm_config_cache"
}
PATH=$DSH_TEST_BIN:/bin:/usr/bin
export PATH
dsh_prepare_macos_toolchain "$DSH_TEST_ROOT"
`, {
      DSH_TEST_BIN: pathForShell(bin),
      DSH_TEST_COREPACK_LOG: pathForShell(corepackLog),
      DSH_TEST_PNPM: pathForShell(pnpmPath),
      DSH_TEST_ROOT: pathForShell(root),
      DSH_TEST_SHIMS: pathForShell(shims),
    })

    expectSuccess(result)
    expect(readFileSync(corepackLog, 'utf8').trim().split('\n')).toEqual([
      'prompt=0',
      'registry=https://registry.npmmirror.com',
    ])
    expect(result.stdout).toContain('Preparing pnpm 11.7.0 through Corepack...\n')
    expect(result.stdout).toContain('Prepared pnpm 11.7.0.\n')
    expect(result.stderr).toContain('pnpm startup diagnostic\n')
  })

  it.skipIf(process.platform === 'win32')('resolves blank, tilde, and relative DSH_HOME values like the Harness', () => {
    const root = fixture()
    const home = join(root, 'user-home')
    mkdirSync(home)
    const shellRoot = pathForShell(root)
    const shellHome = pathForShell(home)
    const result = runShell(`
. ${quoteForShell(pathForShell(helperPath))}
HOME=$DSH_TEST_HOME
export HOME
cd "$DSH_TEST_ROOT"
unset DSH_HOME
printf 'unset=%s\\n' "$(dsh_resolve_macos_home)"
DSH_HOME='   '
export DSH_HOME
printf 'blank=%s\\n' "$(dsh_resolve_macos_home)"
DSH_HOME='~'
printf 'tilde=%s\\n' "$(dsh_resolve_macos_home)"
DSH_HOME='~/nested'
printf 'slash=%s\\n' "$(dsh_resolve_macos_home)"
DSH_HOME='~\\nested'
printf 'backslash=%s\\n' "$(dsh_resolve_macos_home)"
DSH_HOME='relative-home'
printf 'relative=%s\\n' "$(dsh_resolve_macos_home)"
`, { DSH_TEST_HOME: shellHome, DSH_TEST_ROOT: shellRoot })

    expectSuccess(result)
    expect(result.stdout.trim().split('\n')).toEqual([
      `unset=${join(home, '.dsh')}`,
      `blank=${join(home, '.dsh')}`,
      `tilde=${home}`,
      `slash=${join(home, 'nested')}`,
      `backslash=${join(home, 'nested')}`,
      `relative=${join(realpathSync(root), 'relative-home')}`,
    ])
  })

  it.skipIf(process.platform === 'win32')('defaults DSH_HOME and adds bounded heap and private diagnostic reports', () => {
    const root = fixture()
    const home = join(root, 'home with spaces')
    const shellHome = pathForShell(home)
    const result = runShell(`
. ${quoteForShell(pathForShell(helperPath))}
sysctl() { printf '%s\\n' 34359738368; }
HOME=$DSH_TEST_HOME
NODE_OPTIONS=--trace-warnings
export HOME NODE_OPTIONS
dsh_prepare_macos_web_runtime
printf 'home=%s\\n' "$DSH_HOME"
printf 'diagnostics=%s\\n' "$DSH_DIAGNOSTICS"
printf 'options=%s\\n' "$NODE_OPTIONS"
`, { DSH_TEST_HOME: shellHome })

    expectSuccess(result)
    expect(result.stdout).toContain(`home=${shellHome}/.dsh\n`)
    expect(result.stdout).toContain(`diagnostics=${shellHome}/.dsh/diagnostics\n`)
    expect(result.stdout).toContain('--max-old-space-size=16384')
    expect(result.stdout).toContain('--report-on-fatalerror')
    expect(result.stdout).toContain('--report-exclude-env')
    const nodeDiagnostics = process.platform === 'win32'
      ? `${home.replaceAll('\\', '/')}/.dsh/diagnostics`
      : `${shellHome}/.dsh/diagnostics`
    expect(result.stdout).toContain(`--report-directory="${nodeDiagnostics}"`)
    expect(existsSync(join(home, '.dsh', 'diagnostics'))).toBe(true)
    expect(statSync(join(home, '.dsh', 'diagnostics')).mode & 0o777).toBe(0o700)
  })

  it.skipIf(process.platform === 'win32')('refuses a symlinked diagnostics directory', () => {
    const root = fixture()
    const home = join(root, 'user-home')
    const configuredHome = join(root, 'configured-home')
    const target = join(root, 'diagnostics-target')
    mkdirSync(home)
    mkdirSync(configuredHome)
    mkdirSync(target)
    symlinkSync(target, join(configuredHome, 'diagnostics'), 'dir')
    const result = runShell(`
. ${quoteForShell(pathForShell(helperPath))}
HOME=$DSH_TEST_HOME
DSH_HOME=$DSH_TEST_DSH_HOME
export HOME DSH_HOME
if dsh_prepare_macos_web_runtime; then exit 70; fi
`, {
      DSH_TEST_DSH_HOME: pathForShell(configuredHome),
      DSH_TEST_HOME: pathForShell(home),
    })

    expectSuccess(result)
    expect(result.stderr).toContain('Refusing the symlinked diagnostics directory')
  })

  it('installs only the pinned Corepack fallback into its versioned private prefix', () => {
    const root = fixture()
    const bin = join(root, 'bin')
    const npmLog = join(root, 'npm.log')
    const shellRoot = pathForShell(root)
    const shellBin = pathForShell(bin)
    mkdirSync(bin, { recursive: true })
    writeExecutable(join(bin, 'npm'), [
      '#!/bin/sh',
      'printf \'%s\\n\' "$@" > "$DSH_TEST_NPM_LOG"',
      'prefix=',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--prefix" ]; then shift; prefix=$1; fi',
      '  shift',
      'done',
      '/bin/mkdir -p "$prefix/node_modules/.bin"',
      'printf \'%s\\n\' \'#!/bin/sh\' \'exit 0\' > "$prefix/node_modules/.bin/corepack"',
      '/bin/chmod 755 "$prefix/node_modules/.bin/corepack"',
    ])
    const result = runShell(`
. ${quoteForShell(pathForShell(helperPath))}
dsh_prepare_macos_private_runtime() {
  DSH_COREPACK_HOME=$DSH_TEST_ROOT/corepack-$DSH_COREPACK_FALLBACK_VERSION
  DSH_COREPACK_SHIMS=$DSH_TEST_ROOT/shims
  /bin/mkdir -p "$DSH_COREPACK_HOME" "$DSH_COREPACK_SHIMS"
}
PATH=$DSH_TEST_BIN
export PATH
dsh_prepare_macos_corepack
printf 'prefix=%s\\n' "$DSH_COREPACK_HOME"
`, {
      DSH_TEST_BIN: shellBin,
      DSH_TEST_NPM_LOG: pathForShell(npmLog),
      DSH_TEST_ROOT: shellRoot,
    })

    expectSuccess(result)
    expect(result.stdout).toContain(`prefix=${shellRoot}/corepack-0.34.5\n`)
    expect(readFileSync(npmLog, 'utf8').trim().split('\n')).toEqual([
      'install',
      '--prefix',
      `${shellRoot}/corepack-0.34.5`,
      '--no-save',
      '--no-audit',
      '--no-fund',
      'corepack@0.34.5',
    ])
  })
})
