/** Linear task ownership index shared by Host snapshots and the activity panel. */
/**
 * Group tasks by assignee and derive member progress in one ordered pass.
 * @param tasks - durable or projected tasks in display order.
 * @returns exact assignee value to ordered tasks, completion count, and first running task.
 */
export function indexTasksByAssignee(tasks) {
    const mutable = new Map();
    for (const task of tasks) {
        const assignee = task.assignee;
        const group = mutable.get(assignee) ?? { tasks: [], completed: 0, currentTask: '' };
        group.tasks.push(task);
        if (task.status === 'completed')
            group.completed += 1;
        if (group.currentTask === '' && task.status === 'in_progress')
            group.currentTask = task.id;
        mutable.set(assignee, group);
    }
    return mutable;
}
