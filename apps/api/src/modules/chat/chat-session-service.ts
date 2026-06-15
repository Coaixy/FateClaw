/**
 * AI 对话会话服务层。
 *
 * 负责会话归属校验、消息写入与 agent 调度，
 * 避免 route 直接依赖底层存储和运行时实现。
 */

import crypto from 'node:crypto';

import type {
  ChatSessionDto,
  ChatSessionShareResponseDto,
  ChatSessionSendResponseDto,
  MessageDto,
  SessionMessageListResponseDto,
  SharedChatSessionDto,
} from '@fateclaw/contracts/chat';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import {
  archiveChatSession,
  createChatSession,
  getArchivedChatSessionsByUserId,
  getAccountsByUserId,
  getChatSession,
  getChatSessionPiSessionArchive,
  getChatSessionsByUserId,
  getConversationLogByRequestId,
  claimFreeProfessionalAiTurn,
  getMembershipOverview,
  getRecentMessages,
  getSessionMessageById,
  getSessionMessages,
  getSessionMessagesWithToolContext,
  getSharedChatSessionByToken,
  getUserById,
  hasFinalAiChatSessionReply,
  markChatSessionPiSessionArchived,
  markChatSessionPiSessionArchiveRestored,
  releaseFreeProfessionalAiTurn,
  restoreArchivedChatSession,
  shareOwnedChatSession,
  storeMessage,
  updateChatSessionTitle,
} from '../../infrastructure/db.js';
import { logger } from '../../infrastructure/logger.js';
import { getRedis } from '../../infrastructure/redis.js';
import { dispatchAiChatPrompt } from '../../runtime/resident-agent.js';
import { cancelAiChatSessionRequest } from '../../runtime/ipc-worker.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';
import {
  claimOrRefreshSessionProcessingLock,
  releaseSessionProcessingLock,
  sessionProcessingLockKey,
} from '../../runtime/ipc-payloads.js';
import { hasBaseMembershipEntitlement } from '../../shared/membership-plans.js';
import {
  DEFAULT_OWNED_CHAT_SESSION_TITLE,
  normalizeOwnedChatSessionTitle,
} from '../../shared/chat-session-title-policy.js';
import type { ChatSession, NewMessage } from '../../shared/types.js';
import {
  toChatSessionDto,
  toMessageDto,
  toSharedChatSessionDto,
  toSessionMessageListResponseDto,
} from '../../contracts-adapter/chat-contract.js';
import {
  buildSessionBoardContexts,
  messageHasBoardContext,
  type SessionBoardContextDto,
} from './active-board-context.js';
import { buildStructuredInputForSession } from './structured-input.js';
import {
  resolveUserLlmRuntime,
  type EffectiveLlmRuntimeConfig,
} from '../system/system-config.js';
import {
  getWebChatRuntimeId,
  WEB_CHAT_ASSISTANT_NAME,
  WEB_CHAT_USER_NAME,
} from './web-chat-runtime.js';
import type { NormalizedChatSessionMessageInput } from './pasted-board-input.js';
import type { StructuredInput } from './structured-input.js';
import { BILLING_ARREARS_MESSAGE } from '../billing/plans.js';
import {
  deletePiSessionFilesForSession,
  readPiSessionArchiveForSession,
  readPiSessionFileState,
  readPiSessionSnapshotFromTraceEvents,
  writePiSessionSnapshotArchiveToFiles,
  type PiSessionArchivePayload,
  writePiSessionArchiveToFiles,
} from './pi-session-files.js';

const SESSION_PROCESSING_TTL_SECONDS = 2100;
const SESSION_PROCESSING_BUSY_ERROR = '上一条消息仍在处理中，请稍后再试';
const SESSION_CONTINUATION_BLOCKED_MESSAGE =
  '此对话长期未活跃，历史上下文已归档，不支持继续追问。请新建对话。';
const FREE_PROFESSIONAL_AI_QUOTA_EXHAUSTED_MESSAGE =
  '今日免费专业模式 AI 次数已用完，请开通 FateClaw Plus 后继续。';
const CHAT_SESSION_SHARE_TOKEN_BYTES = 18;

