import type { Task } from '@/features/tasks/api';
import { TaskRow } from '@/components/settings/tasks/task-row';

export function TaskList({
  tasks,
  expandedTaskId,
  deletingTaskId,
  onToggleTask,
  onDeleteTask,
}: {
  tasks: Task[];
  expandedTaskId: string | null;
  deletingTaskId: string | null;
  onToggleTask: (taskId: string) => void;
  onDeleteTask: (task: Task) => void;
}) {
  return (
    <div className="rounded-xl border border-hairline divide-y divide-hairline overflow-hidden">
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          expanded={expandedTaskId === task.id}
          deleting={deletingTaskId === task.id}
          onToggle={() => onToggleTask(task.id)}
          onDelete={() => onDeleteTask(task)}
        />
      ))}
    </div>
  );
}
