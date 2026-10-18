import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const registrationInviteTiersMigration: DatabaseMigration = {
  id: '0093_registration_invite_tiers',
  description:
    'Use cumulative recharge tiers for registration invitation capacity',
  async up(client) {
    await client.query(`
      CREATE FUNCTION public.registration_invite_tiers_valid(value jsonb)
      RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
      DECLARE
        tier jsonb;
        threshold numeric;
        slots numeric;
        previous_threshold numeric := 0;
        previous_slots numeric := 0;
      BEGIN
        IF jsonb_typeof(value) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
        IF jsonb_array_length(value) NOT BETWEEN 1 AND 10 THEN RETURN false; END IF;
        FOR tier IN SELECT jsonb_array_elements(value) LOOP
          IF jsonb_typeof(tier) IS DISTINCT FROM 'object'
             OR jsonb_typeof(tier->'threshold_cents') IS DISTINCT FROM 'number'
             OR jsonb_typeof(tier->'total_slots') IS DISTINCT FROM 'number'
          THEN RETURN false; END IF;
          threshold := (tier->>'threshold_cents')::numeric;
          slots := (tier->>'total_slots')::numeric;
          IF threshold <> trunc(threshold) OR threshold NOT BETWEEN 1 AND 100000000
             OR slots <> trunc(slots) OR slots NOT BETWEEN 1 AND 1000
             OR threshold <= previous_threshold OR slots <= previous_slots
          THEN RETURN false; END IF;
          previous_threshold := threshold;
          previous_slots := slots;
        END LOOP;
        RETURN true;
      END $$;

      ALTER TABLE public.registration_invite_policy
        ADD COLUMN tiers jsonb NOT NULL DEFAULT
          '[{"threshold_cents":3000,"total_slots":3},{"threshold_cents":10000,"total_slots":5},{"threshold_cents":30000,"total_slots":10}]'::jsonb
          CHECK (public.registration_invite_tiers_valid(tiers)),
        DROP COLUMN threshold_cents,
        DROP COLUMN default_slots;
      UPDATE public.registration_invite_policy SET revision=revision+1;

      ALTER TABLE public.registration_invite_accounts
        DROP CONSTRAINT registration_invite_accounts_check,
        ADD CONSTRAINT registration_invite_manual_adjustment_range
          CHECK (extra_slots BETWEEN -1000 AND 1000);

      CREATE FUNCTION public.registration_invite_tier_slots(net_cents bigint)
      RETURNS integer LANGUAGE sql STABLE AS $$
        SELECT COALESCE(MAX((tier->>'total_slots')::integer),0)
        FROM public.registration_invite_policy p,
          LATERAL jsonb_array_elements(p.tiers) AS tier
        WHERE net_cents >= (tier->>'threshold_cents')::bigint
      $$;

      CREATE OR REPLACE FUNCTION public.reconcile_registration_invites(p_user_id text)
      RETURNS void LANGUAGE plpgsql AS $$
      DECLARE
        automatic_slots integer;
        adjustment integer;
        used_slots integer;
        remaining_slots integer;
      BEGIN
        -- Keep the foreign-key KEY SHARE compatibility established by 0092.
        PERFORM id FROM public.users WHERE id=p_user_id FOR NO KEY UPDATE;
        IF NOT FOUND THEN RETURN; END IF;
        -- Every read and reservation in this transaction must use one policy version.
        PERFORM id FROM public.registration_invite_policy FOR SHARE;
        INSERT INTO public.registration_invite_accounts(user_id) VALUES(p_user_id)
          ON CONFLICT DO NOTHING;
        automatic_slots := public.registration_invite_tier_slots(
          public.registration_net_recharge_cents(p_user_id));
        UPDATE public.registration_invite_accounts
          SET base_slots=automatic_slots,
              base_granted_at=CASE WHEN automatic_slots > 0
                THEN COALESCE(base_granted_at,clock_timestamp()) ELSE base_granted_at END,
              revision=revision+1
          WHERE user_id=p_user_id AND base_slots<>automatic_slots;
        SELECT extra_slots INTO STRICT adjustment
          FROM public.registration_invite_accounts WHERE user_id=p_user_id;
        SELECT count(*)::integer INTO used_slots FROM public.registration_invites
          WHERE inviter_user_id=p_user_id AND status='used';
        remaining_slots := CASE WHEN automatic_slots=0 THEN 0 ELSE
          GREATEST(0,LEAST(1000,GREATEST(0,automatic_slots+adjustment))-used_slots) END;

        -- Preserve older shared links when a downgrade removes unused capacity.
        WITH excess AS (
          SELECT id FROM public.registration_invites
          WHERE inviter_user_id=p_user_id AND status='active'
            AND expires_at>clock_timestamp()
          ORDER BY created_at,id OFFSET remaining_slots
        )
        UPDATE public.registration_invites SET status='revoked'
          WHERE id IN (SELECT id FROM excess);
      END $$;

      DO $$
      DECLARE owner_id text;
      BEGIN
        FOR owner_id IN
          SELECT user_id FROM public.registration_invite_accounts
          UNION SELECT user_id FROM public.recharge_orders WHERE status='paid'
          ORDER BY 1
        LOOP
          PERFORM public.reconcile_registration_invites(owner_id);
        END LOOP;
      END $$;
    `);
  },
};
