import type { PoolClient } from 'pg';

import { getDbPool } from '#infrastructure/db-pool';

export class InactiveConversationRequestError extends Error {
  constructor() {
    super('工具请求已结束、已取消，或不属于当前会话');
  }
}

export interface ConversationRequestOwner {
  userId: string;
  sessionId: string;
  clientId: string | null;
}

export async function withActiveConversationRequest<T>(
  identity: { accountId: string; requestId: string; executionId: string },
  run: (owner: ConversationRequestOwner, db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await getDbPool().connect();
  let discard = false;
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '10s'");
    // The admitted request supplies identity; the model cannot select a user or session.
    // Its row lock serializes retries before any durable tool result is created.
    const { rows } = await db.query<{
      owner_user_id: string;
      session_id: string;
      client_id: string | null;
    }>(
      `SELECT r.owner_user_id, r.session_id, s.client_id
       FROM agent_requests r JOIN chat_sessions s
         ON s.id=r.session_id AND s.account_id=r.account_id AND s.user_id=r.owner_user_id
       WHERE r.request_id=$1 AND r.account_id=$2 AND r.execution_id=$3
         AND r.state='running' AND r.cancel_requested_at IS NULL
         AND r.deadline_at>clock_timestamp() AND s.deleted_at IS NULL
       FOR UPDATE OF r`,
      [identity.requestId, identity.accountId, identity.executionId],
    );
    const owner = rows[0];
    if (!owner) throw new InactiveConversationRequestError();
    const result = await run(
      {
        userId: owner.owner_user_id,
        sessionId: owner.session_id,
        clientId: owner.client_id,
      },
      db,
    );
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    db.release(discard);
  }
}
