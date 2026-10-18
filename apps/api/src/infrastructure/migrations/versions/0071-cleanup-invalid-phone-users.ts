import type pg from 'pg';

import type { DatabaseMigration } from '#infrastructure/migrations/types';
import { logger } from '#infrastructure/logger';

const INVALID_PHONE_USER_DELETE_TEMP_TABLE = 'users_without_valid_phone';

async function createInvalidPhoneUserDeleteSet(
  client: pg.PoolClient,
): Promise<void> {
  await client.query(`
    DO $$
    DECLARE
      has_phone BOOLEAN;
      has_oauth_identities BOOLEAN;
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'users'
      ) THEN
        DROP TABLE IF EXISTS ${INVALID_PHONE_USER_DELETE_TEMP_TABLE};

        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'phone'
        ) INTO has_phone;

        SELECT to_regclass('public.user_oauth_identities') IS NOT NULL
          INTO has_oauth_identities;

        CREATE TEMP TABLE ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} AS
          SELECT id FROM users WHERE NOT has_phone;

        IF has_phone THEN
          INSERT INTO ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} (id)
          SELECT id
          FROM users
          WHERE phone IS NULL
             OR phone !~ '^1[3-9][0-9]{9}$';

          -- OAuth 上线后，手机号为空不再代表脏用户；有第三方身份的账号必须保留。
          IF has_oauth_identities THEN
            DELETE FROM ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
            USING user_oauth_identities identity
            WHERE identity.user_id = doomed.id;
          END IF;
        END IF;
      END IF;
    END $$;
  `);
}

async function deleteInvalidPhoneUserCommerceData(
  client: pg.PoolClient,
): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      IF to_regclass('pg_temp.${INVALID_PHONE_USER_DELETE_TEMP_TABLE}') IS NULL THEN
        RETURN;
      END IF;

      IF to_regclass('public.user_model_configs') IS NOT NULL THEN
        DELETE FROM user_model_configs m
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE m.user_id = doomed.id;
      END IF;

      IF to_regclass('public.user_model_selections') IS NOT NULL THEN
        DELETE FROM user_model_selections s
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE s.user_id = doomed.id;
      END IF;

      IF to_regclass('public.creator_bundle_subscriptions') IS NOT NULL THEN
        DELETE FROM creator_bundle_subscriptions sub
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE sub.subscriber_id = doomed.id OR sub.creator_id = doomed.id;
      END IF;

      IF to_regclass('public.user_skill_subscriptions') IS NOT NULL THEN
        DELETE FROM user_skill_subscriptions sub
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE sub.subscriber_id = doomed.id;

        IF to_regclass('public.user_custom_skills') IS NOT NULL THEN
          DELETE FROM user_skill_subscriptions sub
          USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
          WHERE sub.skill_id IN (
            SELECT id FROM user_custom_skills WHERE user_id = doomed.id
          );
        END IF;
      END IF;

      IF to_regclass('public.skill_bundles') IS NOT NULL THEN
        DELETE FROM skill_bundles b
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE b.user_id = doomed.id;
      END IF;

      IF to_regclass('public.creator_bundle_config') IS NOT NULL THEN
        DELETE FROM creator_bundle_config cfg
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE cfg.creator_id = doomed.id;
      END IF;

    END $$;
  `);
}

async function deleteInvalidPhoneUserBillingData(
  client: pg.PoolClient,
): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      IF to_regclass('pg_temp.${INVALID_PHONE_USER_DELETE_TEMP_TABLE}') IS NULL THEN
        RETURN;
      END IF;

      IF to_regclass('public.billing_request_reservations') IS NOT NULL THEN
        DELETE FROM billing_request_reservations r
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE r.user_id = doomed.id;
      END IF;

      IF to_regclass('public.monthly_billing_state') IS NOT NULL THEN
        DELETE FROM monthly_billing_state b
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE b.user_id = doomed.id;
      END IF;

      IF to_regclass('public.membership_allowances') IS NOT NULL THEN
        DELETE FROM membership_allowances a
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE a.user_id = doomed.id;
      END IF;

      IF to_regclass('public.user_memberships') IS NOT NULL THEN
        DELETE FROM user_memberships m
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE m.user_id = doomed.id;
      END IF;

      IF to_regclass('public.recharge_orders') IS NOT NULL THEN
        DELETE FROM recharge_orders o
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE o.user_id = doomed.id;
      END IF;

      IF to_regclass('public.wallet_transactions') IS NOT NULL THEN
        DELETE FROM wallet_transactions t
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE t.user_id = doomed.id;
      END IF;

      IF to_regclass('public.balance_grants') IS NOT NULL THEN
        DELETE FROM balance_grants b
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE b.user_id = doomed.id;
      END IF;

      IF to_regclass('public.point_batches') IS NOT NULL THEN
        DELETE FROM point_batches b
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE b.user_id = doomed.id;
      END IF;
    END $$;
  `);
}

