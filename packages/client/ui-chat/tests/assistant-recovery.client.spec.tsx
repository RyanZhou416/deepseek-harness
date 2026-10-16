// @vitest-environment jsdom
/**
 * Assistant occurrence recovery: the plain-text fallback's content guarantees
 * and the generation key that decides when a failed reply may re-attempt rich
 * rendering. The slot machinery's containment itself is covered by the
 * ui-renderer suites; this file owns what the Chat seat hands it.
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AssistantBlock, AssistantMessageNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import {
  AssistantRecoveryFallback, assistantOccurrenceRecovery,
} from '../src/client/chat/AssistantRecovery.tsx'

const COPY: Record<string, string> = {
  'message.renderFallback.notice': 'render notice',
  'message.renderFallback.reasoning': 'reasoning notice',
  'message.renderFallback.unavailable': 'unavailable notice',
}
const t: TranslateNS<'chat'> = key => COPY[key] ?? key

function assistant(
  blocks: readonly AssistantBlock[],
  finalNode?: AssistantMessageNode,
  key = 'assistant:1:1',
): ChatNode<'assistant-step'> {
  return {
    key,
    id: key,
    kind: 'assistant-step',
    target: 'chat',
    anchorSeq: 2,
    location: { kind: 'session' },
    visibility: 'visible',
    data: {
      status: finalNode === undefined ? 'running' : finalNode.interrupted === true ? 'interrupted' : 'settled',
      turn: 1,
      step: 1,
      time: 2,
      blocks,
      ...finalNode === undefined ? {} : { finalNode },
    },
  }
}

function durable(messageId: string, blocks: readonly AssistantBlock[] = []): AssistantMessageNode {
  return { kind: 'assistant', seq: 4, messageId: messageId as MessageId, time: 4, turn: 1, step: 1, blocks }
}

function syntheticInterrupted(seq: number, blocks: readonly AssistantBlock[] = []): AssistantMessageNode {
  return { kind: 'assistant', seq, interrupted: true, time: 4, turn: 1, step: 1, blocks }
}

describe('assistantOccurrenceRecovery generation key', () => {
  it('keys on the node, the grouped portion, and the tagged reply generation', () => {
    const running = assistantOccurrenceRecovery(assistant([{ kind: 'text', text: 'hi' }]), undefined, t)
    expect(running.resetKey).toBe(JSON.stringify(['assistant:1:1', null, ['running']]))
    expect(running.retryDomMutation).toBe(true)

    const settled = assistantOccurrenceRecovery(
      assistant([{ kind: 'text', text: 'hi' }], durable('m1'), 'assistant:1:1'), 'response', t)
    expect(settled.resetKey).toBe(JSON.stringify(['assistant:1:1', 'response', ['message', 'm1']]))

    const interrupted = assistantOccurrenceRecovery(
      assistant([{ kind: 'text', text: 'cut' }], syntheticInterrupted(4.5)), 'response', t)
    expect(interrupted.resetKey).toBe(JSON.stringify(['assistant:1:1', 'response', ['interrupted', 4.5]]))
  })

  it('keeps a durable generation distinct from a sentinel-reading message id', () => {
    const running = assistantOccurrenceRecovery(assistant([{ kind: 'text', text: 'hi' }]), undefined, t)
    const settled = assistantOccurrenceRecovery(
      assistant([{ kind: 'text', text: 'hi' }], durable('running')), undefined, t)
    const interrupted = assistantOccurrenceRecovery(
      assistant([{ kind: 'text', text: 'hi' }], syntheticInterrupted(2)), undefined, t)
    expect(settled.resetKey).not.toBe(running.resetKey)
    expect(interrupted.resetKey).not.toBe(running.resetKey)
    expect(interrupted.resetKey).not.toBe(settled.resetKey)
  })

  it('keeps one key across a same-Step retry: streaming growth never re-invokes a failed renderer', () => {
    const first = assistantOccurrenceRecovery(assistant([{ kind: 'text', text: 'partial' }]), undefined, t)
    const retried = assistantOccurrenceRecovery(
      assistant([{ kind: 'reasoning', text: 'think' }, { kind: 'text', text: 'partial regenerated' }]), undefined, t)
    expect(retried.resetKey).toBe(first.resetKey)
    // The fallback itself follows the retry: it carries the current text.
    const view = render(<>{retried.fallback}</>)
    expect(view.container.textContent).toContain('partial regenerated')
  })

  it('moves the key when a durable settlement replaces the running generation', () => {
    const running = assistantOccurrenceRecovery(assistant([{ kind: 'text', text: 'hi' }]), undefined, t)
    const settled = assistantOccurrenceRecovery(
      assistant([{ kind: 'text', text: 'hi' }], durable('m2')), undefined, t)
    expect(settled.resetKey).not.toBe(running.resetKey)
  })

  it('separates the reasoning occurrence from the response occurrence of one node', () => {
    const node = assistant([{ kind: 'reasoning', text: 'think' }, { kind: 'text', text: 'answer' }], durable('m3'))
    const response = assistantOccurrenceRecovery(node, undefined, t)
    const reasoning = assistantOccurrenceRecovery(node, 'reasoning', t)
    expect(response.resetKey).not.toBe(reasoning.resetKey)
  })
})

describe('AssistantRecoveryFallback', () => {
  it('renders current text literally with preserved whitespace and no rich rendering', () => {
    const node = assistant([{
      kind: 'text',
      text: '<img src=x onerror="boom()">  two  spaces\nsecond line',
    }])
    const view = render(<AssistantRecoveryFallback node={node} groupPart={undefined} t={t} />)
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.textContent).toContain('<img src=x onerror="boom()">  two  spaces\nsecond line')
    expect(view.container.textContent).toContain('render notice')
    expect(view.container.querySelector<HTMLElement>('div[style]')?.style.whiteSpace).toBe('pre-wrap')
  })

  it('reports unavailable user-facing non-text content without dumping it', () => {
    const node = assistant([
      { kind: 'text', text: 'answer' },
      { kind: 'image', attachment: { mediaType: 'image/png', bytes: 3 } as never },
      { kind: 'other', block: { secret: 'payload' } },
    ])
    const view = render(<AssistantRecoveryFallback node={node} groupPart={undefined} t={t} />)
    expect(view.container.textContent).toContain('answer')
    expect(view.container.textContent).toContain('unavailable notice')
    expect(view.container.textContent).not.toContain('payload')
  })

  it('never exposes hidden reasoning or tool protocol in a response occurrence', () => {
    const node = assistant([
      { kind: 'reasoning', text: 'private chain of thought' },
      { kind: 'tool-call', callId: 'c1', name: 'bash', argsRaw: '{"command":"rm -rf"}' },
      { kind: 'text', text: 'answer' },
    ])
    const view = render(<AssistantRecoveryFallback node={node} groupPart={undefined} t={t} />)
    expect(view.container.textContent).toContain('answer')
    expect(view.container.textContent).not.toContain('private chain of thought')
    expect(view.container.textContent).not.toContain('rm -rf')
    // No user-facing non-text content is present, so no unavailable indicator.
    expect(view.container.textContent).not.toContain('unavailable notice')
  })

  it('shows only the unavailable notice for a reasoning occurrence', () => {
    const node = assistant([{ kind: 'reasoning', text: 'private chain of thought' }])
    const view = render(<AssistantRecoveryFallback node={node} groupPart="reasoning" t={t} />)
    expect(view.container.textContent).toBe('reasoning notice')
    expect(view.container.textContent).not.toContain('private chain of thought')
  })

  it('renders the notice alone for a reply whose text never arrived', () => {
    const node = assistant([{ kind: 'image', attachment: { mediaType: 'image/png', bytes: 1 } as never }])
    const view = render(<AssistantRecoveryFallback node={node} groupPart="response" t={t} />)
    expect(view.container.textContent).toContain('render notice')
    expect(view.container.textContent).toContain('unavailable notice')
  })
})
