import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import pg from 'pg';
import { durableAgentRequestsMigration } from '../../api/src/infrastructure/migrations/versions/0076-durable-agent-requests.js';
import { closeAgentDb } from '#agent/agent-db';
import {
  claimDurableExecution,
  deliverDurableResult,
} from '#agent/durable-execution';
import type { InboxRequest, OutboxResponse } from '#agent/types';

const connectionString = process.env.FATECLAW_DURABLE_TEST_DATABASE_URL;
const request = {
  requestId: 'request-1',
  executionId: 'execution-1',
  accountId: 'account-1',
} as InboxRequest;
const response = {
  type: 'response',
  requestId: 'request-1',
  accountId: 'account-1',
  status: 'success',
  text: 'Synthetic result',
  usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
} as OutboxResponse;

describe.skipIf(!connectionString)('Durable PostgreSQL execution', () => {
  let setup: pg.Pool;
  let spoolDir: string;
  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString!;
    spoolDir = await mkdtemp(path.join(tmpdir(), 'fateclaw-spool-pg-'));
    process.env.FATECLAW_PI_SESSION_DIR = spoolDir;
    setup = new pg.Pool({ connectionString });
    const client = await setup.connect();
    try {
      await durableAgentRequestsMigration.up(client);
    } finally {
      client.release();
    }
  });
  beforeEach(async () => {
    await setup.query('TRUNCATE agent_requests, agent_result_deliveries');
    await setup.query(`INSERT INTO agent_requests
      (request_id,execution_id,account_id,session_id,owner_user_id,state,input,runtime,deadline_at)
      VALUES ('request-1','execution-1','account-1','session-1','user-1','dispatched','{}','{}',now()+interval '1 hour')`);
  });
  afterAll(async () => {
    await closeAgentDb();
    await setup.query('DROP TABLE agent_result_deliveries,agent_requests');
    await setup.end();
    await rm(spoolDir, { recursive: true, force: true });
  });
  it('grants exactly one of concurrent duplicate claims', async () => {
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => claimDurableExecution(request)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it.each([
    'cancel_requested_at=now()',
    "deadline_at=now()-interval '1 second'",
  ])('rejects admission when %s', async (change) => {
    await setup.query(`UPDATE agent_requests SET ${change}`);
    expect(await claimDurableExecution(request)).toBe(false);
  });
  it('rejects a stale execution id', async () => {
    expect(
      await claimDurableExecution({ ...request, executionId: 'old' }),
    ).toBe(false);
  });
  it('keeps unknown-usage fatal results recoverable and prevents synthetic overwrite of real results', async () => {
    await claimDurableExecution(request);
    const synthetic = {
      ...response,
      usage: undefined,
      status: 'error' as const,
      metadata: { synthetic_terminal: true },
    };
    const push = vi.fn(async () => {});
    await deliverDurableResult(request, synthetic, push);
    expect(
      (await setup.query('SELECT state FROM agent_requests')).rows[0].state,
    ).toBe('interrupted');
    await deliverDurableResult(request, response, push);
    await deliverDurableResult(request, synthetic, push);
    expect(
      (await setup.query('SELECT result FROM agent_requests')).rows[0].result,
    ).toEqual(response);
    expect(push).toHaveBeenCalledTimes(2);
  });
  it('stores only one real result despite duplicate delivery and retains usage', async () => {
    await claimDurableExecution(request);
    const push = vi.fn(async () => {});
    await Promise.all([
      deliverDurableResult(request, response, push),
      deliverDurableResult(request, response, push),
    ]);
    expect(push).toHaveBeenCalledOnce();
    const { rows } = await setup.query(
      'SELECT state,result FROM agent_requests',
    );
    expect(rows[0]).toEqual({ state: 'result_ready', result: response });
  });
  it('replaces interrupted placeholder with a late real result but fences later execution ids', async () => {
    await setup.query(
      `UPDATE agent_requests SET state='interrupted',lease_owner='recovery',result='{"synthetic_terminal":true}'`,
    );
    const push = vi.fn(async () => {});
    await deliverDurableResult(
      { ...request, executionId: 'old' },
      response,
      push,
    );
    expect(push).not.toHaveBeenCalled();
    await deliverDurableResult(request, response, push);
    const { rows } = await setup.query(
      'SELECT state,result FROM agent_requests',
    );
    expect(rows[0]).toEqual({ state: 'result_ready', result: response });
    expect(push).toHaveBeenCalledOnce();
  });
});
