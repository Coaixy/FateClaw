import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { initDbPool, getDbPool, closeDbPool } from '#infrastructure/db-pool';
import { durableAgentRequestsMigration } from '#infrastructure/migrations/versions/0076-durable-agent-requests';
import { crossConversationMemoryMigration } from '#infrastructure/migrations/versions/0102-cross-conversation-memory';
import { admitAgentRequest } from '#infrastructure/repositories/agent-requests-repository';
import type { AiChatSubmission } from '#runtime/request-types';
import type { LlmRuntimeSnapshot } from '@fateclaw/contracts/agent';
import {
  DEFAULT_MEMORY_RUNTIME_POLICY,
  type MemoryHydration,
  type MemoryRequestScope,
  type MemoryRuntimePolicy,
} from '@fateclaw/contracts/memory';
import type { MemoryJobRow } from '#modules/memory/domain';
import {
  changeMemoryJobState,
  claimMemoryJobs,
  processMemoryJob,
  startMemoryBackfill,
} from '#modules/memory/jobs';
import { updateMemorySessionSettings } from '#modules/memory/session-settings';
import { updateMemoryScopeBinding } from '#modules/memory/scope-management';
import {
  clearMemory,
  createManualMemory,
  excludeMemorySource,
  getMemorySettings,
  ownerMemorySnapshot,
  updateMemorySettings,
  memoryStatus,
} from '#modules/memory/service';
import {
  createMemoryAdmissionScope,
  getCurrentMemorySource,
  lockMemoryRoot,
  queueMemoryJob,
  withMemoryReadTransaction,
  withMemoryTransaction,
} from '#modules/memory/repository';
import {
  getMemoryRuntimePolicy,
  saveMemoryRuntimePolicy,
} from '#modules/memory/policy';
import {
  reconcileMemoryBudgetReservations,
  reserveMemoryBudget,
  settleMemoryBudget,
} from '#modules/memory/budget';
import {
  authorizeMemoryRecall,
  searchMemory,
} from '#modules/memory/retrieval';
import { runMemoryWorkerOnce, stopMemoryWorker } from '#runtime/memory-worker';
import type {
  MemoryModelResolver,
  MemoryTextRunner,
} from '#modules/memory/model-client';

vi.mock('#infrastructure/env', () => ({ readEnvFile: () => ({}) }));

const connectionString = process.env.FATECLAW_TEST_TEXT_MEMORY_DATABASE_URL;
const schema = `memory_worker_test_${randomUUID().replace(/-/g, '')}`;
let administrator: pg.Pool;
const runtime: LlmRuntimeSnapshot = {
  source: 'official',
  billingMode: 'none',
  modelConfigId: 'synthetic-node',
  piApi: 'openai-completions',
  model: 'synthetic-text',
  apiKey: 'synthetic-memory-worker-key',
  authMode: 'openai_api_key',
  providerKey: 'synthetic',
};
const policy: MemoryRuntimePolicy = {
  ...DEFAULT_MEMORY_RUNTIME_POLICY,
  worker_concurrency: 4,
  job_timeout_ms: 15_000,
};
const resolveModel: MemoryModelResolver = async (id) => ({
  modelConfigId: id ?? 'synthetic-node',
  providerKey: 'synthetic',
  piApi: 'openai-completions',
  model: 'synthetic-text',
  apiKey: 'synthetic-memory-worker-key',
  authMode: 'openai_api_key',
});

