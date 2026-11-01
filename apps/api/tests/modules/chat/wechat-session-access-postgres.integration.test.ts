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
import { getDbPool, initDbPool, closeDbPool } from '#infrastructure/db-pool';
import { crossConversationMemoryMigration } from '#infrastructure/migrations/versions/0102-cross-conversation-memory';
import {
  createMemoryAdmissionScope,
  withMemoryTransaction,
} from '#modules/memory/repository';
import {
  listWechatAccessibleSessions,
  getWechatAccessibleSession,
  ensureWechatSessionActor,
} from '#modules/chat/wechat-session-access';
import {
  buildWechatSenderHash,
  handleWechatChatCommand,
} from '#modules/chat/wechat-chat-session-service';
import { withActiveConversationRequest } from '#infrastructure/repositories/conversation-tool-repository';
import { applyClientProfilePrefill } from '#modules/chat/client-profile-service';
import type { Account } from '#shared/types';

const cache = vi.hoisted(() => new Map<string, string>());
vi.mock('#infrastructure/env', () => ({ readEnvFile: () => ({}) }));
vi.mock('#infrastructure/redis', () => ({
  getRedis: () => ({
    get: async (key: string) => cache.get(key) ?? null,
    set: async (key: string, value: string) => {
      cache.set(key, value);
      return 'OK';
    },
  }),
}));

const connectionString = process.env.FATECLAW_TEST_WECHAT_ACCESS_DATABASE_URL;
const schema = `wechat_access_test_${randomUUID().replace(/-/g, '')}`;
const account: Account = {
  id: 'bot-a',
  user_id: 'sender-a',
  owner_id: 'owner',
  name: 'Synthetic account',
  bot_token: 'synthetic-unused',
  base_url: 'https://synthetic.invalid',
  get_updates_buf: '',
  enabled: true,
  created_at: '2026-11-01T00:00:00Z',
};
const identity = (
  sender: string,
  accountId = account.id,
  userId = 'owner',
) => ({
  userId,
  accountId,
  senderHash: buildWechatSenderHash(accountId, sender),
});
const actor = (sender: string) =>
  `wechat:${account.id}:${identity(sender).senderHash}`;
let administrator: pg.Pool | undefined;
let schemaCreated = false;

