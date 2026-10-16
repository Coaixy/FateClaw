import type { Context } from '@earendil-works/pi-ai';
import type { LlmRuntimeSnapshot } from './types.js';
import { getAgentDbPool } from './agent-db.js';

export async function benefitCallBudget(
  runtime: LlmRuntimeSnapshot,
  context: Context,
  trace?: (event: Record<string, unknown>) => void,
) {
  if (runtime.poolKey !== 'benefit') return undefined;
  if (!runtime.benefitRequestId || !runtime.benefitPolicy)
    throw new Error('Benefit request is missing its allowance');
  // A byte bound intentionally overestimates unknown provider tokenizers, including tool schemas.
  const inputTokens = Buffer.byteLength(JSON.stringify(context), 'utf8') + 512;
  trace?.({
    type: 'benefit_input_budget_checked',
    inputTokenUpperBound: inputTokens,
    maxInputTokens: runtime.benefitPolicy.max_input_tokens,
  });
  const { rows } = await getAgentDbPool().query(
    `SELECT output_tokens,execution_deadline_at FROM benefit_requests
    WHERE request_id=$1 AND state='running' AND execution_deadline_at>now()`,
    [runtime.benefitRequestId],
  );
  if (!rows[0]) throw new Error('免费请求已结束或超时');
  if (inputTokens > runtime.benefitPolicy.max_input_tokens)
    throw new Error('context length exceeds benefit allowance');
  const outputTokens = Math.min(
    runtime.benefitPolicy.max_output_tokens,
    runtime.benefitPolicy.max_total_output_tokens -
      Number(rows[0].output_tokens),
    (runtime.contextWindowTokens ?? runtime.benefitPolicy.max_input_tokens) -
      inputTokens,
  );
  if (outputTokens < 1)
    throw new Error('context length or benefit output allowance exceeded');
  return {
    requestId: runtime.benefitRequestId,
    inputTokens,
    outputTokens,
    deadlineAt: Date.parse(rows[0].execution_deadline_at),
  };
}

export async function markBenefitAnswerVisible(
  requestId: string,
): Promise<void> {
  const result = await getAgentDbPool().query(
    `UPDATE benefit_requests SET answer_visible=true WHERE request_id=$1
    AND state='running' AND execution_deadline_at>now()
    AND EXISTS(SELECT 1 FROM agent_requests WHERE request_id=$1 AND state='running' AND cancel_requested_at IS NULL)`,
    [requestId],
  );
  if (!result.rowCount) throw new Error('免费请求已取消或结束');
}

export async function claimBenefitTool(
  runtime: LlmRuntimeSnapshot,
): Promise<void> {
  if (runtime.poolKey !== 'benefit') return;
  const result = await getAgentDbPool().query(
    `UPDATE benefit_requests SET tool_calls=tool_calls+1
    WHERE request_id=$1 AND state='running' AND execution_deadline_at>now()
      AND tool_calls<(policy->>'max_tool_calls')::integer
      AND EXISTS(SELECT 1 FROM agent_requests WHERE request_id=$1 AND state='running' AND cancel_requested_at IS NULL)`,
    [runtime.benefitRequestId],
  );
  if (!result.rowCount) throw new Error('免费单轮工具额度已用完，或请求已结束');
}
