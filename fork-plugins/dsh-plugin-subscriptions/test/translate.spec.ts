/**
 * Pure-function tests for the wire translators: request assembly (harness
 * messages → Responses input / Anthropic messages) and the push-model SSE
 * state machines (parsed events → StreamChunk sequences). No network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError, createAssistantMessage, createDeveloperMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '../src/compat.js'
import type { MessageSource, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  ResponsesStreamTranslator,
  toResponsesInput,
  toResponsesTools,
} from '../src/translate/responses.js'
import type { ReasoningReplayItem, ResponsesStreamEvent } from '../src/translate/responses.js'
import {
  AnthropicStreamTranslator,
  MISSING_TOOL_RESULT_TEXT,
  streamAnthropic,
  toAnthropicMessages,
  toAnthropicSystem,
  toAnthropicTools,
} from '../src/translate/anthropic.js'

/**
 * One message's content as blocks. A mid-conversation system message carries its text as a
 * plain string, which is what the genuine client sends, so the union is narrowed here.
 * @param message - an assembled wire message.
 * @returns its content blocks, or none for a string-carrying message.
 */
function blocksOf(message: { content: unknown }): readonly Record<string, unknown>[] {
  return Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : []
}
import type { AnthropicStreamEvent } from '../src/translate/anthropic.js'
import { ENFORCEMENT_CODE } from '../src/providers/common.js'
import { resolveImages, type TranslatableBlock, type TranslatableMessage } from '../src/translate/resolved.js'
import { toChatMessages } from '../src/translate/chat-completions.js'

/** Build a bare message without touching the frozen constructors. */
function message(
  role: TranslatableMessage['role'],
  content: TranslatableBlock[],
  source?: MessageSource,
): TranslatableMessage {
  const resolvedSource = source ?? (role === 'assistant'
    ? { kind: 'model' as const, provider: 'codex', model: 'gpt-5.1-codex' }
    : { kind: 'user' as const })
  return { role, content, source: resolvedSource }
}

function toolCall(id: string, name: string, args: string): TranslatableBlock {
  return { type: 'tool-call', id: ToolCallId(id), name, arguments: args }
}

function toolResult(callId: string, text: string, isError?: boolean): TranslatableBlock {
  return {
    type: 'tool-result',
    toolCallId: ToolCallId(callId),
    content: [{ type: 'text', text }],
    ...isError === undefined ? {} : { isError },
  }
}

/** Feed every event through a translator and flatten the chunks. */
function drain<T>(translator: { push(event: T): StreamChunk[] }, events: T[]): StreamChunk[] {
  return events.flatMap(event => translator.push(event))
}

test('toResponsesInput: text, tool call, and tool result round trip', () => {
  const { instructions, input } = toResponsesInput([
    message('user', [{ type: 'text', text: 'list files' }]),
    message('assistant', [
      { type: 'text', text: 'running ls' },
      toolCall('call-1', 'bash', '{"cmd":"ls"}'),
    ]),
    message('user', [toolResult('call-1', 'file-a\nfile-b')], { kind: 'tool', callId: ToolCallId('call-1') }),
  ], 'be helpful')

  assert.equal(instructions, 'be helpful')
  assert.deepEqual(input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'running ls' }] },
    { type: 'function_call', call_id: 'call-1', name: 'bash', arguments: '{"cmd":"ls"}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'file-a\nfile-b' },
  ])
})

test('toResponsesInput: system-role messages become instructions unless options.system wins', () => {
  const systemMessage = message('system', [{ type: 'text', text: 'from history' }])
  const fromMessages = toResponsesInput([systemMessage])
  assert.equal(fromMessages.instructions, 'from history')
  assert.deepEqual(fromMessages.input, [])
  const explicit = toResponsesInput([systemMessage], 'explicit system')
  assert.equal(explicit.instructions, 'explicit system')
})

