import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const registrationInvitesMigration: DatabaseMigration = {
  id: '0092_registration_invites',
  description:
    'Require one-use registration invitations with paid-user allowances',
  async up(client) {
    await client.query(`
      CREATE TABLE public.registration_invite_policy (
        id boolean PRIMARY KEY DEFAULT true CHECK (id),
        threshold_cents bigint NOT NULL DEFAULT 10000 CHECK (threshold_cents BETWEEN 1 AND 100000000),
        default_slots integer NOT NULL DEFAULT 3 CHECK (default_slots BETWEEN 0 AND 1000),
        expires_in_days integer NOT NULL DEFAULT 7 CHECK (expires_in_days BETWEEN 1 AND 90),
        revision integer NOT NULL DEFAULT 1 CHECK (revision > 0)
      );
      INSERT INTO public.registration_invite_policy(id) VALUES(true);

      CREATE TABLE public.registration_invite_accounts (
        user_id text PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
        base_slots integer NOT NULL DEFAULT 0 CHECK (base_slots BETWEEN 0 AND 1000),
        extra_slots integer NOT NULL DEFAULT 0,
        base_granted_at timestamptz,
        suspended boolean NOT NULL DEFAULT false,
        revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
        CHECK (base_slots + extra_slots BETWEEN 0 AND 1000)
      );
      CREATE TABLE public.registration_invites (
        id text PRIMARY KEY,
        code_hash text NOT NULL UNIQUE,
        code_suffix text NOT NULL,
        source text NOT NULL CHECK (source IN ('user','admin')),
        inviter_user_id text REFERENCES public.users(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','revoked')),
        expires_at timestamptz NOT NULL,
        used_by_user_id text UNIQUE REFERENCES public.users(id) ON DELETE SET NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK ((source = 'user' AND inviter_user_id IS NOT NULL) OR
               (source = 'admin' AND inviter_user_id IS NULL)),
        CHECK ((status = 'used') = (used_at IS NOT NULL))
      );
      CREATE INDEX registration_invites_owner ON public.registration_invites(inviter_user_id, created_at DESC);
      CREATE INDEX registration_invites_recent ON public.registration_invites(created_at DESC);
      CREATE TABLE public.completed_recharge_refunds (
        id text PRIMARY KEY,
        recharge_order_id text NOT NULL REFERENCES public.recharge_orders(id) ON DELETE CASCADE,
        amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
        reference text NOT NULL UNIQUE,
        reason text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX completed_recharge_refunds_order ON public.completed_recharge_refunds(recharge_order_id);

      CREATE FUNCTION public.registration_net_recharge_cents(p_user_id text)
      RETURNS bigint LANGUAGE sql STABLE AS $$
        SELECT (
          COALESCE((SELECT SUM(amount_coins * 100) FROM public.recharge_orders
                    WHERE user_id = p_user_id AND status = 'paid'), 0)
          - COALESCE((SELECT SUM(r.amount_cents) FROM public.completed_recharge_refunds r
                      JOIN public.recharge_orders o ON o.id = r.recharge_order_id
                      WHERE o.user_id = p_user_id), 0)
        )::bigint
      $$;

      CREATE FUNCTION public.reconcile_registration_invites(p_user_id text)
      RETURNS void LANGUAGE plpgsql AS $$
      DECLARE
        policy public.registration_invite_policy%ROWTYPE;
        net_cents bigint;
      BEGIN
        -- Retain foreign-key KEY SHARE compatibility while serializing account mutations.
        PERFORM id FROM public.users WHERE id = p_user_id FOR NO KEY UPDATE;
        IF NOT FOUND THEN RETURN; END IF;
        INSERT INTO public.registration_invite_accounts(user_id) VALUES(p_user_id)
          ON CONFLICT DO NOTHING;
        SELECT * INTO STRICT policy FROM public.registration_invite_policy;
        net_cents := public.registration_net_recharge_cents(p_user_id);
        IF net_cents >= policy.threshold_cents THEN
          UPDATE public.registration_invite_accounts
            SET base_slots = LEAST(policy.default_slots, 1000 - extra_slots),
                base_granted_at = clock_timestamp(), revision = revision + 1
            WHERE user_id = p_user_id AND base_granted_at IS NULL;
        END IF;
      END $$;

      CREATE FUNCTION public.reconcile_registration_invites_after_recharge()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM public.reconcile_registration_invites(NEW.user_id);
        RETURN NEW;
      END $$;
      CREATE TRIGGER registration_invite_recharge_qualification
        AFTER INSERT OR UPDATE OF status, amount_coins ON public.recharge_orders
        FOR EACH ROW EXECUTE FUNCTION public.reconcile_registration_invites_after_recharge();

      INSERT INTO public.registration_invite_accounts(user_id, base_slots, base_granted_at)
        SELECT u.id, 3, '2026-10-17T00:00:00Z'::timestamptz FROM public.users u
        WHERE public.registration_net_recharge_cents(u.id) >= 10000;
    `);
  },
};
