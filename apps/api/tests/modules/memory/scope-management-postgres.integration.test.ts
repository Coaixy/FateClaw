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
import type { MemoryRequestScope } from '@fateclaw/contracts/memory';
import { initDbPool, getDbPool, closeDbPool } from '#infrastructure/db-pool';
import { crossConversationMemoryMigration } from '#infrastructure/migrations/versions/0102-cross-conversation-memory';
import { durableAgentRequestsMigration } from '#infrastructure/migrations/versions/0076-durable-agent-requests';
import {
  listMemoryScopes,
  updateMemoryScopeBinding,
} from '#modules/memory/scope-management';
import {
  assertMemoryBindingCurrent,
  captureMemorySource,
  createMemoryAdmissionScope,
  insertMemoryItem,
  queueMemoryJob,
  withMemoryTransaction,
} from '#modules/memory/repository';

vi.mock('#infrastructure/env', () => ({ readEnvFile: () => ({}) }));

const connectionString = process.env.FATECLAW_TEST_MEMORY_SCOPES_DATABASE_URL;
const schema = `scope_binding_test_${randomUUID().replace(/-/g, '')}`;
let administrator: pg.Pool | undefined;
let schemaCreated = false;

describe.skipIf(!connectionString)(
  'memory scope binding PostgreSQL integration',
  () => {
    beforeAll(async () => {
      const target = new URL(connectionString!);
      if (
        !['127.0.0.1', 'localhost'].includes(target.hostname) ||
        target.pathname !== '/memory_test'
      )
        throw new Error(
          'Scope binding integration requires an explicitly disposable local memory_test database',
        );
      administrator = new pg.Pool({
        connectionString,
        connectionTimeoutMillis: 5000,
      });
      await administrator.query(`CREATE SCHEMA ${schema}`);
      schemaCreated = true;
      target.searchParams.set('options', `-c search_path=${schema},public`);
      const db = initDbPool(target.toString());
      await db.query(`
      CREATE TABLE users(id text PRIMARY KEY,soul_content text NOT NULL DEFAULT '',soul_edit_enabled boolean NOT NULL DEFAULT true);
      CREATE TABLE accounts(id text PRIMARY KEY,owner_id text REFERENCES users(id),soul_content text DEFAULT '',enabled boolean DEFAULT true,created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE client_profiles(id text PRIMARY KEY,user_id text REFERENCES users(id),name text NOT NULL,deleted_at timestamptz);
      CREATE TABLE chat_sessions(id text PRIMARY KEY,user_id text REFERENCES users(id),account_id text NOT NULL,client_id text REFERENCES client_profiles(id),deleted_at timestamptz);
      CREATE TABLE messages(id text NOT NULL,account_id text NOT NULL,session_id text REFERENCES chat_sessions(id),content text NOT NULL,timestamp timestamptz NOT NULL,deleted_at timestamptz,metadata jsonb,is_bot_message boolean DEFAULT false,PRIMARY KEY(id,account_id));
      CREATE TABLE runtime_config(id text PRIMARY KEY,revision integer NOT NULL DEFAULT 1,updated_at timestamptz DEFAULT clock_timestamp());
      INSERT INTO runtime_config(id) VALUES('default');
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
    });

    beforeEach(async () => {
      await getDbPool().query(`TRUNCATE ${schema}.users CASCADE`);
      await getDbPool().query(`
      INSERT INTO users(id) VALUES('owner'),('other');
      INSERT INTO client_profiles(id,user_id,name,deleted_at) VALUES('active-client','owner','命主甲',NULL),('deleted-client','owner','已归档命主',clock_timestamp()),('foreign-client','other','其他账号命主',NULL);
      INSERT INTO chat_sessions(id,user_id,account_id) VALUES('web-session','owner','web:owner'),('wechat-session','owner','web:owner');
    `);
    });

    afterAll(async () => {
      try {
        await closeDbPool();
      } finally {
        if (schemaCreated)
          await administrator?.query(`DROP SCHEMA ${schema} CASCADE`);
        await administrator?.end();
      }
    });

    const admit = (sender?: string) =>
      withMemoryTransaction((db) =>
        createMemoryAdmissionScope(db, {
          ownerUserId: 'owner',
          sessionId: sender ? 'wechat-session' : 'web-session',
          ...(sender
            ? {
                metadata: {
                  source_channel: 'wechat',
                  wechat_account_id: 'synthetic-account',
                  sender_hash: sender,
                },
              }
            : {}),
        }),
      );
    const binding = (speaker: string | null, revision = 1, share = false) => ({
      speaker_subject_id: speaker,
      share_subject_memory: share,
      revision,
    });

    it('lists friendly scope names and active owned subjects without exposing sender identifiers or creating client entities', async () => {
      const web = await admit();
      const first = await admit('SYNTHETIC_RAW_SENDER_HASH_ONE');
      const second = await admit('SYNTHETIC_RAW_SENDER_HASH_TWO');
      const result = await listMemoryScopes('owner');
      expect(result.scopes).toEqual([
        {
          id: web.scopeId,
          channel: 'web',
          display_name: '网页对话',
          speaker_subject_id: 'self:owner',
          share_subject_memory: false,
          binding_revision: 1,
        },
        {
          id: first.scopeId,
          channel: 'wechat',
          display_name: '微信联系人 1',
          speaker_subject_id: null,
          share_subject_memory: false,
          binding_revision: 1,
        },
        {
          id: second.scopeId,
          channel: 'wechat',
          display_name: '微信联系人 2',
          speaker_subject_id: null,
          share_subject_memory: false,
          binding_revision: 1,
        },
      ]);
      expect(result.subjects).toEqual(
        expect.arrayContaining([
          { id: 'self:owner', kind: 'self', name: '用户本人' },
          { id: 'client:active-client', kind: 'client', name: '命主甲' },
        ]),
      );
      expect(result.subjects).toHaveLength(2);
      expect(JSON.stringify(result)).not.toContain('SYNTHETIC_RAW_SENDER_HASH');
      expect(JSON.stringify(result)).not.toContain('actor_key');
      expect(
        (
          await getDbPool().query(
            "SELECT id FROM memory_entities WHERE id='client:active-client'",
          )
        ).rows,
      ).toEqual([]);
    });

    it('rejects foreign owners, foreign or deleted clients, unknown senders and sharing without a binding', async () => {
      const scope = await admit('synthetic-sender');
      await expect(
        updateMemoryScopeBinding('other', scope.scopeId, binding('self:other')),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: 'MEMORY.SCOPE_MISSING',
      });
      for (const subject of [
        'client:foreign-client',
        'client:deleted-client',
        scope.subjectId,
      ])
        await expect(
          updateMemoryScopeBinding('owner', scope.scopeId, binding(subject)),
        ).rejects.toMatchObject({
          statusCode: 403,
          code: 'MEMORY.SUBJECT_INACTIVE',
        });
      await expect(
        updateMemoryScopeBinding(
          'owner',
          scope.scopeId,
          binding(null, 1, true),
        ),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'MEMORY.BINDING_REQUIRED',
      });
      expect(
        (await listMemoryScopes('owner')).scopes.find(
          (row) => row.id === scope.scopeId,
        )?.binding_revision,
      ).toBe(1);
    });

    it('keeps the web speaker fixed to the owner and gives explicit WeChat bindings a separate sharing switch', async () => {
      const web = await admit();
      for (const request of [
        binding(null),
        binding('client:active-client'),
        binding('self:owner', 1, true),
      ])
        await expect(
          updateMemoryScopeBinding('owner', web.scopeId, request),
        ).rejects.toMatchObject({ code: 'MEMORY.WEB_BINDING_FIXED' });
      const sender = await admit('synthetic-sender');
      const first = await updateMemoryScopeBinding('owner', sender.scopeId, {
        ...binding('client:active-client'),
        display_name: ' 合成联系人 ',
      });
      expect(first).toMatchObject({
        display_name: '合成联系人',
        speaker_subject_id: 'client:active-client',
        share_subject_memory: false,
        binding_revision: 2,
      });
      const next = await admit('synthetic-sender');
      expect(next).toMatchObject({
        speakerSubjectId: 'client:active-client',
        bindingRevision: 2,
        ownerMemoryAccess: false,
      });
      const shared = await updateMemoryScopeBinding(
        'owner',
        sender.scopeId,
        binding('client:active-client', 2, true),
      );
      expect(shared).toMatchObject({
        share_subject_memory: true,
        binding_revision: 3,
      });
      const unbound = await updateMemoryScopeBinding(
        'owner',
        sender.scopeId,
        binding(null, 3, false),
      );
      expect(unbound).toMatchObject({
        speaker_subject_id: null,
        share_subject_memory: false,
        binding_revision: 4,
      });
      expect((await admit('synthetic-sender')).speakerSubjectId).toBe(
        sender.subjectId,
      );
    });

    it('allows only one concurrent compare-and-swap update and leaves identical saves idempotent', async () => {
      const sender = await admit('synthetic-sender');
      const attempts = await Promise.allSettled([
        updateMemoryScopeBinding(
          'owner',
          sender.scopeId,
          binding('self:owner'),
        ),
        updateMemoryScopeBinding(
          'owner',
          sender.scopeId,
          binding('client:active-client'),
        ),
      ]);
      const succeeded = attempts.filter(
        (entry) => entry.status === 'fulfilled',
      );
      const failed = attempts.filter((entry) => entry.status === 'rejected');
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      if (failed[0].status === 'rejected')
        expect(failed[0].reason).toMatchObject({
          statusCode: 409,
          code: 'MEMORY.BINDING_CONFLICT',
        });
      if (succeeded[0].status !== 'fulfilled')
        throw new Error('Expected one successful binding');
      const saved = succeeded[0].value;
      expect(saved.binding_revision).toBe(2);
      expect(
        await updateMemoryScopeBinding(
          'owner',
          sender.scopeId,
          binding(
            saved.speaker_subject_id,
            saved.binding_revision,
            saved.share_subject_memory,
          ),
        ),
      ).toEqual(saved);
      await expect(assertMemoryBindingCurrent(sender)).rejects.toMatchObject({
        code: 'MEMORY.BINDING_CHANGED',
      });
    });

    async function seedSource(scope: MemoryRequestScope) {
      return withMemoryTransaction(async (db) => {
        const messageId = `synthetic-message-${randomUUID()}`;
        const content = '我喜欢简短回答。';
        await db.query(
          "INSERT INTO messages(id,account_id,session_id,content,timestamp) VALUES($1,'web:owner','wechat-session',$2,clock_timestamp())",
          [messageId, content],
        );
        const source = await captureMemorySource(db, {
          scope,
          requestId: `synthetic-request-${randomUUID()}`,
          messageId,
          accountId: 'web:owner',
          sessionId: 'wechat-session',
          content,
          observedAt: new Date().toISOString(),
        });
        if (!source) throw new Error('Synthetic source was not captured');
        const item = await insertMemoryItem(db, {
          scope,
          content,
          kind: 'preference',
          origin: 'automatic',
          source,
          quote: content,
        });
        return { source, item };
      });
    }

    it('cancels old source work without changing historical source identities, item ownership or unrelated work', async () => {
      const sender = await admit('synthetic-sender');
      const { source, item } = await seedSource(sender);
      await withMemoryTransaction((db) =>
        queueMemoryJob(db, {
          scope: sender,
          kind: 'backfill',
          eventType: 'manual_backfill',
          key: `synthetic-backfill-${randomUUID()}`,
        }),
      );
      const before = (
        await getDbPool().query(
          'SELECT subject_id,identity_snapshot,content_hash FROM memory_sources WHERE id=$1',
          [source.id],
        )
      ).rows[0];
      await getDbPool().query(
        "UPDATE memory_jobs SET state='running',lease_token='synthetic-lease',lease_until=clock_timestamp()+interval '1 minute' WHERE scope_id=$1 AND kind='extract'",
        [sender.scopeId],
      );
      await updateMemoryScopeBinding(
        'owner',
        sender.scopeId,
        binding('client:active-client'),
      );
      expect(
        (
          await getDbPool().query(
            'SELECT subject_id,identity_snapshot,content_hash FROM memory_sources WHERE id=$1',
            [source.id],
          )
        ).rows[0],
      ).toEqual(before);
      expect(
        (
          await getDbPool().query(
            'SELECT subject_id FROM memory_items WHERE id=$1',
            [item.id],
          )
        ).rows[0].subject_id,
      ).toBe(sender.subjectId);
      const jobs = (
        await getDbPool().query<{
          kind: string;
          state: string;
          lease_token: string | null;
          error_code: string | null;
        }>(
          'SELECT kind,state,lease_token,error_code FROM memory_jobs WHERE scope_id=$1 ORDER BY kind',
          [sender.scopeId],
        )
      ).rows;
      expect(jobs).toEqual([
        {
          kind: 'backfill',
          state: 'pending',
          lease_token: null,
          error_code: null,
        },
        {
          kind: 'extract',
          state: 'cancelled',
          lease_token: null,
          error_code: 'BINDING_CHANGED',
        },
      ]);
    });

    it('rolls back both the binding and new client entity when cancellation fails', async () => {
      const sender = await admit('synthetic-sender');
      await seedSource(sender);
      await getDbPool()
        .query(`CREATE FUNCTION ${schema}.reject_job_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'SYNTHETIC_CANCEL_FAILURE'; END$$;
      CREATE TRIGGER reject_binding_cancellation BEFORE UPDATE ON ${schema}.memory_jobs FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_job_cancellation()`);
      try {
        await expect(
          updateMemoryScopeBinding(
            'owner',
            sender.scopeId,
            binding('client:active-client'),
          ),
        ).rejects.toThrow('SYNTHETIC_CANCEL_FAILURE');
        const saved = (await listMemoryScopes('owner')).scopes.find(
          (row) => row.id === sender.scopeId,
        );
        expect(saved).toMatchObject({
          speaker_subject_id: null,
          share_subject_memory: false,
          binding_revision: 1,
        });
        expect(
          (
            await getDbPool().query(
              "SELECT id FROM memory_entities WHERE id='client:active-client'",
            )
          ).rows,
        ).toEqual([]);
      } finally {
        await getDbPool().query(
          `DROP TRIGGER reject_binding_cancellation ON ${schema}.memory_jobs; DROP FUNCTION ${schema}.reject_job_cancellation()`,
        );
      }
    });
  },
);
