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
import { piSessionFramesMigration } from '#infrastructure/migrations/versions/0094-pi-session-frames';
import {
  getPiSessionBase,
  getPiSessionSnapshot,
  storePiSessionFrame,
} from '#infrastructure/repositories/pi-session-frames-repository';
import { createPiSessionFrame } from '@fateclaw/contracts/agent/session';
import { readMemoryPiContext } from '#modules/memory/pi-contexts';
import { updateMemoryScopeBinding } from '#modules/memory/scope-management';
import { admitAgentRequest } from '#infrastructure/repositories/agent-requests-repository';
import { resetUserMessages } from '#infrastructure/repositories/chat-repository';
import type { AiChatSubmission } from '#runtime/request-types';
import type { LlmRuntimeSnapshot } from '@fateclaw/contracts/agent';
import {
  DEFAULT_MEMORY_RUNTIME_POLICY,
  type MemoryHydration,
  type MemoryReference,
  type MemoryRequestScope,
} from '@fateclaw/contracts/memory';
import {
  createManualMemory,
  clearMemory,
  executeMemoryOperation,
  forgetManualMemory,
  getMemoryEvidence,
  listMemory,
  ownerMemorySnapshot,
  updateManualMemory,
  updateMemorySettings,
  memoryStatus,
} from '#modules/memory/service';
import { getMemoryRuntimePolicy } from '#modules/memory/policy';
import { claimMemoryJobs, processMemoryJob } from '#modules/memory/jobs';
import type { MemoryTextRunner } from '#modules/memory/model-client';
import {
  getCurrentMemorySource,
  insertMemoryItem,
  withMemoryReadTransaction,
  withMemoryTransaction,
} from '#modules/memory/repository';
import {
  authorizeMemoryRecall,
  prepareMemory,
  readMemory,
  searchMemory,
} from '#modules/memory/retrieval';
import {
  reserveMemoryBudget,
  settleMemoryBudget,
} from '#modules/memory/budget';

vi.mock('#infrastructure/env', () => ({ readEnvFile: () => ({}) }));

const connectionString = process.env.FATECLAW_TEST_TEXT_MEMORY_DATABASE_URL;
const schema = `memory_test_${randomUUID().replace(/-/g, '')}`;
const runtime: LlmRuntimeSnapshot = {
  source: 'official',
  billingMode: 'none',
  modelConfigId: 'synthetic',
  piApi: 'openai-completions',
  model: 'synthetic',
  apiKey: 'synthetic-test-value',
  authMode: 'openai_api_key',
  providerKey: 'synthetic',
};
let administrator: pg.Pool;

