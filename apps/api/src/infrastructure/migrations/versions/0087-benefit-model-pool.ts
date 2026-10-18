import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const benefitModelPoolMigration: DatabaseMigration = {
  id: '0087_benefit_model_pool',
  description:
    'Add isolated benefit supply, durable allowances and shared attempt budgets',
  async up(client) {
    await client.query(`
      ALTER TABLE official_model_pool_settings DROP CONSTRAINT official_model_pool_settings_id_check;
      ALTER TABLE official_model_pool_settings ADD CONSTRAINT official_model_pool_settings_id_check CHECK (id IN ('default','benefit'));
      ALTER TABLE official_model_pool_settings ADD COLUMN enabled boolean NOT NULL DEFAULT true,
        ADD COLUMN revision integer NOT NULL DEFAULT 1, ADD COLUMN benefit_policy jsonb;
      INSERT INTO official_model_pool_settings (id,public_model_id,model_key,display_name,thinking_level,enabled,benefit_policy,updated_at)
        VALUES ('benefit','benefit-model-pool','benefit','免费模型','off',false,'{"daily_turns":3,"concurrency_limit":2,"queue_limit":20,"queue_timeout_seconds":30,"execution_timeout_seconds":180,"max_model_calls":4,"max_tool_calls":4,"max_input_tokens":16384,"max_total_input_tokens":65536,"max_output_tokens":2048,"max_total_output_tokens":4096}',TIMESTAMPTZ '2026-10-16 00:00:00+00');
      CREATE TABLE benefit_quota_groups (
        id text PRIMARY KEY, display_name text NOT NULL,
        requests_per_minute integer NOT NULL CHECK(requests_per_minute>0),
        requests_per_day integer NOT NULL CHECK(requests_per_day>0),
        tokens_per_minute integer NOT NULL CHECK(tokens_per_minute>0),
        tokens_per_day integer NOT NULL CHECK(tokens_per_day>0),
        reset_timezone text NOT NULL DEFAULT 'UTC', expires_at timestamptz,
        approved boolean NOT NULL DEFAULT false, archived boolean NOT NULL DEFAULT false,
        day_start timestamptz, day_requests integer NOT NULL DEFAULT 0,
        day_tokens bigint NOT NULL DEFAULT 0, minute_start timestamptz,
        minute_requests integer NOT NULL DEFAULT 0, minute_tokens bigint NOT NULL DEFAULT 0,
        cooldown_until timestamptz, cooldown_reason text, updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE official_model_pool_nodes ADD COLUMN pool_id text NOT NULL DEFAULT 'default'
        REFERENCES official_model_pool_settings(id), ADD COLUMN quota_group_id text REFERENCES benefit_quota_groups(id),
        ADD CONSTRAINT model_pool_node_membership UNIQUE(pool_id,model_config_id),
        ADD CONSTRAINT benefit_node_requires_quota CHECK(pool_id<>'benefit' OR quota_group_id IS NOT NULL);
      ALTER TABLE official_model_pool_settings DROP CONSTRAINT official_model_pool_settings_primary_node_id_fkey;
      ALTER TABLE official_model_pool_settings ADD CONSTRAINT model_pool_primary_membership
        FOREIGN KEY(id,primary_node_id) REFERENCES official_model_pool_nodes(pool_id,model_config_id) ON DELETE RESTRICT;
      ALTER TABLE chat_sessions ADD COLUMN model_pool_key text NOT NULL DEFAULT 'official' CHECK(model_pool_key IN ('official','benefit'));
      CREATE TABLE user_model_preferences (user_id text PRIMARY KEY REFERENCES users(id),
        pool_key text NOT NULL CHECK(pool_key IN ('official','benefit')), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE benefit_daily_usage (user_id text NOT NULL REFERENCES users(id), allowance_date date NOT NULL,
        consumed_turns integer NOT NULL DEFAULT 0 CHECK(consumed_turns>=0),
        reserved_turns integer NOT NULL DEFAULT 0 CHECK(reserved_turns>=0),
        input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id,allowance_date));
      CREATE TABLE benefit_requests (request_id text PRIMARY KEY REFERENCES agent_requests(request_id),
        user_id text NOT NULL REFERENCES users(id), allowance_date date NOT NULL, policy jsonb NOT NULL,
        state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','running','consumed','released')),
        created_at timestamptz NOT NULL DEFAULT now(), queue_deadline_at timestamptz NOT NULL,
        slot_claimed_at timestamptz, execution_deadline_at timestamptz,
        model_calls integer NOT NULL DEFAULT 0, tool_calls integer NOT NULL DEFAULT 0,
        input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0,
        answer_visible boolean NOT NULL DEFAULT false,
        FOREIGN KEY(user_id,allowance_date) REFERENCES benefit_daily_usage(user_id,allowance_date));
      CREATE INDEX benefit_requests_active ON benefit_requests(created_at) WHERE state IN ('reserved','running');
      CREATE TABLE benefit_model_attempts (id text PRIMARY KEY,
        request_id text REFERENCES benefit_requests(request_id), node_id text NOT NULL,
        quota_group_id text NOT NULL REFERENCES benefit_quota_groups(id),
        is_probe boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
        day_start timestamptz NOT NULL, minute_start timestamptz NOT NULL,
        input_tokens bigint NOT NULL, output_tokens bigint NOT NULL,
        state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','usage_unknown')),
        health_generation integer NOT NULL, probe_token text, outcome text, completed_at timestamptz);
      CREATE INDEX benefit_attempts_probe_budget ON benefit_model_attempts(quota_group_id,created_at) WHERE is_probe;
      CREATE INDEX benefit_attempts_recent_success ON benefit_model_attempts(completed_at DESC) WHERE outcome='success' AND NOT is_probe;
      ALTER TABLE ai_service_status_schedule DROP CONSTRAINT ai_service_status_schedule_id_check;
      ALTER TABLE ai_service_status_schedule ADD CONSTRAINT ai_service_status_schedule_id_check CHECK(id IN ('ai','benefit'));
      INSERT INTO ai_service_status_schedule(id) VALUES ('benefit');
      ALTER TABLE ai_service_status_checks ADD COLUMN pool_key text NOT NULL DEFAULT 'official'
        CHECK(pool_key IN ('official','benefit'));
      ALTER TABLE ai_service_status_checks DROP CONSTRAINT ai_service_status_checks_pkey;
      ALTER TABLE ai_service_status_checks ADD PRIMARY KEY(pool_key,checked_at);

      CREATE FUNCTION start_benefit_execution() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.state='running' AND OLD.state<>'running' THEN
          UPDATE benefit_requests SET state='running',execution_deadline_at=LEAST(NEW.deadline_at,
            now()+make_interval(secs=>(policy->>'execution_timeout_seconds')::integer))
            WHERE request_id=NEW.request_id AND state='reserved' AND slot_claimed_at IS NOT NULL;
          IF FOUND THEN
            SELECT execution_deadline_at INTO NEW.deadline_at FROM benefit_requests WHERE request_id=NEW.request_id;
          ELSIF NEW.runtime->>'poolKey'='benefit' THEN
            RAISE EXCEPTION 'Benefit execution has no owned allowance';
          END IF;
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER benefit_execution_boundary BEFORE UPDATE OF state ON agent_requests
        FOR EACH ROW EXECUTE FUNCTION start_benefit_execution();

      CREATE FUNCTION claim_benefit_attempt(p_request text,p_node text,p_revision integer,p_attempt text,
        p_input integer,p_output integer,p_probe boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $fn$
      DECLARE
        r benefit_requests%ROWTYPE; g benefit_quota_groups%ROWTYPE; n official_model_pool_nodes%ROWTYPE;
        u benefit_daily_usage%ROWTYPE; d timestamptz; m timestamptz; token text; generation integer;
      BEGIN
        PERFORM 1 FROM official_model_pool_settings WHERE id='benefit' AND enabled FOR SHARE;
        IF NOT FOUND OR p_input<0 OR p_output<1 THEN RETURN NULL; END IF;
        IF NOT p_probe THEN
          SELECT * INTO r FROM benefit_requests WHERE request_id=p_request FOR UPDATE;
          IF NOT FOUND OR r.state<>'running' OR r.execution_deadline_at<=now()
            OR NOT EXISTS(SELECT 1 FROM agent_requests WHERE request_id=p_request AND state='running' AND cancel_requested_at IS NULL)
            OR r.model_calls>=(r.policy->>'max_model_calls')::integer
            OR p_input>(r.policy->>'max_input_tokens')::integer
            OR p_output>(r.policy->>'max_output_tokens')::integer
            OR r.input_tokens+p_input>(r.policy->>'max_total_input_tokens')::integer
            OR r.output_tokens+p_output>(r.policy->>'max_total_output_tokens')::integer THEN RETURN NULL; END IF;
          SELECT * INTO u FROM benefit_daily_usage WHERE user_id=r.user_id AND allowance_date=r.allowance_date FOR UPDATE;
          IF u.input_tokens+p_input>(r.policy->>'daily_turns')::integer*(r.policy->>'max_total_input_tokens')::integer
            OR u.output_tokens+p_output>(r.policy->>'daily_turns')::integer*(r.policy->>'max_total_output_tokens')::integer THEN RETURN NULL; END IF;
        END IF;
        SELECT * INTO n FROM official_model_pool_nodes WHERE model_config_id=p_node AND revision=p_revision AND pool_id='benefit';
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT * INTO g FROM benefit_quota_groups WHERE id=n.quota_group_id FOR UPDATE;
        IF NOT FOUND OR NOT g.approved OR g.expires_at<=now() OR g.cooldown_until>now() THEN RETURN NULL; END IF;
        d:=date_trunc('day',now() AT TIME ZONE g.reset_timezone) AT TIME ZONE g.reset_timezone;
        m:=date_trunc('minute',now());
        IF g.day_start IS DISTINCT FROM d THEN g.day_requests:=0; g.day_tokens:=0; END IF;
        IF g.minute_start IS DISTINCT FROM m THEN g.minute_requests:=0; g.minute_tokens:=0; END IF;
        IF g.day_requests>=g.requests_per_day OR g.day_tokens+p_input+p_output>g.tokens_per_day
          OR g.minute_requests>=g.requests_per_minute OR g.minute_tokens+p_input+p_output>g.tokens_per_minute THEN RETURN NULL; END IF;
        IF p_probe AND (SELECT count(*) FROM benefit_model_attempts WHERE quota_group_id=g.id AND is_probe AND created_at>=d)>=4 THEN RETURN NULL; END IF;
        SELECT node.* INTO n FROM official_model_pool_nodes node JOIN official_model_configs model ON model.id=node.model_config_id
          WHERE node.model_config_id=p_node AND node.revision=p_revision AND node.pool_id='benefit' AND model.enabled
            AND (node.cooldown_until IS NULL OR (node.cooldown_until<=now() AND (node.probe_until IS NULL OR node.probe_until<=now())))
          FOR UPDATE OF node;
        IF NOT FOUND THEN RETURN NULL; END IF;
        generation:=n.health_generation;
        token:=CASE WHEN NOT p_probe AND n.cooldown_until IS NOT NULL THEN p_attempt ELSE NULL END;
        INSERT INTO benefit_model_attempts(id,request_id,node_id,quota_group_id,is_probe,day_start,minute_start,input_tokens,output_tokens,health_generation,probe_token)
          VALUES(p_attempt,p_request,p_node,g.id,p_probe,d,m,p_input,p_output,generation,token) ON CONFLICT DO NOTHING;
        IF NOT FOUND THEN RETURN NULL; END IF;
        UPDATE benefit_quota_groups SET day_start=d,day_requests=g.day_requests+1,day_tokens=g.day_tokens+p_input+p_output,
          minute_start=m,minute_requests=g.minute_requests+1,minute_tokens=g.minute_tokens+p_input+p_output WHERE id=g.id;
        IF NOT p_probe THEN
          UPDATE benefit_requests SET model_calls=model_calls+1,input_tokens=input_tokens+p_input,output_tokens=output_tokens+p_output WHERE request_id=p_request;
          UPDATE benefit_daily_usage SET input_tokens=input_tokens+p_input,output_tokens=output_tokens+p_output WHERE user_id=r.user_id AND allowance_date=r.allowance_date;
          UPDATE official_model_pool_nodes SET probe_token=token,probe_until=CASE WHEN token IS NOT NULL THEN now()+interval '200 seconds' ELSE NULL END WHERE model_config_id=p_node;
        END IF;
        RETURN jsonb_build_object('generation',generation,'token',token,'benefitAttemptId',p_attempt);
      END $fn$;

      CREATE FUNCTION settle_benefit_attempt(p_attempt text,p_input integer,p_output integer,p_known boolean,
        p_outcome text,p_retry_seconds integer DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql AS $fn$
      DECLARE a benefit_model_attempts%ROWTYPE; r benefit_requests%ROWTYPE; difference bigint;
      BEGIN
        SELECT * INTO a FROM benefit_model_attempts WHERE id=p_attempt FOR UPDATE;
        IF NOT FOUND THEN RETURN false; END IF;
        IF a.state<>'reserved' THEN RETURN true; END IF;
        IF NOT a.is_probe THEN
          SELECT * INTO r FROM benefit_requests WHERE request_id=a.request_id FOR UPDATE;
          PERFORM 1 FROM benefit_daily_usage WHERE user_id=r.user_id AND allowance_date=r.allowance_date FOR UPDATE;
        END IF;
        PERFORM 1 FROM benefit_quota_groups WHERE id=a.quota_group_id FOR UPDATE;
        IF p_known THEN
          difference:=GREATEST(0,p_input)+GREATEST(0,p_output)-a.input_tokens-a.output_tokens;
          UPDATE benefit_quota_groups SET
            day_tokens=GREATEST(0,day_tokens+CASE WHEN day_start=a.day_start THEN difference ELSE 0 END),
            minute_tokens=GREATEST(0,minute_tokens+CASE WHEN minute_start=a.minute_start THEN difference ELSE 0 END)
            WHERE id=a.quota_group_id;
          IF NOT a.is_probe THEN
            UPDATE benefit_requests SET input_tokens=GREATEST(0,input_tokens+p_input-a.input_tokens),
              output_tokens=GREATEST(0,output_tokens+p_output-a.output_tokens) WHERE request_id=a.request_id;
            UPDATE benefit_daily_usage SET input_tokens=GREATEST(0,input_tokens+p_input-a.input_tokens),
              output_tokens=GREATEST(0,output_tokens+p_output-a.output_tokens) WHERE user_id=r.user_id AND allowance_date=r.allowance_date;
          END IF;
        END IF;
        UPDATE benefit_model_attempts SET state=CASE WHEN p_known THEN 'settled' ELSE 'usage_unknown' END,
          input_tokens=CASE WHEN p_known THEN GREATEST(0,p_input) ELSE input_tokens END,
          output_tokens=CASE WHEN p_known THEN GREATEST(0,p_output) ELSE output_tokens END,
          outcome=p_outcome,completed_at=now() WHERE id=p_attempt;
        IF p_retry_seconds IS NOT NULL THEN
          UPDATE benefit_quota_groups SET cooldown_until=GREATEST(COALESCE(cooldown_until,now()),
            CASE WHEN p_retry_seconds<0 THEN ((now() AT TIME ZONE reset_timezone)::date+1)::timestamp AT TIME ZONE reset_timezone
            ELSE now()+make_interval(secs=>LEAST(86400,GREATEST(1,p_retry_seconds))) END),
            cooldown_reason=CASE WHEN p_retry_seconds<0 THEN 'daily_quota' ELSE 'rate_limit' END WHERE id=a.quota_group_id;
        END IF;
        IF NOT a.is_probe THEN
          UPDATE official_model_pool_nodes SET
            health_generation=health_generation+CASE WHEN p_outcome='failure' OR (p_outcome='success' AND a.probe_token IS NOT NULL) THEN 1 ELSE 0 END,
            failure_count=CASE WHEN p_outcome='failure' THEN failure_count+1 WHEN p_outcome='success' THEN 0 ELSE failure_count END,
            cooldown_until=CASE WHEN p_outcome='failure' THEN now()+make_interval(secs=>LEAST(300,30*power(2,LEAST(failure_count,4)))::integer) WHEN p_outcome='success' THEN NULL ELSE cooldown_until END,
            probe_token=NULL,probe_until=NULL
            WHERE model_config_id=a.node_id AND health_generation=a.health_generation AND probe_token IS NOT DISTINCT FROM a.probe_token;
        END IF;
        RETURN true;
      END $fn$;
    `);
  },
};