test('toResponsesInput: reasoningFor replays completed reasoning items ahead of the tool call', () => {
  const messages = () => [
    message('user', [{ type: 'text', text: 'go' }]),
    message('assistant', [
      toolCall('call-1', 'bash', '{}'),
      toolCall('call-2', 'grep', '{}'),
    ]),
  ]
  // The replay shape is the COMPLETE reasoning item: the Responses input
  // schema does not treat a reasoning item's id or summary as optional.
  const item = (id: string, enc: string): ReasoningReplayItem => ({
    type: 'reasoning',
    id,
    summary: [{ type: 'summary_text', text: 'thought' }],
    status: 'completed',
    encrypted_content: enc,
  })
  // Parallel calls of one response share ONE array instance → replay once,
  // before the first call.
  const shared = [item('rs_1', 'ENC1'), item('rs_2', 'ENC2')]
  assert.deepEqual(toResponsesInput(messages(), undefined, () => shared).input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'thought' }], status: 'completed', encrypted_content: 'ENC1' },
    { type: 'reasoning', id: 'rs_2', summary: [{ type: 'summary_text', text: 'thought' }], status: 'completed', encrypted_content: 'ENC2' },
    { type: 'function_call', call_id: 'call-1', name: 'bash', arguments: '{}' },
    { type: 'function_call', call_id: 'call-2', name: 'grep', arguments: '{}' },
  ])
  // Distinct arrays per call → each replays ahead of its own call.
  const byCall: Record<string, ReasoningReplayItem[]> = {
    'call-1': [item('rs_1', 'E1')],
    'call-2': [item('rs_2', 'E2')],
  }
  assert.deepEqual(toResponsesInput(messages(), undefined, callId => byCall[callId]).input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'thought' }], status: 'completed', encrypted_content: 'E1' },
    { type: 'function_call', call_id: 'call-1', name: 'bash', arguments: '{}' },
    { type: 'reasoning', id: 'rs_2', summary: [{ type: 'summary_text', text: 'thought' }], status: 'completed', encrypted_content: 'E2' },
    { type: 'function_call', call_id: 'call-2', name: 'grep', arguments: '{}' },
  ])
  // Items captured without optional fields replay with just the required ones.
  const minimal: ReasoningReplayItem[] = [{ type: 'reasoning', id: 'rs_3', encrypted_content: 'E3' }]
  assert.deepEqual(
    toResponsesInput(
      [message('assistant', [toolCall('call-x', 'bash', '{}')])],
      undefined,
      () => minimal,
    ).input,
    [
      { type: 'reasoning', id: 'rs_3', encrypted_content: 'E3' },
      { type: 'function_call', call_id: 'call-x', name: 'bash', arguments: '{}' },
    ],
  )
  // An unknown call id injects nothing.
  const toolOnly = [{ type: 'function_call', call_id: 'call-x', name: 'bash', arguments: '{}' }]
  assert.deepEqual(
    toResponsesInput([message('assistant', [toolCall('call-x', 'bash', '{}')])], undefined, () => undefined).input,
    toolOnly,
  )
  // Omitting the callback keeps the pre-replay behavior.
  assert.deepEqual(toResponsesInput([message('assistant', [toolCall('call-x', 'bash', '{}')])]).input, toolOnly)
})

test('toResponsesTools maps to Responses function tools', () => {
  assert.deepEqual(toResponsesTools([{ name: 'bash', description: 'run', parameters: { type: 'object' } }], { strict: false }), [
    { type: 'function', name: 'bash', description: 'run', parameters: { type: 'object' }, strict: false },
  ])
})

test('toResponsesInput: resolved image parts become input_image data URLs', () => {
  const { input } = toResponsesInput([{
    role: 'user',
    content: [
      { type: 'text', text: 'what is this?' },
      { type: 'image', mediaType: 'image/png', dataBase64: 'aGk=' },
    ],
  }])
  assert.deepEqual(input, [{
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'what is this?' },
      { type: 'input_image', image_url: 'data:image/png;base64,aGk=' },
    ],
  }])
  // An unresolved ImageBlock (attachment reference only) is skipped.
  const unresolved = toResponsesInput([{
    role: 'user',
    content: [{ type: 'image', attachment: { attachmentId: 'x' } } as never],
  }])
  assert.deepEqual(unresolved.input, [])
})

test('resolveImages: passthrough, loud failure without attachments, and resolution', async () => {
  const plain: RequestMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  const unchanged = await resolveImages(plain, undefined)
  assert.equal(unchanged[0], plain[0], 'no images preserve ordinary message identity')

  const withImage: RequestMessage[] = [{ role: 'user', content: [{
    type: 'image',
    attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
  } as never] }]
  await assert.rejects(
    () => resolveImages(withImage, undefined),
    (error: unknown) => error instanceof LlmError && error.code === 'UNSUPPORTED',
  )

  const attachments = {
    readImageRequest: (ref: ImageAttachmentRef) => Promise.resolve({ ...ref, attachment: ref, data: new Uint8Array([104, 105]) }),
  } as never
  const resolved = await resolveImages(withImage, attachments)
  assert.deepEqual(resolved[0].content[0], { type: 'image', mediaType: 'image/png', dataBase64: 'aGk=' })
  assert.match((resolved[0].content[1] as { text: string }).text, /image_generate.referenceImages/)
  assert.match((resolved[0].content[1] as { text: string }).text, /"attachmentId":"a1"/)
})

test('V4 tool messages keep their call identity, error flag and request-only user input', async () => {
  const callId = ToolCallId('v4-call')
  const input: RequestMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'start' }] },
    createToolResultMessage({ callId, isError: true, content: [{ type: 'text', text: 'failed' }] }),
  ]
  const resolved = await resolveImages(input, undefined)
  assert.equal(resolved[0], input[0])
  assert.deepEqual(resolved[1], {
    role: 'user', source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, isError: true, content: [{ type: 'text', text: 'failed' }] }],
  })
  assert.deepEqual(toChatMessages(resolved), [
    { role: 'user', content: 'start' },
    { role: 'tool', tool_call_id: 'v4-call', content: 'failed' },
  ])
  await assert.rejects(
    () => resolveImages([createDeveloperMessage({ content: [{ type: 'text', text: 'new tool' }], source: { kind: 'user' } })], undefined),
    (error: unknown) => error instanceof LlmError && error.code === 'UNSUPPORTED_CONTENT',
  )
})

