// Preloaded by run.cmd before the DSH CLI to set up the Host process itself.
//
// Priority: DSH_PROCESS_PRIORITY selects above-normal (default), normal, or
// high, so a machine whose cores are saturated by builds or games still serves
// the Web client and its relay tunnel promptly. Windows starts every child of
// an above-normal process at normal priority unless the parent asks otherwise,
// so commands the agent runs do not inherit the raised level.
//
// Termination guard (Windows): DSH_PROTECT_HOST selects on (default) or off.
// When on, the Host prepends one deny-PROCESS_TERMINATE entry for Everyone to
// its own process DACL. A command or script a Session runs uses the same user
// account as the Host, so without the entry `Stop-Process -Name node`,
// `taskkill /IM node.exe /F`, killing whatever listens on the Host port, or
// `taskkill /T` on the launching console would end the Host with it. With the
// entry those requests fail with "Access is denied" and every other target is
// still terminated. The Host's own exit, Ctrl+C and closing the run.cmd window
// do not open a terminate handle and keep working; an elevated process with
// SeDebugPrivilege (an administrator Task Manager or terminal) still can. The
// owner keeps WRITE_DAC, so code that deliberately rewrites the DACL can undo
// the entry: this guards against accidental kills, not against hostile code.
import { createRequire } from 'node:module'
import { constants, setPriority } from 'node:os'

const LEVELS = {
  normal: constants.priority.PRIORITY_NORMAL,
  'above-normal': constants.priority.PRIORITY_ABOVE_NORMAL,
  high: constants.priority.PRIORITY_HIGH,
}

const requested = process.env.DSH_PROCESS_PRIORITY ?? 'above-normal'
const level = LEVELS[requested]
if (level === undefined) {
  throw new Error(`DSH_PROCESS_PRIORITY must be one of ${Object.keys(LEVELS).join(', ')}; got ${JSON.stringify(requested)}`)
}
try {
  setPriority(0, level)
} catch (error) {
  process.emitWarning(`could not set the DSH process priority to ${requested}: ${error instanceof Error ? error.message : String(error)}`)
}

const protection = process.env.DSH_PROTECT_HOST ?? 'on'
if (protection !== 'on' && protection !== 'off') {
  throw new Error(`DSH_PROTECT_HOST must be on or off; got ${JSON.stringify(protection)}`)
}
if (protection === 'on' && process.platform === 'win32') {
  try {
    denyTermination()
  } catch (error) {
    process.emitWarning(`could not protect the DSH Host from termination: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Prepend a deny-PROCESS_TERMINATE entry for Everyone to this process's DACL. */
function denyTermination() {
  // koffi is the Win32 FFI the subprocess packages already ship.
  const require = createRequire(new URL('../../packages/subprocess/win32-process/package.json', import.meta.url))
  const koffi = require('koffi')
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  const GetCurrentProcess = kernel32.func('void* __stdcall GetCurrentProcess()')
  const LocalFree = kernel32.func('void* __stdcall LocalFree(void*)')
  const GetSecurityInfo = advapi32.func('uint32 __stdcall GetSecurityInfo(void*, int, uint32, _Out_ void**, _Out_ void**, _Out_ void**, _Out_ void**, _Out_ void**)')
  const SetSecurityInfo = advapi32.func('uint32 __stdcall SetSecurityInfo(void*, int, uint32, void*, void*, void*, void*)')
  const toSddl = advapi32.func('int __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void*, uint32, uint32, _Out_ str16*, _Out_ uint32*)')
  const fromSddl = advapi32.func('int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16, uint32, _Out_ void**, _Out_ uint32*)')
  const getDacl = advapi32.func('int __stdcall GetSecurityDescriptorDacl(void*, _Out_ int*, _Out_ void**, _Out_ int*)')
  const SE_KERNEL_OBJECT = 6
  const DACL_SECURITY_INFORMATION = 4
  const SDDL_REVISION_1 = 1
  const DENY_TERMINATE_EVERYONE = '(D;;0x1;;;WD)'

  const self = GetCurrentProcess()
  const current = [null]
  const status = GetSecurityInfo(self, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, [null], [null], [null], [null], current)
  if (status !== 0) throw new Error(`GetSecurityInfo failed with ${String(status)}`)
  const text = [null]
  try {
    if (!toSddl(current[0], SDDL_REVISION_1, DACL_SECURITY_INFORMATION, text, [0])) throw new Error('reading the process DACL failed')
  } finally {
    LocalFree(current[0])
  }
  if (text[0].includes(DENY_TERMINATE_EVERYONE)) return
  // Deny entries must precede allow entries, so the new entry follows the DACL flags.
  const guarded = text[0].replace(/^D:([A-Z]*)/u, (_match, flags) => `D:${flags}${DENY_TERMINATE_EVERYONE}`)
  const descriptor = [null]
  if (!fromSddl(guarded, SDDL_REVISION_1, descriptor, [0])) throw new Error('building the guarded DACL failed')
  try {
    const dacl = [null]
    if (!getDacl(descriptor[0], [0], dacl, [0])) throw new Error('reading the guarded DACL failed')
    const applied = SetSecurityInfo(self, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, null, null, dacl[0], null)
    if (applied !== 0) throw new Error(`SetSecurityInfo failed with ${String(applied)}`)
  } finally {
    LocalFree(descriptor[0])
  }
}
