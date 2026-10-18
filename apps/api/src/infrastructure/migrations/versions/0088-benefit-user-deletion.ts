import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const benefitUserDeletionMigration: DatabaseMigration = {
  id: '0088_benefit_user_deletion',
  description:
    'Cascade personal benefit records while retaining shared attempt accounting',
  async up(client) {
    await client.query(`
      ALTER TABLE user_model_preferences
        DROP CONSTRAINT user_model_preferences_user_id_fkey,
        ADD CONSTRAINT user_model_preferences_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
      ALTER TABLE benefit_daily_usage
        DROP CONSTRAINT benefit_daily_usage_user_id_fkey,
        ADD CONSTRAINT benefit_daily_usage_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
      ALTER TABLE benefit_requests
        DROP CONSTRAINT benefit_requests_user_id_fkey,
        ADD CONSTRAINT benefit_requests_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

      -- Attempts own shared reservations that can settle after account deletion.
      ALTER TABLE benefit_model_attempts
        DROP CONSTRAINT benefit_model_attempts_request_id_fkey,
        ADD CONSTRAINT benefit_model_attempts_request_id_fkey
          FOREIGN KEY (request_id) REFERENCES benefit_requests(request_id) ON DELETE SET NULL;
      CREATE INDEX benefit_requests_user_allowance ON benefit_requests(user_id, allowance_date);
      CREATE INDEX benefit_attempts_request ON benefit_model_attempts(request_id);
    `);
  },
};
