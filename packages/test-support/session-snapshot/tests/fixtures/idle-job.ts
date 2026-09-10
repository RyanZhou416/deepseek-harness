/** Deterministic background job that settles when its owning Agent next reaches idle. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

export const name = 'snapshot-idle-job'
export const inject = ['jobs', 'tools']

interface PendingJob {
  complete(): void
}

/** Register the snapshot-only producer and its model-facing start tool. */
export function apply(ctx: Context): void {
  const pending = new WeakMap<Agent, PendingJob[]>()
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    pending.get(agent)?.shift()?.complete()
  })

  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'snapshot_job',
    description: 'Start a deterministic background job that completes when its owner next becomes idle.',
    parameters: {
      label: { type: 'string', required: true },
    },
    execute(args, exec) {
      const owner = exec.agent
      if (owner === undefined) throw new Error('snapshot_job requires an owning agent')
      const done = Promise.withResolvers<JobOutcome>()
      let settled = false
      const settle = (outcome: JobOutcome): void => {
        if (settled) return
        settled = true
        done.resolve(outcome)
      }
      const id = ctx.jobs.start({
        kind: 'bash',
        label: args.label,
        owner,
        run: () => ({
          cancel: () => { settle({ status: 'killed' }) },
          done: done.promise,
        }),
      })
      let jobs = pending.get(owner)
      if (jobs === undefined) {
        jobs = []
        pending.set(owner, jobs)
      }
      jobs.push({
        complete: () => { settle({ status: 'completed', output: `finished ${args.label}` }) },
      })
      return Promise.resolve([{ type: 'text', text: `started snapshot job ${id}` }])
    },
  })))
}