test('tool-result images: resolve attachments and retain parallel results before image follow-up', async () => {
  const ref = { attachmentId: 'tool-image', mediaType: 'image/png', bytes: 2, width: 1, height: 1 }
  const messages = [
    createAssistantMessage({
      content: ['a', 'b'].map(id => ({ type: 'tool-call', id: ToolCallId(id), name: 'read_image', arguments: '{}' })),
      source: { provider: 'codex', model: 'test' },
    }),
    ...['a', 'b'].map(id => createToolResultMessage({
      callId: ToolCallId(id), isError: false,
      content: [{ type: 'text', text: id }, { type: 'image', attachment: ref } as never],
    })),
  ]
  const before = structuredClone(messages)
  const signal = new AbortController().signal
  let reads = 0
  const resolved = await resolveImages(messages, {
    readImageRequest: async (attachment: unknown, _target: unknown, actualSignal: unknown) => {
      assert.deepEqual(attachment, ref)
      assert.equal(actualSignal, signal)
      reads++
      return { ...ref, attachment: ref, data: new Uint8Array([104, 105]) }
    },
  } as never, signal)
  assert.equal(reads, 1)
  assert.deepEqual(messages, before, 'must not mutate stored history')
  const anthropic = toAnthropicMessages(resolved)
  for (const result of blocksOf(anthropic[1])) {
    assert.equal(result.type, 'tool_result')
    assert.deepEqual((result.content as unknown[])[1], {
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' },
    })
  }
  const responses = toResponsesInput(resolved).input
  assert.deepEqual(responses.map(item => item.type), ['function_call', 'function_call', 'function_call_output', 'function_call_output', 'message'])
  const responseImages = (responses[4].content as Record<string, unknown>[]).filter(part => part.type === 'input_image')
  assert.equal(responseImages.length, 2)
  assert.equal(responseImages[0].image_url, 'data:image/png;base64,aGk=')
  const chat = toChatMessages(resolved)
  assert.deepEqual(chat.map(item => item.role), ['assistant', 'tool', 'tool', 'user'])
  assert.equal((chat[3].content as Record<string, unknown>[]).filter(part => part.type === 'image_url').length, 2)
  await assert.rejects(() => resolveImages(messages, undefined), (error: unknown) => error instanceof LlmError && error.code === 'UNSUPPORTED')
  await assert.rejects(() => resolveImages(messages, { readImageRequest: async () => { throw new Error('read failed') } } as never), /read failed/)
})

test('tool-result images: image-only errors, multiple images and separate turns retain their content', () => {
  const image = { type: 'image' as const, mediaType: 'image/jpeg', dataBase64: 'aGk=' }
  const messages: TranslatableMessage[] = [
    { role: 'assistant', content: [toolCall('first', 'bash', '{}'), toolCall('second', 'bash', '{}')] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: ToolCallId('first'), isError: true, content: [image, image] }] },
    { role: 'assistant', content: [{ type: 'text', text: 'first image seen' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: ToolCallId('second'), content: [{ type: 'text', text: 'caption' }, image] }] },
  ]
  const anthropic = toAnthropicMessages(messages)
  assert.deepEqual(blocksOf(anthropic[0]).map(block => block.type), ['tool_use', 'tool_use'], 'parallel calls stay one assistant turn')
  assert.equal(blocksOf(anthropic[2])[0]?.type, 'text', 'the interleaved assistant text keeps its own turn')
  const first = anthropic[1].content[0] as { is_error?: boolean; content?: unknown[] }
  assert.equal(first.is_error, true)
  assert.equal((first.content as unknown[]).length, 2, 'an image-only result keeps both images')
  const second = anthropic[3].content[0] as { content?: unknown[] }
  assert.equal((second.content as unknown[]).length, 2, 'caption text followed by the image')
  assert.equal((second.content as { type: string }[])[0].type, 'text')
  assert.equal((second.content as { type: string }[])[1].type, 'image')
})

test('Responses translator: text + tool call stream yields usage before finish', () => {
  const events: ResponsesStreamEvent[] = [
    { type: 'response.output_item.added', item: { type: 'message', id: 'msg-1' } },
    { type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'Hel' },
    { type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'lo' },
    {
      type: 'response.output_item.added',
      item: { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'bash' },
    },
    { type: 'response.function_call_arguments.delta', item_id: 'fc-1', delta: '{"cmd":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc-1', delta: '"ls"}' },
    {
      type: 'response.output_item.done',
      item: { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'bash', arguments: '{"cmd":"ls"}' },
    },
    { type: 'response.output_item.done', item: { type: 'message', id: 'msg-1' } },
    {
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          input_tokens_details: { cached_tokens: 30 },
          output_tokens_details: { reasoning_tokens: 5 },
        },
      },
    },
  ]
  const chunks = drain(new ResponsesStreamTranslator(), events)
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'bash', argumentsDelta: '' },
    { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'bash', argumentsDelta: '{"cmd":' },
    { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'bash', argumentsDelta: '"ls"}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"cmd":"ls"}' } },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
    { type: 'usage', usage: { inputTokens: 70, outputTokens: 20, cacheReadTokens: 30, reasoningTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
})

test('Responses translator: plain text completion finishes with stop', () => {
  const chunks = drain(new ResponsesStreamTranslator(), [
    { type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'hi' },
    { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } },
  ])
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('Responses translator: empty completion is an EMPTY_RESPONSE error finish', () => {
  const chunks = drain(new ResponsesStreamTranslator(), [
    { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 0 } } },
  ])
  assert.deepEqual(chunks.at(-1), {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' },
    },
  })
  const usageIndex = chunks.findIndex(chunk => chunk.type === 'usage')
  assert.ok(usageIndex >= 0 && usageIndex < chunks.length - 1, 'usage comes before finish')
})

