import type {
  PiSessionBase,
  PiSessionFrame,
  PiSessionSnapshot,
} from '@fateclaw/contracts/agent';
import {
  isPiSessionFrame,
  PI_SESSION_CHECKPOINT_INTERVAL,
  restorePiSessionFrame,
} from '@fateclaw/contracts/agent/session';
import { getDbPool, type DbQueryable } from '#infrastructure/db-pool';

export async function getPiSessionBase(
  sessionId: string,
  accountId: string,
  contextAudience = '',
  db: DbQueryable = getDbPool(),
): Promise<PiSessionBase | undefined> {
  const { rows } = await db.query<PiSessionBase>(
    `SELECT p.request_id AS "requestId",p.messages_hash AS "messagesHash",p.message_count AS "messageCount",p.checkpoint_depth AS "checkpointDepth",
       COALESCE((p.frame->>'contextGeneration')::int,0) AS "contextGeneration",COALESCE(p.frame->>'contextAudience','') AS "contextAudience"
     FROM pi_session_frames p JOIN chat_sessions s ON s.id=p.session_id AND s.account_id=p.account_id
     LEFT JOIN pi_session_contexts ctx ON ctx.session_id=s.id AND ctx.context_audience=$3
     WHERE p.session_id=$1 AND p.account_id=$2
       AND COALESCE(p.frame->>'contextAudience','')=$3
       AND COALESCE((p.frame->>'contextGeneration')::int,0)=COALESCE(ctx.context_generation,s.memory_context_generation)
       AND (ctx.session_id IS NULL OR ctx.reset_revision=s.memory_context_generation)
     ORDER BY p.created_at DESC,p.request_id DESC LIMIT 1`,
    [sessionId, accountId, contextAudience],
  );
  return rows[0];
}

export async function storePiSessionFrame(
  db: DbQueryable,
  requestId: string,
  sessionId: string,
  accountId: string,
  frame: PiSessionFrame,
): Promise<void> {
  if (!isPiSessionFrame(frame)) throw new Error('Invalid Pi session frame');
  const sessionGeneration = await db.query<{
    memory_context_generation: number;
    context_generation: number | null;
    reset_revision: number | null;
    memory_scope:
      | import('@fateclaw/contracts/memory').MemoryRequestScope
      | null;
  }>(
    `SELECT s.memory_context_generation,ctx.context_generation,ctx.reset_revision,r.memory_scope
     FROM chat_sessions s JOIN agent_requests r ON r.session_id=s.id AND r.account_id=s.account_id AND r.request_id=$3
     LEFT JOIN pi_session_contexts ctx ON ctx.session_id=s.id AND ctx.context_audience=$4
     WHERE s.id=$1 AND s.account_id=$2`,
    [sessionId, accountId, requestId, frame.contextAudience ?? ''],
  );
  const current = sessionGeneration.rows[0];
  if (!current)
    throw new Error('Pi session frame has no matching delivery owner');
  if (
    (current.memory_scope?.contextAudience ?? '') !==
    (frame.contextAudience ?? '')
  )
    throw new Error('Pi session frame audience mismatch');
  if (
    current.memory_scope &&
    current.memory_scope.contextGeneration !== (frame.contextGeneration ?? 0)
  )
    throw new Error('Pi session frame generation mismatch');
  // Revoking an old context must not roll back an otherwise valid reply or its usage.
  if (current.context_generation !== null) {
    if (
      (frame.contextGeneration ?? 0) !== current.context_generation ||
      current.reset_revision !== current.memory_context_generation
    )
      return;
  } else {
    if (
      frame.contextAudience ||
      (frame.contextGeneration ?? 0) !== current.memory_context_generation
    )
      return;
    await db.query(
      "INSERT INTO pi_session_contexts(session_id,context_audience,context_generation,reset_revision,initialized) VALUES($1,'',$2,$2,false) ON CONFLICT DO NOTHING",
      [sessionId, current.memory_context_generation],
    );
  }
  if (frame.kind === 'delta') {
    const base = frame.base;
    if (
      !base ||
      frame.checkpointDepth !== base.checkpointDepth + 1 ||
      frame.messageCount !== base.messageCount + frame.messages.length
    )
      throw new Error('Invalid Pi session delta');
    const { rows } = await db.query(
      `SELECT 1 FROM pi_session_frames WHERE request_id=$1 AND session_id=$2 AND account_id=$3
       AND messages_hash=$4 AND message_count=$5 AND checkpoint_depth=$6 AND COALESCE(frame->>'contextAudience','')=$7
       AND COALESCE((frame->>'contextGeneration')::int,0)=$8`,
      [
        base.requestId,
        sessionId,
        accountId,
        base.messagesHash,
        base.messageCount,
        base.checkpointDepth,
        frame.contextAudience ?? '',
        frame.contextGeneration ?? 0,
      ],
    );
    if (!rows.length) throw new Error('Missing committed Pi session base');
  } else {
    if (frame.base || frame.checkpointDepth !== 0)
      throw new Error('Invalid Pi session checkpoint');
    restorePiSessionFrame(frame);
  }
  const result = await db.query(
    `INSERT INTO pi_session_frames(request_id,session_id,account_id,base_request_id,messages_hash,message_count,checkpoint_depth,frame,created_at)
     SELECT $1,c.id,$3,$4,$5,$6,$7,$8,r.created_at FROM chat_sessions c
     JOIN agent_requests r ON r.request_id=$1 AND r.session_id=c.id AND r.account_id=c.account_id
     WHERE c.id=$2 AND c.account_id=$3
     ON CONFLICT(request_id) DO NOTHING RETURNING request_id`,
    [
      requestId,
      sessionId,
      accountId,
      frame.base?.requestId ?? null,
      frame.messagesHash,
      frame.messageCount,
      frame.checkpointDepth,
      JSON.stringify(frame),
    ],
  );
  if (!result.rows.length)
    throw new Error('Pi session frame has no matching delivery owner');
  await db.query(
    'UPDATE pi_session_contexts SET initialized=true,updated_at=clock_timestamp() WHERE session_id=$1 AND context_audience=$2 AND context_generation=$3',
    [sessionId, frame.contextAudience ?? '', frame.contextGeneration ?? 0],
  );
}

export async function getPiSessionSnapshot(
  requestId: string,
  accountId: string,
  db: DbQueryable = getDbPool(),
): Promise<PiSessionSnapshot | undefined> {
  const { rows } = await db.query<{
    request_id: string;
    frame: PiSessionFrame;
  }>(
    `WITH RECURSIVE chain AS (
       SELECT request_id,session_id,account_id,base_request_id,frame,0 AS depth FROM pi_session_frames
       WHERE request_id=$1 AND account_id=$2
       UNION ALL
       SELECT b.request_id,b.session_id,b.account_id,b.base_request_id,b.frame,c.depth+1
       FROM pi_session_frames b JOIN chain c ON b.request_id=c.base_request_id
         AND b.session_id=c.session_id AND b.account_id=c.account_id WHERE c.depth<$3
     ) SELECT request_id,frame FROM chain ORDER BY depth DESC`,
    [requestId, accountId, PI_SESSION_CHECKPOINT_INTERVAL - 1],
  );
  let snapshot: PiSessionSnapshot | undefined;
  let previousRequestId: string | undefined;
  for (const row of rows) {
    if (
      row.frame.kind === 'delta' &&
      row.frame.base?.requestId !== previousRequestId
    )
      throw new Error('Broken Pi session frame chain');
    snapshot = restorePiSessionFrame(row.frame, snapshot);
    previousRequestId = row.request_id;
  }
  return snapshot;
}
