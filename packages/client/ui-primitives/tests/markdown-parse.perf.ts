/**
 * Threshold-free diagnostic for the settled Markdown parse cost of one block.
 * It mirrors the renderer's settled grammar (`src/markdown/parse.ts`) without
 * the React/CSS import graph and times a 100 KB, 1 MB, and 4 MB block, so the
 * per-byte ratio answers whether parse cost is linear in source bytes or
 * superlinear in one long block. It asserts no budget and joins no gate.
 *
 * Run from the repository root after `pnpm install`:
 *   node --import tsx/esm packages/client/ui-primitives/tests/markdown-parse.perf.ts
 *
 * Measured work: `fromMarkdown` on the settled grammar only. Excluded: the
 * `recoverLocalImages` pass (linear), block rendering, React, streaming
 * re-parses, retained mdast, and anything outside this process. Samples run
 * sequentially in one process, so JIT and heap state are shared; compare ratios
 * between sizes, not absolute times across machines.
 */

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'
import { cjkFriendlyStrong } from '../src/markdown/cjkFriendlyStrong.ts'
import { mathCompatibility } from '../src/markdown/mathCompatibility.ts'

/** Target source sizes in code units; generation rounds each up to a whole cycle. */
const TARGET_SIZES = [100_000, 1_000_000, 4_000_000] as const
/** Timed parses per size; the median absorbs collector noise. */
const SAMPLES = 3

/**
 * One repeating cycle of assistant prose: heading, paragraphs with emphasis,
 * inline code, links, escapes, CJK text, a list, a table, and a code fence.
 */
const CYCLE = `## Result

The **renderer** keeps \`inline code\` and [a link](https://example.com/notes) in one paragraph, with *emphasis* around words and a literal \\* escape.
A second sentence carries \`quoted\` tokens, an em dash — and a footnote reference [^1] left unresolved on purpose.

中文段落同样参与标点分类与强调解析，包含 **加粗**、\`代码\` 与全角标点（括号）以及引号“示例”。

- first item with \`code\`
- second item with **strong** text
- third item with [link](https://example.com/item)

| column | value | note |
| --- | --- | --- |
| alpha | 1 | first row |
| beta | 2 | second row |

\`\`\`ts
export function sample(input: string): string {
  const parts = input.split(/\\s+/u)
  return parts.map(part => part.toUpperCase()).join(' ')
}
\`\`\`

`

interface SizeResult {
  readonly targetSize: number
  readonly bytes: number
  readonly samplesMs: readonly number[]
  readonly medianMs: number
  readonly msPerMB: number
  readonly timeRatio: number | null
  readonly byteRatio: number | null
}

/** Parse one block with the renderer's settled grammar; the result is discarded. */
function parseSettled(text: string): void {
  void fromMarkdown(text, {
    extensions: [gfm(), cjkFriendlyStrong(), mathCompatibility(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  })
}

/** Build a source of at least `target` code units from whole cycles. */
function buildSource(target: number): string {
  const cycles = Math.ceil(target / CYCLE.length)
  return CYCLE.repeat(cycles)
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted[Math.floor(sorted.length / 2)]
  if (middle === undefined) throw new Error('cannot take the median of an empty sample')
  return middle
}

const results: SizeResult[] = []
let previous: SizeResult | null = null
for (const targetSize of TARGET_SIZES) {
  const text = buildSource(targetSize)
  // One untimed parse per size keeps the measured samples warm.
  parseSettled(text)
  const samplesMs: number[] = []
  for (let sample = 0; sample < SAMPLES; sample++) {
    const startedAt = performance.now()
    parseSettled(text)
    samplesMs.push(performance.now() - startedAt)
  }
  const medianMs = median(samplesMs)
  const result: SizeResult = {
    targetSize,
    bytes: text.length,
    samplesMs,
    medianMs,
    msPerMB: medianMs / (text.length / 1_000_000),
    timeRatio: previous === null ? null : medianMs / previous.medianMs,
    byteRatio: previous === null ? null : text.length / previous.bytes,
  }
  results.push(result)
  previous = result
}

process.stdout.write(`${JSON.stringify({
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  grammar: 'settled GFM + CJK-friendly strong + math compatibility + math (mirrors src/markdown/parse.ts)',
  excluded: 'recoverLocalImages, rendering, React, streaming re-parses, retained mdast',
  samplesPerSize: SAMPLES,
  note: 'timeRatio compares one size with the size before it; byteRatio states the same size step in bytes',
  results,
}, null, 2)}\n`)
