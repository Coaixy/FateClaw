import type pg from 'pg';

const INVALID_PHONE_USER_DELETE_TEMP_TABLE = 'users_without_valid_phone';

async function createInvalidPhoneUserDeleteSet(
  client: pg.PoolClient,
): Promise<void> {
  await client.query(`
    DO $$
    DECLARE
      has_phone BOOLEAN;
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

        CREATE TEMP TABLE ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} AS
          SELECT id FROM users WHERE NOT has_phone;

        IF has_phone THEN
          INSERT INTO ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} (id)
          SELECT id
          FROM users
          WHERE phone IS NULL
             OR phone !~ '^1[3-9][0-9]{9}$';
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

      IF to_regclass('public.creator_withdrawals') IS NOT NULL THEN
        DELETE FROM creator_withdrawals w
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE w.creator_id = doomed.id;
      END IF;

      IF to_regclass('public.creator_earnings_monthly') IS NOT NULL THEN
        DELETE FROM creator_earnings_monthly e
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE e.creator_id = doomed.id;
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

      IF to_regclass('public.task_run_logs') IS NOT NULL
         AND to_regclass('public.scheduled_tasks') IS NOT NULL
         AND to_regclass('public.accounts') IS NOT NULL THEN
        DELETE FROM task_run_logs l
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE l.task_id IN (
          SELECT t.id
          FROM scheduled_tasks t
          JOIN accounts a ON a.id = t.account_id
          WHERE a.owner_id = doomed.id
        );
      END IF;

      IF to_regclass('public.scheduled_tasks') IS NOT NULL
         AND to_regclass('public.accounts') IS NOT NULL THEN
        DELETE FROM scheduled_tasks t
        USING ${INVALID_PHONE_USER_DELETE_TEMP_TABLE} doomed
        WHERE t.account_id IN (
          SELECT id FROM accounts WHERE owner_id = doomed.id
        );
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

export async function deleteUsersWithoutValidPhone(
  client: pg.PoolClient,
): Promise<void> {
  await createInvalidPhoneUserDeleteSet(client);
  await deleteInvalidPhoneUserCommerceData(client);
  await deleteInvalidPhoneUserBillingData(client);
  await deleteInvalidPhoneUserRuntimeData(client);
  await deleteInvalidPhoneUserMessageData(client);
  await deleteInvalidPhoneUserCoreData(client);
}
