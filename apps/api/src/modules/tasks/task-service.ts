/**
 * 定时任务 HTTP 场景服务层。
 */

import type { TaskDto } from '@nanoclaw/contracts/tasks';

import {
  getAccountsByUserId,
  getTaskById,
  getTasksForAccount,
} from '../../infrastructure/db.js';
import { deleteTaskAndSync } from './task-sync.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';
import { toTaskDto } from '../../contracts-adapter/task-contract.js';

export async function listTasksForOwnedAccount(
  userId: string,
  accountId: string,
): Promise<ServiceResult<TaskDto[]>> {
  const accounts = await getAccountsByUserId(userId);
  const owns = accounts.some((account) => account.id === accountId);
  if (!owns) {
    return fail(403, '无权访问该账号的任务');
  }
  const tasks = await getTasksForAccount(accountId);
  return ok(tasks.map(toTaskDto));
}

export async function deleteOwnedTask(
  userId: string,
  taskId: string,
): Promise<ServiceResult<{ success: true }>> {
  const task = await getTaskById(taskId);
  if (!task) {
    return fail(404, '任务不存在');
  }

  const accounts = await getAccountsByUserId(userId);
  const owns = accounts.some((account) => account.id === task.account_id);
  if (!owns) {
    return fail(403, '无权操作该任务');
  }

  await deleteTaskAndSync(task.id, task.account_id);
  return ok({ success: true });
}
