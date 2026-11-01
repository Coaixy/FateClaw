import type { PoolClient } from 'pg';

import { getDbPool } from '#infrastructure/db-pool';
import type { MemoryRequestScope } from '@fateclaw/contracts/memory';
import {
  actorSubjectId,
  assertMemoryBindingCurrent,
  hasOwnerMemoryAudience,
} from '#modules/memory/repository';

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
    type AdmittedRequest = {
      owner_user_id: string;
      session_id: string;
      memory_scope: MemoryRequestScope | null;
    };
    const readRequest = async (
      lock: boolean,
      scope: MemoryRequestScope | null = null,
    ) =>
      db.query<AdmittedRequest>(
        `SELECT r.owner_user_id,r.session_id,r.memory_scope
       FROM agent_requests r JOIN chat_sessions s
         ON s.id=r.session_id AND s.account_id=r.account_id AND s.user_id=r.owner_user_id
       WHERE r.request_id=$1 AND r.account_id=$2 AND r.execution_id=$3
         AND r.state='running' AND r.cancel_requested_at IS NULL
         AND r.deadline_at>clock_timestamp() AND s.deleted_at IS NULL
       ${lock ? 'AND r.memory_scope IS NOT DISTINCT FROM $4::jsonb FOR UPDATE OF r' : ''}`,
        lock
          ? [
              identity.requestId,
              identity.accountId,
              identity.executionId,
              scope ? JSON.stringify(scope) : null,
            ]
          : [identity.requestId, identity.accountId, identity.executionId],
      );
    const initial = (await readRequest(false)).rows[0];
    if (!initial) throw new InactiveConversationRequestError();
    const scope = initial.memory_scope;
    if (
      scope &&
      (scope.ownerUserId !== initial.owner_user_id ||
        typeof scope.scopeId !== 'string')
    )
      throw new InactiveConversationRequestError();
    const owner = (await readRequest(true, scope)).rows[0];
    if (!owner) throw new InactiveConversationRequestError();
    let clientId: string | null = null;
    if (scope) {
      await assertMemoryBindingCurrent(scope, db);
      const sharedClient =
        scope.ownerMemoryAccess === true &&
        actorSubjectId(scope) === scope.subjectId;
      if (
        scope.subjectId.startsWith('client:') &&
        (hasOwnerMemoryAudience(scope) || sharedClient)
      ) {
        const id = scope.subjectId.slice('client:'.length);
        // An archived client no longer prefills tools; the conversation itself continues.
        const active = await db.query(
          'SELECT id FROM client_profiles WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR SHARE',
          [id, scope.ownerUserId],
        );
        if (active.rows[0]) clientId = id;
      }
    }
    const result = await run(
      {
        userId: owner.owner_user_id,
        sessionId: owner.session_id,
        clientId,
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