/**
 * AI Chat turn 的来源元信息。
 *
 * @remarks 当前用于标记微信进入网页 session 的消息，后续前端可据此展示来源徽标。
 */
export interface ChatSessionTurnSourceMetadata {
  source_channel?: 'wechat';
  wechat_account_id?: string;
  sender_hash?: string;
}

/**
 * 发送 AI Chat turn 时可覆盖的内部选项。
 *
 * @remarks 微信入口会传入确定性消息 ID，避免 iLink 重试导致重复触发模型。
 */
export interface OwnedChatSessionTurnOptions {
  userMessageId?: string;
  sourceMetadata?: ChatSessionTurnSourceMetadata;
  /** 简易模式等内部 workflow 可传入本轮指定模型运行时。 */
  llmRuntimeOverride?: EffectiveLlmRuntimeConfig;
  /** 内部 workflow 可覆盖送入 runtime 的提示词，同时保留用户端展示内容。 */
  runtimeUserMessageOverride?: string;
  /** 本轮 AI 请求明确授权可读取的 Skill Bundle；不传时保持用户全部有效 Skill 可见，传空数组时不加载用户级 Skill。 */
  authorizedSkillBundleIds?: string[];
  /** 本轮 AI 请求明确授权可读取的 workflow Skill 快照；优先于 Bundle 白名单。 */
  authorizedWorkflowSkillIds?: string[];
  /** 简易模式首轮由服务端内部豁免 Plus 门禁；不要暴露到 HTTP 请求体。 */
  plusGateBypass?: 'simple_workflow_first_turn';
  /** 会话忙碌锁抢占成功后执行；微信入口用它发送非会话 ACK。 */
  onProcessingClaimed?: () => Promise<void>;
}

/**
 * AI Chat turn 的内部执行结果。
 *
 * @remarks HTTP API 继续只暴露 response；微信入口使用 finalAssistantMessages 同步最终落库内容。
 */
export interface OwnedChatSessionTurnResult {
  response: ChatSessionSendResponseDto;
  finalAssistantMessages: MessageDto[];
}

interface PreparedOwnedChatSessionTurn {
  userId: string;
  session: ChatSession;
  input: NormalizedChatSessionMessageInput;
  msgId: string;
  requestId: string;
  llmRuntime: Awaited<ReturnType<typeof resolveUserLlmRuntime>>;
  structured: StructuredInput;
  sessionBoardContexts: SessionBoardContextDto[];
  authorizedSkillBundleIds?: string[];
  authorizedWorkflowSkillIds?: string[];
  sessionTitle: string;
  freeProfessionalAiUsageDate?: string;
}

function isPaymentRequiredError(errorMessage: string): boolean {
  return (
    errorMessage.includes('余额不足') ||
    errorMessage.includes('积分不足') ||
    errorMessage.includes('免费对话额度') ||
    errorMessage.includes('欠费')
  );
}

