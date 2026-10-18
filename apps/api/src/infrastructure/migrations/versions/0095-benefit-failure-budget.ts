import type { DatabaseMigration } from '../types.js';

export const benefitFailureBudgetMigration: DatabaseMigration = {
  id: '0095_benefit_failure_budget',
  description:
    'Bound refunded provider attempts and confirm shared node failures',
  async up(client) {
    await client.query(`
      ALTER TABLE benefit_daily_usage
        ADD COLUMN failed_turns integer NOT NULL DEFAULT 0 CHECK (failed_turns >= 0),
        ADD COLUMN retry_after_at timestamptz;
      UPDATE benefit_daily_usage usage SET failed_turns=failed.count
        FROM (SELECT user_id,allowance_date,count(*)::integer AS count FROM benefit_requests
          WHERE state='released' AND model_calls>0 GROUP BY user_id,allowance_date) failed
        WHERE usage.user_id=failed.user_id AND usage.allowance_date=failed.allowance_date;

      CREATE OR REPLACE FUNCTION settle_benefit_attempt(p_attempt text,p_input integer,p_output integer,p_known boolean,
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
          cooldown_until=CASE WHEN p_outcome='failure' AND
            (p_cooldown_reason IN ('quota','rate_limit') OR failure_count>=2 OR a.probe_token IS NOT NULL)
            THEN GREATEST(COALESCE(cooldown_until,now()),
              now()+make_interval(secs=>CASE WHEN p_retry_seconds IS NOT NULL THEN LEAST(86400,GREATEST(1,p_retry_seconds))
                ELSE LEAST(300,30*power(2,LEAST(GREATEST(0,failure_count-2),4)))::integer END))
            WHEN p_outcome='success' THEN NULL ELSE cooldown_until END,
          cooldown_reason=CASE WHEN p_outcome='failure' AND
            (p_cooldown_reason IN ('quota','rate_limit') OR failure_count>=2 OR a.probe_token IS NOT NULL)
            THEN COALESCE(p_cooldown_reason,'provider_failure')
            WHEN p_outcome='success' THEN NULL ELSE cooldown_reason END,
          probe_token=NULL,probe_until=NULL
          WHERE model_config_id=a.node_id AND pool_id='benefit' AND health_generation=a.health_generation
            AND probe_token IS NOT DISTINCT FROM a.probe_token;
        RETURN true;
      END $fn$;
    `);
  },
};
