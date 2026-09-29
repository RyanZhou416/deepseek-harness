/** Default Web compositions expose no Goal controls and do not admit old Goal rounds. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-commands'
import { GoalId } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

describe('Web Goal disabled by default', () => {
  it('keeps historical Goal data without tools, commands, UI, or resumed Goal requests', async () => {
    const scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    })
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      expect(scaffold.ctx.get('goals')).toBeUndefined()
      const agent = scaffold.ctx.agents.list()[0]
      if (agent === undefined) throw new Error('fresh workspace has no Agent')
      for (const name of ['create_goal', 'get_goal', 'update_goal']) {
        expect(scaffold.ctx.tools.get(name, agent)).toBeUndefined()
      }
      expect(scaffold.ctx.commands.find(agent, 'goal')).toBeUndefined()
      const old = agent.session.append('goal/change', {
        kind: 'goal/change', version: 1, operation: 'create',
        goal: { id: GoalId('historical-goal'), revision: 1, objective: 'historical work', phase: 'active', maxGoalRounds: 4 },
        roundsStarted: 0, createdAt: 0, updatedAt: 0,
      })
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'queued historical Goal round' }],
        source: { kind: 'goal', goalId: GoalId('historical-goal'), revision: 1, round: 1 },
      }))
      await agent.whenIdle()
      const events = [...agent.session.ownEvents()]
      expect(events.some(event => event.type === 'step/start')).toBe(false)
      expect(events.find(event => event.type === 'goal/change')).toEqual(old)
      expect(await page.locator('[data-goal-bar]').count()).toBe(0)
    } finally {
      await browser.close()
      await scaffold.close()
    }
  })
})