const runner: MemoryTextRunner = async (request) => {
  const input = JSON.parse(request.input) as {
    sources?: Array<{
      id: string;
      subjectId: string;
      speakerSubjectId?: string;
      content: string;
    }>;
  };
  const candidates = (input.sources ?? []).flatMap((source) =>
    Array.from(
      new Intl.Segmenter('zh', { granularity: 'sentence' }).segment(
        source.content,
      ),
      ({ segment }) => segment.trim(),
    )
      .filter(Boolean)
      .map((quote) => ({
        sourceId: source.id,
        subjectId: source.speakerSubjectId ?? source.subjectId,
        quote,
        content: quote,
        kind: quote.includes('住在') ? 'fact' : 'preference',
        assertionType: 'stated',
        ...(quote.includes('住在') ? { factKey: 'residence' } : {}),
      })),
  );
  return {
    text: JSON.stringify({ candidates }),
    usage: { inputTokens: 20, outputTokens: 5 },
  };
};
const modelOptions = { runner, resolveModel };

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!connectionString)(
  'durable memory worker PostgreSQL pipeline',
  () => {
    beforeAll(async () => {
      const target = new URL(connectionString!);
      if (
        !['127.0.0.1', 'localhost'].includes(target.hostname) ||
        target.pathname !== '/memory_test'
      )
        throw new Error(
          'Worker integration requires the explicit disposable local memory_test database',
        );
      administrator = new pg.Pool({ connectionString });
      await administrator.query(`CREATE SCHEMA ${schema}`);
      target.searchParams.set('options', `-c search_path=${schema},public`);
      target.searchParams.set('application_name', schema);
      const db = initDbPool(target.toString());
      expect(
        (await db.query('SELECT current_schema() AS name')).rows[0].name,
      ).toBe(schema);
      await db.query(`
      CREATE TABLE users(id text PRIMARY KEY,soul_content text NOT NULL DEFAULT '',soul_edit_enabled boolean NOT NULL DEFAULT true,created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE accounts(id text PRIMARY KEY,owner_id text REFERENCES users(id),soul_content text DEFAULT '',enabled boolean DEFAULT true,created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE client_profiles(id text PRIMARY KEY,user_id text REFERENCES users(id),name text NOT NULL,deleted_at timestamptz);
      CREATE TABLE chat_sessions(id text PRIMARY KEY,account_id text NOT NULL,user_id text REFERENCES users(id),client_id text REFERENCES client_profiles(id),title text NOT NULL DEFAULT '',deleted_at timestamptz,model_pool_key text DEFAULT 'official',updated_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE messages(id text NOT NULL,account_id text NOT NULL,user_id text,sender text,sender_name text,content text NOT NULL,timestamp timestamptz NOT NULL,
        is_from_me boolean,is_bot_message boolean,tool_context jsonb,session_id text REFERENCES chat_sessions(id),metadata jsonb,deleted_at timestamptz,PRIMARY KEY(id,account_id));
      CREATE TABLE runtime_config(id text PRIMARY KEY,revision integer NOT NULL DEFAULT 1,updated_at timestamptz DEFAULT clock_timestamp());
      INSERT INTO runtime_config(id)VALUES('default');
      CREATE TABLE config_audit_logs(id text PRIMARY KEY,actor_user_id text,action text,target_type text,target_key text,before_json jsonb,after_json jsonb);
    `);
      const client = await db.connect();
      try {
        await durableAgentRequestsMigration.up(client);
        // The migration runner applies each version inside a transaction.
        await client.query('BEGIN');
        await crossConversationMemoryMigration.up(client);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      await saveMemoryRuntimePolicy(policy, 'synthetic-bootstrap');
    }, 30_000);

    beforeEach(async () => {
      await getDbPool().query(
        `TRUNCATE ${schema}.users,${schema}.agent_requests,${schema}.agent_result_deliveries,${schema}.memory_daily_budgets CASCADE`,
      );
      await getDbPool().query(
        "INSERT INTO users(id)VALUES('owner'),('other'); INSERT INTO client_profiles(id,user_id,name)VALUES('client','owner','合成命主'); INSERT INTO chat_sessions(id,account_id,user_id)VALUES('session-a','web:owner','owner'),('session-b','web:owner','owner'),('session-other','web:other','other')",
      );
      await getDbPool().query(
        "UPDATE runtime_config SET memory_policy=$1::jsonb WHERE id='default'",
        [JSON.stringify(policy)],
      );
    });

    afterAll(async () => {
      await stopMemoryWorker();
      await closeDbPool();
      if (administrator) {
        await administrator.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await administrator.end();
      }
    });

    async function turn(
      content: string,
      sessionId = 'session-a',
      observedAt = new Date().toISOString(),
      metadata?: Record<string, unknown>,
    ) {
      const requestId = `worker-request-${randomUUID()}`;
      const messageId = `worker-message-${randomUUID()}`;
      const input: AiChatSubmission = {
        accountId: 'web:owner',
        sessionId,
        userMessageId: messageId,
        userMessage: content,
        history: [],
        messageToPersist: {
          id: messageId,
          account_id: 'web:owner',
          user_id: 'owner',
          sender: 'owner',
          sender_name: '合成用户',
          content,
          timestamp: observedAt,
          session_id: sessionId,
          is_from_me: false,
          is_bot_message: false,
          metadata,
        },
      };
      await admitAgentRequest({
        input,
        requestId,
        ownerUserId: 'owner',
        runtime,
        deadlineAt: Date.now() + 60_000,
      });
      const { rows } = await getDbPool().query<{ id: string }>(
        'SELECT id FROM memory_sources WHERE message_id=$1',
        [messageId],
      );
      return {
        requestId,
        messageId,
        sourceId: rows[0].id,
        scope: input.memoryScope!,
      };
    }

    async function legacyMessage(
      content: string,
      observedAt = new Date(Date.now() - 86_400_000).toISOString(),
      metadata?: Record<string, unknown>,
    ) {
      const id = `legacy-${randomUUID()}`;
      await getDbPool().query(
        `INSERT INTO messages(id,account_id,user_id,sender,sender_name,content,timestamp,is_from_me,is_bot_message,session_id,metadata)
      VALUES($1,'web:owner','owner','unknown-sender','旧对话',$2,$3,false,false,'session-a',$4::jsonb)`,
        [id, content, observedAt, metadata ? JSON.stringify(metadata) : null],
      );
      return id;
    }

    async function nextJob(kind?: MemoryJobRow['kind']) {
      const currentPolicy = await getMemoryRuntimePolicy();
      const claimed = await claimMemoryJobs(
        { ...currentPolicy, worker_concurrency: 1 },
        1,
      );
      expect(claimed).toHaveLength(1);
      if (kind) expect(claimed[0].kind).toBe(kind);
      return claimed[0];
    }

    /** The host `search` path, without the request lookup. */
    async function search(
      scope: MemoryRequestScope,
      query: string,
    ): Promise<MemoryHydration> {
      const currentPolicy = await getMemoryRuntimePolicy();
      return withMemoryReadTransaction(async (db) => {
        const context = await authorizeMemoryRecall(db, scope, currentPolicy);
        if (!context) throw new Error('Synthetic recall is disabled');
        return searchMemory(context, { query }, 'session-search');
      });
    }

    async function assistantMessage(content = '根据盘面，你明年可能发财。') {
      const id = `assistant-${randomUUID()}`;
      await getDbPool().query(
        `INSERT INTO messages(id,account_id,user_id,sender,sender_name,content,timestamp,is_from_me,is_bot_message,session_id)
        VALUES($1,'web:owner','owner','web:owner','合成助手',$2,clock_timestamp(),true,true,'session-a')`,
        [id, content],
      );
      return id;
    }

    async function drain() {
      for (let iteration = 0; iteration < 100; iteration++) {
        const faults: unknown[] = [];
        await runMemoryWorkerOnce({
          modelOptions,
          process: async (...args) => {
            try {
              await processMemoryJob(...args);
            } catch (error) {
              faults.push(error);
              throw error;
            }
          },
        });
        if (faults.length) throw faults[0];
        const { rows } = await getDbPool().query<{
          state: string;
          error_code: string | null;
        }>(
          "SELECT state,error_code FROM memory_jobs WHERE state IN ('pending','running','failed')",
        );
        expect(rows.filter((row) => row.state === 'failed')).toEqual([]);
        if (!rows.length) return;
        const delayed = await getDbPool().query(
          "SELECT error_code FROM memory_jobs WHERE state='pending' AND next_attempt_at>clock_timestamp()",
        );
        expect(delayed.rows).toEqual([]);
      }
      throw new Error('Worker failed to finish the finite synthetic queue');
    }

    it('extracts admitted user evidence, indexes its text and recalls it by keyword in another session', async () => {
      const admitted = await turn('我经常喝无糖拿铁。');
      await drain();
      const facts = await getDbPool().query<{
        id: string;
        revision: number;
        content: string;
      }>("SELECT id,revision,content FROM memory_items WHERE status='active'");
      expect(facts.rows).toHaveLength(1);
      expect(facts.rows[0].content).toBe('我经常喝无糖拿铁。');
      const proof = await getDbPool().query(
        'SELECT source_id,quote FROM memory_evidence WHERE item_id=$1',
        [facts.rows[0].id],
      );
      expect(proof.rows).toEqual([
        { source_id: admitted.sourceId, quote: '我经常喝无糖拿铁。' },
      ]);
      expect(
        (
          await getDbPool().query(
            "SELECT search_text FROM memory_index_entries WHERE object_kind='item' AND object_id=$1",
            [facts.rows[0].id],
          )
        ).rows,
      ).toEqual([{ search_text: '我经常喝无糖拿铁。' }]);
      expect(
        (await getCurrentMemorySource(admitted.sourceId))?.extracted_revision,
      ).toBe(1);
      const secondSession = await turn('请回顾此前保存的信息。', 'session-b');
      const recalled = await search(secondSession.scope, '无糖拿铁');
      expect(recalled.status).toBe('ready');
      expect(recalled.excerpts).toContainEqual(
        expect.objectContaining({
          reference: expect.objectContaining({
            kind: 'item',
            id: facts.rows[0].id,
          }),
          text: '我经常喝无糖拿铁。',
        }),
      );
    }, 30_000);

    it.each(['exclude', 'clear', 'binding'])(
      'fences a late extraction after %s and settles its measured usage',
      async (operation) => {
        const admitted = await turn('我喜欢清晨散步。');
        const claimed = await nextJob('extract');
        const entered = deferred<void>();
        const release = deferred<void>();
        const waitingRunner: MemoryTextRunner = async (request) => {
          entered.resolve();
          await release.promise;
          return runner(request);
        };
        const processing = processMemoryJob(claimed, policy, {
          modelOptions: { runner: waitingRunner, resolveModel },
        });
        await entered.promise;
        if (operation === 'exclude')
          await excludeMemorySource('owner', admitted.sourceId);
        else if (operation === 'clear') await clearMemory('owner');
        else
          await getDbPool().query(
            'UPDATE memory_scopes SET binding_revision=binding_revision+1 WHERE id=$1',
            [admitted.scope.scopeId],
          );
        release.resolve();
        await processing;
        expect(
          (
            await getDbPool().query(
              'SELECT count(*)::int AS count FROM memory_items',
            )
          ).rows[0].count,
        ).toBe(0);
        expect(
          (
            await getDbPool().query(
              'SELECT state FROM memory_jobs WHERE id=$1',
              [claimed.id],
            )
          ).rows[0].state,
        ).toMatch(/^(cancelled|skipped)$/);
        expect(
          (
            await getDbPool().query(
              'SELECT input_tokens,output_tokens,usage_known FROM memory_usage WHERE job_id=$1',
              [claimed.id],
            )
          ).rows,
        ).toEqual([{ input_tokens: 20, output_tokens: 5, usage_known: true }]);
        expect(
          (
            await getDbPool().query(
              "SELECT count(*)::int AS count FROM memory_budget_reservations WHERE state='pending'",
            )
          ).rows[0].count,
        ).toBe(0);
        expect(
          (
            await getDbPool().query(
              "SELECT reserved_tokens::int AS tokens FROM memory_daily_budgets WHERE purpose='language'",
            )
          ).rows[0].tokens,
        ).toBe(0);
      },
    );

    it('cancels queued automatic work when the session switch turns off and rejects a late delivery before model spending', async () => {
      const admitted = await turn('我喜欢清晨散步。');
      await updateMemorySessionSettings('owner', 'session-a', {
        learning_enabled: false,
        revision: 1,
      });
      expect(
        (
          await getDbPool().query(
            "SELECT state,error_code FROM memory_jobs WHERE source_id=$1 AND kind='extract'",
            [admitted.sourceId],
          )
        ).rows,
      ).toEqual([
        { state: 'cancelled', error_code: 'MEMORY.SESSION_LEARNING_CHANGED' },
      ]);
      // A delivery queued after the cancellation sweep must still see the closed switch at apply time.
      const id = await withMemoryTransaction((db) =>
        queueMemoryJob(db, {
          scope: admitted.scope,
          kind: 'extract',
          eventType: 'user_message_committed',
          key: 'late-automatic-delivery',
          sourceId: admitted.sourceId,
          sourceRevision: 1,
          requestId: admitted.requestId,
        }),
      );
      const job = await nextJob('extract');
      expect(job.id).toBe(id);
      const observed = vi.fn(runner);
      await processMemoryJob(job, policy, {
        modelOptions: { runner: observed, resolveModel },
      });
      expect(observed.mock.calls.length).toBe(0);
      expect(
        (
          await getDbPool().query(
            'SELECT state,error_code FROM memory_jobs WHERE id=$1',
            [id],
          )
        ).rows[0],
      ).toEqual({
        state: 'skipped',
        error_code: 'MEMORY.SESSION_LEARNING_CHANGED',
      });
      expect(
        (
          await getDbPool().query(
            'SELECT count(*)::int AS count FROM memory_usage',
          )
        ).rows[0].count,
      ).toBe(0);
      expect(
        (
          await getDbPool().query(
            'SELECT count(*)::int AS count FROM memory_items',
          )
        ).rows[0].count,
      ).toBe(0);
    });

    it('fences a running model completion on the current session switch even while its lease remains valid', async () => {
      const admitted = await turn('我喜欢清晨散步。');
      const claimed = await nextJob('extract');
      const entered = deferred<void>();
      const release = deferred<void>();
      const processing = processMemoryJob(claimed, policy, {
        modelOptions: {
          resolveModel,
          runner: async (request) => {
            entered.resolve();
            await release.promise;
            return runner(request);
          },
        },
      });
      await entered.promise;
      await withMemoryTransaction(async (db) => {
        await lockMemoryRoot(admitted.scope.scopeId, db);
        // Keep the lease to verify the apply-time check independently of the cancellation sweep.
        await db.query(
          "UPDATE chat_sessions SET memory_learning_enabled=false WHERE id='session-a'",
        );
      });
      release.resolve();
      await processing;
      expect(
        (
          await getDbPool().query(
            'SELECT state,error_code FROM memory_jobs WHERE id=$1',
            [claimed.id],
          )
        ).rows[0],
      ).toEqual({
        state: 'skipped',
        error_code: 'MEMORY.SESSION_LEARNING_CHANGED',
      });
      expect(
        (
          await getDbPool().query(
            'SELECT count(*)::int AS count FROM memory_items',
          )
        ).rows[0].count,
      ).toBe(0);
      expect(
        (
          await getDbPool().query(
            'SELECT input_tokens,output_tokens,usage_known FROM memory_usage WHERE job_id=$1',
            [claimed.id],
          )
        ).rows,
      ).toEqual([{ input_tokens: 20, output_tokens: 5, usage_known: true }]);
    });

    it('rejects automatic work from a retired conversation generation before a model call', async () => {
      const admitted = await turn('我喜欢清晨散步。');
      const claimed = await nextJob('extract');
      await withMemoryTransaction(async (db) => {
        await lockMemoryRoot(admitted.scope.scopeId, db);
        await db.query(
          "UPDATE chat_sessions SET memory_context_generation=memory_context_generation+1 WHERE id='session-a'",
        );
      });
      const observed = vi.fn(runner);
      await processMemoryJob(claimed, policy, {
        modelOptions: { runner: observed, resolveModel },
      });
      expect(observed.mock.calls.length).toBe(0);
      expect(
        (
          await getDbPool().query(
            'SELECT state,error_code FROM memory_jobs WHERE id=$1',
            [claimed.id],
          )
        ).rows[0],
      ).toEqual({ state: 'skipped', error_code: 'MEMORY.CONTEXT_CHANGED' });
    });

    it('honors an explicit backfill while the session future-learning switch remains closed', async () => {
      const admitted = await turn('我经常喝无糖拿铁。');
      const frozen = (await getCurrentMemorySource(admitted.sourceId))!
        .identity_snapshot;
      await updateMemorySessionSettings('owner', 'session-a', {
        learning_enabled: false,
        revision: 1,
      });
      const queued = await startMemoryBackfill('owner', {
        session_ids: ['session-a'],
      });
      await drain();
      expect(
        (
          await getDbPool().query(
            "SELECT content FROM memory_items WHERE status='active'",
          )
        ).rows,
      ).toEqual([{ content: '我经常喝无糖拿铁。' }]);
      expect(
        (await getCurrentMemorySource(admitted.sourceId))!.identity_snapshot,
      ).toEqual(frozen);
      const extractJobs = await getDbPool().query(
        "SELECT state,payload->>'backfillJobId' AS grant FROM memory_jobs WHERE kind='extract' AND source_id=$1",
        [admitted.sourceId],
      );
      expect(extractJobs.rows).toContainEqual({
        state: 'cancelled',
        grant: null,
      });
      expect(extractJobs.rows).toContainEqual({
        state: 'succeeded',
        grant: queued.id,
      });
      expect(
        (
          await getDbPool().query(
            "SELECT memory_learning_enabled,memory_learning_revision FROM chat_sessions WHERE id='session-a'",
          )
        ).rows[0],
      ).toEqual({
        memory_learning_enabled: false,
        memory_learning_revision: 2,
      });
    });

    it('uses one owner namespace for shared web and WeChat facts while retaining source actor identity', async () => {
      const metadata = {
        source_channel: 'wechat',
        wechat_account_id: 'synthetic-wechat',
        sender_hash: 'shared-owner',
      };
      const root = await ownerMemorySnapshot('owner');
      const initial = await withMemoryTransaction((db) =>
        createMemoryAdmissionScope(db, {
          ownerUserId: 'owner',
          sessionId: 'session-a',
          metadata,
        }),
      );
      await updateMemoryScopeBinding('owner', initial.scopeId, {
        speaker_subject_id: 'self:owner',
        share_subject_memory: true,
        revision: 1,
      });
      const admitted = await turn(
        '我经常喝无糖拿铁。',
        'session-a',
        new Date().toISOString(),
        metadata,
      );
      await drain();
      expect(admitted.scope.scopeId).not.toBe(root.scopeId);
      expect(admitted.scope.memorySpaceId).toBe(root.scopeId);
      expect(
        (await getDbPool().query('SELECT DISTINCT scope_id FROM memory_items'))
          .rows,
      ).toEqual([{ scope_id: root.scopeId }]);
      const origins = await getDbPool().query(
        'SELECT scope_id,memory_space_id,identity_snapshot FROM memory_sources',
      );
      expect(
        origins.rows.every(
          (source) =>
            source.scope_id === initial.scopeId &&
            source.memory_space_id === root.scopeId &&
            source.identity_snapshot.scopeId === initial.scopeId &&
            source.identity_snapshot.actorKey === admitted.scope.actorKey,
        ),
      ).toBe(true);
      const recalled = await search(root, '无糖拿铁');
      expect(
        recalled.excerpts.some(
          (excerpt) =>
            excerpt.reference.kind === 'item' &&
            excerpt.text.includes('无糖拿铁'),
        ),
      ).toBe(true);
    });

    it('does not turn a namespace identifier into owner-audience permission for a private actor', async () => {
      const root = await ownerMemorySnapshot('owner');
      const admitted = await turn(
        '我喜欢独处。',
        'session-a',
        new Date().toISOString(),
        {
          source_channel: 'wechat',
          wechat_account_id: 'synthetic-wechat',
          sender_hash: 'private-actor',
        },
      );
      expect(admitted.scope.ownerMemoryAccess).toBe(false);
      expect(admitted.scope.memorySpaceId).toBe(admitted.scope.scopeId);
      await getDbPool().query(
        'UPDATE memory_sources SET memory_space_id=$2 WHERE id=$1',
        [admitted.sourceId, root.scopeId],
      );
      const claimed = await nextJob('extract');
      const observed = vi.fn(runner);
      await processMemoryJob(claimed, policy, {
        modelOptions: { runner: observed, resolveModel },
      });
      expect(observed.mock.calls.length).toBe(0);
      expect(
        (
          await getDbPool().query(
            'SELECT state,error_code FROM memory_jobs WHERE id=$1',
            [claimed.id],
          )
        ).rows[0],
      ).toEqual({ state: 'skipped', error_code: 'MEMORY.SPACE_DENIED' });
      expect(
        (
          await getDbPool().query(
            'SELECT count(*)::int AS count FROM memory_items',
          )
        ).rows[0].count,
      ).toBe(0);
    });

    it('keeps an active backfill parent visible after more than twenty newer child jobs', async () => {
      const scope = await ownerMemorySnapshot('owner');
      const parent = await startMemoryBackfill('owner', {});
      const running = await nextJob('backfill');
      expect(running.id).toBe(parent.id);
      await withMemoryTransaction(async (db) => {
        for (let index = 0; index < 25; index++)
          await queueMemoryJob(db, {
            scope,
            kind: 'extract',
            eventType: 'explicit_backfill_grant',
            key: `status-child-${index}`,
            payload: { backfillJobId: parent.id },
          });
      });
      expect((await memoryStatus('owner')).recent_jobs[0]).toMatchObject({
        id: parent.id,
        state: 'running',
      });
      await changeMemoryJobState('owner', parent.id, 'pause');
      expect((await memoryStatus('owner')).recent_jobs[0]).toMatchObject({
        id: parent.id,
        state: 'paused',
      });
      await changeMemoryJobState('owner', parent.id, 'resume');
      const status = await memoryStatus('owner');
      expect(status.recent_jobs).toHaveLength(20);
      expect(status.recent_jobs[0]).toMatchObject({
        id: parent.id,
        state: 'pending',
      });
    });

    it('reclaims an expired lease, settles its abandoned reservation conservatively, and rejects duplicate old completions', async () => {
      await turn('我喜欢清晨散步。');
      const old = await nextJob('extract');
      await reserveMemoryBudget({
        ownerUserId: 'owner',
        purpose: 'memory.extract',
        tokens: 123,
        policy,
        jobId: old.id,
        jobLeaseToken: old.lease_token!,
      });
      await getDbPool().query(
        "UPDATE memory_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [old.id],
      );
      const reclaimed = await nextJob('extract');
      expect(reclaimed.id).toBe(old.id);
      expect(reclaimed.lease_token).not.toBe(old.lease_token);
      const observedRunner = vi.fn(runner);
      await processMemoryJob(old, policy, {
        modelOptions: { runner: observedRunner, resolveModel },
      });
      await processMemoryJob(reclaimed, policy, {
        modelOptions: { runner: observedRunner, resolveModel },
      });
      await processMemoryJob(reclaimed, policy, {
        modelOptions: { runner: observedRunner, resolveModel },
      });
      expect(observedRunner).toHaveBeenCalledTimes(1);
      expect(
        (
          await getDbPool().query(
            'SELECT count(*)::int AS count FROM memory_items',
          )
        ).rows[0].count,
      ).toBe(1);
      expect(
        (
          await getDbPool().query(
            'SELECT input_tokens,usage_known FROM memory_usage WHERE job_id=$1 ORDER BY usage_known',
            [old.id],
          )
        ).rows,
      ).toEqual([
        { input_tokens: 123, usage_known: false },
        { input_tokens: 20, usage_known: true },
      ]);
      expect(
        (
          await getDbPool().query(
            "SELECT reserved_tokens::int AS tokens FROM memory_daily_budgets WHERE purpose='language'",
          )
        ).rows[0].tokens,
      ).toBe(0);
    });

    it('pauses a backfill blocked on real database I/O, prevents its late batch from applying, and resumes its cursor', async () => {
      await ownerMemorySnapshot('owner');
      await legacyMessage('我曾学习过古琴。');
      const queued = await startMemoryBackfill('owner', {
        session_ids: ['session-a'],
      });
      const claimed = await nextJob('backfill');
      const blocker = await administrator.connect();
      let processing: Promise<void> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          `LOCK TABLE ${schema}.messages IN ACCESS EXCLUSIVE MODE`,
        );
        processing = processMemoryJob(claimed, policy, { modelOptions });
        await vi.waitFor(
          async () => {
            const waiting = await administrator.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
              [schema],
            );
            expect(waiting.rows[0].count).toBe(1);
          },
          { timeout: 3000, interval: 10 },
        );
        expect(
          (await changeMemoryJobState('owner', queued.id, 'pause')).state,
        ).toBe('paused');
        await blocker.query('COMMIT');
        await processing;
        expect(
          (
            await getDbPool().query(
              'SELECT count(*)::int AS count FROM memory_sources',
            )
          ).rows[0].count,
        ).toBe(0);
        expect(
          (
            await getDbPool().query(
              'SELECT state,processed_count FROM memory_jobs WHERE id=$1',
              [queued.id],
            )
          ).rows[0],
        ).toEqual({ state: 'paused', processed_count: 0 });
        await changeMemoryJobState('owner', queued.id, 'resume');
        await drain();
        expect(
          (
            await getDbPool().query(
              'SELECT state,processed_count FROM memory_jobs WHERE id=$1',
              [queued.id],
            )
          ).rows[0],
        ).toEqual({ state: 'succeeded', processed_count: 1 });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await processing;
      }
    }, 30_000);

    it('indexes unknown historical identity only as source context, deduplicates repeat backfill and validates scope ownership', async () => {
      const scope = await ownerMemorySnapshot('owner');
      await legacyMessage('我曾学习过古琴。');
      const first = await startMemoryBackfill('owner', {
        scope_ids: [scope.scopeId],
      });
      expect(
        (await startMemoryBackfill('owner', { scope_ids: [scope.scopeId] })).id,
      ).toBe(first.id);
      await drain();
      expect(
        (
          await getDbPool().query(
            'SELECT count(*)::int AS count FROM memory_items',
          )
        ).rows[0].count,
      ).toBe(0);
      const sources = await getDbPool().query(
        "SELECT e.kind,x.search_text FROM memory_sources s JOIN memory_entities e ON e.id=s.subject_id JOIN memory_index_entries x ON x.object_kind='source' AND x.object_id=s.id",
      );
      expect(sources.rows).toEqual([
        { kind: 'unresolved', search_text: '我曾学习过古琴。' },
      ]);
      const hydrated = await search(scope, '古琴');
      expect(hydrated.excerpts).toHaveLength(1);
      expect(hydrated.excerpts[0].label).toContain('身份未确认');
      const repeated = await startMemoryBackfill('owner', {
        scope_ids: [scope.scopeId],
      });
      expect(repeated.id).not.toBe(first.id);
      await drain();
      expect(
        (
          await getDbPool().query(
            'SELECT count(*)::int AS count FROM memory_sources',
          )
        ).rows[0].count,
      ).toBe(1);
      const otherScope = await ownerMemorySnapshot('other');
      await expect(
        startMemoryBackfill('owner', { scope_ids: [otherScope.scopeId] }),
      ).rejects.toMatchObject({ code: 'MEMORY.SCOPE_DENIED' });
      await expect(
        startMemoryBackfill('owner', { scope_ids: [] }),
      ).rejects.toThrow('范围列表无效');
    }, 30_000);

    it('does not resurrect a never-captured message from before clear', async () => {
      await ownerMemorySnapshot('owner');
      const old = await legacyMessage('我以前住在成都。');
      await clearMemory('owner');
      await startMemoryBackfill('owner', { session_ids: ['session-a'] });
      await drain();
      expect(
        (
          await getDbPool().query(
            'SELECT count(*)::int AS count FROM memory_sources WHERE message_id=$1',
            [old],
          )
        ).rows[0].count,
      ).toBe(0);
      expect(
        (
          await getDbPool().query(
            'SELECT count(*)::int AS count FROM memory_index_entries',
          )
        ).rows[0].count,
      ).toBe(0);
    });

    it('finishes batch-one backfill across same-millisecond microseconds and reverse message IDs without duplicate progress', async () => {
      await ownerMemorySnapshot('owner');
      const batchPolicy = { ...policy, backfill_batch_size: 1 };
      await getDbPool().query(
        "UPDATE runtime_config SET memory_policy=$1::jsonb WHERE id='default'",
        [JSON.stringify(batchPolicy)],
      );
      const messages = [
        {
          id: 'z-earlier-message',
          content: '我曾学习过篆刻。',
          at: '2026-10-31 03:40:55.958705+00',
        },
        {
          id: 'a-later-message',
          content: '我曾学习过古琴。',
          at: '2026-10-31 03:40:55.958900+00',
        },
      ];
      for (const message of messages)
        await getDbPool().query(
          `INSERT INTO messages(id,account_id,user_id,sender,sender_name,content,timestamp,is_from_me,is_bot_message,session_id)
         VALUES($1,'web:owner','owner','unknown-sender','旧对话',$2,$3,false,false,'session-a')`,
          [message.id, message.content, message.at],
        );
      const queued = await startMemoryBackfill('owner', {
        session_ids: ['session-a'],
      });
      for (let step = 0; step < 5; step++) {
        await runMemoryWorkerOnce({ modelOptions });
        if (
          (
            await getDbPool().query(
              'SELECT state FROM memory_jobs WHERE id=$1',
              [queued.id],
            )
          ).rows[0].state === 'succeeded'
        )
          break;
      }
      expect(
        (
          await getDbPool().query(
            'SELECT state,processed_count,total_count FROM memory_jobs WHERE id=$1',
            [queued.id],
          )
        ).rows[0],
      ).toEqual({ state: 'succeeded', processed_count: 2, total_count: 2 });
      expect(
        (
          await getDbPool().query(
            'SELECT message_id,observed_at::text FROM memory_sources ORDER BY observed_at,message_id',
          )
        ).rows,
      ).toEqual([
        {
          message_id: 'z-earlier-message',
          observed_at: '2026-10-31 03:40:55.958705+00',
        },
        {
          message_id: 'a-later-message',
          observed_at: '2026-10-31 03:40:55.9589+00',
        },
      ]);
      expect(
        (
          await getDbPool().query(
            "SELECT s.message_id,x.observed_at::text FROM memory_index_entries x JOIN memory_sources s ON x.object_kind='source' AND x.object_id=s.id ORDER BY s.observed_at,s.message_id",
          )
        ).rows,
      ).toEqual([
        {
          message_id: 'z-earlier-message',
          observed_at: '2026-10-31 03:40:55.958705+00',
        },
        {
          message_id: 'a-later-message',
          observed_at: '2026-10-31 03:40:55.9589+00',
        },
      ]);
      expect(
        (
          await getDbPool().query(
            "SELECT payload->'cursor'->>'at' AS at FROM memory_jobs WHERE id=$1",
            [queued.id],
          )
        ).rows[0].at,
      ).toBe('2026-10-31 03:40:55.9589+00');
    });

    it('keeps messages after clear within the same millisecond and excludes those before its microsecond boundary', async () => {
      const scope = await ownerMemorySnapshot('owner');
      await clearMemory('owner');
      await getDbPool().query(
        'UPDATE memory_scopes SET cleared_at=$2::timestamptz WHERE id=$1',
        [scope.scopeId, '2026-10-31 03:40:55.123705+00'],
      );
      const before = await legacyMessage(
        '我曾学习过绘画。',
        '2026-10-31 03:40:55.123500+00',
      );
      const after = await legacyMessage(
        '我曾学习过古琴。',
        '2026-10-31 03:40:55.123900+00',
      );
      const queued = await startMemoryBackfill('owner', {
        session_ids: ['session-a'],
      });
      await drain();
      expect(
        (
          await getDbPool().query(
            'SELECT message_id,observed_at::text FROM memory_sources ORDER BY message_id',
          )
        ).rows,
      ).toEqual([
        { message_id: after, observed_at: '2026-10-31 03:40:55.1239+00' },
      ]);
      expect(
        (
          await getDbPool().query(
            'SELECT count(*)::int AS count FROM memory_sources WHERE message_id=$1',
            [before],
          )
        ).rows[0].count,
      ).toBe(0);
      expect(
        (
          await getDbPool().query(
            'SELECT state,processed_count,total_count FROM memory_jobs WHERE id=$1',
            [queued.id],
          )
        ).rows[0],
      ).toEqual({ state: 'succeeded', processed_count: 1, total_count: 1 });
    });

    it.each(['present', 'removed'])(
      'explicitly backfills a disabled-learning user source, but no assistant reply, with %s request history without rewriting identity',
      async (requestHistory) => {
        let settings = await getMemorySettings('owner');
        settings = await updateMemorySettings('owner', {
          revision: settings.revision,
          learning_enabled: false,
        });
        const admitted = await turn(
          '我经常喝无糖拿铁。',
          'session-a',
          '2026-10-31 03:40:55.958705+00',
        );
        await assistantMessage();
        const original = (
          await getDbPool().query(
            'SELECT id,identity_snapshot,subject_id,content_hash,revision FROM memory_sources ORDER BY id',
          )
        ).rows;
        expect(original).toHaveLength(1);
        expect(original[0].identity_snapshot.learningEnabled).toBe(false);
        expect(
          (
            await getDbPool().query(
              'SELECT count(*)::int AS count FROM memory_jobs',
            )
          ).rows[0].count,
        ).toBe(0);
        if (requestHistory === 'removed')
          await getDbPool().query(
            'DELETE FROM agent_requests WHERE request_id=$1',
            [admitted.requestId],
          );
        await updateMemorySettings('owner', {
          revision: settings.revision,
          learning_enabled: true,
        });
        const backfill = await startMemoryBackfill('owner', {
          session_ids: ['session-a'],
        });
        await drain();
        expect(
          (
            await getDbPool().query(
              'SELECT id,identity_snapshot,subject_id,content_hash,revision FROM memory_sources ORDER BY id',
            )
          ).rows,
        ).toEqual(original);
        expect(
          (
            await getDbPool().query(
              "SELECT count(*)::int AS count FROM memory_entities WHERE kind='unresolved'",
            )
          ).rows[0].count,
        ).toBe(0);
        expect(
          (
            await getDbPool().query(
              "SELECT content FROM memory_items WHERE status='active'",
            )
          ).rows,
        ).toEqual([{ content: '我经常喝无糖拿铁。' }]);
        const grants = await getDbPool().query(
          "SELECT request_id,kind,payload FROM memory_jobs WHERE event_type='explicit_backfill_grant' ORDER BY kind",
        );
        expect(
          grants.rows.map((grant) => ({
            kind: grant.kind,
            requestId: grant.request_id,
          })),
        ).toEqual([
          {
            kind: 'extract',
            requestId: requestHistory === 'present' ? admitted.requestId : null,
          },
        ]);
        expect(
          grants.rows.every(
            (grant) => grant.payload.backfillJobId === backfill.id,
          ),
        ).toBe(true);
        expect(
          (
            await getDbPool().query(
              "SELECT count(*)::int AS count FROM memory_jobs WHERE error_code='MEMORY.USER_SOURCE_MISSING'",
            )
          ).rows[0].count,
        ).toBe(0);
      },
    );

    it.each(['exclude', 'clear'])(
      'does not reauthorize a disabled-learning source after %s',
      async (operation) => {
        let settings = await getMemorySettings('owner');
        settings = await updateMemorySettings('owner', {
          revision: settings.revision,
          learning_enabled: false,
        });
        const admitted = await turn('我经常喝无糖拿铁。');
        const original = (
          await getDbPool().query(
            'SELECT identity_snapshot FROM memory_sources WHERE id=$1',
            [admitted.sourceId],
          )
        ).rows[0].identity_snapshot;
        if (operation === 'exclude')
          await excludeMemorySource('owner', admitted.sourceId);
        else await clearMemory('owner');
        settings = await getMemorySettings('owner');
        await updateMemorySettings('owner', {
          revision: settings.revision,
          learning_enabled: true,
        });
        await startMemoryBackfill('owner', { session_ids: ['session-a'] });
        await drain();
        expect(
          (
            await getDbPool().query(
              'SELECT identity_snapshot,learning_enabled FROM memory_sources WHERE id=$1',
              [admitted.sourceId],
            )
          ).rows,
        ).toEqual([{ identity_snapshot: original, learning_enabled: false }]);
        expect(
          (
            await getDbPool().query(
              'SELECT count(*)::int AS count FROM memory_items',
            )
          ).rows[0].count,
        ).toBe(0);
        expect(
          (
            await getDbPool().query(
              'SELECT count(*)::int AS count FROM memory_index_entries',
            )
          ).rows[0].count,
        ).toBe(0);
        expect(
          (
            await getDbPool().query(
              "SELECT count(*)::int AS count FROM memory_jobs WHERE event_type='explicit_backfill_grant'",
            )
          ).rows[0].count,
        ).toBe(0);
      },
    );

    it('backfills only the selected actor scope while retaining uncertain source identity', async () => {
      const metadata = {
        source_channel: 'wechat',
        wechat_account_id: 'synthetic-wechat',
        sender_hash: 'synthetic-sender',
      };
      const actor = await withMemoryTransaction((db) =>
        createMemoryAdmissionScope(db, {
          ownerUserId: 'owner',
          sessionId: 'session-a',
          metadata,
        }),
      );
      const selected = await legacyMessage(
        '我曾学习过篆刻。',
        undefined,
        metadata,
      );
      const unselected = await legacyMessage('我曾学习过摄影。');
      await startMemoryBackfill('owner', { scope_ids: [actor.scopeId] });
      await drain();
      const sources = await getDbPool().query(
        'SELECT s.message_id,s.scope_id,e.kind FROM memory_sources s JOIN memory_entities e ON e.id=s.subject_id',
      );
      expect(sources.rows).toEqual([
        { message_id: selected, scope_id: actor.scopeId, kind: 'unresolved' },
      ]);
      expect(sources.rows.some((row) => row.message_id === unselected)).toBe(
        false,
      );
      expect(
        (
          await getDbPool().query(
            'SELECT count(*)::int AS count FROM memory_items',
          )
        ).rows[0].count,
      ).toBe(0);
    });

    it('keeps a manual item searchable without queued work while automatic learning is disabled', async () => {
      const settings = await getMemorySettings('owner');
      await updateMemorySettings('owner', {
        revision: settings.revision,
        learning_enabled: false,
      });
      const manual = await createManualMemory('owner', {
        content: '我偏好简洁直接的回答。',
        kind: 'preference',
      });
      expect(
        (
          await getDbPool().query(
            'SELECT count(*)::int AS count FROM memory_jobs',
          )
        ).rows[0].count,
      ).toBe(0);
      const found = await search(await ownerMemorySnapshot('owner'), '简洁');
      expect(found.excerpts.map((excerpt) => excerpt.reference.id)).toContain(
        manual.id,
      );
    });

    it('settles expired unbound reservations exactly once without freeing their conservative usage or shortening a newer deadline', async () => {
      const expired = await reserveMemoryBudget({
        ownerUserId: 'owner',
        purpose: 'memory.extract',
        tokens: 80,
        policy,
      });
      const recent = await reserveMemoryBudget({
        ownerUserId: 'owner',
        purpose: 'memory.extract',
        tokens: 20,
        policy,
      });
      await getDbPool().query(
        "UPDATE memory_budget_reservations SET deadline_at=clock_timestamp()-interval '10 seconds' WHERE id=$1",
        [expired.id],
      );
      const changedPolicy = {
        ...policy,
        job_timeout_ms: 1,
        recall_timeout_ms: 1,
      };
      expect(
        (
          await Promise.all([
            reconcileMemoryBudgetReservations(changedPolicy),
            reconcileMemoryBudgetReservations(changedPolicy),
          ])
        ).sort(),
      ).toEqual([0, 1]);
      const usage = await getDbPool().query(
        'SELECT input_tokens,output_tokens,usage_known,model_config_id,model FROM memory_usage WHERE id=$1',
        [expired.id],
      );
      expect(usage.rows).toEqual([
        {
          input_tokens: 80,
          output_tokens: 0,
          usage_known: false,
          model_config_id: 'unknown',
          model: 'unknown',
        },
      ]);
      expect(
        (
          await getDbPool().query(
            "SELECT used_tokens::int,reserved_tokens::int FROM memory_daily_budgets WHERE purpose='language'",
          )
        ).rows[0],
      ).toEqual({ used_tokens: 80, reserved_tokens: 20 });
      expect(
        (
          await getDbPool().query(
            'SELECT state FROM memory_budget_reservations WHERE id=$1',
            [recent.id],
          )
        ).rows[0].state,
      ).toBe('pending');
      await settleMemoryBudget(expired, {
        purpose: 'memory.extract',
        modelConfigId: 'late-model',
        model: 'late-model',
        durationMs: 1,
        usage: { inputTokens: 2, outputTokens: 0 },
      });
      expect(
        (
          await getDbPool().query(
            'SELECT input_tokens,usage_known FROM memory_usage WHERE id=$1',
            [expired.id],
          )
        ).rows,
      ).toEqual([{ input_tokens: 80, usage_known: false }]);
      expect(await reconcileMemoryBudgetReservations(policy)).toBe(0);
      await getDbPool().query(
        "UPDATE memory_budget_reservations SET deadline_at=clock_timestamp()-interval '10 seconds' WHERE id=$1",
        [recent.id],
      );
      await getDbPool().query(
        "UPDATE runtime_config SET memory_policy=jsonb_set(memory_policy,'{enabled}','false') WHERE id='default'",
      );
      await runMemoryWorkerOnce();
      expect(
        (
          await getDbPool().query(
            'SELECT input_tokens,usage_known,model_config_id,model FROM memory_usage WHERE id=$1',
            [recent.id],
          )
        ).rows,
      ).toEqual([
        {
          input_tokens: 20,
          usage_known: false,
          model_config_id: 'unknown',
          model: 'unknown',
        },
      ]);
      expect(
        (
          await getDbPool().query(
            "SELECT used_tokens::int,reserved_tokens::int FROM memory_daily_budgets WHERE purpose='language'",
          )
        ).rows[0],
      ).toEqual({ used_tokens: 100, reserved_tokens: 0 });
    });

    it('protects live matching job leases and recovers expired old leases and paused work without changing job state', async () => {
      await turn('我偏好安静的环境。');
      const old = await nextJob('extract');
      const abandoned = await reserveMemoryBudget({
        ownerUserId: 'owner',
        purpose: 'memory.extract',
        tokens: 50,
        policy,
        jobId: old.id,
        jobLeaseToken: old.lease_token!,
      });
      await getDbPool().query(
        "UPDATE memory_budget_reservations SET deadline_at=clock_timestamp()-interval '10 seconds' WHERE id=$1",
        [abandoned.id],
      );
      expect(await reconcileMemoryBudgetReservations(policy)).toBe(0);
      await getDbPool().query(
        "UPDATE memory_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [old.id],
      );
      const current = await nextJob('extract');
      expect(current.lease_token).not.toBe(old.lease_token);
      expect(await reconcileMemoryBudgetReservations(policy)).toBe(1);
      const live = await reserveMemoryBudget({
        ownerUserId: 'owner',
        purpose: 'memory.extract',
        tokens: 60,
        policy,
        jobId: current.id,
        jobLeaseToken: current.lease_token!,
      });
      await getDbPool().query(
        "UPDATE memory_budget_reservations SET deadline_at=clock_timestamp()-interval '10 seconds' WHERE id=$1",
        [live.id],
      );
      expect(await reconcileMemoryBudgetReservations(policy)).toBe(0);
      await changeMemoryJobState('owner', current.id, 'pause');
      expect(
        await reconcileMemoryBudgetReservations(policy, { limit: 1 }),
      ).toBe(1);
      expect(await reconcileMemoryBudgetReservations(policy)).toBe(0);
      expect(
        (
          await getDbPool().query('SELECT state FROM memory_jobs WHERE id=$1', [
            current.id,
          ])
        ).rows[0].state,
      ).toBe('paused');
      expect(
        (
          await getDbPool().query(
            'SELECT input_tokens,usage_known,model_config_id,model FROM memory_usage ORDER BY input_tokens',
          )
        ).rows,
      ).toEqual([
        {
          input_tokens: 50,
          usage_known: false,
          model_config_id: 'unknown',
          model: 'unknown',
        },
        {
          input_tokens: 60,
          usage_known: false,
          model_config_id: 'unknown',
          model: 'unknown',
        },
      ]);
      expect(
        (
          await getDbPool().query(
            "SELECT used_tokens::int,reserved_tokens::int FROM memory_daily_budgets WHERE purpose='language'",
          )
        ).rows[0],
      ).toEqual({ used_tokens: 110, reserved_tokens: 0 });
    });

    it('resumes complete-source fragments without duplicate facts and rejects a later-arriving older residence claim', async () => {
      const narrow = { ...policy, extraction_input_tokens: 4000 };
      await getDbPool().query(
        "UPDATE runtime_config SET memory_policy=$1::jsonb WHERE id='default'",
        [JSON.stringify(narrow)],
      );
      const statements = Array.from(
        { length: 14 },
        (_value, index) =>
          `我记录的第${index}项饮食偏好是${'常温、低糖、固定时段饮用'.repeat(5)}。`,
      );
      const admitted = await turn(statements.join('\n\n'));
      const initial = await nextJob('extract');
      await processMemoryJob(initial, narrow, { modelOptions });
      const progress = (
        await getDbPool().query(
          'SELECT state,processed_count,total_count,payload FROM memory_jobs WHERE id=$1',
          [initial.id],
        )
      ).rows[0];
      expect(progress.state).toBe('pending');
      expect(progress.processed_count).toBe(1);
      expect(progress.total_count).toBeGreaterThan(1);
      expect(progress.payload.extractionCursor).toBe(1);
      await processMemoryJob(initial, narrow, { modelOptions });
      await drain();
      expect(
        (
          await getDbPool().query(
            "SELECT count(*)::int AS count,count(DISTINCT content_hash)::int AS distinct_count FROM memory_items WHERE status='active'",
          )
        ).rows[0],
      ).toEqual({ count: 14, distinct_count: 14 });
      expect(
        (await getCurrentMemorySource(admitted.sourceId))?.extracted_revision,
      ).toBe(1);
      await turn('我目前住在上海。', 'session-a', '2026-10-31T10:00:00Z');
      await drain();
      await turn('我以前住在北京。', 'session-b', '2026-10-30T10:00:00Z');
      await drain();
      expect(
        (
          await getDbPool().query(
            "SELECT content FROM memory_items WHERE fact_key='residence' AND status='active'",
          )
        ).rows,
      ).toEqual([{ content: '我目前住在上海。' }]);
    }, 60_000);
  },
);
