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
import type { User } from '#shared/types';

const state = vi.hoisted(() => ({ pool: null as pg.Pool | null }));
vi.mock('#infrastructure/db-pool', () => ({
  getDbPool: () => state.pool,
}));
vi.mock('#infrastructure/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('#infrastructure/config', () => ({ MAX_OVERDRAFT_COINS: 50 }));
vi.mock('#infrastructure/db', () => ({
  getUserByPhone: (phone: string) => getUserByPhoneUsing(state.pool!, phone),
}));
vi.mock('#modules/user/sms-captcha-service', () => ({
  verifySMSCaptcha: vi.fn(async () => 'synthetic-sms-verification'),
}));

import { MIGRATIONS } from '#infrastructure/migrations/manifest';
import { getUserByPhoneUsing } from '#infrastructure/repositories/users-repository';
import { getMembershipOverview } from '#infrastructure/repositories/billing-repository';
import { registerUser } from '#modules/user/auth-service';
import {
  assertRegistrationInviteValid,
  createRegisteredUser,
  createRegistrationInvite,
  getRegistrationInvitePolicy,
  getRegistrationInviteSummary,
  listCompletedRechargeRefunds,
  recordCompletedRechargeRefund,
  revokeRegistrationInvite,
  saveRegistrationInvitePolicy,
  updateRegistrationInviteAccount,
} from '#infrastructure/repositories/registration-invites-repository';

// Only an explicitly supplied disposable server is used; application configuration is never loaded.
const databaseUrl = process.env.FATECLAW_TEST_INVITES_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  'registration invitation PostgreSQL boundaries',
  () => {
    let admin: pg.Pool;
    let database: string;
    let nextPhone = 0;
    let historicalGrants: Array<{
      user_id: string;
      base_slots: number;
      extra_slots: number;
    }>;
    const db = () => state.pool!;
    const requestKey = () => randomUUID();
    const newUser = (phone?: string): User => ({
      id: randomUUID(),
      phone: phone ?? `139${String(++nextPhone).padStart(8, '0')}`,
      phone_verified: true,
      password_hash: 'synthetic-password-hash',
      role: 'consumer',
      purchased_coins: 0,
      bonus_coins: 0,
      reserved_coins: 0,
      created_at: '2026-10-17T00:00:00.000Z',
    });
    const pay = async (amount: number, userId = 'alice', status = 'paid') => {
      const trade = `synthetic-${randomUUID()}`;
      await db().query(
        `INSERT INTO recharge_orders(id,user_id,trade_id,pay_type,amount_coins,status,paid_at)
      VALUES($1,$2,$3,'alipay',$4,$5,CASE WHEN $5='paid' THEN now() END)`,
        [randomUUID(), userId, trade, amount, status],
      );
      return trade;
    };
    const issue = () => createRegistrationInvite('alice', requestKey());
    const refund = (trade: string, amount: number, reference = requestKey()) =>
      recordCompletedRechargeRefund({
        trade_id: trade,
        amount_yuan: amount,
        reference,
        reason: 'Synthetic completed refund',
      });

    beforeAll(async () => {
      admin = new pg.Pool({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 5000,
      });
      database = `fateclaw_invites_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE DATABASE "${database}"`);
      const connection = new URL(databaseUrl!);
      connection.pathname = `/${database}`;
      state.pool = new pg.Pool({
        connectionString: connection.toString(),
        max: 16,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
        query_timeout: 12000,
      });
      const client = await db().connect();
      try {
        for (const migration of MIGRATIONS) {
          if (migration.id === '0092_registration_invites') {
            await client.query(`INSERT INTO users(id,phone,created_at,purchased_coins,bonus_coins)
            VALUES('historical-paid','13000000001',now(),0,0),('historical-bonus','13000000002',now(),500,500),
              ('historical-newly-qualified','13000000003',now(),0,0);
            INSERT INTO recharge_orders(id,user_id,trade_id,pay_type,amount_coins,status)
            VALUES('historical-paid-order','historical-paid','historical-trade','alipay',100,'paid'),
              ('historical-pending-order','historical-bonus','historical-pending','alipay',500,'pending'),
              ('historical-new-order','historical-newly-qualified','historical-new','alipay',30,'paid')`);
          }
          if (migration.id === '0093_registration_invite_tiers')
            await client.query(
              "UPDATE registration_invite_accounts SET extra_slots=2 WHERE user_id='historical-paid'",
            );
          await client.query('BEGIN');
          await migration.up(client);
          await client.query('COMMIT');
        }
        historicalGrants = (
          await client.query<{
            user_id: string;
            base_slots: number;
            extra_slots: number;
          }>(
            'SELECT user_id,base_slots,extra_slots FROM registration_invite_accounts ORDER BY user_id',
          )
        ).rows;
      } finally {
        client.release();
      }
    }, 30000);

    beforeEach(async () => {
      nextPhone = 0;
      await db()
        .query(`TRUNCATE registration_invites,completed_recharge_refunds,
      registration_invite_accounts,recharge_orders,users CASCADE;
      UPDATE membership_config SET enabled=true;
      UPDATE registration_invite_policy SET tiers='[{"threshold_cents":3000,"total_slots":3},{"threshold_cents":10000,"total_slots":5},{"threshold_cents":30000,"total_slots":10}]'::jsonb,expires_in_days=7,revision=1;
      INSERT INTO users(id,phone,phone_verified,created_at,purchased_coins,bonus_coins)
      VALUES('alice','13000000001',true,now(),500,500),('bob','13000000002',true,now(),0,0)`);
    });

    afterAll(async () => {
      await state.pool?.end();
      if (database) await admin.query(`DROP DATABASE "${database}"`);
      await admin?.end();
    });

    it('backfills historical paid orders without treating wallet credit or pending orders as payment', async () => {
      expect(historicalGrants).toEqual([
        {
          user_id: 'historical-newly-qualified',
          base_slots: 3,
          extra_slots: 0,
        },
        { user_id: 'historical-paid', base_slots: 5, extra_slots: 2 },
      ]);
      await pay(500, 'alice', 'pending');
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        eligible: false,
        net_recharge_yuan: 0,
        total_slots: 0,
        available_slots: 0,
      });
    });

    it('grants once in the payment transaction and retains eligibility after wallet spending', async () => {
      const trade = await pay(30, 'alice', 'pending');
      await db().query(
        "UPDATE recharge_orders SET status='paid' WHERE trade_id=$1",
        [trade],
      );
      expect(
        (
          await db().query(
            'SELECT base_slots FROM registration_invite_accounts WHERE user_id=$1',
            ['alice'],
          )
        ).rows,
      ).toEqual([{ base_slots: 3 }]);
      await db().query(
        "UPDATE users SET purchased_coins=0,bonus_coins=0 WHERE id='alice'",
      );
      await db().query(
        "UPDATE recharge_orders SET status='paid' WHERE trade_id=$1",
        [trade],
      );
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        eligible: true,
        net_recharge_yuan: 30,
        total_slots: 3,
        available_slots: 3,
      });
    });

    it('serializes simultaneous issuance at the exact quota boundary', async () => {
      await pay(30);
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, issue),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(3);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(9);
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        reserved_slots: 3,
        available_slots: 0,
      });
    });

    it('upgrades the cumulative allowance from three to five to ten without stacking grants', async () => {
      await pay(30);
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        total_slots: 3,
      });
      await pay(70);
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        total_slots: 5,
      });
      const trade = await pay(200);
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        total_slots: 10,
      });
      await db().query(
        "UPDATE recharge_orders SET status='paid' WHERE trade_id=$1",
        [trade],
      );
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        total_slots: 10,
      });
    });

    it('uses exact cent boundaries for every tier and does not grow past the highest tier', async () => {
      for (const [amount, automatic] of [
        [29.99, 0],
        [0.01, 3],
        [69.99, 3],
        [0.01, 5],
        [199.99, 5],
        [0.01, 10],
        [500, 10],
      ]) {
        await pay(amount);
        expect(await getRegistrationInviteSummary('alice')).toMatchObject({
          automatic_slots: automatic,
          total_slots: automatic,
          eligible: automatic > 0,
        });
      }
    });

    it('counts used and reserved invitations against upgraded totals', async () => {
      await pay(30);
      const first = await issue(),
        second = await issue();
      await issue();
      await createRegisteredUser(newUser(), first.code!);
      await createRegisteredUser(newUser(), second.code!);
      await pay(70);
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        total_slots: 5,
        used_slots: 2,
        reserved_slots: 1,
        available_slots: 2,
      });
      await Promise.all([issue(), issue()]);
      await pay(200);
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        total_slots: 10,
        used_slots: 2,
        reserved_slots: 3,
        available_slots: 5,
      });
    });

    it('retains manual additions and older reserved links when a refund downgrades capacity', async () => {
      const trade = await pay(100);
      const initial = await getRegistrationInviteSummary('alice');
      await updateRegistrationInviteAccount('alice', {
        total_slots: 7,
        suspended: false,
        expected_revision: initial.revision,
      });
      const codes = [];
      for (let index = 0; index < 7; index += 1) codes.push(await issue());
      await createRegisteredUser(newUser(), codes[0].code!);
      await createRegisteredUser(newUser(), codes[1].code!);
      await refund(trade, 70);
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        net_recharge_yuan: 30,
        automatic_slots: 3,
        manual_slot_adjustment: 2,
        total_slots: 5,
        used_slots: 2,
        reserved_slots: 3,
        available_slots: 0,
      });
      await expect(
        assertRegistrationInviteValid(codes[2].code!),
      ).resolves.toMatchObject({ valid: true });
      await expect(
        assertRegistrationInviteValid(codes[4].code!),
      ).resolves.toMatchObject({ valid: true });
      await expect(
        assertRegistrationInviteValid(codes[5].code!),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        assertRegistrationInviteValid(codes[6].code!),
      ).rejects.toMatchObject({ statusCode: 400 });
      await pay(70);
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        total_slots: 7,
        automatic_slots: 5,
        used_slots: 2,
        reserved_slots: 3,
        available_slots: 2,
      });
    });

    it('preserves historical usage above a downgraded tier without adding capacity on suspension changes', async () => {
      const trade = await pay(300);
      for (let index = 0; index < 7; index += 1) {
        const invitation = await issue();
        await createRegisteredUser(newUser(), invitation.code!);
      }
      const unused = await issue();
      await refund(trade, 270);
      const downgraded = await getRegistrationInviteSummary('alice');
      expect(downgraded).toMatchObject({
        total_slots: 7,
        automatic_slots: 3,
        manual_slot_adjustment: 0,
        used_slots: 7,
        reserved_slots: 0,
        available_slots: 0,
      });
      await expect(
        assertRegistrationInviteValid(unused.code!),
      ).rejects.toMatchObject({ statusCode: 400 });
      const paused = await updateRegistrationInviteAccount('alice', {
        total_slots: 7,
        suspended: true,
        expected_revision: downgraded.revision,
      });
      const resumed = await updateRegistrationInviteAccount('alice', {
        total_slots: 7,
        suspended: false,
        expected_revision: paused.revision,
      });
      expect(resumed).toMatchObject({
        manual_slot_adjustment: 0,
        automatic_slots: 3,
        available_slots: 0,
      });
      await expect(issue()).rejects.toMatchObject({ statusCode: 409 });
      await pay(270);
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        total_slots: 10,
        used_slots: 7,
        available_slots: 3,
      });
    });

    it('keeps negative manual adjustments valid through refunds and later tier upgrades', async () => {
      const trade = await pay(30);
      const summary = await getRegistrationInviteSummary('alice');
      await updateRegistrationInviteAccount('alice', {
        total_slots: 1,
        suspended: false,
        expected_revision: summary.revision,
      });
      await refund(trade, 30);
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        automatic_slots: 0,
        manual_slot_adjustment: -2,
        total_slots: 0,
        eligible: false,
      });
      await pay(100);
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        automatic_slots: 5,
        manual_slot_adjustment: -2,
        total_slots: 3,
        available_slots: 3,
      });
    });

    it('rejects invalid ladders at the database boundary', async () => {
      await expect(
        db().query('UPDATE registration_invite_policy SET tiers=$1::jsonb', [
          JSON.stringify([
            { threshold_cents: 3000, total_slots: 3 },
            { threshold_cents: 3000, total_slots: 5 },
          ]),
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      expect((await getRegistrationInvitePolicy()).tiers).toHaveLength(3);
    });

    it('holds one policy version for the complete account transaction', async () => {
      await pay(30);
      const reader = await db().connect(),
        writer = await db().connect();
      let changing: Promise<pg.QueryResult> | undefined;
      let completed = false;
      try {
        const pid = (await writer.query('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid;
        await reader.query('BEGIN');
        await reader.query("SELECT reconcile_registration_invites('alice')");
        changing = writer
          .query(
            `UPDATE registration_invite_policy SET tiers=$1::jsonb,revision=revision+1`,
            [
              JSON.stringify([
                { threshold_cents: 10000, total_slots: 3 },
                { threshold_cents: 20000, total_slots: 5 },
                { threshold_cents: 40000, total_slots: 10 },
              ]),
            ],
          )
          .then((result) => {
            completed = true;
            return result;
          });
        await vi.waitFor(
          async () => {
            expect(
              completed,
              'policy changes must wait for the active account operation',
            ).toBe(false);
            const wait = (
              await db().query(
                'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',
                [pid],
              )
            ).rows[0];
            expect(wait?.wait_event_type).toBe('Lock');
          },
          { timeout: 1500, interval: 10 },
        );
        const snapshot = (
          await reader.query(`SELECT p.tiers,a.base_slots FROM registration_invite_policy p
          CROSS JOIN registration_invite_accounts a WHERE a.user_id='alice'`)
        ).rows[0];
        expect(snapshot.base_slots).toBe(3);
        expect(snapshot.tiers[0].threshold_cents).toBe(3000);
        await reader.query('COMMIT');
        await changing;
        expect(await getRegistrationInviteSummary('alice')).toMatchObject({
          automatic_slots: 0,
          eligible: false,
        });
      } finally {
        await reader.query('ROLLBACK');
        await changing;
        reader.release();
        writer.release();
      }
    });

    it('qualifies simultaneous recharge inserts without upgrading foreign-key locks', async () => {
      const clients = await Promise.all([db().connect(), db().connect()]);
      try {
        await Promise.all(
          clients.map(async (client) => {
            await client.query('BEGIN');
            await client.query(
              "SELECT id FROM users WHERE id='alice' FOR KEY SHARE",
            );
          }),
        );
        const results = await Promise.allSettled(
          clients.map(async (client) => {
            try {
              await client.query(
                `INSERT INTO recharge_orders(id,user_id,trade_id,pay_type,amount_coins,status)
            VALUES($1,'alice',$2,'alipay',50,'paid')`,
                [randomUUID(), randomUUID()],
              );
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            }
          }),
        );
        expect(
          results.map((result) =>
            result.status === 'fulfilled'
              ? 'fulfilled'
              : String((result.reason as { code?: string }).code),
          ),
        ).toEqual(['fulfilled', 'fulfilled']);
        expect(await getRegistrationInviteSummary('alice')).toMatchObject({
          total_slots: 5,
          net_recharge_yuan: 100,
        });
      } finally {
        await Promise.all(
          clients.map(async (client) => {
            await client.query('ROLLBACK');
            client.release();
          }),
        );
      }
    });

    it('deduplicates simultaneous retries without storing or recovering plaintext codes', async () => {
      await pay(30);
      const key = requestKey();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => createRegistrationInvite('alice', key)),
      );
      expect(results.filter((result) => result.code !== null)).toHaveLength(1);
      expect(new Set(results.map((result) => result.invite.id)).size).toBe(1);
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        reserved_slots: 1,
        available_slots: 2,
      });
      const record = (
        await db().query('SELECT * FROM registration_invites WHERE id=$1', [
          key,
        ])
      ).rows[0];
      expect(record).not.toHaveProperty('code');
      expect(record.code_hash).not.toContain(
        results.find((result) => result.code)!.code,
      );
      await expect(createRegistrationInvite('bob', key)).rejects.toMatchObject({
        statusCode: 409,
      });
    });

    it('registers an ordinary account without an invitation or membership', async () => {
      const user = await registerUser(
        newUser().phone!,
        'synthetic-password',
        '123456',
        '127.0.0.1',
      );
      expect(
        (await db().query('SELECT id FROM users WHERE id=$1', [user.id])).rows,
      ).toEqual([{ id: user.id }]);
      expect(
        (
          await db().query('SELECT * FROM user_memberships WHERE user_id=$1', [
            user.id,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (await db().query('SELECT * FROM registration_invites')).rows,
      ).toEqual([]);
    });

    it.each([true, false])(
      'grants exactly 72 hours without charging the wallet and expires normally when membership sales are enabled=%s',
      async (enabled) => {
        await db().query('UPDATE membership_config SET enabled=$1', [enabled]);
        await pay(30);
        const { code } = await issue();
        const started = Date.now();
        const user = await registerUser(
          newUser().phone!,
          'synthetic-password',
          '123456',
          '127.0.0.1',
          code!,
        );
        const {
          rows: [membership],
        } = await db().query(
          'SELECT * FROM user_memberships WHERE user_id=$1',
          [user.id],
        );
        expect(membership).toMatchObject({
          plan_key: 'membership',
          status: 'active',
        });
        expect(
          membership.current_period_start.getTime(),
        ).toBeGreaterThanOrEqual(started - 1000);
        expect(membership.current_period_start.getTime()).toBeLessThanOrEqual(
          Date.now() + 1000,
        );
        expect(
          membership.current_period_end.getTime() -
            membership.current_period_start.getTime(),
        ).toBe(72 * 60 * 60 * 1000);
        expect(
          (
            await db().query(
              'SELECT purchased_coins::float8,bonus_coins::float8 FROM users WHERE id=$1',
              [user.id],
            )
          ).rows,
        ).toEqual([{ purchased_coins: 0, bonus_coins: 0 }]);
        expect(
          (
            await db().query(
              'SELECT * FROM wallet_transactions WHERE user_id=$1',
              [user.id],
            )
          ).rows,
        ).toEqual([]);
        expect(await getRegistrationInviteSummary(user.id)).toMatchObject({
          eligible: false,
          available_slots: 0,
        });
        expect(await getMembershipOverview(user.id)).toMatchObject({
          active: true,
        });
        await db().query(
          `UPDATE user_memberships SET current_period_start=NOW()-interval '73 hours',
         current_period_end=NOW()-interval '1 hour' WHERE user_id=$1`,
          [user.id],
        );
        expect(await getMembershipOverview(user.id)).toMatchObject({
          active: false,
          membership: null,
        });
      },
    );

    it('rolls back registration and code consumption if the trial grant fails, then allows retry', async () => {
      await pay(30);
      const invitation = await issue();
      const user = { ...newUser(), id: 'trial-grant-failure' };
      await db().query(`
        CREATE FUNCTION fail_invitation_trial_grant() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.user_id = 'trial-grant-failure' THEN
            RAISE EXCEPTION 'Synthetic trial grant failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER fail_invitation_trial_grant BEFORE INSERT ON user_memberships
          FOR EACH ROW EXECUTE FUNCTION fail_invitation_trial_grant();
      `);
      try {
        await expect(
          createRegisteredUser(user, invitation.code!),
        ).rejects.toThrow('Synthetic trial grant failure');
        expect(
          (await db().query('SELECT id FROM users WHERE id=$1', [user.id]))
            .rows,
        ).toEqual([]);
        expect(
          (
            await db().query(
              'SELECT * FROM user_memberships WHERE user_id=$1',
              [user.id],
            )
          ).rows,
        ).toEqual([]);
        await expect(
          assertRegistrationInviteValid(invitation.code!),
        ).resolves.toMatchObject({ valid: true });
      } finally {
        await db().query(
          'DROP TRIGGER fail_invitation_trial_grant ON user_memberships; DROP FUNCTION fail_invitation_trial_grant()',
        );
      }
      await createRegisteredUser(user, invitation.code!);
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        used_slots: 1,
        reserved_slots: 0,
      });
    });

    it('allows a single account and trial from concurrent redemptions and never restores a used slot after invitee deletion', async () => {
      await pay(30);
      const { code } = await issue();
      const users = Array.from({ length: 8 }, () => newUser());
      const outcomes = await Promise.allSettled(
        users.map((user) => createRegisteredUser(user, code!)),
      );
      expect(
        outcomes.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        Number(
          (
            await db().query(
              "SELECT count(*) FROM users WHERE id NOT IN ('alice','bob')",
            )
          ).rows[0].count,
        ),
      ).toBe(1);
      const winner =
        users[outcomes.findIndex((result) => result.status === 'fulfilled')];
      expect(
        (await db().query('SELECT user_id FROM user_memberships')).rows,
      ).toEqual([{ user_id: winner.id }]);
      await db().query('DELETE FROM users WHERE id=$1', [winner.id]);
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        used_slots: 1,
        available_slots: 2,
      });
    });

    it('rolls back code consumption when account creation fails', async () => {
      await pay(30);
      const { code } = await issue();
      await expect(
        createRegisteredUser(newUser('13000000001'), code!),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(assertRegistrationInviteValid(code!)).resolves.toMatchObject(
        { valid: true },
      );
      await createRegisteredUser(newUser(), code!);
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        used_slots: 1,
        reserved_slots: 0,
      });
    });

    it('releases expired and revoked reservations and enforces ownership', async () => {
      await pay(30);
      const first = await issue();
      await db().query(
        "UPDATE registration_invites SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [first.invite.id],
      );
      await expect(
        assertRegistrationInviteValid(first.code!),
      ).rejects.toMatchObject({ statusCode: 400 });
      const second = await issue();
      await expect(
        revokeRegistrationInvite(second.invite.id, 'bob'),
      ).rejects.toMatchObject({ statusCode: 404 });
      await revokeRegistrationInvite(second.invite.id, 'alice');
      await revokeRegistrationInvite(second.invite.id, 'alice');
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        reserved_slots: 0,
        available_slots: 3,
      });
    });

    it('blocks suspended inviters and prevents stale edits or quota reductions below occupied slots', async () => {
      await pay(30);
      const issued = await issue();
      const summary = await getRegistrationInviteSummary('alice');
      await expect(
        updateRegistrationInviteAccount('alice', {
          total_slots: 0,
          suspended: false,
          expected_revision: summary.revision,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const paused = await updateRegistrationInviteAccount('alice', {
        total_slots: 3,
        suspended: true,
        expected_revision: summary.revision,
      });
      await expect(issue()).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        assertRegistrationInviteValid(issued.code!),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        updateRegistrationInviteAccount('alice', {
          total_slots: 3,
          suspended: false,
          expected_revision: summary.revision,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await updateRegistrationInviteAccount('alice', {
        total_slots: 3,
        suspended: false,
        expected_revision: paused.revision,
      });
      await expect(
        assertRegistrationInviteValid(issued.code!),
      ).resolves.toMatchObject({ valid: true });
    });

    it('records refunds idempotently, revokes outstanding codes and preserves used slots and wallet balances', async () => {
      const trade = await pay(30);
      const first = await issue();
      const second = await issue();
      await createRegisteredUser(newUser(), first.code!);
      const reference = requestKey();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => refund(trade, 0.01, reference)),
      );
      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      expect(await listCompletedRechargeRefunds('alice')).toHaveLength(1);
      await expect(
        assertRegistrationInviteValid(second.code!),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        eligible: false,
        net_recharge_yuan: 29.99,
        total_slots: 1,
        automatic_slots: 0,
        used_slots: 1,
        reserved_slots: 0,
      });
      expect(
        Number(
          (
            await db().query(
              "SELECT purchased_coins FROM users WHERE id='alice'",
            )
          ).rows[0].purchased_coins,
        ),
      ).toBe(500);
      await expect(refund(trade, 0.02, reference)).rejects.toMatchObject({
        statusCode: 409,
      });
      await pay(30);
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        total_slots: 3,
        available_slots: 2,
      });
    });

    it('serializes partial refunds so their sum cannot exceed the paid order', async () => {
      const trade = await pay(100);
      const outcomes = await Promise.allSettled([
        refund(trade, 60),
        refund(trade, 60),
      ]);
      expect(
        outcomes.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        outcomes.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        net_recharge_yuan: 40,
      });
    });

    it('supports operational codes and reconciles revised tier totals without stacking capacity', async () => {
      const operational = await createRegistrationInvite(null, requestKey());
      await createRegisteredUser(newUser(), operational.code!);
      await pay(100);
      const policy = await getRegistrationInvitePolicy();
      await saveRegistrationInvitePolicy({
        ...policy,
        tiers: policy.tiers.map((tier, index) =>
          index === 1 ? { ...tier, total_slots: 6 } : tier,
        ),
        expected_revision: policy.revision,
      });
      await expect(
        saveRegistrationInvitePolicy({
          ...policy,
          expected_revision: policy.revision,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await pay(100, 'bob');
      expect(await getRegistrationInviteSummary('alice')).toMatchObject({
        total_slots: 6,
      });
      expect(await getRegistrationInviteSummary('bob')).toMatchObject({
        total_slots: 6,
      });
    });
  },
);
