import { getAgentDbPool } from './agent-db.js';
import type { RuntimeModelPoolNode } from '@fateclaw/contracts/model-settings';

export interface ModelPoolClaim {
  generation: number;
  token: string | null;
  benefitAttemptId?: string;
}

export interface BenefitAttemptBudget {
  requestId: string;
  inputTokens: number;
  outputTokens: number;
}
export interface BenefitAttemptUsage {
  inputTokens: number;
  outputTokens: number;
  known: boolean;
  retryAfterSeconds?: number;
  cooldownReason?: 'rate_limit' | 'quota';
}

export interface ModelPoolHealthStore {
  claim(
    node: RuntimeModelPoolNode,
    token: string,
    budget?: BenefitAttemptBudget,
  ): Promise<ModelPoolClaim | null>;
  finish(
    node: RuntimeModelPoolNode,
    claim: ModelPoolClaim,
    outcome: 'success' | 'failure' | 'release',
    usage?: BenefitAttemptUsage,
  ): Promise<void>;
}

export const databaseModelPoolHealth: ModelPoolHealthStore = {
  async claim(node, token, budget) {
    if (node.poolKey === 'benefit') {
      if (!budget) throw new Error('Benefit dispatch requires an allowance');
      const { rows } = await getAgentDbPool().query<{
        claim: ModelPoolClaim | null;
      }>('SELECT claim_benefit_attempt($1,$2,$3,$4,$5,$6) AS claim', [
        budget.requestId,
        node.modelConfigId,
        node.revision,
        token,
        budget.inputTokens,
        budget.outputTokens,
      ]);
      return rows[0]?.claim ?? null;
    }
    const { rows } = await getAgentDbPool().query<ModelPoolClaim>(
      `UPDATE official_model_pool_nodes node SET
         probe_token=CASE WHEN node.cooldown_until IS NOT NULL THEN $3 ELSE NULL END,
         probe_until=CASE WHEN node.cooldown_until IS NOT NULL THEN now()+interval '200 seconds' ELSE NULL END
       FROM official_model_configs model
       WHERE node.model_config_id=$1 AND node.revision=$2
         AND model.id=node.model_config_id AND model.enabled
         AND (node.cooldown_until IS NULL OR (node.cooldown_until<=now()
           AND (node.probe_until IS NULL OR node.probe_until<=now())))
       RETURNING node.health_generation AS generation, node.probe_token AS token`,
      [node.modelConfigId, node.revision, token],
    );
    return rows[0] ?? null;
  },
  async finish(node, claim, outcome, usage) {
    if (claim.benefitAttemptId) {
      if (!usage) throw new Error('Benefit settlement is missing usage');
      await getAgentDbPool().query(
        'SELECT settle_benefit_attempt($1,$2,$3,$4,$5,$6,$7)',
        [
          claim.benefitAttemptId,
          usage.inputTokens,
          usage.outputTokens,
          usage.known,
          outcome,
          usage.retryAfterSeconds ?? null,
          usage.cooldownReason ?? null,
        ],
      );
      return;
    }
    await getAgentDbPool().query(
      `UPDATE official_model_pool_nodes SET
         health_generation=health_generation+CASE WHEN $5='failure' OR ($5='success' AND $4::text IS NOT NULL) THEN 1 ELSE 0 END,
         failure_count=CASE WHEN $5='failure' THEN failure_count+1 WHEN $5='success' THEN 0 ELSE failure_count END,
         cooldown_until=CASE WHEN $5='failure' THEN now()+make_interval(secs=>LEAST(300,30*power(2,LEAST(failure_count,4)))::int)
           WHEN $5='success' THEN NULL ELSE cooldown_until END,
         probe_token=NULL, probe_until=NULL
       WHERE model_config_id=$1 AND revision=$2 AND health_generation=$3
         AND probe_token IS NOT DISTINCT FROM $4::text`,
      [
        node.modelConfigId,
        node.revision,
        claim.generation,
        claim.token,
        outcome,
      ],
    );
  },
};