async function deleteInvalidPhoneUserRuntimeData(
  client: pg.PoolClient,
): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      IF to_regclass('pg_temp.${INVALID_PHONE_USER_DELETE_TEMP_TABLE}') IS NULL THEN
        RETURN;
      END IF;

      IF to_regclass('public.user_custom_skills') IS NOT NULL THEN
        DELETE FROM user_custom_skills s
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE s.user_id = doomed.id;
      END IF;

    END $$;
  `);
}

async function deleteInvalidPhoneUserMessageData(
  client: pg.PoolClient,
): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      IF to_regclass('pg_temp.${INVALID_PHONE_USER_DELETE_TEMP_TABLE}') IS NULL THEN
        RETURN;
      END IF;

      IF to_regclass('public.conversation_logs') IS NOT NULL THEN
        IF to_regclass('public.accounts') IS NOT NULL THEN
          DELETE FROM conversation_logs l
          USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
          WHERE l.account_id IN (
            SELECT id FROM accounts WHERE owner_id = doomed.id
          )
             OR l.account_id = CONCAT('web:', doomed.id);
        ELSE
          DELETE FROM conversation_logs l
          USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
          WHERE l.account_id = CONCAT('web:', doomed.id);
        END IF;
      END IF;

      IF to_regclass('public.messages') IS NOT NULL THEN
        IF to_regclass('public.accounts') IS NOT NULL THEN
          DELETE FROM messages m
          USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
          WHERE m.account_id IN (
            SELECT id FROM accounts WHERE owner_id = doomed.id
          )
             OR m.account_id = CONCAT('web:', doomed.id);
        ELSE
          DELETE FROM messages m
          USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
          WHERE m.account_id = CONCAT('web:', doomed.id);
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'messages' AND column_name = 'user_id'
        ) THEN
          DELETE FROM messages m
          USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
          WHERE m.user_id = doomed.id;
        END IF;
      END IF;

      IF to_regclass('public.chat_sessions') IS NOT NULL THEN
        IF to_regclass('public.accounts') IS NOT NULL THEN
          DELETE FROM chat_sessions s
          USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
          WHERE s.account_id IN (
            SELECT id FROM accounts WHERE owner_id = doomed.id
          )
             OR s.account_id = CONCAT('web:', doomed.id);
        ELSE
          DELETE FROM chat_sessions s
          USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
          WHERE s.account_id = CONCAT('web:', doomed.id);
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'chat_sessions' AND column_name = 'user_id'
        ) THEN
          DELETE FROM chat_sessions s
          USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
          WHERE s.user_id = doomed.id;
        END IF;
      END IF;
    END $$;
  `);
}

async function deleteInvalidPhoneUserCoreData(
  client: pg.PoolClient,
): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      IF to_regclass('pg_temp.${INVALID_PHONE_USER_DELETE_TEMP_TABLE}') IS NULL THEN
        RETURN;
      END IF;

      IF to_regclass('public.daily_usage') IS NOT NULL THEN
        DELETE FROM daily_usage u
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE u.user_id = doomed.id;
      END IF;

      IF to_regclass('public.user_skills') IS NOT NULL THEN
        DELETE FROM user_skills s
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE s.user_id = doomed.id;
      END IF;

      IF to_regclass('public.accounts') IS NOT NULL THEN
        DELETE FROM accounts a
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE a.owner_id = doomed.id;
      END IF;

      DELETE FROM users u
      USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
      WHERE u.id = doomed.id;

      DROP TABLE ${INVALID_PHONE_USER_DELETE_TEMP_TABLE};
    END $$;
  `);
}

/**
 * 记录本次将被硬删除的用户数量。
 *
 * @remarks 删除集为会话级临时表，可能在 users 表缺失时未创建；先探测存在性再计数，
 *   避免对不存在的临时表做 SELECT 时在解析阶段直接报错。计数 > 0 时打 warn 级留痕，
 *   让「破坏性删除究竟删了多少」始终可回溯。
 */
async function logInvalidPhoneUserDeleteCount(
  client: pg.PoolClient,
): Promise<void> {
  const { rows: existsRows } = await client.query<{ present: boolean }>(
    `SELECT to_regclass('pg_temp.${INVALID_PHONE_USER_DELETE_TEMP_TABLE}') IS NOT NULL AS present`,
  );
  if (!existsRows[0]?.present) return;

  const { rows } = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ${INVALID_PHONE_USER_DELETE_TEMP_TABLE}`,
  );
  const doomedCount = rows[0]?.n ?? 0;
  if (doomedCount > 0) {
    logger.warn(
      { doomedCount },
      '一次性清理：即将硬删除无有效手机号用户及其关联数据',
    );
  }
}

async function deleteUsersWithoutValidPhone(
  client: pg.PoolClient,
): Promise<void> {
  await createInvalidPhoneUserDeleteSet(client);
  await logInvalidPhoneUserDeleteCount(client);
  await deleteInvalidPhoneUserCommerceData(client);
  await deleteInvalidPhoneUserBillingData(client);
  await deleteInvalidPhoneUserRuntimeData(client);
  await deleteInvalidPhoneUserMessageData(client);
  await deleteInvalidPhoneUserCoreData(client);
}

/**
 * 一次性清理「无有效手机号」的历史脏用户及其关联数据。
 *
 * @remarks
 * 该删除逻辑原本被无条件放在每次进程启动路径（`db.ts` 的 `initDatabase`），
 * 本质是「手机号改造」上线时的一次性数据迁移，却被误当成永久启动逻辑：
 * 一旦守卫条件（大陆手机号正则 / OAuth 身份保留）被改动，或某类合法用户落入删除集，
 * 每次重启都会静默批量硬删除用户及其账务数据，是不可回溯的定时炸弹。
 *
 * 此处将其正式纳入迁移体系，借助 `schema_migrations` 幂等 + advisory lock 只执行一次，
 * 且整个删除跑在迁移的单一事务内（失败即回滚，具备原来 autocommit 逐语句执行所没有的原子性）。
 * 删除逻辑本身（含 OAuth 身份保留守卫与删除前计数告警）保持不变。
 *
 * 编号说明：基线已压平历史 0001-0067，远程 ledger 另有 0068-0070，故从 0071 续号。
 */
export const cleanupInvalidPhoneUsersMigration: DatabaseMigration = {
  id: '0071_cleanup_invalid_phone_users',
  description: '一次性清理无有效手机号的历史脏用户及其关联数据',
  up: async (client: pg.PoolClient): Promise<void> => {
    await deleteUsersWithoutValidPhone(client);
  },
};
