/** Linear task ownership index shared by Host snapshots and the activity panel. */

/** Minimum task fields needed for ownership statistics. */
export interface AssignedTask {
  readonly id: string
  readonly status: string
  readonly assignee?: string
}

/** Tasks and progress for one assignee, preserving durable task order. */
export interface AssigneeTaskGroup<T extends AssignedTask> {
  readonly tasks: readonly T[]
  readonly completed: number
  readonly currentTask: string
}

/**
 * Group tasks by assignee and derive member progress in one ordered pass.
 * @param tasks - durable or projected tasks in display order.
 * @returns exact assignee value to ordered tasks, completion count, and first running task.
 */
export function indexTasksByAssignee<T extends AssignedTask>(
  tasks: readonly T[],
): ReadonlyMap<string | undefined, AssigneeTaskGroup<T>> {
  const mutable = new Map<string | undefined, { tasks: T[]; completed: number; currentTask: string }>()
  for (const task of tasks) {
    const assignee = task.assignee
    const group = mutable.get(assignee) ?? { tasks: [], completed: 0, currentTask: '' }
    group.tasks.push(task)
    if (task.status === 'completed') group.completed += 1
    if (group.currentTask === '' && task.status === 'in_progress') group.currentTask = task.id
    mutable.set(assignee, group)
  }
  return mutable
}