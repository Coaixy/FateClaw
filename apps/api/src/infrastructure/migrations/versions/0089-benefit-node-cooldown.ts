import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const benefitNodeCooldownMigration: DatabaseMigration = {
  id: '0089_benefit_node_cooldown',
  description:
    'Replace manual upstream quotas with provider-driven node cooldowns',
  async up(client) {
    await client.query(`
      ALTER TABLE official_model_pool_nodes ADD COLUMN cooldown_reason text;
      UPDATE official_model_pool_nodes node SET cooldown_until=quota.cooldown_until,
        cooldown_reason=CASE WHEN quota.cooldown_reason='daily_quota' THEN 'quota' ELSE 'rate_limit' END
        FROM benefit_quota_groups quota WHERE node.quota_group_id=quota.id
          AND quota.cooldown_until>now()
          AND (node.cooldown_until IS NULL OR node.cooldown_until<quota.cooldown_until);

      CREATE OR REPLACE FUNCTION claim_benefit_attempt(p_request text,p_node text,p_revision integer,p_attempt text,
        p_input integer,p_output integer,p_probe boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $fn$
      DECLARE
        r benefit_requests%ROWTYPE; n official_model_pool_nodes%ROWTYPE;
        u benefit_daily_usage%ROWTYPE; token text;
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
        SELECT node.* INTO n FROM official_model_pool_nodes node JOIN official_model_configs model ON model.id=node.model_config_id
          WHERE node.model_config_id=p_node AND node.revision=p_revision AND node.pool_id='benefit' AND model.enabled
            AND (node.cooldown_until IS NULL OR (node.cooldown_until<=now() AND (node.probe_until IS NULL OR node.probe_until<=now())))
          FOR UPDATE OF node;
        IF NOT FOUND THEN RETURN NULL; END IF;
        token:=CASE WHEN n.cooldown_until IS NOT NULL THEN p_attempt ELSE NULL END;
        INSERT INTO benefit_model_attempts(id,request_id,node_id,is_probe,input_tokens,output_tokens,health_generation,probe_token)
          VALUES(p_attempt,p_request,p_node,p_probe,p_input,p_output,n.health_generation,token) ON CONFLICT DO NOTHING;
        IF NOT FOUND THEN RETURN NULL; END IF;
        IF NOT p_probe THEN
          UPDATE benefit_requests SET model_calls=model_calls+1,input_tokens=input_tokens+p_input,output_tokens=output_tokens+p_output WHERE request_id=p_request;
          UPDATE benefit_daily_usage SET input_tokens=input_tokens+p_input,output_tokens=output_tokens+p_output WHERE user_id=r.user_id AND allowance_date=r.allowance_date;
        END IF;
        UPDATE official_model_pool_nodes SET probe_token=token,probe_until=CASE WHEN token IS NOT NULL THEN now()+interval '200 seconds' ELSE NULL END WHERE model_config_id=p_node;
        RETURN jsonb_build_object('generation',n.health_generation,'token',token,'benefitAttemptId',p_attempt);
      END $fn$;

      DROP FUNCTION settle_benefit_attempt(text,integer,integer,boolean,text,integer);
      CREATE FUNCTION settle_benefit_attempt(p_attempt text,p_input integer,p_output integer,p_known boolean,
        p_outcome text,p_retry_seconds integer DEFAULT NULL,p_cooldown_reason text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql AS $fn$
      DECLARE a benefit_model_attempts%ROWTYPE; r benefit_requests%ROWTYPE;
      BEGIN
        SELECT * INTO a FROM benefit_model_attempts WHERE id=p_attempt FOR UPDATE;
        IF NOT FOUND THEN RETURN false; END IF;
        IF a.state<>'reserved' THEN RETURN true; END IF;
        IF NOT a.is_probe THEN
          SELECT * INTO r FROM benefit_requests WHERE request_id=a.request_id FOR UPDATE;
          PERFORM 1 FROM benefit_daily_usage WHERE user_id=r.user_id AND allowance_date=r.allowance_date FOR UPDATE;
          IF p_known THEN
            UPDATE benefit_requests SET input_tokens=GREATEST(0,input_tokens+GREATEST(0,p_input)-a.input_tokens),
              output_tokens=GREATEST(0,output_tokens+GREATEST(0,p_output)-a.output_tokens) WHERE request_id=a.request_id;
            UPDATE benefit_daily_usage SET input_tokens=GREATEST(0,input_tokens+GREATEST(0,p_input)-a.input_tokens),
              output_tokens=GREATEST(0,output_tokens+GREATEST(0,p_output)-a.output_tokens) WHERE user_id=r.user_id AND allowance_date=r.allowance_date;
          END IF;
        END IF;
        UPDATE benefit_model_attempts SET state=CASE WHEN p_known THEN 'settled' ELSE 'usage_unknown' END,
          input_tokens=CASE WHEN p_known THEN GREATEST(0,p_input) ELSE input_tokens END,
          output_tokens=CASE WHEN p_known THEN GREATEST(0,p_output) ELSE output_tokens END,
          outcome=p_outcome,completed_at=now() WHERE id=p_attempt;
        UPDATE official_model_pool_nodes SET
          health_generation=health_generation+CASE WHEN p_outcome='failure' OR (p_outcome='success' AND a.probe_token IS NOT NULL) THEN 1 ELSE 0 END,
          failure_count=CASE WHEN p_outcome='failure' THEN failure_count+1 WHEN p_outcome='success' THEN 0 ELSE failure_count END,
          cooldown_until=CASE WHEN p_outcome='failure' THEN GREATEST(COALESCE(cooldown_until,now()),
            now()+make_interval(secs=>CASE WHEN p_retry_seconds IS NOT NULL THEN LEAST(86400,GREATEST(1,p_retry_seconds))
              ELSE LEAST(300,30*power(2,LEAST(failure_count,4)))::integer END))
            WHEN p_outcome='success' THEN NULL ELSE cooldown_until END,
          cooldown_reason=CASE WHEN p_outcome='failure' THEN COALESCE(p_cooldown_reason,'provider_failure')
            WHEN p_outcome='success' THEN NULL ELSE cooldown_reason END,
          probe_token=NULL,probe_until=NULL
          WHERE model_config_id=a.node_id AND pool_id='benefit' AND health_generation=a.health_generation
            AND probe_token IS NOT DISTINCT FROM a.probe_token;
        RETURN true;
      END $fn$;

      ALTER TABLE official_model_pool_nodes DROP CONSTRAINT benefit_node_requires_quota, DROP COLUMN quota_group_id;
      ALTER TABLE benefit_model_attempts DROP COLUMN quota_group_id, DROP COLUMN day_start, DROP COLUMN minute_start;
      DROP TABLE benefit_quota_groups;
    `);
  },
};
