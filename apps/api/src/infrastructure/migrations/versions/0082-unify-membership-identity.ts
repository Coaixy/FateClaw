import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const unifyMembershipIdentityMigration: DatabaseMigration = {
  id: '0082_unify_membership_identity',
  description: 'Use one membership identity without historical tier names',
  async up(client) {
    // Rename in place so prices, sale status, membership periods and audit fields survive.
    await client.query(`
      UPDATE public.membership_config
      SET id = 'membership',
          name = CASE WHEN name = 'FateClaw Clarity' THEN '卦师使用权' ELSE name END
      WHERE id = 'fateclaw_clarity'
    `);
    await client.query(`
      UPDATE public.user_memberships
      SET plan_key = 'membership'
      WHERE plan_key <> 'membership'
    `);
    await client.query(`
      ALTER TABLE public.user_memberships
        ALTER COLUMN plan_key SET DEFAULT 'membership',
        ADD CONSTRAINT user_memberships_identity CHECK (plan_key = 'membership');
      ALTER TABLE public.membership_config
        ADD CONSTRAINT membership_config_identity CHECK (id = 'membership')
    `);
  },
};