function createAiChatRequestId(): string {
  return `aichat-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeAuthorizedIds(ids?: string[]): string[] {
  return Array.from(
    new Set((ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0)),
  );
}

function generateChatSessionShareToken(): string {
  return crypto
    .randomBytes(CHAT_SESSION_SHARE_TOKEN_BYTES)
    .toString('base64url');
}

async function claimChatSessionProcessing(
  sessionId: string,
  requestId: string,
): Promise<boolean> {
  return claimOrRefreshSessionProcessingLock(
    sessionId,
    requestId,
    SESSION_PROCESSING_TTL_SECONDS,
  );
}

async function releaseChatSessionProcessing(
  sessionId: string,
  requestId: string,
): Promise<void> {
  await releaseSessionProcessingLock(sessionId, requestId);
}

async function compensateFreeProfessionalAiTurn(
  prepared: Pick<
    PreparedOwnedChatSessionTurn,
    'userId' | 'freeProfessionalAiUsageDate'
  >,
): Promise<void> {
  if (!prepared.freeProfessionalAiUsageDate) return;
  try {
    await releaseFreeProfessionalAiTurn({
      userId: prepared.userId,
      usageDate: prepared.freeProfessionalAiUsageDate,
    });
  } catch (err) {
    logger.warn(
      {
        userId: prepared.userId,
        usageDate: prepared.freeProfessionalAiUsageDate,
        err,
      },
      'AI 对话: Free 专业模式次数退回失败',
    );
  }
}

function buildSelectedBoardContext(message: NewMessage): boolean {
  return messageHasBoardContext(message);
}

function getMessageTime(message: Pick<NewMessage, 'timestamp'>): number {
  const time = new Date(message.timestamp).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function isFinalAssistantReplyMessage(message: NewMessage): boolean {
  if (!message.is_bot_message) return false;
  const metadata =
    message.metadata &&
    typeof message.metadata === 'object' &&
    !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : null;
  return metadata?.kind === 'final' || /^aichat-.*_reply/.test(message.id);
}

function buildBoardFirstQuestionPrompt(args: {
  question: string;
  board: SessionBoardContextDto;
}): string {
  const title = args.board.artifactTitle?.trim() || '当前盘面';
  return [
    `已生成${title}。你可以直接提问，后续未切换主题时会参考此盘面。`,
    '',
    '【用户发送的问题】',
    args.question,
  ].join('\n');
}

function buildRuntimeUserMessageForBoardFirstQuestion(args: {
  input: NormalizedChatSessionMessageInput;
  previousMessages: NewMessage[];
  sessionBoardContexts: SessionBoardContextDto[];
}): string {
  if (args.input.inputKind !== 'normal') return args.input.content;

  const currentBoard = args.sessionBoardContexts.find(
    (board) => board.isCurrent,
  );
  if (!currentBoard?.createdAt) return args.input.content;

  const boardMessage = args.previousMessages.find(
    (message) => message.id === currentBoard.sourceMessageId,
  );
  if (!boardMessage) return args.input.content;

  const boardTime = getMessageTime(boardMessage);
  const hasFinalReplyAfterBoard = args.previousMessages.some(
    (message) =>
      getMessageTime(message) > boardTime &&
      isFinalAssistantReplyMessage(message),
  );
  if (hasFinalReplyAfterBoard) return args.input.content;

  return buildBoardFirstQuestionPrompt({
    question: args.input.content,
    board: currentBoard,
  });
}

function normalizeAssistantReplyTexts(output: {
  text?: string;
  assistantMessages?: string[];
}): string[] {
  const assistantMessages = Array.isArray(output.assistantMessages)
    ? output.assistantMessages.map((message) => message.trim()).filter(Boolean)
    : [];
  if (assistantMessages.length > 0) {
    return assistantMessages;
  }
  const fallback = output.text?.trim();
  return fallback ? [fallback] : [];
}

function buildFinalReplyMetadata(output: {
  metadata?: unknown;
  requestId?: string;
}): Record<string, unknown> {
  return output.metadata &&
    typeof output.metadata === 'object' &&
    !Array.isArray(output.metadata)
    ? {
        ...output.metadata,
        kind: 'final',
        turn_complete: true,
        request_id: output.requestId,
      }
    : {
        kind: 'final',
        turn_complete: true,
        request_id: output.requestId,
      };
}

function mergeMessageMetadata(
  base: Record<string, unknown> | null,
  source?: ChatSessionTurnSourceMetadata,
): Record<string, unknown> | null {
  if (!source) return base;
  return {
    ...(base ?? {}),
    ...source,
  };
}

async function getOwnedSession(
  userId: string,
  sessionId: string,
): Promise<ServiceResult<ChatSession>> {
  const session = await getChatSession(sessionId);
  if (!session) {
    return fail(404, '会话不存在');
  }

  if (session.user_id !== userId) {
    return fail(403, '无权操作');
  }

  return ok(session);
}

async function resolveOwnedSoulAccountId(
  userId: string,
): Promise<string | undefined> {
  const accounts = await getAccountsByUserId(userId);
  return accounts[0]?.id;
}

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

async function resolveSessionContinuationState(session: ChatSession): Promise<{
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

export async function listChatSessionsForOwnedUser(
  userId: string,
): Promise<ServiceResult<ChatSessionDto[]>> {
  const sessions = await getChatSessionsByUserId(userId);
  return ok(sessions.map(toChatSessionDto));
}

/**
 * 列出当前用户已归档的 AI Chat 会话。
 *
 * @param userId 会话归属用户 ID。
 * @returns 已归档会话 DTO 列表。
 */
export async function listArchivedChatSessionsForOwnedUser(
  userId: string,
): Promise<ServiceResult<ChatSessionDto[]>> {
  const sessions = await getArchivedChatSessionsByUserId(userId);
  return ok(sessions.map(toChatSessionDto));
}

export async function createChatSessionForOwnedUser(
  userId: string,
  title: string,
): Promise<ServiceResult<ChatSessionDto>> {
  const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedTitle = normalizeOwnedChatSessionTitle(title);
  const session = await createChatSession({
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
 * 兼容旧路由命名的归档入口。
 *
 * @param userId 会话归属用户 ID。
 * @param sessionId chat_sessions.id。
 * @returns 成功响应；无权限或会话不存在时返回错误。
 */
export async function deleteOwnedChatSession(
  userId: string,
  sessionId: string,
): Promise<ServiceResult<SuccessResponse>> {
  return archiveOwnedChatSession(userId, sessionId);
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

export async function getOwnedChatSessionMessages(
  userId: string,
  sessionId: string,
  limit: number,
  before?: string,
): Promise<ServiceResult<SessionMessageListResponseDto>> {
  const sessionResult = await getOwnedSession(userId, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  const session = sessionResult.data;
  const [messages, processingRequestId] = await Promise.all([
    getRecentMessages(session.account_id, limit, before, undefined, session.id),
    getRedis().get(sessionProcessingLockKey(session.id)),
  ]);
  const continuation = await resolveSessionContinuationState(session);

  return ok(
    toSessionMessageListResponseDto(messages, Boolean(processingRequestId), {
      continuationBlocked: continuation.blocked,
      continuationBlockReason: continuation.reason,
      continuationBlockMessage: continuation.message,
    }),
  );
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

export async function getOwnedChatSessionQueryProcessSource(
  userId: string,
  sessionId: string,
  messageId: string,
): Promise<
  ServiceResult<{
    available: boolean;
    request_id: string | null;
    trace_events: unknown[];
  }>
> {
  const sessionResult = await getOwnedSession(userId, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  const session = sessionResult.data;
  const message = await getSessionMessageById(
    session.account_id,
    session.id,
    messageId,
  );
  if (!message) {
    return fail(404, '消息不存在');
  }

  const metadata =
    message.metadata &&
    typeof message.metadata === 'object' &&
    !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : null;
  const requestId =
    metadata && typeof metadata.request_id === 'string'
      ? metadata.request_id
      : null;

  if (!requestId) {
    return ok({
      available: false,
      request_id: null,
      trace_events: [],
    });
  }

  const log = await getConversationLogByRequestId(requestId);
  if (!log || log.account_id !== session.account_id) {
    return ok({
      available: false,
      request_id: requestId,
      trace_events: [],
    });
  }

  return ok({
    available: true,
    request_id: requestId,
    trace_events: Array.isArray(log.trace_events) ? log.trace_events : [],
  });
}

/**
 * 中断当前用户拥有的 AI Chat 会话输出。
 *
 * @param userId 当前登录平台用户 ID。
 * @param sessionId 需要中断的 AI Chat 会话 ID。
 * @returns 成功响应；没有正在执行的请求也视为幂等成功。
 */
export async function cancelOwnedChatSessionMessage(
  userId: string,
  sessionId: string,
): Promise<ServiceResult<SuccessResponse>> {
  const sessionResult = await getOwnedSession(userId, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  await cancelAiChatSessionRequest(
    sessionResult.data.id,
    sessionResult.data.account_id,
  );
  return ok({ success: true });
}

export async function sendOwnedChatSessionMessage(
  userId: string,
  sessionId: string,
  input: NormalizedChatSessionMessageInput,
  options: OwnedChatSessionTurnOptions = {},
): Promise<ServiceResult<ChatSessionSendResponseDto>> {
  const prepared = await prepareOwnedChatSessionTurn(
    userId,
    sessionId,
    input,
    options,
  );
  if (!prepared.ok) {
    return prepared;
  }

  return enqueuePreparedOwnedChatSessionTurn(prepared.data);
}

/**
 * 执行当前用户拥有的 AI Chat 会话一轮对话。
 *
 * @param userId - 会话归属用户。
 * @param sessionId - chat_sessions.id。
 * @param input - 标准化后的用户输入。
 * @param options - 内部调用选项；微信入口用于传入来源与幂等消息 ID。
 * @returns 包含 HTTP 响应数据和最终已落库 assistant 消息的服务结果。
 */
export async function runOwnedChatSessionTurn(
  userId: string,
  sessionId: string,
  input: NormalizedChatSessionMessageInput,
  options: OwnedChatSessionTurnOptions = {},
): Promise<ServiceResult<OwnedChatSessionTurnResult>> {
  const prepared = await prepareOwnedChatSessionTurn(
    userId,
    sessionId,
    input,
    options,
  );
  if (!prepared.ok) {
    return prepared;
  }

  return completeOwnedChatSessionTurn(prepared.data);
}

async function prepareOwnedChatSessionTurn(
  userId: string,
  sessionId: string,
  input: NormalizedChatSessionMessageInput,
  options: OwnedChatSessionTurnOptions = {},
): Promise<ServiceResult<PreparedOwnedChatSessionTurn>> {
  const sessionResult = await getOwnedSession(userId, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  const session = sessionResult.data;
  const continuation = await resolveSessionContinuationState(session);
  if (continuation.blocked) {
    return fail(
      410,
      continuation.message ?? SESSION_CONTINUATION_BLOCKED_MESSAGE,
    );
  }

  const owner = await getUserById(userId);
  if (owner && owner.purchased_coins + owner.bonus_coins < 0) {
    return fail(402, BILLING_ARREARS_MESSAGE);
  }
  let freeQuotaRequired = false;
  if (!options.plusGateBypass) {
    const membership = await getMembershipOverview(userId);
    if (!hasBaseMembershipEntitlement(membership)) {
      freeQuotaRequired = true;
    }
  }
  const msgId =
    options.userMessageId ??
    `aichat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (options.userMessageId) {
    const existingMessage = await getSessionMessageById(
      session.account_id,
      session.id,
      options.userMessageId,
    );
    if (existingMessage) {
      return fail(409, '消息已处理');
    }
  }
  const selectedBoardMessageId = input.selectedBoardMessageId;
  const selectedBoardContext = selectedBoardMessageId
    ? await (async () => {
        const selectedBoardMessage = await getSessionMessageById(
          session.account_id,
          session.id,
          selectedBoardMessageId,
        );
        if (!selectedBoardMessage) {
          return fail(404, '指定的盘面消息不存在');
        }
        if (!buildSelectedBoardContext(selectedBoardMessage)) {
          return fail(400, '指定的消息不包含可用盘面');
        }
        return ok(true);
      })()
    : null;
  if (selectedBoardContext && !selectedBoardContext.ok) {
    return selectedBoardContext;
  }

  const requestId = createAiChatRequestId();
  const processingClaimed = await claimChatSessionProcessing(
    session.id,
    requestId,
  );
  if (!processingClaimed) {
    return fail(409, SESSION_PROCESSING_BUSY_ERROR);
  }
  let freeProfessionalAiUsageDate: string | undefined;
  if (freeQuotaRequired) {
    const quota = await claimFreeProfessionalAiTurn({ userId });
    if (!quota.allowed) {
      await releaseChatSessionProcessing(session.id, requestId);
      return fail(403, FREE_PROFESSIONAL_AI_QUOTA_EXHAUSTED_MESSAGE);
    }
    freeProfessionalAiUsageDate = quota.usage_date;
  }
  try {
    await options.onProcessingClaimed?.();
  } catch (err) {
    logger.warn(
      { accountId: session.account_id, sessionId: session.id, err },
      'AI 对话: 会话抢占后的回调执行失败',
    );
  }

  try {
    const llmRuntime =
      options.llmRuntimeOverride ?? (await resolveUserLlmRuntime(userId));
    const authorizedSkillBundleIds =
      options.authorizedSkillBundleIds === undefined
        ? undefined
        : normalizeAuthorizedIds(options.authorizedSkillBundleIds);
    const authorizedWorkflowSkillIds =
      options.authorizedWorkflowSkillIds === undefined
        ? undefined
        : normalizeAuthorizedIds(options.authorizedWorkflowSkillIds);
    const previousMessages =
      input.inputKind === 'normal'
        ? await getSessionMessages(session.account_id, session.id)
        : [];
    const userMessage: NewMessage = {
      id: msgId,
      account_id: session.account_id,
      user_id: userId,
      sender: userId,
      sender_name: WEB_CHAT_USER_NAME,
      content: input.content,
      metadata: mergeMessageMetadata(
        input.inputKind === 'user_pasted_board'
          ? {
              kind: 'user_pasted_board',
              category: input.pastedBoard?.category,
            }
          : null,
        options.sourceMetadata,
      ),
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
      session_id: session.id,
    };
    await storeMessage(userMessage);
    const boardMessages = await getSessionMessagesWithToolContext(
      session.account_id,
      session.id,
    );
    const sessionBoardContexts = buildSessionBoardContexts(boardMessages, {
      selectedBoardMessageId,
      currentPastedBoard:
        input.inputKind === 'user_pasted_board' && input.pastedBoard
          ? {
              sourceMessageId: msgId,
              pastedBoard: input.pastedBoard,
              createdAt: userMessage.timestamp,
            }
          : undefined,
    });
    const defaultRuntimeUserMessage =
      buildRuntimeUserMessageForBoardFirstQuestion({
        input,
        previousMessages,
        sessionBoardContexts,
      });
    const runtimeUserMessage =
      options.runtimeUserMessageOverride?.trim() || defaultRuntimeUserMessage;

    const structured = await buildStructuredInputForSession(
      {
        runtimeId: session.account_id,
        userName: WEB_CHAT_USER_NAME,
        assistantName: WEB_CHAT_ASSISTANT_NAME,
        soulAccountId: await resolveOwnedSoulAccountId(userId),
      },
      runtimeUserMessage,
      session.id,
      llmRuntime.model,
      llmRuntime.contextWindowTokens,
    );

    return ok({
      userId,
      session,
      input,
      msgId,
      requestId,
      llmRuntime,
      structured,
      sessionBoardContexts,
      authorizedSkillBundleIds,
      authorizedWorkflowSkillIds,
      sessionTitle:
        normalizeOwnedChatSessionTitle(session.title) ||
        DEFAULT_OWNED_CHAT_SESSION_TITLE,
      freeProfessionalAiUsageDate,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await releaseChatSessionProcessing(session.id, requestId);
    await compensateFreeProfessionalAiTurn({
      userId,
      freeProfessionalAiUsageDate,
    });
    logger.error(
      { accountId: session.account_id, sessionId: session.id, err },
      'AI 对话: 请求准备失败',
    );

    if (isPaymentRequiredError(errorMessage)) {
      return fail(402, errorMessage);
    }

    return fail(502, errorMessage || '抱歉，AI 服务暂时不可用');
  }
}

async function enqueuePreparedOwnedChatSessionTurn(
  prepared: PreparedOwnedChatSessionTurn,
): Promise<ServiceResult<ChatSessionSendResponseDto>> {
  const { input, llmRuntime, msgId, requestId, session, structured } = prepared;

  try {
    const output = await dispatchAiChatPrompt({
      accountId: session.account_id,
      userMessage: structured.userMessage,
      inputKind: input.inputKind,
      pastedBoard: input.pastedBoard,
      history: [],
      sessionBoardContexts: prepared.sessionBoardContexts,
      userName: structured.userName,
      assistantName: structured.assistantName,
      sessionId: session.id,
      userMessageId: msgId,
      requestId,
      llmRuntime,
      authorizedSkillBundleIds: prepared.authorizedSkillBundleIds,
      authorizedWorkflowSkillIds: prepared.authorizedWorkflowSkillIds,
      waitForResponse: false,
    });

    if (output.status === 'error') {
      const errorMessage =
        output.publicErrorText || output.text || output.error || 'AI 处理失败';
      await releaseChatSessionProcessing(session.id, requestId);
      await compensateFreeProfessionalAiTurn(prepared);
      return fail(
        isPaymentRequiredError(errorMessage) ? 402 : 502,
        errorMessage,
      );
    }

    return ok({
      text: '',
      accepted: true,
      request_id: output.requestId || requestId,
      session_title: prepared.sessionTitle || DEFAULT_OWNED_CHAT_SESSION_TITLE,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await releaseChatSessionProcessing(session.id, requestId);
    await compensateFreeProfessionalAiTurn(prepared);
    logger.error(
      { accountId: session.account_id, sessionId: session.id, err },
      'AI 对话: 请求入队失败',
    );

    if (isPaymentRequiredError(errorMessage)) {
      return fail(402, errorMessage);
    }

    return fail(502, errorMessage || '抱歉，AI 服务暂时不可用');
  }
}

async function completeOwnedChatSessionTurn(
  prepared: PreparedOwnedChatSessionTurn,
): Promise<ServiceResult<OwnedChatSessionTurnResult>> {
  const { input, llmRuntime, msgId, requestId, session, structured } = prepared;

  try {
    const output = await dispatchAiChatPrompt({
      accountId: session.account_id,
      userMessage: structured.userMessage,
      inputKind: input.inputKind,
      pastedBoard: input.pastedBoard,
      history: [],
      sessionBoardContexts: prepared.sessionBoardContexts,
      userName: structured.userName,
      assistantName: structured.assistantName,
      sessionId: session.id,
      userMessageId: msgId,
      requestId,
      llmRuntime,
      authorizedSkillBundleIds: prepared.authorizedSkillBundleIds,
      authorizedWorkflowSkillIds: prepared.authorizedWorkflowSkillIds,
    });

    if (output.status === 'error') {
      const errorMessage =
        output.publicErrorText || output.text || output.error || 'AI 处理失败';
      logger.warn(
        {
          accountId: session.account_id,
          sessionId: session.id,
          error: output.error,
        },
        'AI 对话: agent 返回错误',
      );
      await compensateFreeProfessionalAiTurn(prepared);
      return fail(
        isPaymentRequiredError(errorMessage) ? 402 : 502,
        errorMessage,
      );
    }

    const replyText = output.text || '';
    const replyTexts = normalizeAssistantReplyTexts(output);
    const replyTimestampBase = Date.now();
    const finalAssistantMessages: MessageDto[] = [];

    // 多轮 runtime 可能返回多条 assistant 文本；这里仅组装给同步调用方，最终落库由 outbox handler 统一完成。
    for (let index = 0; index < replyTexts.length; index += 1) {
      const isFinalReply = index === replyTexts.length - 1;
      const assistantMessage: NewMessage = {
        id:
          replyTexts.length === 1
            ? `${msgId}_reply`
            : `${msgId}_reply_${index + 1}`,
        account_id: session.account_id,
        user_id: prepared.userId,
        sender: session.account_id,
        sender_name: WEB_CHAT_ASSISTANT_NAME,
        content: replyTexts[index],
        timestamp: new Date(replyTimestampBase + index).toISOString(),
        is_from_me: true,
        is_bot_message: true,
        session_id: session.id,
        tool_context:
          isFinalReply && output.skillContext && output.skillContext.length > 0
            ? JSON.stringify(output.skillContext)
            : null,
        metadata: isFinalReply
          ? buildFinalReplyMetadata(output)
          : {
              kind: 'assistant',
              request_id: output.requestId,
            },
      };
      finalAssistantMessages.push(toMessageDto(assistantMessage));
    }

    return ok({
      response: {
        text: replyText,
        session_title:
          prepared.sessionTitle || DEFAULT_OWNED_CHAT_SESSION_TITLE,
        request_id: output.requestId || requestId,
      },
      finalAssistantMessages,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await releaseChatSessionProcessing(session.id, requestId);
    await compensateFreeProfessionalAiTurn(prepared);
    logger.error(
      { accountId: session.account_id, sessionId: session.id, err },
      'AI 对话: agent 调用失败',
    );

    if (isPaymentRequiredError(errorMessage)) {
      return fail(402, errorMessage);
    }

    return fail(502, errorMessage || '抱歉，AI 服务暂时不可用');
  }
}
