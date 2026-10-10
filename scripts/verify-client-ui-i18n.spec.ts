import { describe, expect, it } from 'vitest'
import {
  clientSourceRoot, clientUiSources, findUiI18nViolations, forkPluginOf, scansForkPluginClientCopy,
} from './verify-client-ui-i18n.ts'

function messages(source: string): string[] {
  return findUiI18nViolations('packages/client/ui-example/src/client/View.tsx', source)
    .map(violation => violation.text)
}

describe('Client UI i18n source check', () => {
  it('rejects direct JSX copy and copy-bearing attributes', () => {
    expect(messages(`
      const View = ({ ready }: { ready: boolean }) => <section aria-label="Overview">
        <span>Hard-coded text</span>
        <input placeholder={ready ? 'Search now' : ` + "`Wait ${'${ready}'}`" + `} />
        <div runningSummary="Still working" />
      </section>
    `)).toEqual(['Overview', 'Hard-coded text', 'Search now', 'Wait', 'Still working'])
  })

  it('rejects copy kept in label data and copy helper returns', () => {
    expect(messages(`
      const TABS = [{ id: 'summary', label: 'Summary' }]
      function statusLabel(status: string): string {
        if (status === 'done') return 'Complete'
        return 'Still running'
      }
      function duration(): string { return 'Not recorded' }
      function mode(): string { return 'compact' }
      function displayFailureMessage(): string { return 'API key is invalid' }
      const emptySummary = 'Nothing to show'
      function Dialog({ closeLabel = 'Close dialog' }: { closeLabel?: string }) { return closeLabel }
    `)).toEqual([
      'Summary', 'Complete', 'Still running', 'Not recorded', 'API key is invalid',
      'Nothing to show', 'Close dialog',
    ])
  })

  it('normalizes native separators before deriving a Client source root', () => {
    expect(clientSourceRoot('packages/extensions/sample/src/client/View.tsx'))
      .toBe('packages/extensions/sample/src/client')
    expect(clientSourceRoot('packages\\extensions\\sample\\src\\client\\View.tsx'))
      .toBe('packages/extensions/sample/src/client')
    expect(clientSourceRoot('packages/extensions/sample/src/server/index.ts')).toBeUndefined()
  })

  it('scans fork plugin Client copy outside the upstream subtree imports', () => {
    expect(forkPluginOf('fork-plugins/dsh-plugin-subscriptions/src/client/SubscriptionsSection.tsx'))
      .toBe('fork-plugins/dsh-plugin-subscriptions')
    expect(forkPluginOf('fork-plugins\\dsh-context\\src\\client\\components\\nodes.tsx'))
      .toBe('fork-plugins/dsh-context')
    expect(forkPluginOf('packages/client/ui-example/src/client/View.tsx')).toBeUndefined()
    expect(forkPluginOf('fork-plugins/dsh-plugin-subscriptions/src/providers/pool.ts')).toBeUndefined()

    expect(scansForkPluginClientCopy('fork-plugins/dsh-plugin-subscriptions')).toBe(true)
    expect(scansForkPluginClientCopy('fork-plugins/dsh-agent-teams')).toBe(false)
    expect(scansForkPluginClientCopy('fork-plugins/dsh-context')).toBe(false)
  })

  it('discovers the fork plugin Client sources this repository owns', () => {
    const files = clientUiSources()
    expect(files.some(file => file.startsWith('fork-plugins/dsh-plugin-subscriptions/src/client/'))).toBe(true)
    expect(files.some(file => file.startsWith('fork-plugins/dsh-context/'))).toBe(false)
    expect(files.some(file => file.startsWith('fork-plugins/dsh-agent-teams/'))).toBe(false)
  })

  it('rejects hard-coded copy in a fork plugin Client source', () => {
    expect(findUiI18nViolations(
      'fork-plugins/dsh-plugin-subscriptions/src/client/View.tsx',
      'export const View = () => <span aria-label="Overview">Hard-coded</span>',
    ).map(row => row.text)).toEqual(['Overview', 'Hard-coded'])
  })

  it('accepts translated copy, dynamic values, structural attributes, and language tokens', () => {
    expect(messages(`
      const View = ({ t, value }: { t: (key: string) => string; value: string }) => (
        <section className="root" role="region" aria-label={t('overview')}>
          <span>{t('status.complete')}</span>
          <code>null</code>
          {value === 'pending' && <output>{value}</output>}
          <output>{value}</output>
        </section>
      )
    `)).toEqual([])
  })

  it('does not inspect locale dictionary owners', () => {
    expect(findUiI18nViolations(
      'packages/client/ui-example/src/client/locales.ts',
      'export const en = { title: "Hard-coded by design" }',
    )).toEqual([])
  })

  it('rejects Electron dialog, title, prompt, and DOM copy outside locale owners', () => {
    const source = `
      dialog.showMessageBox({ title: 'Update available', message: 'Install it now?' })
      window.setTitle('Desktop plugins')
      window.prompt('Target version')
      status.textContent = 'Finished'
    `
    expect(findUiI18nViolations('apps/desktop/src/main.ts', source).map(row => row.text)).toEqual([
      'Update available',
      'Install it now?',
      'Desktop plugins',
      'Target version',
      'Finished',
    ])
  })
})
