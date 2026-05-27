import { ScheduledTask, TaskRunLog } from '../../shared/types.js';
import { getDbPool } from '../db-pool.js';
import { getAccountsByUserId } from './accounts-repository.js';

export async function createTask(
  task: Omit<
    ScheduledTask,
    'last_run' | 'last_result' | 'scheduler_locked_until'
  >,
): Promise<void> {
  await getDbPool().query(
    `INSERT INTO scheduled_tasks (id, account_id, prompt, schedule_type, schedule_value, reminder_type, voice_text, next_run, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      task.id,
      task.account_id,
      task.prompt,
      task.schedule_type,
      task.schedule_value,
      task.reminder_type ?? null,
      task.voice_text ?? null,
      task.next_run,
      task.status,
      task.created_at,
    ],
  );
}

export async function getTaskById(
  id: string,
): Promise<ScheduledTask | undefined> {
  const { rows } = await getDbPool().query(
    'SELECT * FROM scheduled_tasks WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  return rows[0] as ScheduledTask | undefined;
}

export async function getTasksForAccount(
  accountId: string,
): Promise<ScheduledTask[]> {
  const { rows } = await getDbPool().query(
    'SELECT * FROM scheduled_tasks WHERE account_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
    [accountId],
  );
  return rows as ScheduledTask[];
}

export async function getAllTasks(): Promise<ScheduledTask[]> {
  const { rows } = await getDbPool().query(
    'SELECT * FROM scheduled_tasks WHERE deleted_at IS NULL ORDER BY created_at DESC',
  );
  return rows as ScheduledTask[];
}

export async function getActiveTaskCountForUser(
  userId: string,
): Promise<number> {
  const { rows } = await getDbPool().query(
    `SELECT COUNT(*) as cnt FROM scheduled_tasks t
     JOIN accounts a ON a.id = t.account_id
     WHERE a.owner_id = $1 AND t.status = 'active' AND t.deleted_at IS NULL`,
    [userId],
  );
  return Number((rows[0] as { cnt: string }).cnt);
}

export async function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'reminder_type'
      | 'voice_text'
      | 'next_run'
      | 'status'
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (updates.prompt !== undefined) {
    fields.push(`prompt = $${paramIdx++}`);
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push(`schedule_type = $${paramIdx++}`);
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push(`schedule_value = $${paramIdx++}`);
    values.push(updates.schedule_value);
  }
  if (updates.reminder_type !== undefined) {
    fields.push(`reminder_type = $${paramIdx++}`);
    values.push(updates.reminder_type);
  }
  if (updates.voice_text !== undefined) {
    fields.push(`voice_text = $${paramIdx++}`);
    values.push(updates.voice_text);
  }
  if (updates.next_run !== undefined) {
    fields.push(`next_run = $${paramIdx++}`);
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push(`status = $${paramIdx++}`);
    values.push(updates.status);
    fields.push('scheduler_locked_until = NULL');
  }

  if (fields.length === 0) return;
  values.push(id);
  await getDbPool().query(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = $${paramIdx}`,
    values,
  );
}

export async function deleteTask(id: string): Promise<void> {
  await getDbPool().query('DELETE FROM task_run_logs WHERE task_id = $1', [id]);
  await getDbPool().query('DELETE FROM scheduled_tasks WHERE id = $1', [id]);
}

export async function resetUserTasks(userId: string): Promise<string[]> {
  const now = new Date().toISOString();
  const userAccounts = await getAccountsByUserId(userId);
  const accountIds = userAccounts.map((a) => a.id);

  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    for (const accountId of accountIds) {
      await client.query(
        `UPDATE task_run_logs SET deleted_at = $1 WHERE deleted_at IS NULL AND task_id IN
         (SELECT id FROM scheduled_tasks WHERE account_id = $2)`,
        [now, accountId],
      );
      await client.query(
        'UPDATE scheduled_tasks SET deleted_at = $1 WHERE account_id = $2 AND deleted_at IS NULL',
        [now, accountId],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return accountIds;
}

export async function claimDueTasks(
  lockUntil: string,
  limit = 50,
): Promise<ScheduledTask[]> {
  const now = new Date().toISOString();
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `WITH due AS (
         SELECT id
         FROM scheduled_tasks
         WHERE status = 'active'
           AND next_run IS NOT NULL
           AND next_run <= $1::timestamptz
           AND deleted_at IS NULL
           AND (
             scheduler_locked_until IS NULL
             OR scheduler_locked_until <= $1::timestamptz
           )
         ORDER BY next_run
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       UPDATE scheduled_tasks AS t
       SET scheduler_locked_until = $2::timestamptz
       FROM due
       WHERE t.id = due.id
       RETURNING t.*`,
      [now, lockUntil, limit],
    );
    await client.query('COMMIT');
    return rows as ScheduledTask[];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function extendTaskRunLock(
  id: string,
  lockUntil: string,
): Promise<boolean> {
  const { rowCount } = await getDbPool().query(
    `UPDATE scheduled_tasks
     SET scheduler_locked_until = $2::timestamptz
     WHERE id = $1
       AND deleted_at IS NULL
       AND status = 'active'
       AND scheduler_locked_until IS NOT NULL`,
    [id, lockUntil],
  );
  return (rowCount ?? 0) > 0;
}

export async function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): Promise<void> {
  const now = new Date().toISOString();
  await getDbPool().query(
    `UPDATE scheduled_tasks
     SET next_run = $1::timestamptz, last_run = $2, last_result = $3,
         scheduler_locked_until = NULL,
         status = CASE WHEN $1::timestamptz IS NULL THEN 'completed' ELSE status END
     WHERE id = $4`,
    [nextRun, now, lastResult, id],
  );
}

export async function logTaskRun(log: TaskRunLog): Promise<void> {
  await getDbPool().query(
    `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      log.task_id,
      log.run_at,
      log.duration_ms,
      log.status,
      log.result,
      log.error,
    ],
  );
}
