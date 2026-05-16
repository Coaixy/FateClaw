/**
 * 任务操作层。
 *
 * 所有对定时任务的增删改都通过本模块调用，确保 DB 操作统一。
 */

import {
  createTask,
  deleteTask,
  updateTask,
  updateTaskAfterRun,
} from '../../infrastructure/db.js';
import { ScheduledTask } from '../../shared/types.js';

export async function createTaskAndSync(
  task: Omit<
    ScheduledTask,
    'last_run' | 'last_result' | 'scheduler_locked_until'
  >,
): Promise<void> {
  await createTask(task);
}

export async function updateTaskAndSync(
  id: string,
  _accountId: string,
  updates: Parameters<typeof updateTask>[1],
): Promise<void> {
  await updateTask(id, updates);
}

export async function deleteTaskAndSync(
  id: string,
  _accountId: string,
): Promise<void> {
  await deleteTask(id);
}

export async function updateTaskAfterRunAndSync(
  id: string,
  _accountId: string,
  nextRun: string | null,
  lastResult: string,
): Promise<void> {
  await updateTaskAfterRun(id, nextRun, lastResult);
}
