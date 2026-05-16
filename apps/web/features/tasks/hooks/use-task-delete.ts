'use client';

import { useCallback, useState } from 'react';

import { tasksApi, type Task } from '@/features/tasks/api';

export function useTaskDelete(onDeleted: (taskId: string) => void) {
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);

  const deleteTask = useCallback(
    async (task: Task) => {
      setDeletingTaskId(task.id);
      try {
        await tasksApi.remove(task.id);
        onDeleted(task.id);
      } finally {
        setDeletingTaskId(null);
      }
    },
    [onDeleted],
  );

  return { deletingTaskId, deleteTask };
}