describe.skipIf(!connectionString)(
  'WeChat session and conversation tool access PostgreSQL integration',
  () => {
    beforeAll(async () => {
      const target = new URL(connectionString!);
      if (
        !['127.0.0.1', 'localhost'].includes(target.hostname) ||
        target.pathname !== '/memory_test'
      )
        throw new Error(
          'WeChat access integration requires an explicitly disposable local memory_test database',
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
      CREATE TABLE accounts(id text PRIMARY KEY,owner_id text REFERENCES users(id),user_id text,enabled boolean DEFAULT true,created_at timestamptz DEFAULT clock_timestamp(),soul_content text DEFAULT '');
      CREATE TABLE client_profiles(id text PRIMARY KEY,user_id text REFERENCES users(id),name text NOT NULL,gender text,solar_date text,hour int,minute int,birthplace text,notes text,tags text[],status text,created_at timestamptz DEFAULT clock_timestamp(),updated_at timestamptz DEFAULT clock_timestamp(),deleted_at timestamptz);
      CREATE TABLE chat_sessions(id text PRIMARY KEY,user_id text REFERENCES users(id),account_id text NOT NULL,title text,client_id text REFERENCES client_profiles(id),share_token text,model_pool_key text DEFAULT 'official',created_at timestamptz DEFAULT clock_timestamp(),updated_at timestamptz DEFAULT clock_timestamp(),deleted_at timestamptz);
      CREATE TABLE messages(id text NOT NULL,account_id text NOT NULL,user_id text,session_id text REFERENCES chat_sessions(id),content text NOT NULL,timestamp timestamptz NOT NULL,is_from_me boolean,is_bot_message boolean,metadata jsonb,deleted_at timestamptz,PRIMARY KEY(id,account_id));
      CREATE TABLE runtime_config(id text PRIMARY KEY,revision int DEFAULT 1,updated_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE agent_requests(request_id text PRIMARY KEY,execution_id text,account_id text,owner_user_id text,session_id text REFERENCES chat_sessions(id),state text,cancel_requested_at timestamptz,deadline_at timestamptz);
      CREATE TABLE wechat_chat_session_links(account_id text REFERENCES accounts(id),sender_hash text,user_id text REFERENCES users(id),session_id text REFERENCES chat_sessions(id),created_at timestamptz DEFAULT clock_timestamp(),updated_at timestamptz DEFAULT clock_timestamp(),last_used_at timestamptz DEFAULT clock_timestamp(),PRIMARY KEY(account_id,sender_hash));
      INSERT INTO runtime_config(id)VALUES('default');
    `);
      const client = await db.connect();
      try {
        // The migration runner applies each version inside a transaction.
        await client.query('BEGIN');
        await crossConversationMemoryMigration.up(client);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    });
    beforeEach(async () => {
      cache.clear();
      await getDbPool().query(`TRUNCATE ${schema}.users CASCADE`);
      await getDbPool().query(`INSERT INTO users(id) VALUES('owner'),('other');
      INSERT INTO accounts(id,owner_id,user_id) VALUES('bot-a','owner','sender-a'),('bot-b','owner','different-user'),('foreign-bot','other','other');
      INSERT INTO client_profiles(id,user_id,name,gender,solar_date,hour,minute) VALUES('client-a','owner','Client A','男','1990-05-15',10,30),('client-b','owner','Client B','女','2000-06-16',11,40);
      INSERT INTO chat_sessions(id,user_id,account_id,title,client_id,created_at,updated_at) VALUES
      ('owner-private','owner','web:owner','OWNER_PRIVATE_TITLE',NULL,'2026-11-01','2030-01-01'),
      ('sender-a-own','owner','web:owner','OWNER_RENAMED_A',NULL,'2026-11-01','2026-11-02'),
      ('sender-b-own','owner','web:owner','OWNER_RENAMED_B',NULL,'2026-11-01','2026-11-02'),
      ('legacy-a','owner','web:owner','OWNER_CHANGED_LEGACY_TITLE',NULL,'2026-11-01','2026-11-02'),
      ('wrong-account-proof','owner','web:owner','WRONG_ACCOUNT_TITLE',NULL,'2026-11-01','2026-11-02'),
      ('wrong-user-proof','owner','web:owner','WRONG_USER_TITLE',NULL,'2026-11-01','2026-11-02'),
      ('foreign-session','other','web:other','FOREIGN_OWNER_TITLE',NULL,'2026-11-01','2026-11-02'),
      ('tool-session','owner','web:owner','Tool session','client-a','2026-11-01','2026-11-02');`);
      await getDbPool().query(
        "UPDATE chat_sessions SET created_actor_key=$1,created_actor_title='SENDER_A_ORIGINAL_TITLE' WHERE id='sender-a-own'",
        [actor('sender-a')],
      );
      await getDbPool().query(
        "UPDATE chat_sessions SET created_actor_key=$1,created_actor_title='SENDER_B_ORIGINAL_TITLE' WHERE id='sender-b-own'",
        [actor('sender-b')],
      );
      for (const [id, session, user, bot, content] of [
        [
          'legacy-message',
          'legacy-a',
          'owner',
          'bot-a',
          'SENDER_A_FIRST_MESSAGE_SUMMARY',
        ],
        [
          'different-account-message',
          'wrong-account-proof',
          'owner',
          'bot-b',
          'WRONG_ACCOUNT_MESSAGE',
        ],
        [
          'different-owner-message',
          'wrong-user-proof',
          'other',
          'bot-a',
          'WRONG_OWNER_MESSAGE',
        ],
      ])
        await getDbPool().query(
          "INSERT INTO messages(id,account_id,user_id,session_id,content,timestamp,is_from_me,is_bot_message,metadata) VALUES($1,'web:owner',$2,$3,$4,'2026-11-01',false,false,$5)",
          [
            id,
            user,
            session,
            content,
            JSON.stringify({
              source_channel: 'wechat',
              wechat_account_id: bot,
              sender_hash: identity('sender-a').senderHash,
            }),
          ],
        );
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

    async function shareOwner(sender = 'sender-a') {
      await ensureWechatSessionActor(identity(sender));
      await getDbPool().query(
        "UPDATE memory_scopes SET bound_subject_id='self:owner',share_subject_memory=true,binding_revision=binding_revision+1 WHERE actor_key=$1",
        [actor(sender)],
      );
    }

    it('isolates sender-created and legacy participation titles even when QR identity matches the sender', async () => {
      const a = await listWechatAccessibleSessions(identity('sender-a'), 100);
      expect(a.map((row) => row.id).sort()).toEqual([
        'legacy-a',
        'sender-a-own',
      ]);
      expect(a.find((row) => row.id === 'sender-a-own')?.title).toBe(
        'SENDER_A_ORIGINAL_TITLE',
      );
      expect(a.find((row) => row.id === 'legacy-a')?.title).toBe(
        'SENDER_A_FIRST_MESSAGE_SUMMARY',
      );
      expect(JSON.stringify(a)).not.toContain('OWNER_');
      const b = await listWechatAccessibleSessions(identity('sender-b'), 100);
      expect(b.map((row) => row.id)).toEqual(['sender-b-own']);
      expect(b[0].title).toBe('SENDER_B_ORIGINAL_TITLE');
      await expect(
        listWechatAccessibleSessions(identity('sender-a', 'foreign-bot')),
      ).rejects.toMatchObject({ code: 'MEMORY.ACTOR_DENIED' });
    });

    it('allows explicit owner sharing but rechecks stale cached targets after revocation', async () => {
      await shareOwner();
      const listed = await handleWechatChatCommand({
        account,
        owner: { id: 'owner' },
        sender: 'sender-a',
        content: '/sessions',
      });
      expect(listed.replyText).toContain('OWNER_PRIVATE_TITLE');
      await getDbPool().query(
        'UPDATE memory_scopes SET share_subject_memory=false,binding_revision=binding_revision+1 WHERE actor_key=$1',
        [actor('sender-a')],
      );
      const resumed = await handleWechatChatCommand({
        account,
        owner: { id: 'owner' },
        sender: 'sender-a',
        content: '/resume 1',
      });
      expect(resumed.replyText).not.toContain('OWNER_PRIVATE_TITLE');
      expect(resumed.replyText).toContain('/memory');
      expect(
        (await getDbPool().query('SELECT * FROM wechat_chat_session_links'))
          .rows,
      ).toEqual([]);
      await shareOwner();
      const accepted = await handleWechatChatCommand({
        account,
        owner: { id: 'owner' },
        sender: 'sender-a',
        content: '/resume 1',
      });
      expect(accepted.replyText).toContain('OWNER_PRIVATE_TITLE');
      expect(
        (
          await getDbPool().query(
            'SELECT session_id FROM wechat_chat_session_links',
          )
        ).rows[0].session_id,
      ).toBe('owner-private');
    });

    it('uses a generic title for a current link without proof of the sender original title', async () => {
      await getDbPool().query(
        "INSERT INTO wechat_chat_session_links(account_id,sender_hash,user_id,session_id) VALUES('bot-a',$1,'owner','owner-private')",
        [identity('sender-a').senderHash],
      );
      expect(
        await getWechatAccessibleSession(identity('sender-a'), 'owner-private'),
      ).toMatchObject({ title: '微信对话' });
      const where = await handleWechatChatCommand({
        account,
        owner: { id: 'owner' },
        sender: 'sender-a',
        content: '/where',
      });
      expect(where.replyText).toBe('当前接续：微信对话');
      expect(
        await getWechatAccessibleSession(identity('sender-b'), 'owner-private'),
      ).toBeNull();
    });

    async function admitted(sender?: string): Promise<{
      requestId: string;
      executionId: string;
      scope: MemoryRequestScope;
    }> {
      return withMemoryTransaction(async (db) => {
        const scope = await createMemoryAdmissionScope(db, {
          ownerUserId: 'owner',
          sessionId: 'tool-session',
          ...(sender
            ? {
                metadata: {
                  source_channel: 'wechat',
                  wechat_account_id: account.id,
                  sender_hash: identity(sender).senderHash,
                },
              }
            : {}),
        });
        const requestId = `request-${randomUUID()}`;
        const executionId = randomUUID();
        await db.query(
          "INSERT INTO agent_requests(request_id,execution_id,account_id,owner_user_id,session_id,state,deadline_at,memory_scope) VALUES($1,$2,'web:owner','owner','tool-session','running',clock_timestamp()+interval '5 minutes',$3)",
          [requestId, executionId, JSON.stringify(scope)],
        );
        return { requestId, executionId, scope };
      });
    }
    const tool = <T>(
      request: { requestId: string; executionId: string },
      run: Parameters<typeof withActiveConversationRequest<T>>[1],
    ) =>
      withActiveConversationRequest(
        { accountId: 'web:owner', ...request },
        run,
      );

    it('keeps explicit tools usable for legacy and guest calls while refusing automatic profile access', async () => {
      await getDbPool().query(
        "INSERT INTO agent_requests(request_id,execution_id,account_id,owner_user_id,session_id,state,deadline_at) VALUES('legacy','legacy','web:owner','owner','tool-session','running',clock_timestamp()+interval '5 minutes')",
      );
      expect(
        await tool(
          { requestId: 'legacy', executionId: 'legacy' },
          async (owner) => ({
            clientId: owner.clientId,
            explicit: 'caller-provided-parameters',
          }),
        ),
      ).toEqual({ clientId: null, explicit: 'caller-provided-parameters' });
      const guest = await admitted('sender-a');
      expect(
        await tool(guest, async (owner, db) =>
          applyClientProfilePrefill(
            owner.userId,
            owner.clientId ?? undefined,
            { hour: 9 },
            db,
          ),
        ),
      ).toEqual({ hour: 9 });
    });

    it('uses the admitted owner client even if the business session changes to another client', async () => {
      const owner = await admitted();
      await getDbPool().query(
        "UPDATE chat_sessions SET client_id='client-b' WHERE id='tool-session'",
      );
      expect(
        await tool(owner, async (who, db) =>
          applyClientProfilePrefill(
            who.userId,
            who.clientId ?? undefined,
            { hour: 9 },
            db,
          ),
        ),
      ).toMatchObject({
        solarDate: '1990-05-15',
        hour: 9,
        minute: 30,
        gender: '男',
      });
    });

    it('prefills a client-bound sender only after the same client is explicitly shared', async () => {
      await admitted();
      await ensureWechatSessionActor(identity('sender-a'));
      await getDbPool().query(
        "UPDATE memory_scopes SET bound_subject_id='client:client-a',share_subject_memory=false,binding_revision=binding_revision+1 WHERE actor_key=$1",
        [actor('sender-a')],
      );
      const closed = await admitted('sender-a');
      expect(await tool(closed, async (who) => who.clientId)).toBeNull();
      await getDbPool().query(
        'UPDATE memory_scopes SET share_subject_memory=true,binding_revision=binding_revision+1 WHERE actor_key=$1',
        [actor('sender-a')],
      );
      const shared = await admitted('sender-a');
      expect(await tool(shared, async (who) => who.clientId)).toBe('client-a');
    });

    it('rejects an admitted tool call when its sender binding changed', async () => {
      await shareOwner();
      const request = await admitted('sender-a');
      await getDbPool().query(
        'UPDATE memory_scopes SET binding_revision=binding_revision+1 WHERE actor_key=$1',
        [actor('sender-a')],
      );
      const run = vi.fn(async () => 'must not execute');
      await expect(tool(request, run)).rejects.toBeInstanceOf(Error);
      expect(run).not.toHaveBeenCalled();
    });

    it.each(['epoch', 'subject'] as const)(
      'keeps ordinary tools available after a memory %s change, without archived client prefill',
      async (change) => {
        await shareOwner();
        const request = await admitted('sender-a');
        if (change === 'epoch')
          await getDbPool().query(
            "UPDATE memory_scopes SET epoch=epoch+1 WHERE owner_user_id='owner' AND parent_scope_id IS NULL",
          );
        else
          await getDbPool().query(
            "UPDATE client_profiles SET deleted_at=clock_timestamp() WHERE id='client-a'",
          );
        expect(await tool(request, async (who) => who.clientId)).toBe(
          change === 'epoch' ? 'client-a' : null,
        );
      },
    );
  },
);
