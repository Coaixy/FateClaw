import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ pool: null as pg.Pool | null }));
vi.mock('#infrastructure/env', () => ({ readEnvFile: () => ({}) }));
vi.mock('#infrastructure/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#infrastructure/config')>()),
  DATABASE_URL: 'postgresql://synthetic-disposable-client',
}));
vi.mock('#infrastructure/db-pool', () => ({
  getDbPool: () => state.pool,
  initDbPool: () => state.pool,
  closeDbPool: async () => {
    await state.pool?.end();
  },
}));
vi.mock('#modules/skills/legacy-skill-import', () => ({
  importLegacySkillContent: async () => ({
    migrated: 0,
    missing: 0,
    mismatched: 0,
    invalid: 0,
  }),
}));

import { closeDatabase, deleteUser, initDatabase } from '#infrastructure/db';
import { saveModelPoolPreference } from '#infrastructure/repositories/benefit-repository';

// Only the explicit disposable test server is used; workspace configuration is never read.
const connectionString = process.env.FATECLAW_TEST_BENEFIT_DATABASE_URL;
describe.skipIf(!connectionString)('user deletion with benefit records', () => {
  let admin: pg.Pool;
  const databaseName = `fateclaw_user_deletion_${randomUUID().replaceAll('-', '')}`;
  let created = false;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const url = new URL(connectionString!);
    url.pathname = `/${databaseName}`;
    state.pool = new pg.Pool({
      connectionString: url.toString(),
      connectionTimeoutMillis: 5000,
    });
    await initDatabase();
  }, 30000);

  afterAll(async () => {
    await closeDatabase();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin?.end();
  });

  it('deletes users who only saved an official preference while the benefit pool is disabled', async () => {
    await state.pool!.query(
      "INSERT INTO users(id,phone,created_at) VALUES('preference-user','13000000001',now())",
    );
    await saveModelPoolPreference('preference-user', 'official');
    expect(
      (
        await state.pool!.query(
          "SELECT enabled FROM official_model_pool_settings WHERE id='benefit'",
        )
      ).rows[0].enabled,
    ).toBe(false);

    await deleteUser('preference-user');

    expect(
      (
        await state.pool!.query(
          "SELECT 1 FROM users WHERE id='preference-user'",
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await state.pool!.query(
          "SELECT 1 FROM user_model_preferences WHERE user_id='preference-user'",
        )
      ).rowCount,
    ).toBe(0);
  });

  it('removes personal free records while preserving other users, probes and idempotent late usage settlement', async () => {
    await state.pool!.query(`
      INSERT INTO users(id,phone,created_at) VALUES ('free-user','13000000002',now()),('other-user','13000000003',now());
      INSERT INTO chat_sessions(id,account_id,user_id,title) VALUES ('free-session','web:free-user','free-user','Synthetic');
      INSERT INTO user_model_preferences(user_id,pool_key) VALUES ('free-user','benefit'),('other-user','official');
      INSERT INTO benefit_daily_usage(user_id,allowance_date) VALUES
        ('free-user',CURRENT_DATE),('free-user',CURRENT_DATE-1),('other-user',CURRENT_DATE);
      INSERT INTO agent_requests(request_id,execution_id,account_id,session_id,owner_user_id,state,input,runtime,deadline_at) VALUES
        ('free-request','free-execution','web:free-user','free-session','free-user','running','{}','{}',now()+interval '1 minute'),
        ('old-request','old-execution','web:free-user','free-session','free-user','completed','{}','{}',now()),
        ('other-request','other-execution','web:other-user','other-session','other-user','queued','{}','{}',now()+interval '1 minute');
      INSERT INTO benefit_requests(request_id,user_id,allowance_date,policy,state,queue_deadline_at) VALUES
        ('free-request','free-user',CURRENT_DATE,'{}','running',now()),
        ('old-request','free-user',CURRENT_DATE-1,'{}','consumed',now()),
        ('other-request','other-user',CURRENT_DATE,'{}','reserved',now());
      INSERT INTO benefit_model_attempts(id,request_id,node_id,is_probe,input_tokens,output_tokens,health_generation,state) VALUES
        ('free-attempt','free-request','synthetic-node',false,1,1,0,'reserved'),
        ('old-attempt','old-request','synthetic-node',false,1,1,0,'settled'),
        ('probe-attempt',NULL,'synthetic-node',true,1,1,0,'settled');
    `);

    await deleteUser('free-user');

    for (const [table, column] of [
      ['users', 'id'],
      ['chat_sessions', 'user_id'],
      ['user_model_preferences', 'user_id'],
      ['benefit_daily_usage', 'user_id'],
      ['benefit_requests', 'user_id'],
    ]) {
      expect(
        (
          await state.pool!.query(
            `SELECT 1 FROM ${table} WHERE ${column}='free-user'`,
          )
        ).rowCount,
      ).toBe(0);
    }
    expect(
      (await state.pool!.query("SELECT 1 FROM users WHERE id='other-user'"))
        .rowCount,
    ).toBe(1);
    expect(
      (
        await state.pool!.query(
          "SELECT 1 FROM user_model_preferences WHERE user_id='other-user'",
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await state.pool!.query(
          "SELECT 1 FROM benefit_daily_usage WHERE user_id='other-user'",
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await state.pool!.query(
          "SELECT 1 FROM benefit_requests WHERE user_id='other-user'",
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await state.pool!.query(
          'SELECT id,request_id,is_probe FROM benefit_model_attempts ORDER BY id',
        )
      ).rows,
    ).toEqual([
      { id: 'free-attempt', request_id: null, is_probe: false },
      { id: 'old-attempt', request_id: null, is_probe: false },
      { id: 'probe-attempt', request_id: null, is_probe: true },
    ]);
    const usage = async () =>
      (
        await state.pool!.query(
          "SELECT input_tokens,output_tokens,state FROM benefit_model_attempts WHERE id='free-attempt'",
        )
      ).rows[0];
    expect(await usage()).toEqual({
      input_tokens: '1',
      output_tokens: '1',
      state: 'reserved',
    });
    for (let index = 0; index < 2; index += 1) {
      expect(
        (
          await state.pool!.query(
            "SELECT settle_benefit_attempt('free-attempt',3,4,true,'success') AS settled",
          )
        ).rows[0].settled,
      ).toBe(true);
      expect(await usage()).toEqual({
        input_tokens: '3',
        output_tokens: '4',
        state: 'settled',
      });
    }
  });
});
