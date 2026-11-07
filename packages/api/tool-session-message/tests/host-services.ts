/** Host services the merged wiring injects but this package's tests cannot mount. @module */

import type { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import { projectToolSchema } from '@deepseek-ai/dsh-tools'
import { executeToolBatch, ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import type {
  ToolBatchInput, ToolBatchResult, ToolDefinition, ToolExecutor, ToolModelInput,
} from '@deepseek-ai/dsh-tools'

/** One projection unit whose empty-log state these tests serve. */
interface ProjectionUnit {
  init(header: SessionHeader, inheritedEventCount: SessionLogOffset): unknown
}

/** Projection registry surface the Agent registry injects. */
interface ProjectionRegistryFixture {
  register(unit: ProjectionUnit): Promise<{
    stateOf(session: Session): unknown
    readerFor(session: Session): () => unknown
    dispose(): Promise<void>
  }>
  wireKeys(): readonly string[]
}

/**
 * Provide the projection registry the merged Agent registry injects.
 *
 * These tests assert Session-addressed tool behavior, not projection folding, so
 * every unit serves its empty-log state and keeps the real Agent registry mounted.
 */
export const projectionRegistryFixture = {
  name: 'fixture-session-projections',
  apply(ctx: Context): void {
    const registry: ProjectionRegistryFixture = {
      register: (unit) => {
        const read = (session: Session): unknown => unit.init(session.header, SessionLogOffset(0))
        return Promise.resolve({
          stateOf: read,
          readerFor: (session: Session) => () => read(session),
          dispose: () => Promise.resolve(),
        })
      },
      wireKeys: () => [],
    }
    ctx.provide('sessionProjections', registry)
  },
}

/** Native-equivalent executor so the merged batch API runs in a hand-mounted context. */
class FixtureToolExecutor implements ToolExecutor {
  private readonly pipeline: ToolExecutionPipeline

  constructor(ctx: Context) {
    this.pipeline = new ToolExecutionPipeline(ctx)
  }

  describe(tools: readonly ToolDefinition[]): ToolModelInput {
    return { schemas: tools.map(definition => projectToolSchema(definition, false)) }
  }

  execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    return executeToolBatch(input, this.pipeline, () => 10)
  }
}

/** Select the fixture executor in the composing scope. */
export const toolExecutorFixture = {
  name: 'fixture-tool-executor',
  inject: ['tools'],
  apply(ctx: Context): void {
    ctx.tools.setExecutor(new FixtureToolExecutor(ctx))
  },
}
