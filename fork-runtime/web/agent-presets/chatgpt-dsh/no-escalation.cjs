// no-escalation.cjs — preset-local plugin for the `chatgpt-dsh` preset.
//
// Registered from this preset's standing mount, so its `system-prompt/assemble`
// listener admits every agent scope mounted under the preset (dsh-scope event
// admission extends up the chain). It makes the sandbox escalation surface
// invisible to this mode's agents: the two escalation parameters are deleted
// from the pwsh/write/edit schemas before every prompt assembly, and the pwsh
// description's escalation narrative is replaced by a short denial-is-final
// contract. Execution is untouched — the escalation fields simply cannot be
// generated anymore, because they never reach the model's parameter space.
'use strict'

const ESCALATION_FIELDS = ['sandbox_permissions', 'justification']
const FIELD_HIDDEN_TOOLS = new Set(['pwsh', 'write', 'edit'])

// Start of the ConfinedLanguage/escalation narrative dsh-tool-pwsh appends to
// the pwsh description only when escalation modes are advertised.
const PWSH_ESCALATION_ANCHOR = ' Under the Windows sandbox, read-only pwsh runs in PowerShell ConstrainedLanguage mode'
const PWSH_DENIAL_NOTE = ' This mode hides every sandbox-permission and escalation field: a `[sandbox: file access denied ...]` result means the command did not run and no wider-permission retry exists. On a denial, stop — do not rephrase and retry — adapt the operation to the permitted scope or report the limitation to the user.'

function hideEscalationFields(tool) {
  const params = tool.parameters
  if (!params || typeof params !== 'object') return
  const props = params.properties
  if (!props || typeof props !== 'object') return
  for (const field of ESCALATION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(props, field)) delete props[field]
  }
}

function trimPwshDescription(tool) {
  if (typeof tool.description !== 'string') return
  const cut = tool.description.indexOf(PWSH_ESCALATION_ANCHOR)
  if (cut < 0) return
  tool.description = tool.description.slice(0, cut) + PWSH_DENIAL_NOTE
}

module.exports = {
  name: 'no-escalation',
  apply(ctx) {
    return ctx.on('system-prompt/assemble', (assembly, context, next) => {
      return Promise.resolve(next()).then((result) => {
        if (!result || !Array.isArray(result.tools)) return result
        for (const tool of result.tools) {
          if (!FIELD_HIDDEN_TOOLS.has(tool.name)) continue
          hideEscalationFields(tool)
          if (tool.name === 'pwsh') trimPwshDescription(tool)
        }
        return result
      })
    })
  },
}