describe.skipIf(!connectionString)(
  'cross-conversation memory PostgreSQL integration',
  () => {
    beforeAll(async () => {
      const target = new URL(connectionString!);
      if (
        !['127.0.0.1', 'localhost'].includes(target.hostname) ||
        !/^\/(?:fateclaw_)?memory_test$/.test(target.pathname)
      )
        throw new Error(
          'Memory integration requires an explicitly disposable local memory_test database',
        );
      administrator = new pg.Pool({ connectionString });
      await administrator.query(`CREATE SCHEMA ${schema}`);
      target.searchParams.set('options', `-c search_path=${schema},public`);
      const db = initDbPool(target.toString());
      await db.query(`
      CREATE TABLE users(id text PRIMARY KEY,soul_content text NOT NULL DEFAULT '',soul_edit_enabled boolean NOT NULL DEFAULT true,created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE accounts(id text PRIMARY KEY,owner_id text REFERENCES users(id),soul_content text DEFAULT '',enabled boolean DEFAULT true,created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE client_profiles(id text PRIMARY KEY,user_id text REFERENCES users(id),name text NOT NULL,deleted_at timestamptz);
      CREATE TABLE chat_sessions(id text PRIMARY KEY,account_id text NOT NULL,user_id text REFERENCES users(id),client_id text REFERENCES client_profiles(id),deleted_at timestamptz,model_pool_key text DEFAULT 'official',updated_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE messages(id text NOT NULL,account_id text NOT NULL,user_id text,sender text,sender_name text,content text NOT NULL,timestamp timestamptz NOT NULL,
        is_from_me boolean,is_bot_message boolean,tool_context jsonb,session_id text REFERENCES chat_sessions(id),metadata jsonb,deleted_at timestamptz,PRIMARY KEY(id,account_id));
      CREATE TABLE runtime_config(id text PRIMARY KEY,revision integer NOT NULL DEFAULT 1,updated_at timestamptz DEFAULT clock_timestamp());
      INSERT INTO runtime_config(id)VALUES('default');
      CREATE TABLE config_audit_logs(id text PRIMARY KEY,actor_user_id text,action text,target_type text,target_key text,before_json jsonb,after_json jsonb);
    `);
      const client = await db.connect();
      try {
        await durableAgentRequestsMigration.up(client);
        await piSessionFramesMigration.up(client);
        // The migration runner applies each version inside a transaction.
        await client.query('BEGIN');
        await crossConversationMemoryMigration.up(client);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    });

    beforeEach(async () => {
      await getDbPool().query(
        'TRUNCATE users,agent_requests,agent_result_deliveries,memory_daily_budgets CASCADE',
      );
      await getDbPool().query(
        "UPDATE runtime_config SET memory_policy=$1::jsonb WHERE id='default'",
        [JSON.stringify(DEFAULT_MEMORY_RUNTIME_POLICY)],
      );
      await getDbPool().query(
        "INSERT INTO users(id) VALUES('owner'),('other'); INSERT INTO client_profiles(id,user_id,name)VALUES('client','owner','命主甲'); INSERT INTO chat_sessions(id,account_id,user_id)VALUES('session-a','web:owner','owner'),('session-b','web:owner','owner'),('session-other','web:other','other')",
      );
    });

    afterAll(async () => {
      if (!administrator) return;
      await closeDbPool();
      await administrator.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await administrator.end();
    });

    /** The host read path of `prepare`/`read`/`search`, without the request lookup. */
    async function recall(
      scope: MemoryRequestScope,
      run: (
        context: NonNullable<Awaited<ReturnType<typeof authorizeMemoryRecall>>>,
      ) => Promise<MemoryHydration>,
    ): Promise<MemoryHydration> {
      const policy = await getMemoryRuntimePolicy();
      return withMemoryReadTransaction(async (db) => {
        const context = await authorizeMemoryRecall(db, scope, policy);
        if (!context) throw new Error('Synthetic recall is disabled');
        return run(context);
      });
    }
    const read = (scope: MemoryRequestScope, references: MemoryReference[]) =>
      recall(scope, (context) => readMemory(context, references));
    const search = (
      scope: MemoryRequestScope,
      query: string,
      sessionId = 'session-search',
    ) =>
      recall(scope, (context) => searchMemory(context, { query }, sessionId));
    const prepare = (
      scope: MemoryRequestScope,
      sessionId: string,
      references: MemoryReference[] = [],
      query?: string,
    ) =>
      recall(scope, (context) =>
        prepareMemory(context, { query, references, sessionId }),
      );
    const refs = (hydration: MemoryHydration) =>
      hydration.excerpts.map((excerpt) => excerpt.reference);

    async function turn(
      sessionId: string,
      content: string,
      metadata?: Record<string, unknown>,
    ) {
      const owner = sessionId === 'session-other' ? 'other' : 'owner';
      const requestId = `request-${randomUUID()}`;
      const messageId = `message-${randomUUID()}`;
      const input: AiChatSubmission = {
        accountId: `web:${owner}`,
        sessionId,
        userMessageId: messageId,
        userMessage: content,
        history: [],
        messageToPersist: {
          id: messageId,
          account_id: `web:${owner}`,
          user_id: owner,
          sender: owner,
          sender_name: '合成用户',
          content,
          timestamp: new Date().toISOString(),
          session_id: sessionId,
          metadata,
        },
      };
      const executionId = await admitAgentRequest({
        input,
        requestId,
        ownerUserId: owner,
        runtime,
        deadlineAt: Date.now() + 60_000,
      });
      return {
        input,
        requestId,
        executionId,
        messageId,
        scope: input.memoryScope!,
      };
    }

    it('atomically captures submitted user statements and private identity before any assistant completion', async () => {
      const a = await turn('session-a', '我准备参加考研。');
      expect(a.scope.learningEnabled).toBe(true);
      const admitted = (
        await getDbPool().query(
          'SELECT input,memory_scope FROM agent_requests WHERE request_id=$1',
          [a.requestId],
        )
      ).rows[0];
      expect(admitted.input.memoryScope).toEqual(a.scope);
      expect(admitted.memory_scope).toEqual(a.scope);
      const sources = (
        await getDbPool().query(
          'SELECT * FROM memory_sources WHERE message_id=$1',
          [a.messageId],
        )
      ).rows;
      expect(sources).toHaveLength(1);
      expect(
        (
          await getDbPool().query(
            "SELECT count(*)::int AS count FROM memory_jobs WHERE request_id=$1 AND kind='extract'",
            [a.requestId],
          )
        ).rows[0].count,
      ).toBe(1);
      const b = await turn('session-b', '我应该怎样安排学习？');
      const hydrated = await prepare(b.scope, 'session-b');
      expect(
        hydrated.excerpts.some((row) => row.text.includes('我准备参加考研')),
      ).toBe(true);
      expect(
        hydrated.excerpts.some((row) => row.text.includes('怎样安排')),
      ).toBe(false);
    });

    it('learns, renders core at read time, recalls and forgets on plain PostgreSQL', async () => {
      const a = await turn('session-a', '我喜欢咖啡。');
      const runner: MemoryTextRunner = async (request) => {
        const input = JSON.parse(request.input) as {
          sources: Array<{ id: string; subjectId: string; content: string }>;
        };
        return {
          text: JSON.stringify({
            candidates: input.sources.map((source) => ({
              sourceId: source.id,
              subjectId: source.subjectId,
              quote: source.content,
              content: source.content,
              kind: 'preference',
              assertionType: 'stated',
            })),
          }),
          usage: { inputTokens: 20, outputTokens: 5 },
        };
      };
      const policy = await getMemoryRuntimePolicy();
      for (let batch = 0; batch < 5; batch++) {
        const jobs = await claimMemoryJobs(policy, 10);
        if (!jobs.length) break;
        for (const job of jobs)
          await processMemoryJob(job, policy, {
            modelOptions: { runner, resolveModel: async () => runtime },
          });
      }
      expect(
        (
          await getDbPool().query(
            'SELECT kind,state FROM memory_jobs WHERE request_id=$1',
            [a.requestId],
          )
        ).rows,
      ).toEqual([{ kind: 'extract', state: 'succeeded' }]);
      const b = await turn('session-b', '我喜欢什么饮料？');
      const core = await prepare(b.scope, 'session-b');
      expect(
        core.excerpts.some(
          (excerpt) =>
            excerpt.automatic &&
            excerpt.reference.kind === 'item' &&
            excerpt.text.includes('咖啡'),
        ),
      ).toBe(true);
      const recalled = await search(b.scope, '咖啡');
      expect(recalled.status).toBe('ready');
      expect(
        recalled.excerpts.some((excerpt) => excerpt.text.includes('咖啡')),
      ).toBe(true);
      expect(await memoryStatus('owner')).toMatchObject({
        active_items: 1,
        indexed_items: 1,
      });
      const item = (await listMemory('owner')).items[0];
      await forgetManualMemory('owner', item.id, item.revision);
      expect((await search(b.scope, '咖啡')).excerpts).toEqual([]);
      expect(a.scope.scopeId).toBe(b.scope.scopeId);
    });

    it('bulk message reset revokes learned facts, source index and pending work, keeping manual memory', async () => {
      const learned = await turn('session-a', '我喜欢咖啡。');
      const runner: MemoryTextRunner = async (request) => {
        const input = JSON.parse(request.input) as {
          sources: Array<{ id: string; subjectId: string; content: string }>;
        };
        return {
          text: JSON.stringify({
            candidates: input.sources.map((source) => ({
              sourceId: source.id,
              subjectId: source.subjectId,
              quote: source.content,
              content: source.content,
              kind: 'preference',
              assertionType: 'stated',
            })),
          }),
          usage: { inputTokens: 20, outputTokens: 5 },
        };
      };
      const policy = await getMemoryRuntimePolicy();
      for (const job of await claimMemoryJobs(policy, 10))
        await processMemoryJob(job, policy, {
          modelOptions: { runner, resolveModel: async () => runtime },
        });
      const pending = await turn('session-b', '我住在杭州。');
      const manual = await createManualMemory('owner', {
        content: '我对花生过敏',
      });

      await resetUserMessages('owner');

      const items = (
        await getDbPool().query<{ id: string; status: string }>(
          "SELECT id,status FROM memory_items WHERE owner_user_id='owner'",
        )
      ).rows;
      expect(items.find((row) => row.id === manual.id)?.status).toBe('active');
      expect(
        items.filter((row) => row.id !== manual.id).map((row) => row.status),
      ).toEqual(['forgotten']);
      expect(
        (
          await getDbPool().query(
            "SELECT 1 FROM memory_index_entries WHERE owner_user_id='owner' AND object_kind='source'",
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await getDbPool().query(
            'SELECT state FROM memory_jobs WHERE request_id=$1',
            [pending.requestId],
          )
        ).rows,
      ).toEqual([{ state: 'cancelled' }]);
      expect(
        (
          await getDbPool().query(
            'SELECT 1 FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE s.message_id=$1 AND e.revoked_at IS NULL',
            [learned.messageId],
          )
        ).rowCount,
      ).toBe(0);
    });

    it('recalls an older relevant fact ahead of many newer partial matches', async () => {
      const target = await createManualMemory('owner', {
        content: '我女儿在准备考研。',
      });
      const root = (
        await getDbPool().query<{ id: string }>(
          "SELECT id FROM memory_scopes WHERE owner_user_id='owner' AND parent_scope_id IS NULL",
        )
      ).rows[0].id;
      await getDbPool().query(
        "UPDATE memory_index_entries SET updated_at=clock_timestamp()-interval '1 day' WHERE object_id=$1",
        [target.id],
      );
      await getDbPool().query(
        `INSERT INTO memory_index_entries(owner_user_id,scope_id,subject_id,object_kind,object_id,object_revision,search_text)
         SELECT 'owner',$1,'self:owner','item','noise-'||g,1,'今天的事情很多'||g FROM generate_series(1,150) g`,
        [root],
      );
      const b = await turn('session-b', '随便聊聊。');
      const recalled = await search(b.scope, '我女儿考研的事怎么样了');
      expect(recalled.excerpts.map((row) => row.reference.id)).toContain(
        target.id,
      );
    });

    it('does not echo the current conversation back as a remembered source', async () => {
      const a = await turn('session-a', '我下周三要去体检。');
      const sourceText = (hydration: MemoryHydration) =>
        hydration.excerpts.filter(
          (excerpt) =>
            excerpt.reference.kind === 'source' &&
            excerpt.text.includes('体检'),
        );
      expect(sourceText(await search(a.scope, '体检', 'session-a'))).toEqual(
        [],
      );
      expect(
        sourceText(await prepare(a.scope, 'session-a', [], '体检')),
      ).toEqual([]);
      const b = await turn('session-b', '我什么时候体检？');
      expect(
        sourceText(await search(b.scope, '体检', 'session-b')),
      ).not.toEqual([]);
    });

    it('keeps actors and subjects distinct and rejects forged cross-user or cross-sender references', async () => {
      const web = await turn('session-a', '我喜欢简短的回答。');
      const saved = await createManualMemory('owner', {
        content: '我偏好简短回答。',
        kind: 'preference',
      });
      const wechat = await turn('session-b', '我希望继续上次的问题。', {
        source_channel: 'wechat',
        wechat_account_id: 'synthetic-account',
        sender_hash: 'synthetic-sender',
      });
      expect(wechat.scope.actorKey).not.toBe(web.scope.actorKey);
      expect(wechat.scope.subjectId.startsWith('sender:')).toBe(true);
      const ref = {
        kind: 'item' as const,
        id: saved.id,
        revision: saved.revision,
      };
      expect((await read(wechat.scope, [ref])).excerpts).toEqual([]);
      const other = await turn('session-other', '我能看哪些信息？');
      expect((await read(other.scope, [ref])).excerpts).toEqual([]);
    });

    it('forgets one supported statement without hiding an unrelated statement from the same source', async () => {
      const a = await turn('session-a', '我住在上海。我喜欢咖啡。');
      const row = (
        await getDbPool().query<{ id: string }>(
          'SELECT id FROM memory_sources WHERE message_id=$1',
          [a.messageId],
        )
      ).rows[0];
      const source = (await getCurrentMemorySource(row.id))!;
      const [location, coffee] = await withMemoryTransaction(async (db) => [
        await insertMemoryItem(db, {
          scope: a.scope,
          content: '我住在上海。',
          kind: 'fact',
          factKey: 'residence',
          origin: 'automatic',
          source,
          quote: '我住在上海。',
        }),
        await insertMemoryItem(db, {
          scope: a.scope,
          content: '我喜欢咖啡。',
          kind: 'preference',
          origin: 'automatic',
          source,
          quote: '我喜欢咖啡。',
        }),
      ]);
      await forgetManualMemory('owner', location.id, location.revision);
      const visible = await getCurrentMemorySource(source.id);
      expect(visible?.content).not.toContain('上海');
      expect(visible?.content).toContain('我喜欢咖啡。');
      const b = await turn('session-b', '我喜欢喝什么？');
      const hydrated = await read(b.scope, [
        { kind: 'item', id: coffee.id, revision: coffee.revision },
        { kind: 'source', id: source.id, revision: source.revision },
      ]);
      expect(hydrated.excerpts.some((row) => row.text.includes('咖啡'))).toBe(
        true,
      );
      expect(hydrated.excerpts.some((row) => row.text.includes('上海'))).toBe(
        false,
      );
      await expect(
        withMemoryTransaction((db) =>
          insertMemoryItem(db, {
            scope: a.scope,
            content: '我住在上海。',
            kind: 'fact',
            factKey: 'residence',
            origin: 'automatic',
            source,
            quote: '我住在上海。',
          }),
        ),
      ).rejects.toThrow();
    });

    it('merges a duplicate update while actually superseding the edited item', async () => {
      const first = await createManualMemory('owner', {
        content: '我喜欢长回答。',
        kind: 'preference',
      });
      const second = await createManualMemory('owner', {
        content: '我喜欢短回答。',
        kind: 'preference',
      });
      const pending = await turn('session-a', first.content);
      const pendingSource = (await getCurrentMemorySource(
        (
          await getDbPool().query(
            'SELECT id FROM memory_sources WHERE message_id=$1',
            [pending.messageId],
          )
        ).rows[0].id,
      ))!;
      const changed = await updateManualMemory('owner', first.id, {
        content: second.content,
        revision: first.revision,
      });
      expect(changed.content).toBe(second.content);
      const active = await listMemory('owner');
      expect(
        active.items.filter((item) => item.content.includes('回答')),
      ).toHaveLength(1);
      expect(active.items.some((item) => item.content === first.content)).toBe(
        false,
      );
      const oldSource = (
        await getDbPool().query<{ source_id: string }>(
          'SELECT source_id FROM memory_evidence WHERE item_id=$1',
          [first.id],
        )
      ).rows[0];
      await forgetManualMemory('owner', changed.id, changed.revision);
      expect(
        (await getCurrentMemorySource(oldSource.source_id))?.content ?? '',
      ).not.toContain('长回答');
      await expect(
        withMemoryTransaction((db) =>
          insertMemoryItem(db, {
            scope: pending.scope,
            content: first.content,
            kind: 'preference',
            origin: 'automatic',
            source: pendingSource,
            quote: first.content,
          }),
        ),
      ).rejects.toThrow('被用户排除');
    });

    it('revokes old learning and read snapshots across clear, preserving Soul unless explicitly selected', async () => {
      await getDbPool().query(
        "UPDATE users SET soul_content='手工固定设定' WHERE id='owner'",
      );
      const a = await turn('session-a', '我准备考研。');
      const source = (
        await getDbPool().query<{ id: string }>(
          'SELECT id FROM memory_sources WHERE message_id=$1',
          [a.messageId],
        )
      ).rows[0];
      const original = (await getCurrentMemorySource(source.id))!;
      const settings = await clearMemory('owner', true);
      expect(settings.epoch).toBe(a.scope.epoch + 1);
      expect(
        (
          await getDbPool().query(
            "SELECT soul_content FROM users WHERE id='owner'",
          )
        ).rows[0].soul_content,
      ).toBe('手工固定设定');
      expect(
        (
          await getDbPool().query(
            "SELECT memory_context_generation FROM chat_sessions WHERE id='session-a'",
          )
        ).rows[0].memory_context_generation,
      ).toBe(1);
      await expect(prepare(a.scope, 'session-a')).rejects.toMatchObject({
        code: 'MEMORY.REVOKED',
      });
      await expect(
        withMemoryTransaction((db) =>
          insertMemoryItem(db, {
            scope: a.scope,
            content: '我准备考研。',
            kind: 'plan',
            origin: 'automatic',
            source: original,
            quote: '我准备考研。',
          }),
        ),
      ).rejects.toThrow();
    });

    it('does not resume old learning after an off/on cycle and still permits direct user edits', async () => {
      const a = await turn('session-a', '我在准备考试。');
      await getDbPool().query(
        "UPDATE memory_jobs SET state='running',lease_token='old-lease',lease_until=clock_timestamp()+interval '1 minute' WHERE request_id=$1",
        [a.requestId],
      );
      let settings = (await listMemory('owner')).settings;
      settings = await updateMemorySettings('owner', {
        revision: settings.revision,
        learning_enabled: false,
        chat_editing_enabled: false,
      });
      settings = await updateMemorySettings('owner', {
        revision: settings.revision,
        learning_enabled: true,
      });
      expect(settings.learning_enabled).toBe(true);
      // Switching off cancelled the in-flight job and cleared its lease, so it can never apply.
      expect(
        (
          await getDbPool().query(
            'SELECT state,lease_token,error_code FROM memory_jobs WHERE request_id=$1',
            [a.requestId],
          )
        ).rows,
      ).toEqual([
        {
          state: 'cancelled',
          lease_token: null,
          error_code: 'LEARNING_CHANGED',
        },
      ]);
      expect(await claimMemoryJobs(await getMemoryRuntimePolicy(), 10)).toEqual(
        [],
      );
      const manual = await createManualMemory('owner', {
        content: '手动保存的信息。',
      });
      expect(manual.content).toBe('手动保存的信息。');
      expect((await listMemory('owner')).settings.chat_editing_enabled).toBe(
        false,
      );
    });

    it('requires the admitted execution and preserves mutation idempotency without storing read bodies', async () => {
      const a = await turn('session-a', '请记住我喜欢简短回答。');
      await getDbPool().query(
        "UPDATE agent_requests SET state='running' WHERE request_id=$1",
        [a.requestId],
      );
      const request = {
        rpcId: randomUUID(),
        requestId: a.requestId,
        executionId: a.executionId,
        operation: {
          mode: 'remember' as const,
          content: '我喜欢简短回答。',
          kind: 'preference' as const,
          toolCallId: 'tool-call',
        },
      };
      const result = await executeMemoryOperation('web:owner', request);
      expect(result.ok).toBe(true);
      expect(await executeMemoryOperation('web:owner', request)).toEqual(
        result,
      );
      expect((await listMemory('owner')).items).toHaveLength(1);
      await expect(
        executeMemoryOperation('web:other', request),
      ).rejects.toThrow();
      const receipts = (
        await getDbPool().query('SELECT result FROM memory_tool_results')
      ).rows;
      expect(JSON.stringify(receipts)).not.toContain('简短回答');
      if (result.ok && result.mode === 'remember')
        expect(
          (await getMemoryEvidence('owner', result.reference.id)).evidence[0]
            .quote,
        ).toBe('我喜欢简短回答。');
    });

    it('reserves platform budget atomically, binds job leases, and settles once', async () => {
      const scope = await ownerMemorySnapshot('owner');
      const policy = {
        ...DEFAULT_MEMORY_RUNTIME_POLICY,
        daily_token_budget: 100,
      };
      const attempts = await Promise.allSettled(
        Array.from({ length: 3 }, () =>
          reserveMemoryBudget({
            ownerUserId: 'owner',
            purpose: 'memory.extract',
            tokens: 60,
            policy,
          }),
        ),
      );
      const accepted = attempts.filter(
        (result) => result.status === 'fulfilled',
      );
      expect(accepted).toHaveLength(1);
      if (accepted[0].status !== 'fulfilled') throw new Error('No reservation');
      const reservation = accepted[0].value;
      const usage = {
        purpose: 'memory.extract',
        modelConfigId: 'synthetic',
        model: 'synthetic',
        durationMs: 1,
        usage: { inputTokens: 20, outputTokens: 10 },
      };
      await Promise.all([
        settleMemoryBudget(reservation, usage),
        settleMemoryBudget(reservation, usage),
      ]);
      expect(
        (
          await getDbPool().query(
            "SELECT used_tokens,reserved_tokens FROM memory_daily_budgets WHERE purpose='language'",
          )
        ).rows[0],
      ).toEqual({ used_tokens: '30', reserved_tokens: '0' });
      expect(
        (
          await getDbPool().query(
            'SELECT count(*)::int AS count FROM memory_usage',
          )
        ).rows[0].count,
      ).toBe(1);
      await expect(
        reserveMemoryBudget({
          ownerUserId: scope.ownerUserId,
          purpose: 'memory.extract',
          tokens: 1,
          policy,
          jobId: 'missing',
          jobLeaseToken: 'missing',
        }),
      ).rejects.toThrow();
    });

    it('retains full supporting evidence when one of multiple sources is excluded', async () => {
      const a = await turn('session-a', '我喜欢咖啡。');
      const b = await turn('session-b', '我喜欢咖啡。');
      const sources = (
        await getDbPool().query<{ id: string }>(
          'SELECT id FROM memory_sources WHERE message_id=ANY($1::text[])',
          [[a.messageId, b.messageId]],
        )
      ).rows;
      let itemId = '';
      for (const ref of sources) {
        const source = (await getCurrentMemorySource(ref.id))!;
        const item = await withMemoryTransaction((db) =>
          insertMemoryItem(db, {
            scope: a.scope,
            content: '我喜欢咖啡。',
            kind: 'preference',
            origin: 'automatic',
            source,
            quote: '我喜欢咖啡。',
          }),
        );
        itemId = item.id;
      }
      const { excludeMemorySource } = await import('#modules/memory/service');
      await excludeMemorySource('owner', sources[0].id);
      const found = await search(b.scope, '咖啡');
      expect(
        refs(found).some((ref) => ref.kind === 'item' && ref.id === itemId),
      ).toBe(true);
      expect((await getMemoryEvidence('owner', itemId)).evidence).toHaveLength(
        1,
      );
    });

    it('updates one canonical owner fact across web and explicitly shared owner WeChat, preserving source provenance', async () => {
      const web = await turn('session-a', '我住在北京。');
      const firstSource = (await getCurrentMemorySource(
        (
          await getDbPool().query(
            'SELECT id FROM memory_sources WHERE message_id=$1',
            [web.messageId],
          )
        ).rows[0].id,
      ))!;
      const first = await withMemoryTransaction((db) =>
        insertMemoryItem(db, {
          scope: web.scope,
          content: '我住在北京。',
          kind: 'fact',
          factKey: 'residence',
          origin: 'automatic',
          source: firstSource,
          quote: '我住在北京。',
        }),
      );
      const metadata = {
        source_channel: 'wechat',
        wechat_account_id: 'synthetic-owner',
        sender_hash: 'verified-owner',
      };
      const discovery = await turn('session-b', '你好。', metadata);
      await updateMemoryScopeBinding('owner', discovery.scope.scopeId, {
        speaker_subject_id: 'self:owner',
        share_subject_memory: true,
        revision: 1,
      });
      const shared = await turn('session-b', '我住在深圳。', metadata);
      expect(shared.scope.scopeId).not.toBe(web.scope.scopeId);
      expect(shared.scope.memorySpaceId).toBe(web.scope.scopeId);
      const sharedSource = (await getCurrentMemorySource(
        (
          await getDbPool().query(
            'SELECT id FROM memory_sources WHERE message_id=$1',
            [shared.messageId],
          )
        ).rows[0].id,
      ))!;
      const latest = await withMemoryTransaction((db) =>
        insertMemoryItem(db, {
          scope: shared.scope,
          content: '我住在深圳。',
          kind: 'fact',
          factKey: 'residence',
          origin: 'automatic',
          source: sharedSource,
          quote: '我住在深圳。',
        }),
      );
      expect(latest.family_id).toBe(first.family_id);
      expect(latest.revision).toBe(2);
      const current = await turn('session-a', '我住在哪里？');
      const hydrated = await search(current.scope, '住');
      expect(hydrated.excerpts.some((row) => row.text.includes('深圳'))).toBe(
        true,
      );
      expect(
        hydrated.excerpts.some(
          (row) => row.reference.kind === 'item' && row.text.includes('北京'),
        ),
      ).toBe(false);
      const listed = await listMemory('owner', {
        scopeId: shared.scope.scopeId,
      });
      expect(
        listed.items.some(
          (row) => row.id === latest.id && row.scope_name?.includes('微信'),
        ),
      ).toBe(true);
      expect(
        (await getMemoryEvidence('owner', latest.id)).evidence[0].scope_id,
      ).toBe(shared.scope.scopeId);
    });

    it('shares only authorized client proof spans and refuses writes to the owner canonical store', async () => {
      await getDbPool().query(
        "UPDATE chat_sessions SET client_id='client' WHERE id='session-a'",
      );
      const owner = await turn(
        'session-a',
        '这是账号主人的私人事项。客户目前住在杭州。',
      );
      const source = (await getCurrentMemorySource(
        (
          await getDbPool().query(
            'SELECT id FROM memory_sources WHERE message_id=$1',
            [owner.messageId],
          )
        ).rows[0].id,
      ))!;
      const fact = await withMemoryTransaction((db) =>
        insertMemoryItem(db, {
          scope: owner.scope,
          content: '客户目前住在杭州。',
          origin: 'automatic',
          source,
          quote: '客户目前住在杭州。',
        }),
      );
      const metadata = {
        source_channel: 'wechat',
        wechat_account_id: 'synthetic-client',
        sender_hash: 'client-sender',
      };
      const discovery = await turn('session-b', '你好。', metadata);
      await updateMemoryScopeBinding('owner', discovery.scope.scopeId, {
        speaker_subject_id: 'client:client',
        share_subject_memory: true,
        revision: 1,
      });
      const shared = await turn('session-b', '我的资料是什么？', metadata);
      const hydrated = await read(shared.scope, [
        { kind: 'item', id: fact.id, revision: fact.revision },
        { kind: 'source', id: source.id, revision: source.revision },
      ]);
      expect(hydrated.excerpts.some((row) => row.text.includes('杭州'))).toBe(
        true,
      );
      expect(JSON.stringify(hydrated)).not.toContain('私人事项');
      expect((await search(shared.scope, '私人事项')).excerpts).toEqual([]);
      expect(
        hydrated.excerpts.find((row) => row.reference.kind === 'source')
          ?.sourceSessionId,
      ).toBeUndefined();
      await getDbPool().query(
        "UPDATE agent_requests SET state='running' WHERE request_id=$1",
        [shared.requestId],
      );
      await expect(
        executeMemoryOperation('web:owner', {
          rpcId: randomUUID(),
          requestId: shared.requestId,
          executionId: shared.executionId,
          operation: {
            mode: 'update',
            id: fact.id,
            revision: fact.revision,
            content: '改成其他内容。',
            toolCallId: 'client-edit',
          },
        }),
      ).rejects.toThrow('只能修改自己的记忆');
    });

    it('keeps a former shared-owner source private after the same actor becomes a shared client', async () => {
      const metadata = {
        source_channel: 'wechat',
        wechat_account_id: 'synthetic-switch',
        sender_hash: 'same-sender',
      };
      const discovery = await turn('session-a', '你好。', metadata);
      await updateMemoryScopeBinding('owner', discovery.scope.scopeId, {
        speaker_subject_id: 'self:owner',
        share_subject_memory: true,
        revision: 1,
      });
      await getDbPool().query(
        "UPDATE chat_sessions SET client_id='client' WHERE id='session-a'",
      );
      const previous = await turn(
        'session-a',
        '这是账号主人的私人事项。客户目前住在杭州。',
        metadata,
      );
      const source = (await getCurrentMemorySource(
        (
          await getDbPool().query(
            'SELECT id FROM memory_sources WHERE message_id=$1',
            [previous.messageId],
          )
        ).rows[0].id,
      ))!;
      await withMemoryTransaction((db) =>
        insertMemoryItem(db, {
          scope: previous.scope,
          content: '客户目前住在杭州。',
          origin: 'automatic',
          source,
          quote: '客户目前住在杭州。',
        }),
      );
      await updateMemoryScopeBinding('owner', discovery.scope.scopeId, {
        speaker_subject_id: 'client:client',
        share_subject_memory: true,
        revision: 2,
      });
      const shared = await turn('session-a', '我的资料。', metadata);
      expect(shared.scope.scopeId).toBe(previous.scope.scopeId);
      expect(shared.scope.memorySpaceId).not.toBe(previous.scope.memorySpaceId);
      const proof = await read(shared.scope, [
        { kind: 'source', id: source.id, revision: source.revision },
      ]);
      expect(proof.excerpts.some((row) => row.text.includes('杭州'))).toBe(
        true,
      );
      expect(JSON.stringify(proof)).not.toContain('私人事项');
      expect((await search(shared.scope, '私人事项')).excerpts).toEqual([]);
      await updateMemoryScopeBinding('owner', discovery.scope.scopeId, {
        speaker_subject_id: 'client:client',
        share_subject_memory: false,
        revision: 3,
      });
      const privateClient = await turn('session-a', '我的资料。', metadata);
      expect(
        (
          await read(privateClient.scope, [
            { kind: 'source', id: source.id, revision: source.revision },
          ])
        ).excerpts,
      ).toEqual([]);
    });

    it('masks every repeated forgotten quote and revokes overlapping unsupported evidence', async () => {
      const a = await turn('session-a', '我住在上海。我喜欢咖啡。我住在上海。');
      const source = (await getCurrentMemorySource(
        (
          await getDbPool().query(
            'SELECT id FROM memory_sources WHERE message_id=$1',
            [a.messageId],
          )
        ).rows[0].id,
      ))!;
      const [fact, overlap, coffee] = await withMemoryTransaction(
        async (db) => [
          await insertMemoryItem(db, {
            scope: a.scope,
            content: '我住在上海。',
            origin: 'automatic',
            source,
            quote: '我住在上海。',
          }),
          await insertMemoryItem(db, {
            scope: a.scope,
            content: '我住在上海。我喜欢咖啡。',
            origin: 'automatic',
            source,
            quote: '我住在上海。我喜欢咖啡。',
          }),
          await insertMemoryItem(db, {
            scope: a.scope,
            content: '我喜欢咖啡。',
            kind: 'preference',
            origin: 'automatic',
            source,
            quote: '我喜欢咖啡。',
          }),
        ],
      );
      await forgetManualMemory('owner', fact.id, fact.revision);
      const visible = (await getCurrentMemorySource(source.id))!;
      expect(visible.content).not.toContain('上海');
      expect(visible.content).toContain('我喜欢咖啡。');
      const hydrated = await read(a.scope, [
        { kind: 'item', id: overlap.id, revision: overlap.revision },
        { kind: 'item', id: coffee.id, revision: coffee.revision },
        { kind: 'source', id: source.id, revision: source.revision },
      ]);
      expect(JSON.stringify(hydrated)).not.toContain('上海');
      expect(hydrated.excerpts.some((row) => row.text.includes('咖啡'))).toBe(
        true,
      );
      await getDbPool().query('DELETE FROM memory_sources WHERE id=$1', [
        source.id,
      ]);
      expect(
        (
          await getDbPool().query(
            'SELECT count(*)::int AS n FROM memory_exclusions WHERE source_ref=$1',
            [source.source_ref],
          )
        ).rows[0].n,
      ).toBeGreaterThan(0);
    });

    it('preserves source exclusion after physical deletion and reimport of the same message', async () => {
      const a = await turn('session-a', '这条来源必须排除。');
      const source = (await getCurrentMemorySource(
        (
          await getDbPool().query(
            'SELECT id FROM memory_sources WHERE message_id=$1',
            [a.messageId],
          )
        ).rows[0].id,
      ))!;
      const { excludeMemorySource } = await import('#modules/memory/service');
      await excludeMemorySource('owner', source.id);
      await getDbPool().query('DELETE FROM memory_sources WHERE id=$1', [
        source.id,
      ]);
      const { captureMemorySource } =
        await import('#modules/memory/repository');
      const reimported = await withMemoryTransaction((db) =>
        captureMemorySource(db, {
          scope: a.scope,
          requestId: a.requestId,
          messageId: a.messageId,
          accountId: 'web:owner',
          sessionId: 'session-a',
          content: a.input.userMessage,
          observedAt: new Date().toISOString(),
          backfillJobId: 'synthetic-import',
        }),
      );
      expect(reimported?.learning_enabled).toBe(false);
      expect(await getCurrentMemorySource(source.id)).toBeNull();
    });

    it('separates durable frame continuity per audience and resets each context without restoring stale history', async () => {
      const owner = await turn('session-a', 'owner ordinary history');
      const guest = await turn('session-a', 'guest ordinary history', {
        source_channel: 'wechat',
        wechat_account_id: 'synthetic',
        sender_hash: 'guest',
      });
      const save = async (admitted: typeof owner) => {
        const snapshot = {
          persisted: true,
          provider: 'synthetic',
          model: 'synthetic',
          userPrompt: 'synthetic',
          systemPrompt: 'synthetic',
          appendSystemPrompt: [],
          allowedTools: [],
          readableSkills: [],
          contextGeneration: admitted.scope.contextGeneration,
          contextAudience: admitted.scope.contextAudience,
          messageCount: 1,
          messages: [{ role: 'user', content: admitted.input.userMessage }],
        };
        const frame = createPiSessionFrame(snapshot);
        await storePiSessionFrame(
          getDbPool(),
          admitted.requestId,
          'session-a',
          'web:owner',
          frame,
        );
        return frame;
      };
      const ownerFrame = await save(owner);
      await save(guest);
      const ownerBase = (await getPiSessionBase('session-a', 'web:owner'))!;
      const guestBase = (await getPiSessionBase(
        'session-a',
        'web:owner',
        guest.scope.contextAudience,
      ))!;
      expect(ownerBase.requestId).toBe(owner.requestId);
      expect(guestBase.requestId).toBe(guest.requestId);
      expect(
        JSON.stringify(
          await getPiSessionSnapshot(guestBase.requestId, 'web:owner'),
        ),
      ).not.toContain('owner ordinary history');
      expect(
        (
          await readMemoryPiContext(
            'session-a',
            'owner',
            guest.scope.contextAudience,
          )
        ).initialized,
      ).toBe(true);
      await clearMemory('owner', true);
      expect(await getPiSessionBase('session-a', 'web:owner')).toBeUndefined();
      expect(
        await getPiSessionBase(
          'session-a',
          'web:owner',
          guest.scope.contextAudience,
        ),
      ).toBeUndefined();
      const current = await readMemoryPiContext('session-a', 'owner');
      expect(current).toMatchObject({
        initialized: false,
        contextGeneration: 1,
      });
      await storePiSessionFrame(
        getDbPool(),
        owner.requestId,
        'session-a',
        'web:owner',
        ownerFrame,
      );
      expect(
        (await readMemoryPiContext('session-a', 'owner')).initialized,
      ).toBe(false);
      const staleInput = {
        ...owner.input,
        userMessageId: 'stale-message',
        messageToPersist: {
          ...owner.input.messageToPersist!,
          id: 'stale-message',
        },
      };
      await expect(
        admitAgentRequest({
          input: staleInput,
          requestId: 'stale-request',
          ownerUserId: 'owner',
          runtime,
          deadlineAt: Date.now() + 60000,
        }),
      ).rejects.toThrow('上下文已变化');
      expect(
        (
          await getDbPool().query(
            "SELECT 1 FROM messages WHERE id='stale-message'",
          )
        ).rowCount,
      ).toBe(0);
    });

    it('accepts remember evidence only from a user message of the current session and audience', async () => {
      const elsewhere = await turn('session-b', '我对花生过敏。');
      const a = await turn('session-a', '请记住我对花生过敏。');
      await getDbPool().query(
        "UPDATE agent_requests SET state='running' WHERE request_id=$1",
        [a.requestId],
      );
      const remember = (toolCallId: string, sourceMessageId?: string) =>
        executeMemoryOperation('web:owner', {
          rpcId: randomUUID(),
          requestId: a.requestId,
          executionId: a.executionId,
          operation: {
            mode: 'remember',
            content: '我对花生过敏。',
            toolCallId,
            ...(sourceMessageId ? { sourceMessageId } : {}),
          },
        });
      await expect(
        remember('other-session', elsewhere.messageId),
      ).rejects.toMatchObject({ code: 'MEMORY.EVIDENCE_REQUIRED' });
      expect(await remember('own-message')).toMatchObject({
        ok: true,
        mode: 'remember',
      });
    });

    it('never lets automatic extraction supersede a manual fact, by proposal or by duplicate merge', async () => {
      const manual = await createManualMemory('owner', {
        content: '我住在北京。',
        kind: 'fact',
      });
      const a = await turn('session-a', '我住在上海。');
      const source = (await getCurrentMemorySource(
        (
          await getDbPool().query(
            'SELECT id FROM memory_sources WHERE message_id=$1',
            [a.messageId],
          )
        ).rows[0].id,
      ))!;
      const extracted = () =>
        withMemoryTransaction((db) =>
          insertMemoryItem(db, {
            scope: a.scope,
            content: '我住在上海。',
            kind: 'fact',
            origin: 'automatic',
            source,
            quote: '我住在上海。',
            supersedesId: manual.id,
          }),
        );
      const first = await extracted();
      const duplicate = await extracted();
      expect(duplicate.id).toBe(first.id);
      expect(
        (
          await getDbPool().query(
            'SELECT status,merged_into_id FROM memory_items WHERE id=$1',
            [manual.id],
          )
        ).rows[0],
      ).toEqual({ status: 'active', merged_into_id: null });
    });

    it('does not let a shared client sender read another sender private space', async () => {
      await getDbPool().query(
        "UPDATE chat_sessions SET client_id='client' WHERE id IN ('session-a','session-b')",
      );
      const other = await turn('session-a', '客户喜欢喝茶。', {
        source_channel: 'wechat',
        wechat_account_id: 'synthetic-account',
        sender_hash: 'private-sender',
      });
      const source = (await getCurrentMemorySource(
        (
          await getDbPool().query(
            'SELECT id FROM memory_sources WHERE message_id=$1',
            [other.messageId],
          )
        ).rows[0].id,
      ))!;
      const privateFact = await withMemoryTransaction((db) =>
        insertMemoryItem(db, {
          scope: other.scope,
          content: '客户喜欢喝茶。',
          origin: 'automatic',
          source,
          quote: '客户喜欢喝茶。',
        }),
      );
      const metadata = {
        source_channel: 'wechat',
        wechat_account_id: 'synthetic-account',
        sender_hash: 'shared-client',
      };
      const discovery = await turn('session-b', '你好。', metadata);
      await updateMemoryScopeBinding('owner', discovery.scope.scopeId, {
        speaker_subject_id: 'client:client',
        share_subject_memory: true,
        revision: 1,
      });
      const shared = await turn('session-b', '我喜欢喝什么？', metadata);
      expect(
        (
          await read(shared.scope, [
            {
              kind: 'item',
              id: privateFact.id,
              revision: privateFact.revision,
            },
          ])
        ).excerpts,
      ).toEqual([]);
      expect((await search(shared.scope, '喝茶')).excerpts).toEqual([]);
    });

    it('keeps chatting with an archived client or inactive binding, with memory off for that turn', async () => {
      await getDbPool().query(
        "UPDATE chat_sessions SET client_id='client' WHERE id='session-a'",
      );
      const metadata = {
        source_channel: 'wechat',
        wechat_account_id: 'synthetic-account',
        sender_hash: 'bound-sender',
      };
      const discovery = await turn('session-b', '你好。', metadata);
      await updateMemoryScopeBinding('owner', discovery.scope.scopeId, {
        speaker_subject_id: 'client:client',
        share_subject_memory: true,
        revision: 1,
      });
      await getDbPool().query(
        "UPDATE client_profiles SET deleted_at=clock_timestamp() WHERE id='client'",
      );
      const archived = await turn('session-a', '继续上次的话题。');
      expect(archived.scope).toMatchObject({
        subjectId: 'client:client',
        learningEnabled: false,
        recallEnabled: false,
        chatEditingEnabled: false,
      });
      const unbound = await turn('session-b', '继续上次的话题。', metadata);
      expect(unbound.scope).toMatchObject({
        learningEnabled: false,
        recallEnabled: false,
        ownerAudience: false,
      });
      expect(
        (
          await getDbPool().query(
            'SELECT count(*)::int AS n FROM messages WHERE id=ANY($1::text[])',
            [[archived.messageId, unbound.messageId]],
          )
        ).rows[0].n,
      ).toBe(2);
      expect(
        (
          await getDbPool().query(
            'SELECT count(*)::int AS n FROM memory_jobs WHERE request_id=ANY($1::text[])',
            [[archived.requestId, unbound.requestId]],
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it('prepares one turn through the host path and drops the oldest supplied references over the cap', async () => {
      await getDbPool().query(
        `UPDATE runtime_config SET memory_policy=memory_policy||'{"recall_max_results":1,"recall_token_budget":100000}'::jsonb WHERE id='default'`,
      );
      const long = await createManualMemory('owner', {
        content: '甲'.repeat(2000),
      });
      const a = await turn('session-a', '继续。');
      await getDbPool().query(
        "UPDATE agent_requests SET state='running' WHERE request_id=$1",
        [a.requestId],
      );
      const page = (offset: number) => ({
        kind: 'item' as const,
        id: long.id,
        revision: long.revision,
        offset,
        limit: 400,
      });
      const result = await executeMemoryOperation('web:owner', {
        rpcId: randomUUID(),
        requestId: a.requestId,
        executionId: a.executionId,
        operation: {
          mode: 'prepare',
          references: [400, 800, 1200, 1600, 1800].map(page),
        },
      });
      if (!result.ok || result.mode !== 'prepare')
        throw new Error('Synthetic prepare failed');
      const offsets = result.hydration.excerpts
        .filter((excerpt) => !excerpt.automatic)
        .map((excerpt) => excerpt.reference.offset);
      expect(offsets).toEqual([1200, 1600, 1800]);
      await updateMemorySettings('owner', {
        revision: (await listMemory('owner')).settings.revision,
        recall_enabled: false,
      });
      const disabled = await turn('session-b', '再继续。');
      await getDbPool().query(
        "UPDATE agent_requests SET state='running' WHERE request_id=$1",
        [disabled.requestId],
      );
      expect(
        await executeMemoryOperation('web:owner', {
          rpcId: randomUUID(),
          requestId: disabled.requestId,
          executionId: disabled.executionId,
          operation: { mode: 'prepare', references: [] },
        }),
      ).toMatchObject({
        ok: true,
        mode: 'prepare',
        hydration: { status: 'disabled', excerpts: [] },
      });
    });
  },
);
