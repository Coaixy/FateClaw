import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { getDbPool } from '../db-pool.js';
import { storeMessage } from './chat-repository.js';
import type { AiChatSubmission } from '../../runtime/ipc-worker.js';
import type { LlmRuntimeSnapshot } from '../../runtime/ipc-payloads.js';
import {
  reserveBenefitTurn,
  ModelSelectionError,
} from './benefit-repository.js';

export const REQUEST_OWNER = randomUUID();
export type StoredRuntime = Omit<LlmRuntimeSnapshot, 'apiKey' | 'poolNodes'> & {
  poolNodes?: Array<
    Omit<NonNullable<LlmRuntimeSnapshot['poolNodes']>[number], 'apiKey'>
  >;
};
export interface DurableRequest {
  request_id: string;
  execution_id: string;
  account_id: string;
  session_id: string;
  owner_user_id: string;
  user_message_id: string | null;
  input: AiChatSubmission;
  runtime: StoredRuntime;
  state: string;
  deadline_at: Date | string;
  cancel_requested_at: Date | null;
  result: unknown;
}

export function durableSubmissionInput(
  input: AiChatSubmission,
): AiChatSubmission {
  // Only request data crosses this boundary; credentials stay in their owning source.
  return {
    accountId: input.accountId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    userMessageId: input.userMessageId,
    userMessage: input.userMessage,
    inputKind: input.inputKind,
    pastedBoard: input.pastedBoard,
    history: input.history,
    sessionBoardContexts: input.sessionBoardContexts,
    userName: input.userName,
    assistantName: input.assistantName,
    personaPrompt: input.personaPrompt,
    authorizedSkillIds: input.authorizedSkillIds,
    entitlementSnapshot: input.entitlementSnapshot,
    waitForResponse: false,
  };
}

