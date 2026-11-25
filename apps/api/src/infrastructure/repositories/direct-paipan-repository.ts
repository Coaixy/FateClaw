import type { PoolClient } from 'pg';

import { getDbPool, type DbQueryable } from '#infrastructure/db-pool';
import type { ChatSession, NewMessage } from '#shared/types';
import {
  createChatSession,
  storeMessage,
  touchChatSession,
} from './chat-repository.js';
import { getClientProfile } from './client-profiles-repository.js';

export interface DirectPaipanMessages {
  requestMessage: NewMessage;
  resultMessage: NewMessage;
}

export interface StoredDirectPaipan extends DirectPaipanMessages {
  session: ChatSession;
}

export type DirectPaipanWriteResult =
  | { status: 'saved'; data: StoredDirectPaipan }
  | { status: 'missing' }
  | { status: 'forbidden' };

async function inDirectPaipanTransaction<T>(
  write: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await getDbPool().connect();
  let discardClient = false;
  try {
    await db.query('BEGIN');
    const result = await write(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {
      discardClient = true;
    }
    throw error;
  } finally {
    db.release(discardClient);
  }
}

export async function findDirectPaipanCommit(
  previewId: string,
  userId: string,
  db: DbQueryable = getDbPool(),
): Promise<DirectPaipanWriteResult | undefined> {
  const {
    rows: [receipt],
  } = await db.query<{
    user_id: string | null;
    session: ChatSession | null;
    request_message: NewMessage | null;
    result_message: NewMessage | null;
  }>(
    `SELECT receipt.user_id, row_to_json(session) AS session,
            row_to_json(request) AS request_message,
            row_to_json(result) AS result_message
     FROM direct_paipan_commits receipt
     LEFT JOIN LATERAL (
       SELECT id, account_id, user_id, title, client_id, model_pool_key,
              created_at, updated_at, deleted_at, share_token
       FROM chat_sessions
       WHERE id=receipt.session_id AND receipt.user_id=$2 AND user_id=$2
         AND deleted_at IS NULL
     ) session ON true
     LEFT JOIN messages request ON request.id=receipt.request_message_id
       AND request.account_id=session.account_id AND request.session_id=session.id
       AND request.user_id=session.user_id AND request.deleted_at IS NULL
     LEFT JOIN messages result ON result.id=receipt.result_message_id
       AND result.account_id=session.account_id AND result.session_id=session.id
       AND result.user_id=session.user_id AND result.deleted_at IS NULL
     WHERE receipt.preview_id=$1`,
    [previewId, userId],
  );
  if (!receipt) return undefined;
  if (!receipt.user_id) return { status: 'missing' };
  if (receipt.user_id !== userId) return { status: 'forbidden' };
  const {
    session,
    request_message: requestMessage,
    result_message: resultMessage,
  } = receipt;
  if (!session || !requestMessage || !resultMessage)
    return { status: 'missing' };
  return { status: 'saved', data: { session, requestMessage, resultMessage } };
}

async function saveBoardMessages(
  session: ChatSession,
  messages: DirectPaipanMessages,
  db: PoolClient,
): Promise<DirectPaipanWriteResult> {
  await storeMessage(messages.requestMessage, db);
  await storeMessage(messages.resultMessage, db);
  await touchChatSession(session.id, db);
  return { status: 'saved', data: { session, ...messages } };
}

export async function createDirectPaipanFromPreview(input: {
  previewId: string;
  session: Parameters<typeof createChatSession>[0];
  messages: DirectPaipanMessages;
}): Promise<DirectPaipanWriteResult> {
  return inDirectPaipanTransaction(async (db) => {
    const { previewId, session, messages } = input;
    // The unique receipt serializes concurrent submissions before the session is created.
    const claimed = await db.query(
      `INSERT INTO direct_paipan_commits
       (preview_id, user_id, session_id, request_message_id, result_message_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (preview_id) DO NOTHING`,
      [
        previewId,
        session.userId,
        session.id,
        messages.requestMessage.id,
        messages.resultMessage.id,
      ],
    );
    if (!claimed.rowCount) {
      return (
        (await findDirectPaipanCommit(previewId, session.userId, db)) ?? {
          status: 'missing',
        }
      );
    }

    const client = session.clientId
      ? await getClientProfile(session.clientId, session.userId, db)
      : undefined;
    const created = await createChatSession(
      { ...session, clientId: client?.id },
      db,
    );
    return saveBoardMessages(created, messages, db);
  });
}

export async function appendDirectPaipanToSession(input: {
  sessionId: string;
  userId: string;
  accountId: string;
  messages: DirectPaipanMessages;
}): Promise<DirectPaipanWriteResult> {
  return inDirectPaipanTransaction(async (db) => {
    // Account deletion locks the user before deleting its sessions and messages.
    const owner = await db.query(
      'SELECT id FROM users WHERE id=$1 FOR KEY SHARE',
      [input.userId],
    );
    if (!owner.rowCount) return { status: 'missing' };

    const {
      rows: [session],
    } = await db.query<ChatSession>(
      `SELECT * FROM chat_sessions WHERE id=$1 AND deleted_at IS NULL
       FOR NO KEY UPDATE`,
      [input.sessionId],
    );
    if (!session) return { status: 'missing' };
    if (
      session.user_id !== input.userId ||
      session.account_id !== input.accountId
    )
      return { status: 'forbidden' };
    return saveBoardMessages(session, input.messages, db);
  });
}
