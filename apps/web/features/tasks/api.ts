import type { SuccessResponse } from '@nanoclaw/contracts/common';
import type { TaskDto } from '@nanoclaw/contracts/tasks';

import { requestJson } from '@/lib/http/client';

export type Task = TaskDto;

export const tasksApi = {
  list: (accountId: string) =>
    requestJson<Task[]>(`/api/tasks/${encodeURIComponent(accountId)}`),
  remove: (taskId: string) =>
    requestJson<SuccessResponse>(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
    }),
};
