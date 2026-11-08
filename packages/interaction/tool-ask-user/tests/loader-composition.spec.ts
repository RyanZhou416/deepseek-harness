/** The shipped ask_user_question row honors a composed unattended-mode row through a real Loader. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as systemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import * as toolsPlugin from '@deepseek-ai/dsh-tools'
import * as userQuestionsPlugin from '@deepseek-ai/dsh-user-questions'
import * as unattendedModePlugin from '@deepseek-ai/dsh-unattended-mode'
import * as askUserPlugin from '@deepseek-ai/dsh-tool-ask-user'
import { userAwayMessage } from '@deepseek-ai/dsh-tool-ask-user/src/unattended.ts'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('ask_user_question real Loader composition', () => {
  it('refuses a question while the unattended-mode row is on', async () => {
    root = await mkdtemp(join(tmpdir(), 'ask-user-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: system-prompt',
      '  name: cordis:systemPrompt',
      '- id: tools',
      '  name: cordis:tools',
      '- id: tool-executor-native',
      '  name: cordis:nativeToolExecutor',
      '- id: user-questions',
      '  name: cordis:userQuestions',
      '- id: unattended-mode',
      '  name: cordis:unattendedMode',
      '  config:',
      '    enabled: true',
      '- id: tool-ask-user',
      '  name: cordis:askUser',
      '',
    ].join('\n'))
    const ctx = context = new Context()
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include,
      systemPrompt: systemPromptPlugin,
      tools: toolsPlugin,
      nativeToolExecutor: NativeToolExecutor,
      userQuestions: userQuestionsPlugin,
      unattendedMode: unattendedModePlugin,
      askUser: askUserPlugin,
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()

    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('ask-loader'),
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'continue', question: 'Continue?' }] },
    })

    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'UserQuestionError', code: 'USER_AWAY' } },
      content: [{ type: 'text', text: `Error: ${userAwayMessage}` }],
    })
  })
})
