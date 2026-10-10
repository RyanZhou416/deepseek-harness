/**
 * Prints the key order of the body this plugin actually sends, so it can be compared with
 * the genuine client's order.
 */
import { buildClaudeWireRequest } from '../../src/providers/claude-wire.js'
import type { ClaudeSession } from '../../src/auth/store.js'
import type { TranslatableMessage } from '../../src/translate/resolved.js'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

const session: ClaudeSession = {
  accessToken: 'synthetic-access-token-0123456789abcdef0123456789abcdef0123456789abcdef',
  refreshToken: 'ref',
  expiresAt: Date.now() + 3_600_000,
  scopes: 'user:inference',
  accountUuid: 'uuid-1',
  deviceId: 'a'.repeat(64),
}

const messages: TranslatableMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  { role: 'assistant', content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 'bash', arguments: '{}' }] },
  { role: 'user', content: [{ type: 'tool-result', toolCallId: ToolCallId('c1'), content: [{ type: 'text', text: 'ok' }] }] },
]

const built = await buildClaudeWireRequest(
  { provider: 'claude', model: 'claude-opus-5', messages, system: 'be terse' } as never,
  session,
  messages,
  32_000,
  undefined,
  undefined,
  'sess-1',
  'acct-a',
)

const body = JSON.parse(built.body) as Record<string, unknown>
console.log('  body key order:')
for (const [index, key] of Object.keys(body).entries()) {
  const value = body[key]
  const kind = Array.isArray(value) ? `array(${value.length})` : typeof value
  console.log(`    ${index + 1}. ${key}  (${kind})`)
}
const first = (body.messages as unknown[])[0] as object
console.log('\n  messages[0] keys:', Object.keys(first).join(', '))
console.log('  system[0] keys:  ', Object.keys((body.system as unknown[])[0] as object).join(', '))
const tool = (body.tools as unknown[] | undefined)?.[0]
if (tool) console.log('  tools[0] keys:   ', Object.keys(tool as object).join(', '))
