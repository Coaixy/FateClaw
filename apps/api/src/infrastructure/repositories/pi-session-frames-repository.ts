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
import { getDbPool, type DbQueryable } from '../db-pool.js';

export async function getPiSessionBase(
  sessionId: string,
  accountId: string,
): Promise<PiSessionBase | undefined> {
  const { rows } = await getDbPool().query<PiSessionBase>(
    `SELECT request_id AS "requestId",messages_hash AS "messagesHash",message_count AS "messageCount",checkpoint_depth AS "checkpointDepth"
     FROM pi_session_frames WHERE session_id=$1 AND account_id=$2
     ORDER BY created_at DESC,request_id DESC LIMIT 1`,
    [sessionId, accountId],
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
       AND messages_hash=$4 AND message_count=$5 AND checkpoint_depth=$6`,
      [
        base.requestId,
        sessionId,
        accountId,
        base.messagesHash,
        base.messageCount,
        base.checkpointDepth,
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