test('Responses translator: response.failed maps context overflow and quota', () => {
  const overflow = new ResponsesStreamTranslator()
  assert.throws(
    () => overflow.push({ type: 'response.failed', response: { error: { code: 'context_window_exceeded', message: 'too long' } } }),
    (error: unknown) => error instanceof LlmError && error.code === 'CONTEXT_WINDOW_EXCEEDED',
  )
  const quota = new ResponsesStreamTranslator()
  assert.throws(
    () => quota.push({ type: 'response.failed', response: { error: { code: 'insufficient_quota', message: 'out of credits' } } }),
    (error: unknown) => error instanceof LlmError && error.code === 'QUOTA',
  )
  const generic = new ResponsesStreamTranslator()
  assert.throws(
    () => generic.push({ type: 'error', code: 'server_error', message: 'boom' }),
    (error: unknown) => error instanceof LlmError && error.code === 'SERVER',
  )
})

test('toAnthropicMessages: merge, tool_use input parsing, tool_result', () => {
  const messages = toAnthropicMessages([
    message('system', [{ type: 'text', text: 'system text' }]),
    message('user', [{ type: 'text', text: 'first' }]),
    message('user', [
      { type: 'text', text: 'second' },
      toolResult('call-1', 'result text', true),
    ]),
    message('assistant', [
      { type: 'text', text: 'calling' },
      toolCall('call-1', 'bash', '{"cmd":"ls"}'),
    ]),
  ])
  assert.deepEqual(messages, [
    {
      // The merged user message leads with its tool result; the texts keep
      // their relative order behind it.
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call-1', content: 'result text', is_error: true },
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 'call-1', name: 'bash', input: { cmd: 'ls' } },
      ],
    },
  ])

  // Malformed tool-call JSON degrades to an empty object, never a crash.
  const malformed = toAnthropicMessages([
    message('assistant', [toolCall('c', 'n', '{bad')]),
  ])
  assert.deepEqual(malformed[0].content[0], { type: 'tool_use', id: 'c', name: 'n', input: {} })
})

test('toAnthropicMessages: a replayed tool call in a user message rides as text', () => {
  // A settled background subagent's closing message is spliced into the parent
  // conversation as a user-role notice, carrying the subagent's own blocks —
  // including tool calls that never got a result. Anthropic rejects `tool_use`
  // outside assistant messages, so those must not reach the wire as tool_use.
  const messages = toAnthropicMessages([
    message('user', [
      { type: 'text', text: 'Background subagent 7f21c45a failed before it finished.' },
      toolCall('toolu_01MG', 'bash', '{"command":"ls"}'),
    ], { kind: 'user' }),
  ])
  assert.deepEqual(messages, [{
    role: 'user',
    content: [
      { type: 'text', text: 'Background subagent 7f21c45a failed before it finished.' },
      { type: 'text', text: '[tool call bash: {"command":"ls"}]' },
    ],
  }])
  assert.ok(!JSON.stringify(messages).includes('tool_use'))
})

test('toAnthropicMessages: merged user message keeps tool_result blocks in one leading run', () => {
  // A parallel tool batch arrives as one result message per call, so context
  // spliced mid-batch merges in between them. Anthropic answers each tool_use
  // against the blocks leading the next message, so the results must regroup
  // at the front or the request is rejected for an unanswered call.
  const messages = toAnthropicMessages([
    message('assistant', [toolCall('call-1', 'bash', '{}'), toolCall('call-2', 'bash', '{}')]),
    message('user', [toolResult('call-1', 'first')], { kind: 'tool', callId: ToolCallId('call-1') }),
    message('user', [{ type: 'text', text: 'spliced notice' }]),
    message('user', [toolResult('call-2', 'second')], { kind: 'tool', callId: ToolCallId('call-2') }),
  ])
  assert.deepEqual(messages[1], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'call-1', content: 'first' },
      { type: 'tool_result', tool_use_id: 'call-2', content: 'second' },
      { type: 'text', text: 'spliced notice' },
    ],
  })

  // A user message with no tool results is left exactly as assembled.
  const plain = toAnthropicMessages([
    message('user', [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
  ])
  assert.deepEqual(plain[0].content, [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
})

test('toAnthropicMessages: resolved image parts become base64 image blocks', () => {
  const messages = toAnthropicMessages([{
    role: 'user',
    content: [
      { type: 'image', mediaType: 'image/png', dataBase64: 'aGk=' },
      { type: 'text', text: 'what is this?' },
    ],
  }])
  assert.deepEqual(messages, [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
      { type: 'text', text: 'what is this?' },
    ],
  }])
})

test('toAnthropicSystem: explicit and history system text, no identity block', () => {  const blocks = toAnthropicSystem('explicit', [message('system', [{ type: 'text', text: 'from history' }])])
  assert.deepEqual(blocks, [
    { type: 'text', text: 'explicit' },
    { type: 'text', text: 'from history' },
  ], 'the wire builder prepends the billing and identity blocks itself')
  assert.deepEqual(toAnthropicSystem(), [], 'no caller system text means no blocks')
})

