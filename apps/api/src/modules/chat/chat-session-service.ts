import crypto from 'node:crypto';
import type {
  ChatSessionDto,
  ChatSessionShareResponseDto,
  SharedChatSessionDto,
} from '@fateclaw/contracts/chat';
import type { SuccessResponse } from '@fateclaw/contracts/common';
import {
  toChatSessionDto,
  toSharedChatSessionDto,
} from '#contracts-adapter/chat-contract';
import {
  archiveChatSession,
  createChatSession,
  getArchivedChatSessionsByUserId,
  getChatSessionsByClientId,
  getChatSessionsByUserId,
  getSessionMessages,
  getSharedChatSessionByToken,
  markChatSessionPiSessionArchived,
  restoreArchivedChatSession,
  shareOwnedChatSession,
  updateChatSessionTitle,
} from '#infrastructure/db';
import { getPreferredModelPool } from '#infrastructure/repositories/benefit-repository';
import { normalizeOwnedChatSessionTitle } from '#shared/chat-session-title-policy';
import { fail, ok, type ServiceResult } from '#shared/service-result';
import { getOwnedSession } from './chat-session-access.js';
import {
  deletePiSessionFilesForSession,
  readPiSessionArchiveForSession,
} from './pi-session-files.js';
import { getWebChatRuntimeId } from './web-chat-runtime.js';

export {
  getOwnedChatSessionMessages,
  getOwnedChatSessionQueryProcessSource,
  listOwnedChatSessionBoards,
} from './chat-session-history.js';
export {
  cancelOwnedChatSessionMessage,
  runOwnedChatSessionTurn,
  sendOwnedChatSessionMessage,
  type ChatSessionTurnSourceMetadata,
  type OwnedChatSessionTurnOptions,
  type OwnedChatSessionTurnResult,
} from './chat-session-turn.js';

const CHAT_SESSION_SHARE_TOKEN_BYTES = 18;

function generateChatSessionShareToken(): string {
  return crypto
    .randomBytes(CHAT_SESSION_SHARE_TOKEN_BYTES)
    .toString('base64url');
}

export async function listChatSessionsForOwnedUser(
  userId: string,
  clientId?: string,
): Promise<ServiceResult<ChatSessionDto[]>> {
  const sessions = await getChatSessionsByUserId(userId, undefined, clientId);
  return ok(sessions.map(toChatSessionDto));
}

export async function listArchivedChatSessionsForOwnedUser(
  userId: string,
): Promise<ServiceResult<ChatSessionDto[]>> {
  const sessions = await getArchivedChatSessionsByUserId(userId);
  return ok(sessions.map(toChatSessionDto));
}

/**
 * 列出某客户名下的全部会话（活跃 + 已归档），用于客户档案历史视图。
 *
 * @param userId 会话归属用户 ID（owner 隔离）。
 * @param clientId 客户档案 ID。
 * @returns 按更新时间倒序的会话 DTO 列表；归档会话 deleted_at 非空。
 */
export async function listChatSessionsByClientForOwnedUser(
  userId: string,
  clientId: string,
): Promise<ServiceResult<ChatSessionDto[]>> {
  const sessions = await getChatSessionsByClientId(userId, clientId);
  return ok(sessions.map(toChatSessionDto));
}

export async function createChatSessionForOwnedUser(
  userId: string,
  title: string,
): Promise<ServiceResult<ChatSessionDto>> {
  const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedTitle = normalizeOwnedChatSessionTitle(title);
  const session = await createChatSession({
    modelPoolKey: await getPreferredModelPool(userId),
    id,
    accountId: getWebChatRuntimeId(userId),
    userId,
    title: normalizedTitle,
  });
  return ok(toChatSessionDto(session));
}

export async function renameOwnedChatSession(
  userId: string,
  sessionId: string,
  title: string,
): Promise<ServiceResult<SuccessResponse>> {
  const sessionResult = await getOwnedSession(userId, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  await updateChatSessionTitle(sessionResult.data.id, title);
  return ok({ success: true });
}

/**
 * 归档当前用户拥有的 AI Chat 会话，并清理本地 Pi session 文件。
 *
 * @param userId 会话归属用户 ID。
 * @param sessionId chat_sessions.id。
 * @returns 成功响应；无权限、会话不存在或文件归档失败时返回错误。
 */
export async function archiveOwnedChatSession(
  userId: string,
  sessionId: string,
): Promise<ServiceResult<SuccessResponse>> {
  const sessionResult = await getOwnedSession(userId, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  const piSessionArchive = await readPiSessionArchiveForSession(
    sessionResult.data.id,
  );
  await archiveChatSession(sessionResult.data.id);
  await markChatSessionPiSessionArchived({
    sessionId: sessionResult.data.id,
    reason: 'soft_deleted',
    payload: piSessionArchive.payload,
  });
  await deletePiSessionFilesForSession(sessionResult.data.id);
  return ok({ success: true });
}

/**
 * 恢复当前用户拥有的已归档 AI Chat 会话。
 *
 * @param userId 会话归属用户 ID。
 * @param sessionId chat_sessions.id。
 * @returns 恢复后的会话；不存在或不属于当前用户时返回错误。
 */
export async function restoreOwnedArchivedChatSession(
  userId: string,
  sessionId: string,
): Promise<ServiceResult<ChatSessionDto>> {
  const session = await restoreArchivedChatSession({ userId, sessionId });
  if (!session) {
    return fail(404, '归档会话不存在');
  }
  return ok(toChatSessionDto(session));
}

export async function shareOwnedChatSessionForUser(
  userId: string,
  sessionId: string,
): Promise<ServiceResult<ChatSessionShareResponseDto>> {
  const sessionResult = await getOwnedSession(userId, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  const session = await shareOwnedChatSession({
    userId,
    sessionId: sessionResult.data.id,
    shareToken: generateChatSessionShareToken(),
  });
  if (!session?.share_token) {
    return fail(404, '会话不存在');
  }

  return ok({
    share_token: session.share_token,
    share_url_path: `/ai-chat/share?token=${encodeURIComponent(session.share_token)}`,
    session: toChatSessionDto(session),
  });
}

export async function getSharedChatSessionByShareToken(
  token: string,
): Promise<ServiceResult<SharedChatSessionDto>> {
  const normalizedToken = token.trim();
  if (!normalizedToken) {
    return fail(400, '分享链接无效');
  }

  const session = await getSharedChatSessionByToken(normalizedToken);
  if (!session) {
    return fail(404, '分享链接不存在或已失效');
  }

  const messages = await getSessionMessages(session.account_id, session.id);
  return ok(toSharedChatSessionDto({ session, messages }));
}
