/**
 * Claude auxiliary-endpoint boundaries: what the Files API upload does with an answer it
 * cannot use, and whether a failed upload leaves anything behind for the next request.
 *
 * The upload path is driven through `bindClaudeFileIds` with an injected fetch and synthetic
 * bytes, so no attachment store, credential or server endpoint is involved. The uploaded-id
 * table is process-global and keyed by account: each case uses its own account key and drops
 * its entries in `finally`, so no case can observe another's cache.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LlmError } from '@deepseek-ai/dsh-llm'
import { CLAUDE_MAX_BASE64_IMAGE_CHARS, bindClaudeFileIds, clearClaudeFileIds } from '../src/providers/claude.js'
import type { FetchFn } from '../src/providers/common.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'

/** One request message carrying an image over the inline vision limit. */
function oversizedImage(): TranslatableMessage[] {
  return [{
    role: 'user',
    content: [{
      type: 'image',
      mediaType: 'image/png',
      dataBase64: 'A'.repeat(CLAUDE_MAX_BASE64_IMAGE_CHARS + 1),
    }],
  }]
}

interface Uploaded {
  fetchFn: FetchFn
  calls(): number
  urls: string[]
  authorization: string[]
}

/** A fetch at the Files endpoint answering one scripted response every time. */
function filesFetch(answer: () => Response): Uploaded {
  let calls = 0
  const urls: string[] = []
  const authorization: string[] = []
  const fetchFn = ((url: unknown, init?: { headers?: Record<string, string> }) => {
    calls += 1
    urls.push(String(url))
    authorization.push(String(init?.headers?.['authorization'] ?? ''))
    return Promise.resolve(answer())
  }) as FetchFn
  return { fetchFn, calls: () => calls, urls, authorization }
}

test('an upload answer without a file id is refused and leaves no cache entry', async () => {
  const account = 'boundary-malformed-upload'
  const upload = filesFetch(() => Response.json({ type: 'file' }))
  try {
    await assert.rejects(
      bindClaudeFileIds(oversizedImage(), account, 'synthetic-token', upload.fetchFn),
      (error: unknown) => {
        assert.ok(error instanceof LlmError, 'the unusable answer is a typed LlmError')
        assert.match(error.message, /no file id/)
        return true
      },
    )
    // The same image is uploaded again rather than bound from a poisoned entry.
    await assert.rejects(bindClaudeFileIds(oversizedImage(), account, 'synthetic-token', upload.fetchFn))
    assert.equal(upload.calls(), 2, 'the failed upload was not remembered')
    assert.equal(upload.urls.every(url => url === 'https://api.anthropic.com/v1/files'), true)
    assert.deepEqual(upload.authorization, ['Bearer synthetic-token', 'Bearer synthetic-token'])
  } finally {
    clearClaudeFileIds(account)
  }
})

test('an upload answer of the wrong type is refused, and a refused upload caches nothing', async () => {
  const account = 'boundary-refused-upload'
  const wrongType = filesFetch(() => Response.json({ id: 'file_1', type: 'message' }))
  const refused = filesFetch(() => new Response('{}', { status: 500 }))
  try {
    await assert.rejects(
      bindClaudeFileIds(oversizedImage(), account, 'synthetic-token', wrongType.fetchFn),
      (error: unknown) => error instanceof LlmError && /no file id/.test(error.message),
    )

    await assert.rejects(
      bindClaudeFileIds(oversizedImage(), account, 'synthetic-token', refused.fetchFn),
      (error: unknown) => {
        assert.match(String((error as Error).message), /claude files API/)
        return true
      },
    )

    // A successful upload afterwards is a fresh request, not a replay of either failure.
    const usable = filesFetch(() => Response.json({ id: 'file_ok', type: 'file' }))
    const bound = await bindClaudeFileIds(oversizedImage(), account, 'synthetic-token', usable.fetchFn)
    const [block] = bound[0]?.content ?? []
    assert.equal(block?.type === 'image' && 'fileId' in block ? block.fileId : undefined, 'file_ok')
    assert.equal(wrongType.calls(), 1)
    assert.equal(refused.calls(), 1)
    assert.equal(usable.calls(), 1)
  } finally {
    clearClaudeFileIds(account)
  }
})