test('toAnthropicSystem hoists only the system messages that precede the conversation', () => {
  const history = [
    message('system', [{ type: 'text', text: 'opening' }]),
    message('user', [{ type: 'text', text: 'hi' }]),
    message('system', [{ type: 'text', text: 'mid-conversation' }]),
  ]
  assert.deepEqual(toAnthropicSystem('explicit', history), [
    { type: 'text', text: 'explicit' },
    { type: 'text', text: 'opening' },
  ], 'a later system message must not move in front of the cached history')
})

test('toAnthropicMessages rides a later system message as a user reminder on every model', () => {
  // The pinned wire contract models no system-role message, so even models
  // that support mid-conversation system get the reminder form — merged into
  // the surrounding user turn because both share one wire role.
  const messages = toAnthropicMessages([
    message('user', [{ type: 'text', text: 'hi' }]),
    message('system', [{ type: 'text', text: 'terse mode' }]),
  ], 'claude-opus-5')
  assert.deepEqual(messages, [{
    role: 'user',
    content: [
      { type: 'text', text: 'hi' },
      { type: 'text', text: '<system-reminder>terse mode</system-reminder>' },
    ],
  }])
})

test('toAnthropicMessages keeps Sonnet 5 mid-conversation system text as a reminder', () => {
  const messages = toAnthropicMessages([
    message('user', [{ type: 'text', text: 'hi' }]),
    message('assistant', [{ type: 'text', text: 'hello' }]),
    message('system', [{ type: 'text', text: 'terse mode' }]),
  ], 'claude-sonnet-5')
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder>terse mode</system-reminder>' }],
  })
})

test('toAnthropicMessages sends a Files API image by file_id', () => {
  const messages = toAnthropicMessages([
    message('user', [{ type: 'image', mediaType: 'image/png', dataBase64: 'aGk=', fileId: 'file_011' }]),
  ])
  assert.deepEqual(messages[0].content, [
    { type: 'image', source: { type: 'file', file_id: 'file_011' } },
  ])
})

test('toAnthropicTools adds the regex tool search tool only for deferred tools', () => {
  const deferred = toAnthropicTools([
    { name: 'bash', description: 'run', parameters: { type: 'object' }, deferLoading: true },
  ])
  assert.deepEqual(deferred[0], { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' })
  assert.deepEqual(deferred[1], {
    name: 'bash',
    description: 'run',
    input_schema: { type: 'object' },
    defer_loading: true,
  })
})

test('toAnthropicMessages: a mid-conversation system message rides in place as a reminder', () => {
  const messages = toAnthropicMessages([
    message('system', [{ type: 'text', text: 'opening' }]),
    message('user', [{ type: 'text', text: 'hi' }]),
    message('assistant', [{ type: 'text', text: 'hello' }]),
    message('system', [{ type: 'text', text: 'terse mode' }]),
  ])
  assert.deepEqual(messages, [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>terse mode</system-reminder>' }] },
  ])
})

test('toAnthropicSystem places no cache breakpoints; the wire builder owns them', () => {
  assert.deepEqual(toAnthropicSystem('explicit'), [{ type: 'text', text: 'explicit' }])
})

test('toAnthropicMessages narrates a tool result whose tool_use was narrated away', () => {
  // A replayed user-role notice can carry a settled subagent's tool call
  // (narrated as text) while a later merge still carries its result; the wire
  // validator rejects a tool_result without a matching tool_use, so it rides
  // as text instead.
  const messages = toAnthropicMessages([
    message('user', [toolCall('c1', 'bash', '{}')], { kind: 'user' }),
    message('user', [toolResult('c1', 'done')]),
  ])
  assert.deepEqual(messages[0].content, [
    // The merged user message leads with its tool_result run, so the narrated
    // result sits ahead of the narrated call.
    { type: 'text', text: '[tool result c1: done]' },
    { type: 'text', text: '[tool call bash: {}]' },
  ])
  assert.ok(!JSON.stringify(messages).includes('tool_result'))
})

test('toAnthropicMessages answers a tool_use whose result is missing', () => {
  // A call whose result never reached the log (a crash whose tail repair ran
  // before the closed step) still has to be answered: the wire contract
  // requires the result in the message following the call. The genuine client
  // synthesizes it with its own wording and error flag.
  const history = [
    message('user', [{ type: 'text', text: 'go' }]),
    message('assistant', [toolCall('c1', 'bash', '{}')]),
    message('user', [{ type: 'text', text: 'still here' }]),
  ]
  const messages = toAnthropicMessages(history)
  assert.deepEqual(messages[2].content, [
    { type: 'tool_result', tool_use_id: 'c1', content: MISSING_TOOL_RESULT_TEXT, is_error: true },
    { type: 'text', text: 'still here' },
  ])
  assert.equal(MISSING_TOOL_RESULT_TEXT, '[Tool result missing due to internal error]', 'the client wording verbatim')
  assert.deepEqual(history[2].content, [{ type: 'text', text: 'still here' }], 'the durable history is never mutated')
})

test('toAnthropicMessages appends the synthesized result when no message follows the call', () => {
  const messages = toAnthropicMessages([
    message('assistant', [
      toolCall('c1', 'bash', '{}'),
      toolCall('c2', 'bash', '{}'),
    ]),
  ])
  assert.deepEqual(messages[1], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'c1', content: MISSING_TOOL_RESULT_TEXT, is_error: true },
      { type: 'tool_result', tool_use_id: 'c2', content: MISSING_TOOL_RESULT_TEXT, is_error: true },
    ],
  })
})

