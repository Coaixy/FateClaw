import type pg from 'pg';
import { getDbPool, type DbQueryable } from '#infrastructure/db-pool';
import { MemoryError } from './domain.js';

export interface MemoryPiContext {
  contextAudience: string;
  contextGeneration: number;
  initialized: boolean;
}

/** This metadata is separate from business messages, which may have several audiences. */
export async function resolveMemoryPiContext(
  db: DbQueryable,
  args: { sessionId: string; ownerUserId: string; audience?: string },
): Promise<MemoryPiContext> {
  const audience = args.audience ?? '';
  const session = await db.query<{ memory_context_generation: number }>(
    'SELECT memory_context_generation FROM chat_sessions WHERE id=$1 AND user_id=$2',
    [args.sessionId, args.ownerUserId],
  );
  if (!session.rows[0])
    throw new MemoryError(
      '会话不存在或无权访问',
      404,
      'MEMORY.SESSION_MISSING',
    );
  const reset = session.rows[0].memory_context_generation;
  const { rows } = await db.query<{
    context_generation: number;
    initialized: boolean;
  }>(
    `INSERT INTO pi_session_contexts(session_id,context_audience,context_generation,reset_revision,initialized)
     VALUES($1,$2,$3,$3,$2='' AND $3=0 AND EXISTS(
       SELECT 1 FROM messages m
       LEFT JOIN agent_requests r ON r.request_id=m.metadata->>'request_id' AND r.session_id=m.session_id
       LEFT JOIN LATERAL(SELECT identity_snapshot FROM memory_sources s WHERE s.message_id=m.id AND s.account_id=m.account_id ORDER BY revision DESC LIMIT 1) src ON true
       WHERE m.session_id=$1 AND m.is_bot_message AND m.deleted_at IS NULL
         AND (m.metadata->>'kind'='final' OR m.id LIKE 'aichat-%_reply%')
         AND COALESCE(r.memory_scope->>'contextAudience',src.identity_snapshot->>'contextAudience','')=''))
     ON CONFLICT(session_id,context_audience) DO UPDATE SET
       context_generation=CASE WHEN pi_session_contexts.reset_revision<>$3 THEN GREATEST(pi_session_contexts.context_generation+1,$3) ELSE pi_session_contexts.context_generation END,
       initialized=CASE WHEN pi_session_contexts.reset_revision<>$3 THEN false ELSE pi_session_contexts.initialized END,
       reset_revision=$3,updated_at=clock_timestamp()
     RETURNING context_generation,initialized`,
    [args.sessionId, audience, reset],
  );
  return {
    contextAudience: audience,
    contextGeneration: rows[0].context_generation,
    initialized: rows[0].initialized,
  };
}

export async function readMemoryPiContext(
  sessionId: string,
  ownerUserId: string,
  audience = '',
): Promise<MemoryPiContext> {
  const { withMemoryTransaction } = await import('./repository.js');
  return withMemoryTransaction(async (db: pg.PoolClient) => {
    return resolveMemoryPiContext(db, { sessionId, ownerUserId, audience });
  });
}

export async function isMemoryPiContextCurrent(
  args: { sessionId: string; audience: string; generation: number },
  db: DbQueryable = getDbPool(),
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM pi_session_contexts c JOIN chat_sessions s ON s.id=c.session_id
     WHERE c.session_id=$1 AND c.context_audience=$2 AND c.context_generation=$3 AND c.reset_revision=s.memory_context_generation`,
    [args.sessionId, args.audience, args.generation],
  );
  return Boolean(rows[0]);
}
