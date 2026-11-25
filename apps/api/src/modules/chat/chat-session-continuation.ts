import {
  getPiSessionBase,
  getPiSessionSnapshot,
} from '#infrastructure/repositories/pi-session-frames-repository';
import {
  getChatSessionPiSessionArchive,
  getConversationLogByRequestId,
  getRecentMessages,
  hasFinalAiChatSessionReply,
  markChatSessionPiSessionArchived,
  markChatSessionPiSessionArchiveRestored,
} from '#infrastructure/db';
import { logger } from '#infrastructure/logger';
import type { ChatSession, NewMessage } from '#shared/types';
import {
  readPiSessionFileState,
  readPiSessionSnapshotFromTraceEvents,
  writePiSessionSnapshotArchiveToFiles,
  type PiSessionArchivePayload,
  writePiSessionArchiveToFiles,
} from './pi-session-files.js';

export const SESSION_CONTINUATION_BLOCKED_MESSAGE =
  '此对话长期未活跃，历史上下文已归档，不支持继续追问。请新建对话。';

function readRequestIdFromMessage(message: NewMessage): string | null {
  const metadata =
    message.metadata &&
    typeof message.metadata === 'object' &&
    !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : null;
  const requestId = metadata?.request_id;
  return typeof requestId === 'string' && requestId.trim()
    ? requestId.trim()
    : null;
}

async function restorePiSessionFromConversationSnapshot(
  session: ChatSession,
): Promise<boolean> {
  const recentMessages = await getRecentMessages(
    session.account_id,
    50,
    undefined,
    undefined,
    session.id,
  );
  const requestIds = Array.from(
    new Set(
      recentMessages
        .map(readRequestIdFromMessage)
        .filter((requestId): requestId is string => Boolean(requestId)),
    ),
  );

  for (const requestId of requestIds) {
    const log = await getConversationLogByRequestId(requestId);
    if (!log || log.account_id !== session.account_id) {
      continue;
    }
    const snapshot = readPiSessionSnapshotFromTraceEvents(log.trace_events);
    if (!snapshot) {
      continue;
    }
    const result = await writePiSessionSnapshotArchiveToFiles(
      session.id,
      snapshot,
    );
    if (!result?.writtenMappingFile || result.writtenSessionFiles <= 0) {
      continue;
    }
    await markChatSessionPiSessionArchived({
      sessionId: session.id,
      reason: 'inactive',
      payload: result.payload,
    });
    await markChatSessionPiSessionArchiveRestored(session.id);
    logger.warn(
      {
        sessionId: session.id,
        requestId,
        snapshotMessageCount: result.snapshotMessageCount,
      },
      '已从 conversation log 的 Pi session snapshot 重建本地 Pi session 文件',
    );
    return true;
  }

  return false;
}

export async function resolveSessionContinuationState(
  session: ChatSession,
): Promise<{
  blocked: boolean;
  reason?: 'pi_session_missing';
  message?: string;
}> {
  const hasFinalReply = await hasFinalAiChatSessionReply(
    session.account_id,
    session.id,
  );
  if (!hasFinalReply) {
    return { blocked: false };
  }

  const piSession = await readPiSessionFileState(session.id);
  if (piSession.hasSessionFile) {
    return { blocked: false };
  }

  const base = await getPiSessionBase(session.id, session.account_id);
  const durableSnapshot = base
    ? await getPiSessionSnapshot(base.requestId, session.account_id)
    : undefined;
  if (durableSnapshot) {
    const restored = await writePiSessionSnapshotArchiveToFiles(
      session.id,
      durableSnapshot,
    );
    if (restored?.writtenMappingFile && restored.writtenSessionFiles > 0) {
      await markChatSessionPiSessionArchiveRestored(session.id);
      return { blocked: false };
    }
  }

  const archive = await getChatSessionPiSessionArchive(session.id);
  if (archive?.pi_session_archive_payload) {
    await writePiSessionArchiveToFiles(
      session.id,
      archive.pi_session_archive_payload as PiSessionArchivePayload,
    );
    await markChatSessionPiSessionArchiveRestored(session.id);
    const restoredPiSession = await readPiSessionFileState(session.id);
    if (restoredPiSession.hasSessionFile) {
      return { blocked: false };
    }
  }

  if (await restorePiSessionFromConversationSnapshot(session)) {
    const restoredPiSession = await readPiSessionFileState(session.id);
    if (restoredPiSession.hasSessionFile) {
      return { blocked: false };
    }
  }

  return {
    blocked: true,
    reason: 'pi_session_missing',
    message: SESSION_CONTINUATION_BLOCKED_MESSAGE,
  };
}