test('toAnthropicMessages invents no result for a call answered later in the request', () => {
  // Pairing is request-wide, as in `reconcileResponsesToolCalls`: a call whose
  // result is present anywhere needs no placeholder, even two turns later.
  const messages = toAnthropicMessages([
    message('assistant', [toolCall('c1', 'bash', '{}')]),
    message('user', [{ type: 'text', text: 'note' }]),
    message('assistant', [{ type: 'text', text: 'more' }]),
    message('user', [toolResult('c1', 'late')]),
  ])
  assert.equal(JSON.stringify(messages).includes(MISSING_TOOL_RESULT_TEXT), false)
  assert.equal(messages.length, 4)
})

test('toAnthropicMessages answers only the calls an existing result leaves open', () => {
  const messages = toAnthropicMessages([
    message('assistant', [
      toolCall('c1', 'bash', '{}'),
      toolCall('c2', 'bash', '{}'),
    ]),
    message('user', [toolResult('c1', 'ok')]),
  ])
  assert.deepEqual(messages[1].content, [
    { type: 'tool_result', tool_use_id: 'c2', content: MISSING_TOOL_RESULT_TEXT, is_error: true },
    { type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
  ])
})

test('toAnthropicMessages: a system reminder merged with tool results stays behind the leading run', () => {
  const messages = toAnthropicMessages([
    message('user', [{ type: 'text', text: 'go' }]),
    message('assistant', [toolCall('c1', 'bash', '{}')]),
    message('user', [toolResult('c1', 'ok')]),
    message('system', [{ type: 'text', text: 'terse mode' }]),
  ])
  assert.deepEqual(messages[2].content, [
    { type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
    { type: 'text', text: '<system-reminder>terse mode</system-reminder>' },
  ], 'tool_result blocks must still lead the merged message')
})

test('an all-system history hoists everything and leaves no messages', () => {
  const history = [
    message('system', [{ type: 'text', text: 'first' }]),
    message('system', [{ type: 'text', text: 'second' }]),
  ]
  assert.deepEqual(toAnthropicSystem(undefined, history), [
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' },
  ])
  assert.deepEqual(toAnthropicMessages(history), [])
})

test('toAnthropicMessages replays a signed thinking block for the same Claude model', () => {
  const messages = toAnthropicMessages([
    message('assistant', [
      { type: 'reasoning', text: 'plan' },
      { type: 'text', text: 'done' },
    ], {
      kind: 'model',
      provider: 'claude',
      model: 'claude-opus-5-5',
      replayState: {
        response: { kind: 'claude', version: 1 },
        blocks: [{ signature: 'sig-1' }, {}],
      },
    }),
  ], 'claude-opus-5-5')
  assert.deepEqual(messages[0].content, [
    { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
    { type: 'text', text: 'done' },
  ])
})

test('toAnthropicMessages drops unsigned reasoning and a signature from another model', () => {
  const content = [
    { type: 'reasoning' as const, text: 'plan' },
    { type: 'text' as const, text: 'done' },
  ]
  const unsigned = toAnthropicMessages([
    message('assistant', content, { kind: 'model', provider: 'claude', model: 'claude-opus-5-5' }),
  ], 'claude-opus-5-5')
  assert.deepEqual(unsigned[0].content, [{ type: 'text', text: 'done' }])
  const otherModel = toAnthropicMessages([
    message('assistant', content, {
      kind: 'model',
      provider: 'claude',
      model: 'claude-opus-5',
      replayState: {
        response: { kind: 'claude', version: 1 },
        blocks: [{ signature: 'sig-old' }, {}],
      },
    }),
  ], 'claude-opus-5-5')
  assert.deepEqual(otherModel[0].content, [{ type: 'text', text: 'done' }])
})

test('toAnthropicMessages replays redacted thinking ahead of the tool call', () => {
  const messages = toAnthropicMessages([
    message('assistant', [
      { type: 'reasoning', text: '' },
      toolCall('c1', 'bash', '{}'),
    ], {
      kind: 'model',
      provider: 'claude',
      model: 'claude-opus-5-5',
      replayState: {
        response: { kind: 'claude', version: 1 },
        blocks: [{ redacted: 'opaque' }, {}],
      },
    }),
  ], 'claude-opus-5-5')
  assert.deepEqual(messages[0].content, [
    { type: 'redacted_thinking', data: 'opaque' },
    { type: 'tool_use', id: 'c1', name: 'bash', input: {} },
  ])
})

test('toAnthropicSystem is empty when no caller system text exists', () => {
  assert.deepEqual(toAnthropicSystem(), [])
})

test('toAnthropicTools maps to input_schema tools', () => {
  assert.deepEqual(toAnthropicTools([{ name: 'bash', description: 'run', parameters: { type: 'object' } }]), [
    { name: 'bash', description: 'run', input_schema: { type: 'object' } },
  ])
})

test('toAnthropicTools sorts by name so the tools prefix survives registration order', () => {
  const schemas = [
    { name: 'write', description: 'write a file', parameters: { type: 'object' } },
    { name: 'bash', description: 'run', parameters: { type: 'object' } },
  ]
  assert.deepEqual(toAnthropicTools(schemas), [
    { name: 'bash', description: 'run', input_schema: { type: 'object' } },
    { name: 'write', description: 'write a file', input_schema: { type: 'object' } },
  ])
  assert.deepEqual(
    toAnthropicTools([...schemas].reverse()),
    toAnthropicTools(schemas),
    'the wire order does not depend on the input order',
  )
})

test('Anthropic translator: text + tool_use stream with usage before finish', () => {
  const events: AnthropicStreamEvent[] = [
    { type: 'message_start', message: { usage: { input_tokens: 50, cache_read_input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu-1', name: 'bash' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ls"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ]
  const chunks = drain(new AnthropicStreamTranslator(), events)
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'toolu-1', name: 'bash', argumentsDelta: '' },
    { type: 'tool-call-delta', index: 1, id: 'toolu-1', name: 'bash', argumentsDelta: '{"cmd":' },
    { type: 'tool-call-delta', index: 1, id: 'toolu-1', name: 'bash', argumentsDelta: '"ls"}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'toolu-1', name: 'bash', arguments: '{"cmd":"ls"}' } },
    { type: 'usage', usage: { inputTokens: 50, outputTokens: 7, cacheReadTokens: 10 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
})

test('Anthropic translator records output_tokens_details.thinking_tokens', () => {
  const chunks = drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 9, output_tokens_details: { thinking_tokens: 6 } },
    },
    { type: 'message_stop' },
  ])
  const usage = chunks.find(chunk => chunk.type === 'usage')
  assert.ok(usage?.type === 'usage')
  assert.equal(usage.usage.reasoningTokens, 6)
  assert.equal(usage.usage.outputTokens, 9)
})

test('Anthropic translator keeps a thinking signature on the finish envelope', () => {
  const chunks = drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ])
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type !== 'finish') return
  assert.deepEqual(finish.replayState, {
    response: { kind: 'claude', version: 1 },
    blocks: [{ signature: 'sig' }, {}],
  })
  const reasoning = chunks.find(chunk => chunk.type === 'block-end')
  assert.ok(reasoning?.type === 'block-end')
  assert.deepEqual(reasoning.block, { type: 'reasoning', text: 'plan' })
})

test('Anthropic translator keeps redacted thinking data on the finish envelope', () => {
  const chunks = drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ])
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type !== 'finish') return
  assert.deepEqual(finish.replayState, {
    response: { kind: 'claude', version: 1 },
    blocks: [{ redacted: 'opaque' }],
  })
})

