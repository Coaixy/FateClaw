import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/agent-db.js', () => ({ getAgentDbPool: () => ({ query }) }));
vi.mock('../src/io.js', () => ({ log: vi.fn() }));
import {
  deliverDurableResult,
  replayDurableResults,
} from '../src/durable-execution.js';
import {
  readSpooledResults,
  spoolResult,
  removeSpooledResult,
} from '../src/result-spool.js';
import type { InboxRequest, OutboxResponse } from '../src/types.js';
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'fateclaw-result-spool-'));
  vi.stubEnv('FATECLAW_PI_SESSION_DIR', dir);
  query.mockReset();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
const request = {
  requestId: 'r',
  executionId: 'e',
  accountId: 'a',
  llmRuntime: { apiKey: 'synthetic-not-to-be-persisted' },
} as InboxRequest;
const response = {
  requestId: 'r',
  accountId: 'a',
  status: 'success',
  text: 'Synthetic reply',
  usage: { totalTokens: 9 },
} as OutboxResponse;
describe('local result recovery', () => {
  it('acknowledging a synthetic file cannot delete a newer actual result for the same execution', async () => {
    const synthetic = {
      ...response,
      status: 'error',
      usage: undefined,
      metadata: { synthetic_terminal: true },
    } as OutboxResponse;
    const oldFile = await spoolResult(request, synthetic);
    const actualFile = await spoolResult(request, response);
    await removeSpooledResult(oldFile);
    const remaining = await readSpooledResults('a');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].file).toBe(actualFile);
    expect(remaining[0].result.response).toEqual(response);
  });

  it('retains result when both stores fail and replays without credentials or model execution', async () => {
    query.mockRejectedValue(new Error('synthetic PG outage'));
    await deliverDurableResult(
      request,
      response,
      vi.fn().mockRejectedValue(new Error('synthetic Redis outage')),
    );
    const pending = await readSpooledResults('a');
    expect(pending).toHaveLength(1);
    const saved = await readFile(pending[0].file, 'utf8');
    expect(saved).not.toContain('synthetic-not-to-be-persisted');
    expect(pending[0].result.response).toEqual(response);
    expect(
      (await readdir(path.dirname(pending[0].file))).filter((name) =>
        name.endsWith('.tmp'),
      ),
    ).toEqual([]);
    query.mockResolvedValue({ rowCount: 1 });
    const push = vi.fn().mockResolvedValue(1);
    await replayDurableResults('a', push);
    expect(push).toHaveBeenCalledWith('ipc:a:outbox', JSON.stringify(response));
    expect(await readSpooledResults('a')).toEqual([]);
  });
  it('retains an unconfirmed result when the database still shows queued', async () => {
    query
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ execution_id: 'e', account_id: 'a', state: 'queued' }],
      });
    const push = vi.fn();
    await deliverDurableResult(request, response, push);
    expect(await readSpooledResults('a')).toHaveLength(1);
    expect(push).not.toHaveBeenCalled();
  });
  it('removes local result after PG persists it even if Redis is down', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    await deliverDurableResult(
      request,
      response,
      vi.fn().mockRejectedValue(new Error('synthetic Redis outage')),
    );
    expect(await readSpooledResults('a')).toEqual([]);
  });
});
