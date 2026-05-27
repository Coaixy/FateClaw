import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbPool } = vi.hoisted(() => ({
  mockGetDbPool: vi.fn(),
}));

vi.mock('../db-pool.js', () => ({
  getDbPool: mockGetDbPool,
}));

import {
  claimDueTasks,
  deleteTask,
  extendTaskRunLock,
  getActiveTaskCountForUser,
  resetUserTasks,
  updateTask,
} from './tasks-repository.js';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function createMockPool(rows: unknown[] = [], rowCount = 0) {
  const calls: QueryCall[] = [];
  const clientCalls: QueryCall[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      clientCalls.push({ sql, params });
      return { rows, rowCount };
    },
    release: vi.fn(),
  };
  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows, rowCount };
    },
    async connect() {
      return client;
    },
  };
  mockGetDbPool.mockReturnValue(pool);
  return { calls, clientCalls, client };
}

describe('tasks repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds dynamic task updates and clears lock when status changes', async () => {
    const { calls } = createMockPool();

    await updateTask('task-1', {
      prompt: 'next prompt',
      status: 'paused',
      next_run: null,
    });

    expect(calls[0]?.sql).toContain('prompt = $1');
    expect(calls[0]?.sql).toContain('next_run = $2');
    expect(calls[0]?.sql).toContain('status = $3');
    expect(calls[0]?.sql).toContain('scheduler_locked_until = NULL');
    expect(calls[0]?.sql).toContain('WHERE id = $4');
    expect(calls[0]?.params).toEqual(['next prompt', null, 'paused', 'task-1']);
  });

  it('does not query when update payload is empty', async () => {
    const { calls } = createMockPool();

    await updateTask('task-1', {});

    expect(calls).toEqual([]);
  });

  it('claims due tasks inside a transaction and releases the client', async () => {
    const { clientCalls, client } = createMockPool([{ id: 'task-1' }]);

    await expect(
      claimDueTasks('2026-05-27T01:00:00.000Z', 10),
    ).resolves.toEqual([{ id: 'task-1' }]);

    expect(clientCalls[0]?.sql).toBe('BEGIN');
    expect(clientCalls[1]?.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(clientCalls[1]?.params?.[1]).toBe('2026-05-27T01:00:00.000Z');
    expect(clientCalls[1]?.params?.[2]).toBe(10);
    expect(clientCalls[2]?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('deletes run logs before deleting the task row', async () => {
    const { calls } = createMockPool();

    await deleteTask('task-1');

    expect(calls).toEqual([
      {
        sql: 'DELETE FROM task_run_logs WHERE task_id = $1',
        params: ['task-1'],
      },
      {
        sql: 'DELETE FROM scheduled_tasks WHERE id = $1',
        params: ['task-1'],
      },
    ]);
  });

  it('reports whether task run lock extension matched a row', async () => {
    createMockPool([], 1);

    await expect(
      extendTaskRunLock('task-1', '2026-05-27T01:00:00.000Z'),
    ).resolves.toBe(true);
  });

  it('counts active tasks by owner user', async () => {
    const { calls } = createMockPool([{ cnt: '3' }]);

    await expect(getActiveTaskCountForUser('user-1')).resolves.toBe(3);

    expect(calls[0]?.sql).toContain('JOIN accounts a ON a.id = t.account_id');
    expect(calls[0]?.sql).toContain('a.owner_id = $1');
    expect(calls[0]?.params).toEqual(['user-1']);
  });

  it('soft deletes task rows and run logs for a user account set', async () => {
    const { calls, clientCalls, client } = createMockPool([
      { id: 'account-1' },
      { id: 'account-2' },
    ]);

    await expect(resetUserTasks('user-1')).resolves.toEqual([
      'account-1',
      'account-2',
    ]);

    expect(calls[0]?.sql).toContain('WHERE owner_id = $1');
    expect(clientCalls[0]?.sql).toBe('BEGIN');
    expect(clientCalls[1]?.sql).toContain('UPDATE task_run_logs');
    expect(clientCalls[1]?.params?.[1]).toBe('account-1');
    expect(clientCalls[2]?.sql).toContain('UPDATE scheduled_tasks');
    expect(clientCalls[3]?.params?.[1]).toBe('account-2');
    expect(clientCalls[4]?.params?.[1]).toBe('account-2');
    expect(clientCalls[5]?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });
});