test('Anthropic translator captures server tool blocks with their insertion positions', () => {
  const chunks = drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'searching' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'server_tool_use', id: 'srvtoolu-1', name: 'tool_search_tool_regex', input: {} },
    },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"lint"}' } },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: {
        type: 'tool_search_tool_result',
        tool_use_id: 'srvtoolu-1',
        content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'lint' }] },
      },
    },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 3, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'found it' } },
    { type: 'content_block_stop', index: 3 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
    { type: 'message_stop' },
  ])

  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type !== 'finish') return
  // The server blocks occupy no harness block, so both sit ahead of the second text block
  // and the per-block entries stay aligned with the harness blocks the model streamed.
  assert.deepEqual(finish.replayState, {
    response: {
      kind: 'claude',
      version: 1,
      serverBlocks: [
        {
          index: 1,
          block: { type: 'server_tool_use', id: 'srvtoolu-1', name: 'tool_search_tool_regex', input: { query: 'lint' } },
        },
        {
          index: 1,
          block: {
            type: 'tool_search_tool_result',
            tool_use_id: 'srvtoolu-1',
            content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'lint' }] },
          },
        },
      ],
    },
    blocks: [{}, {}],
  })
  const ends = chunks.filter(chunk => chunk.type === 'block-end')
  assert.deepEqual(
    ends.map(chunk => (chunk.type === 'block-end' ? chunk.block.type : '')),
    ['text', 'text'],
  )
})

test('toAnthropicMessages splices captured server blocks back in verbatim', () => {
  const chunks = drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'searching' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'server_tool_use', id: 'srvtoolu-1', name: 'tool_search_tool_regex', input: {} },
    },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"lint"}' } },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: {
        type: 'tool_search_tool_result',
        tool_use_id: 'srvtoolu-1',
        content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'lint' }] },
      },
    },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 3, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'found it' } },
    { type: 'content_block_stop', index: 3 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
    { type: 'message_stop' },
  ])
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish' && finish.replayState !== undefined)

  const messages = toAnthropicMessages([
    message('user', [{ type: 'text', text: 'find a tool' }]),
    message('assistant', [
      { type: 'text', text: 'searching' },
      { type: 'text', text: 'found it' },
    ], {
      kind: 'model',
      provider: 'claude',
      model: 'claude-opus-5-5',
      replayState: finish.replayState,
    }),
  ], 'claude-opus-5-5')

  assert.deepEqual(blocksOf(messages[0]), [{ type: 'text', text: 'find a tool' }])
  assert.deepEqual(blocksOf(messages[1]), [
    { type: 'text', text: 'searching' },
    { type: 'server_tool_use', id: 'srvtoolu-1', name: 'tool_search_tool_regex', input: { query: 'lint' } },
    {
      type: 'tool_search_tool_result',
      tool_use_id: 'srvtoolu-1',
      content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'lint' }] },
    },
    { type: 'text', text: 'found it' },
  ])
})

