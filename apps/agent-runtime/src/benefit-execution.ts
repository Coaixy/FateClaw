import type { LlmRuntimeSnapshot } from './types.js';
import { getAgentDbPool } from './agent-db.js';

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

export async function recordBenefitToolCall(
  runtime: LlmRuntimeSnapshot,
): Promise<void> {
  if (runtime.poolKey !== 'benefit') return;
  const result = await getAgentDbPool().query(
    `UPDATE benefit_requests SET tool_calls=tool_calls+1
    WHERE request_id=$1 AND state='running' AND execution_deadline_at>now()
      AND EXISTS(SELECT 1 FROM agent_requests WHERE request_id=$1 AND state='running' AND cancel_requested_at IS NULL)`,
    [runtime.benefitRequestId],
  );
  if (!result.rowCount) throw new Error('免费请求已取消或结束');
}
