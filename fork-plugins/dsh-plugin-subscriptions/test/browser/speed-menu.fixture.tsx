/** Real menu components in an offline browser; all provider I/O is replaced by local choices. */
import { Fragment, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ModelSelect } from '../../../../packages/client/ui-model-selection/src/client/ModelSelect.tsx'
import { en as modelEn, zh as modelZh } from '../../../../packages/client/ui-model-selection/src/client/locales.ts'
import { SpeedSelect } from '../../src/client/SpeedSelect.js'
import { en as subscriptionsEn, zh as subscriptionsZh } from '../../src/client/locales.js'

const chinese = document.documentElement.lang !== 'en'
const current = { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high' }
const snapshot = {
  current, routable: true, failures: [], status: 'ready', error: null,
  groups: [{ id: 'claude', name: 'Claude', models: [{
    id: current.model, name: 'Opus 5.5',
    reasoning: { efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
  }] }],
}
const directory = { getSnapshot: () => snapshot, subscribe: () => () => {} }
const dictionary = chinese ? modelZh : modelEn
const words = chinese ? subscriptionsZh : subscriptionsEn
const translate = (key: string, params?: Record<string, unknown>) => {
  const template = dictionary[key] ?? ({ 'action.back': chinese ? '返回' : 'Back' })[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? name))
}
let tier: 'standard' | 'fast' = 'standard'
let writes = 0
const controls = { fail: false, delay: 0 }
Object.assign(window, { speedFixture: { get tier() { return tier }, get writes() { return writes }, controls } })

function SpeedRow({ owner }: { owner: Record<string, unknown> }) {
  return <SpeedSelect
    {...owner}
    useModel={select => select(current)}
    loadSpeed={async () => ({ visible: true, tier })}
    setSpeed={async (_model, next) => {
      if (controls.delay > 0) await new Promise(resolve => setTimeout(resolve, controls.delay))
      if (controls.fail) return false
      tier = next; writes += 1; return true
    }}
    t={key => words[key]}
  />
}
function App() {
  const [, render] = useState(0)
  return <div style={{ position: 'fixed', bottom: 12, right: 20 }}>
    <ModelSelect locked={false} available directory={directory} load={() => {}}
      select={async selection => { Object.assign(current, selection); render(value => value + 1); return { ok: true, value: undefined } }}
      t={translate} SessionProvider={Fragment}
      renderSlot={(_name, owner) => <SpeedRow owner={owner} />}
    />
  </div>
}
createRoot(document.getElementById('root')!).render(<App />)