test('Anthropic translator records nothing for a response with no replayable block', () => {
  const chunks = drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 2 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('Anthropic translator: stop reasons and empty completion', () => {
  const maxed = drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ])
  assert.deepEqual(maxed.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })

  const empty = drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
    { type: 'message_stop' },
  ])
  assert.deepEqual(empty.at(-1), {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' },
    },
  })
  const usageIndex = empty.findIndex(chunk => chunk.type === 'usage')
  assert.ok(usageIndex >= 0 && usageIndex < empty.length - 1, 'usage comes before finish')
})

test('Anthropic translator: error event mapping', () => {
  const tooLong = new AnthropicStreamTranslator()
  assert.throws(
    () => tooLong.push({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 300000 tokens' } }),
    (error: unknown) => error instanceof LlmError && error.code === 'CONTEXT_WINDOW_EXCEEDED',
  )
  // A rate-limit event is retryable by default: its usual cause is a window that
  // reopens. What makes one final is a fact about the response it arrived on, so
  // the caller's probe decides, and without one the default stands.
  const rateLimited = new AnthropicStreamTranslator()
  assert.throws(
    () => rateLimited.push({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }),
    (error: unknown) => error instanceof LlmError && error.code === 'RATE_LIMIT',
  )
  const overloaded = new AnthropicStreamTranslator()
  assert.throws(
    () => overloaded.push({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
    (error: unknown) => error instanceof LlmError && error.code === 'SERVER',
  )
  const auth = new AnthropicStreamTranslator()
  assert.throws(
    () => auth.push({ type: 'error', error: { type: 'authentication_error', message: 'bad token' } }),
    (error: unknown) => error instanceof LlmError && error.code === 'AUTH',
  )
})

test('an in-band rate limit the response states is final raises ENFORCEMENT', () => {
  // The refusal reaches the harness inside a 200, so no status classifies it; the
  // probe reads the response's own signals and the event is terminal.
  const refused = new AnthropicStreamTranslator(undefined, () => true)
  assert.throws(
    () => refused.push({ type: 'error', error: { type: 'rate_limit_error', message: 'usage credits are required' } }),
    (error: unknown) => error instanceof LlmError && error.code === ENFORCEMENT_CODE,
  )
})

test('an in-band rate limit with a disclosed window keeps its retryable code', () => {
  const limited = new AnthropicStreamTranslator(undefined, () => false)
  assert.throws(
    () => limited.push({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }),
    (error: unknown) => error instanceof LlmError && error.code === 'RATE_LIMIT',
  )
  // The probe is consulted for the retryable event type alone: a credential
  // refusal keeps AUTH whatever the response said.
  const auth = new AnthropicStreamTranslator(undefined, () => true)
  assert.throws(
    () => auth.push({ type: 'error', error: { type: 'authentication_error', message: 'bad token' } }),
    (error: unknown) => error instanceof LlmError && error.code === 'AUTH',
  )
})

test('blank text blocks are dropped from a request, and a message left empty gets a placeholder', () => {
  // The API rejects a text block whose content is whitespace-only, and the genuine
  // client strips such blocks before sending and substitutes a placeholder when a
  // message is left with none.
  const anthropic = toAnthropicMessages([
    { role: 'user', content: [{ type: 'text', text: '   ' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'kept' }, { type: 'text', text: '\n\t' }] },
  ] as never)
  assert.deepEqual(anthropic[0].content, [{ type: 'text', text: '(no content)' }])
  assert.deepEqual(anthropic[1].content, [{ type: 'text', text: 'kept' }])
})

test('Anthropic translator: a refusal is reported as its own finish reason', () => {
  const events: AnthropicStreamEvent[] = [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 0 } },
    { type: 'message_stop' },
  ]
  const chunks = drain(new AnthropicStreamTranslator(), events)
  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.deepEqual(finish, { type: 'finish', reason: { kind: 'refusal' } })
})

/** One SSE frame carrying a stream event. */
function anthropicFrame(type: string, payload: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

/** A response body that carries exactly the given frames and then ends. */
function anthropicBody(frames: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

/** A complete text response: message_start through message_stop. */
const TEXT_RESPONSE: readonly string[] = [
  anthropicFrame('message_start', { type: 'message_start', message: { usage: { input_tokens: 5 } } }),
  anthropicFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  anthropicFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
  anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
  anthropicFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
  anthropicFrame('message_stop', { type: 'message_stop' }),
]

test('streamAnthropic: a body that ends before message_stop fails as a retryable transport truncation', async () => {
  const chunks: StreamChunk[] = []
  let failure: unknown
  try {
    for await (const chunk of streamAnthropic(anthropicBody(TEXT_RESPONSE.slice(0, -1)))) chunks.push(chunk)
  } catch (error) {
    failure = error
  }
  // What the stream already delivered stays delivered; the missing terminal event is the
  // failure, and the client retries it as a dropped connection.
  assert.deepEqual(chunks.at(-1), { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } })
  assert.ok(failure instanceof LlmError, 'a truncated body throws')
  assert.equal(failure.code, 'TRANSPORT', 'the retry policy repeats TRANSPORT')
})

test('streamAnthropic: a body with its terminal event completes without throwing', async () => {
  const chunks: StreamChunk[] = []
  for await (const chunk of streamAnthropic(anthropicBody(TEXT_RESPONSE))) chunks.push(chunk)
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'hi'))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})
