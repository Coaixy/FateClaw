import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const benefitTurnsAndConcurrencyMigration: DatabaseMigration = {
  id: '0090_benefit_turns_and_concurrency',
  description: 'Limit free service by daily turns and concurrency only',
  async up(client) {
    await client.query(`
      UPDATE official_model_pool_settings SET benefit_policy=jsonb_build_object(
        'daily_turns',benefit_policy->'daily_turns',
        'concurrency_limit',benefit_policy->'concurrency_limit'),
        revision=revision+1 WHERE id='benefit';
      UPDATE benefit_requests SET policy=jsonb_build_object(
        'daily_turns',policy->'daily_turns',
        'concurrency_limit',policy->'concurrency_limit') WHERE state IN ('reserved','running');
      UPDATE benefit_requests request SET queue_deadline_at=agent.deadline_at
        FROM agent_requests agent WHERE agent.request_id=request.request_id AND request.state='reserved';
      UPDATE benefit_requests request SET execution_deadline_at=agent.deadline_at
        FROM agent_requests agent WHERE agent.request_id=request.request_id AND request.state='running';

      CREATE OR REPLACE FUNCTION start_benefit_execution() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.state='running' AND OLD.state<>'running' THEN
          UPDATE benefit_requests SET state='running',execution_deadline_at=NEW.deadline_at
            WHERE request_id=NEW.request_id AND state='reserved' AND slot_claimed_at IS NOT NULL;
          IF NOT FOUND AND NEW.runtime->>'poolKey'='benefit' THEN
            RAISE EXCEPTION 'Benefit execution has no owned allowance';
          END IF;
        END IF;
        RETURN NEW;
      END $fn$;

      DROP FUNCTION claim_benefit_attempt(text,text,integer,text,integer,integer,boolean);
      CREATE FUNCTION claim_benefit_attempt(p_request text,p_node text,p_revision integer,p_attempt text,
        p_probe boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $fn$
      DECLARE r benefit_requests%ROWTYPE; n official_model_pool_nodes%ROWTYPE; token text;
      BEGIN
        PERFORM 1 FROM official_model_pool_settings WHERE id='benefit' AND enabled FOR SHARE;
        IF NOT FOUND THEN RETURN NULL; END IF;
        IF NOT p_probe THEN
          SELECT * INTO r FROM benefit_requests WHERE request_id=p_request FOR UPDATE;
          IF NOT FOUND OR r.state<>'running' OR r.execution_deadline_at<=now()
            OR NOT EXISTS(SELECT 1 FROM agent_requests WHERE request_id=p_request AND state='running' AND cancel_requested_at IS NULL)
            THEN RETURN NULL; END IF;
        END IF;
        SELECT node.* INTO n FROM official_model_pool_nodes node JOIN official_model_configs model ON model.id=node.model_config_id
          WHERE node.model_config_id=p_node AND node.revision=p_revision AND node.pool_id='benefit' AND model.enabled
            AND (node.cooldown_until IS NULL OR (node.cooldown_until<=now() AND (node.probe_until IS NULL OR node.probe_until<=now())))
          FOR UPDATE OF node;
        IF NOT FOUND THEN RETURN NULL; END IF;
        token:=CASE WHEN n.cooldown_until IS NOT NULL THEN p_attempt ELSE NULL END;
        INSERT INTO benefit_model_attempts(id,request_id,node_id,is_probe,input_tokens,output_tokens,health_generation,probe_token)
          VALUES(p_attempt,p_request,p_node,p_probe,0,0,n.health_generation,token) ON CONFLICT DO NOTHING;
        IF NOT FOUND THEN RETURN NULL; END IF;
        IF NOT p_probe THEN
          UPDATE benefit_requests SET model_calls=model_calls+1 WHERE request_id=p_request;
        END IF;
        UPDATE official_model_pool_nodes SET probe_token=token,
          probe_until=CASE WHEN token IS NOT NULL THEN now()+interval '200 seconds' ELSE NULL END WHERE model_config_id=p_node;
        RETURN jsonb_build_object('generation',n.health_generation,'token',token,'benefitAttemptId',p_attempt);
      END $fn$;
    `);
  },
};