export async function admitAgentRequest(args: {
  input: AiChatSubmission;
  requestId: string;
  ownerUserId: string;
  runtime: LlmRuntimeSnapshot;
  deadlineAt: number;
}): Promise<string> {
  const { apiKey: _credential, poolNodes, ...baseRuntime } = args.runtime;
  const runtime: StoredRuntime = {
    ...baseRuntime,
    ...(poolNodes
      ? { poolNodes: poolNodes.map(({ apiKey: _key, ...node }) => node) }
      : {}),
  };
  const client = await getDbPool().connect();
  let discardClient = false;
  try {
    await client.query('BEGIN');
    if (runtime.poolKey) {
      const session = await client.query<{ model_pool_key: string }>(
        `SELECT model_pool_key FROM chat_sessions
        WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`,
        [args.input.sessionId, args.ownerUserId],
      );
      if (session.rows[0]?.model_pool_key !== runtime.poolKey)
        throw new ModelSelectionError('会话模型选择已变化，请确认后重新发送');
      const active = await client.query(
        "SELECT 1 FROM agent_requests WHERE session_id=$1 AND request_id<>$2 AND state IN ('queued','dispatched','running') LIMIT 1",
        [args.input.sessionId, args.requestId],
      );
      if (active.rowCount)
        throw new ModelSelectionError('会话正在处理其他请求');
    }
    const executionId = randomUUID();
    const inserted = await client.query<{ execution_id: string }>(
      `INSERT INTO agent_requests
       (request_id,execution_id,account_id,session_id,user_message_id,owner_user_id,state,input,runtime,lease_owner,lease_until,deadline_at)
       VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,now()+interval '60 seconds',$10)
       ON CONFLICT (request_id) DO NOTHING RETURNING execution_id`,
      [
        args.requestId,
        executionId,
        args.input.accountId,
        args.input.sessionId,
        args.input.userMessageId ?? null,
        args.ownerUserId,
        JSON.stringify(durableSubmissionInput(args.input)),
        JSON.stringify(runtime),
        REQUEST_OWNER,
        new Date(args.deadlineAt),
      ],
    );
    if (!inserted.rowCount)
      throw new Error('Request has already been admitted');
    if (runtime.poolKey === 'benefit') {
      if (
        runtime.billingMode !== 'none' ||
        !runtime.benefitPolicy ||
        !runtime.poolNodes?.length ||
        runtime.poolNodes.some((node) => node.poolKey !== 'benefit')
      )
        throw new Error('Invalid benefit runtime admission');
      await reserveBenefitTurn(
        client,
        args.ownerUserId,
        args.requestId,
        runtime.benefitPolicy,
        runtime.poolRevision,
      );
    }
    if (args.input.messageToPersist)
      await storeMessage(args.input.messageToPersist, client);
    await client.query('COMMIT');
    return executionId;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discardClient = true;
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}

export async function markAgentRequestDispatched(
  requestId: string,
): Promise<boolean> {
  const result = await getDbPool().query(
    `UPDATE agent_requests SET state='dispatched', updated_at=now(),lease_until=now()+interval '60 seconds'
     WHERE request_id=$1 AND lease_owner=$2 AND state IN ('queued','dispatched')
       AND cancel_requested_at IS NULL AND deadline_at>now()`,
    [requestId, REQUEST_OWNER],
  );
  return result.rowCount === 1;
}

export async function renewAgentRequestLeases(
  requestIds: string[],
): Promise<void> {
  if (!requestIds.length) return;
  await getDbPool().query(
    `UPDATE agent_requests SET lease_until=now()+interval '60 seconds'
     WHERE request_id=ANY($1::text[]) AND lease_owner=$2 AND state IN ('queued','dispatched')`,
    [requestIds, REQUEST_OWNER],
  );
}

export async function requestAgentCancellation(
  requestId: string,
): Promise<void> {
  await getDbPool().query(
    `UPDATE agent_requests SET cancel_requested_at=COALESCE(cancel_requested_at,now()),updated_at=now()
     WHERE request_id=$1 AND state NOT IN ('completed','result_ready')`,
    [requestId],
  );
}

export async function takeRecoverableRequests(): Promise<DurableRequest[]> {
  const { rows } = await getDbPool().query<DurableRequest>(
    `WITH candidates AS (
       SELECT request_id FROM agent_requests WHERE state <> 'completed' AND (state <> 'interrupted' OR interrupted_notified_at IS NULL)
         AND (lease_until IS NULL OR lease_until<now())
       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
     ) UPDATE agent_requests r SET lease_owner=$1,lease_until=now()+interval '60 seconds'
       FROM candidates c WHERE r.request_id=c.request_id RETURNING r.*`,
    [REQUEST_OWNER],
  );
  return rows;
}

export async function persistAgentFailure(
  requestId: string,
  payload: unknown,
): Promise<unknown | null> {
  const { rows } = await getDbPool().query<{ result: unknown }>(
    `UPDATE agent_requests SET state='result_ready',result=$2,lease_until=NULL,updated_at=now()
     WHERE request_id=$1 AND state IN ('queued','dispatched') AND lease_owner=$3
       AND result IS NULL RETURNING result`,
    [requestId, JSON.stringify(payload), REQUEST_OWNER],
  );
  return rows[0]?.result ?? null;
}

export async function interruptAgentRequest(
  requestId: string,
  payload: unknown,
): Promise<boolean> {
  const result = await getDbPool().query(
    `UPDATE agent_requests SET state='interrupted',result=$2,input='{}',updated_at=now()
     WHERE request_id=$1 AND state IN ('running','interrupted') AND lease_owner=$3`,
    [requestId, JSON.stringify(payload), REQUEST_OWNER],
  );
  return result.rowCount === 1;
}

export async function withAgentResultDelivery(
  requestId: string,
  accountId: string,
  deliver: (client: pg.PoolClient) => Promise<string | null>,
): Promise<string | null> {
  const client = await getDbPool().connect();
  let discardClient = false;
  try {
    await client.query('BEGIN');
    const admitted = await client.query<{ account_id: string }>(
      'SELECT account_id FROM agent_requests WHERE request_id=$1 FOR UPDATE',
      [requestId],
    );
    // Legacy results have no admission row; durable results must match its owner.
    if (admitted.rows[0] && admitted.rows[0].account_id !== accountId) {
      throw new Error('Result account mismatch');
    }
    await client.query(
      `INSERT INTO agent_result_deliveries (request_id,account_id) VALUES ($1,$2)
       ON CONFLICT (request_id) DO NOTHING`,
      [requestId, accountId],
    );
    const { rows } = await client.query<{
      account_id: string;
      delivered: boolean;
      final_message_id: string | null;
    }>('SELECT * FROM agent_result_deliveries WHERE request_id=$1 FOR UPDATE', [
      requestId,
    ]);
    if (rows[0].account_id !== accountId)
      throw new Error('Result account mismatch');
    const finalMessageId = rows[0].delivered
      ? rows[0].final_message_id
      : await deliver(client);
    await client.query(
      `UPDATE agent_result_deliveries SET delivered=true,final_message_id=$2 WHERE request_id=$1`,
      [requestId, finalMessageId],
    );
    await client.query(
      `UPDATE agent_requests SET state='completed',input='{}',result=NULL,lease_until=NULL,updated_at=now()
       WHERE request_id=$1 AND account_id=$2`,
      [requestId, accountId],
    );
    await client.query('COMMIT');
    return finalMessageId;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discardClient = true;
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}

export async function acknowledgeAgentInterruption(
  requestId: string,
): Promise<void> {
  await getDbPool().query(
    `UPDATE agent_requests SET interrupted_notified_at=now(),lease_until=NULL
     WHERE request_id=$1 AND state='interrupted'`,
    [requestId],
  );
}

/** Serialize interruption notices with actual result publication and delivery. */
export async function withAgentInterruptionDelivery(
  requestId: string,
  accountId: string,
  deliver: (client: pg.PoolClient) => Promise<string | null>,
): Promise<string | null> {
  const client = await getDbPool().connect();
  let discardClient = false;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ account_id: string; state: string }>(
      'SELECT account_id,state FROM agent_requests WHERE request_id=$1 FOR UPDATE',
      [requestId],
    );
    const request = rows[0];
    if (request && request.account_id !== accountId)
      throw new Error('Result account mismatch');
    // Missing rows are legacy in-flight requests. Never overwrite a known result.
    const finalMessageId =
      request && !['running', 'interrupted'].includes(request.state)
        ? null
        : await deliver(client);
    await client.query('COMMIT');
    return finalMessageId;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discardClient = true;
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}
