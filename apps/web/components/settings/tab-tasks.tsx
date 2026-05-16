'use client';

import { AlertTriangle } from 'lucide-react';

import { type Task } from '@/features/tasks/api';
import { useAccountTasks } from '@/features/tasks/hooks/use-account-tasks';
import { useTaskDelete } from '@/features/tasks/hooks/use-task-delete';
import { TaskAccountSwitcher } from '@/components/settings/tasks/task-account-switcher';
import { TaskEmptyState } from '@/components/settings/tasks/task-empty-state';
import { TaskList } from '@/components/settings/tasks/task-list';
import { TaskLoadingList } from '@/components/settings/tasks/task-loading-list';
import { EmptyState } from '@/components/ui/empty-state';
import { useConfirm } from '@/lib/use-confirm';
import { useToast } from '@/lib/use-toast';

export function TabTasks() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const tasks = useAccountTasks();
  const taskDelete = useTaskDelete(tasks.removeTaskFromList);

  const handleDelete = async (task: Task) => {
    const ok = await confirm({
      title: '删除任务',
      message: `确定要删除这个任务吗？\n\n「${task.prompt.slice(0, 60)}」`,
      confirmLabel: '删除',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await taskDelete.deleteTask(task);
      toast('success', '任务已删除');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '删除失败');
    }
  };

  const activeCount = tasks.taskList.filter((t) => t.status === 'active').length;

  return (
    <div className="space-y-4">
      {/* Header row: account switcher + count */}
      <div className="flex items-center justify-between gap-3">
        {!tasks.loading && tasks.taskList.length > 0 ? (
          <p className="text-[12px] text-muted">
            {tasks.taskList.length} 个任务 · {activeCount} 个运行中
          </p>
        ) : (
          <span />
        )}
        <TaskAccountSwitcher
          accounts={tasks.accountList}
          selectedAccount={tasks.selectedAccount}
          onSelect={tasks.selectAccount}
        />
      </div>

      {tasks.loading ? (
        <TaskLoadingList />
      ) : tasks.loadError ? (
        <EmptyState
          icon={AlertTriangle}
          title="任务列表加载失败"
          description={tasks.loadError}
          action={{
            label: '重试',
            onClick: () =>
              void (tasks.selectedAccount
                ? tasks.loadTasks(tasks.selectedAccount)
                : tasks.loadAccounts()),
          }}
        />
      ) : tasks.taskList.length === 0 ? (
        <TaskEmptyState canUseWeixin={tasks.accountList.length > 0} />
      ) : (
        <TaskList
          tasks={tasks.taskList}
          expandedTaskId={tasks.expandedTaskId}
          deletingTaskId={taskDelete.deletingTaskId}
          onToggleTask={tasks.toggleExpandedTask}
          onDeleteTask={(task) => void handleDelete(task)}
        />
      )}
    </div>
  );
}
