import crypto from 'crypto';

import type {
  MessageDto,
  PaipanCatalogItemDto,
  PaipanCommitRequestDto,
  PaipanCommitResponseDto,
  PaipanPreviewResponseDto,
  SkillContextEntryDto,
} from '@fateclaw/contracts/chat';

import { getPreferredModelPool } from '#infrastructure/repositories/benefit-repository';
import {
  createChatSession,
  getChatSession,
  storeMessage,
  touchChatSession,
} from '#infrastructure/db';
import { logger } from '#infrastructure/logger';
import { getRedis } from '#infrastructure/redis';
import {
  toChatSessionDto,
  toMessageDto,
} from '#contracts-adapter/chat-contract';
import { fail, ok, type ServiceResult } from '#shared/service-result';
import type { ChatSession, NewMessage } from '#shared/types';
import { applyClientProfilePrefill } from './client-profile-service.js';
import {
  DirectPaipanError,
  executeDirectPaipan,
  listDirectPaipanCatalog,
} from './paipan-runtime.js';
import {
  getWebChatRuntimeId,
  WEB_CHAT_ASSISTANT_NAME,
  WEB_CHAT_USER_NAME,
} from './web-chat-runtime.js';

const PAIPAN_PREVIEW_TTL_MS = 30 * 60 * 1000;

interface DirectPaipanPreviewRecord {
  previewId: string;
  userId: string | null;
  runtimeId: string;
  skill: string;
  requestSummary: string;
  sessionTitle: string;
  skillContextEntry: SkillContextEntryDto;
  /** 预览时关联的客户档案 id；提交为新会话时回填到会话。 */
  clientId: string | null;
  createdAt: string;
  expiresAt: string;
}

async function verifyOwnedSession(
  userId: string,
  sessionId: string,
): Promise<ServiceResult<ChatSession>> {
  const session = await getChatSession(sessionId);
  if (!session) {
    return fail(404, '会话不存在');
  }

  if (session.user_id !== userId) {
    return fail(403, '无权访问该会话');
  }

  return ok(session);
}

function createMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildDirectPaipanMessages(args: {
  userId: string;
  runtimeId: string;
  session: ChatSession;
  requestSummary: string;
  skillContextEntry: SkillContextEntryDto;
}): {
  requestMessage: NewMessage;
  resultMessage: NewMessage;
} {
  const requestId = createMessageId('paipan-req');
  const resultId = createMessageId('paipan-res');
  const now = new Date().toISOString();
  const title =
    args.skillContextEntry.artifactTitle || args.skillContextEntry.skill;
  const resultText = `已生成${title}。你可以直接提问，后续未切换主题时会参考此盘面。`;
  return {
    requestMessage: {
      id: requestId,
      account_id: args.runtimeId,
      user_id: args.userId,
      sender: args.userId,
      sender_name: WEB_CHAT_USER_NAME,
      content: args.requestSummary,
      timestamp: now,
      is_from_me: false,
      is_bot_message: false,
      session_id: args.session.id,
      metadata: {
        kind: 'board_request',
        workflow: 'direct_paipan',
        board_skill: args.skillContextEntry.skill,
      },
    },
    resultMessage: {
      id: resultId,
      account_id: args.runtimeId,
      user_id: args.userId,
      sender: args.runtimeId,
      sender_name: WEB_CHAT_ASSISTANT_NAME,
      content: resultText,
      timestamp: now,
      is_from_me: true,
      is_bot_message: true,
      session_id: args.session.id,
      tool_context: JSON.stringify([args.skillContextEntry]),
      metadata: {
        kind: 'board_result',
        workflow: 'direct_paipan',
        board_skill: args.skillContextEntry.skill,
      },
    },
  };
}

function mapDirectPaipanError(error: unknown): ServiceResult<never> {
  if (error instanceof DirectPaipanError) {
    return fail(error.statusCode, error.message);
  }
  logger.error({ err: error }, '纯排盘执行失败');
  return fail(500, '排盘服务暂时不可用，请稍后重试');
}

async function storeDirectPaipanPreviewRecord(
  record: DirectPaipanPreviewRecord,
): Promise<void> {
  await getRedis().set(
    `direct-paipan:preview:${record.previewId}`,
    JSON.stringify(record),
    'PX',
    PAIPAN_PREVIEW_TTL_MS,
  );
}

async function loadDirectPaipanPreviewRecord(
  previewId: string,
): Promise<DirectPaipanPreviewRecord | null> {
  const raw = await getRedis().get(`direct-paipan:preview:${previewId}`);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as DirectPaipanPreviewRecord;
    if (
      typeof parsed.previewId !== 'string' ||
      (parsed.userId !== null && typeof parsed.userId !== 'string') ||
      typeof parsed.runtimeId !== 'string' ||
      typeof parsed.skill !== 'string' ||
      typeof parsed.requestSummary !== 'string' ||
      typeof parsed.sessionTitle !== 'string' ||
      !parsed.skillContextEntry ||
      typeof parsed.skillContextEntry !== 'object' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.expiresAt !== 'string'
    ) {
      return null;
    }
    // 兼容历史缓存记录：旧记录没有 clientId 字段，按未关联客户处理。
    return { ...parsed, clientId: parsed.clientId ?? null };
  } catch {
    return null;
  }
}

async function deleteDirectPaipanPreviewRecord(
  previewId: string,
): Promise<void> {
  await getRedis().del(`direct-paipan:preview:${previewId}`);
}

async function createSessionWithBoardMessages(args: {
  userId: string;
  runtimeId: string;
  sessionTitle: string;
  requestSummary: string;
  skillContextEntry: SkillContextEntryDto;
  clientId?: string | null;
}): Promise<{
  session: ChatSession;
  requestMessage: MessageDto;
  resultMessage: MessageDto;
}> {
  const session = await createChatSession({
    modelPoolKey: await getPreferredModelPool(args.userId),
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    accountId: args.runtimeId,
    userId: args.userId,
    title: args.sessionTitle,
    clientId: args.clientId ?? undefined,
  });
  const { requestMessage, resultMessage } = buildDirectPaipanMessages({
    userId: args.userId,
    runtimeId: args.runtimeId,
    session,
    requestSummary: args.requestSummary,
    skillContextEntry: args.skillContextEntry,
  });
  await storeMessage(requestMessage);
  await storeMessage(resultMessage);
  await touchChatSession(session.id);

  return {
    session,
    requestMessage: toMessageDto(requestMessage),
    resultMessage: toMessageDto(resultMessage),
  };
}

async function appendBoardMessagesToExistingSession(args: {
  userId: string;
  runtimeId: string;
  session: ChatSession;
  requestSummary: string;
  skillContextEntry: SkillContextEntryDto;
}): Promise<{
  session: ChatSession;
  requestMessage: MessageDto;
  resultMessage: MessageDto;
}> {
  const { requestMessage, resultMessage } = buildDirectPaipanMessages({
    userId: args.userId,
    runtimeId: args.runtimeId,
    session: args.session,
    requestSummary: args.requestSummary,
    skillContextEntry: args.skillContextEntry,
  });
  await storeMessage(requestMessage);
  await storeMessage(resultMessage);
  await touchChatSession(args.session.id);
  return {
    session: args.session,
    requestMessage: toMessageDto(requestMessage),
    resultMessage: toMessageDto(resultMessage),
  };
}

/**
 * 获取当前可用的直接排盘目录。
 * userId 为空时只返回公共排盘能力；传入用户时可包含用户可见的扩展能力。
 */
export async function listDirectPaipanCatalogForOwnedUser(
  userId?: string,
): Promise<ServiceResult<PaipanCatalogItemDto[]>> {
  const catalog = await listDirectPaipanCatalog(userId);
  return ok(catalog);
}

/**
 * 执行直接排盘预览，并把预览结果写入短期缓存。
 * userId 为空时按游客预览保存，后续提交会凭不可猜测的 previewId 绑定到登录用户。
 *
 * @remarks 传入 clientId 时（需登录）用客户档案生辰预填排盘输入，本轮输入优先；
 *          clientId 会随预览记录保存，提交为新会话时回填到会话。
 */
export async function previewDirectPaipanForOwnedUser(args: {
  userId?: string;
  skill: string;
  input: Record<string, unknown>;
  clientId?: string;
}): Promise<ServiceResult<PaipanPreviewResponseDto>> {
  const runtimeId = args.userId
    ? getWebChatRuntimeId(args.userId)
    : getWebChatRuntimeId('public-preview');

  // 客户档案预填仅在登录用户携带 clientId 时生效；游客预览忽略 clientId。
  const effectiveClientId = args.userId ? args.clientId : undefined;
  const effectiveInput = effectiveClientId
    ? await applyClientProfilePrefill(
        args.userId as string,
        effectiveClientId,
        args.input,
      )
    : args.input;

  try {
    const execution = await executeDirectPaipan({
      accountId: runtimeId,
      userId: args.userId,
      skillDir: args.skill,
      input: effectiveInput,
    });
    const previewId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + PAIPAN_PREVIEW_TTL_MS,
    ).toISOString();

    await storeDirectPaipanPreviewRecord({
      previewId,
      userId: args.userId ?? null,
      runtimeId,
      skill: execution.skill.dir,
      requestSummary: execution.requestSummary,
      sessionTitle: execution.sessionTitle,
      skillContextEntry: execution.skillContextEntry,
      clientId: effectiveClientId ?? null,
      createdAt,
      expiresAt,
    });

    logger.info(
      {
        userId: args.userId ?? null,
        accountId: runtimeId,
        skill: execution.skill.dir,
        workflow: 'direct_paipan_preview',
      },
      '纯排盘预览完成',
    );

    return ok({
      previewId,
      skillContextEntry: execution.skillContextEntry,
      expiresAt,
    });
  } catch (error) {
    return mapDirectPaipanError(error);
  }
}

/**
 * 将直接排盘结果写入用户会话。
 * 从预览提交时会校验已绑定预览的归属；游客预览则在提交时归属到当前登录用户。
 *
 * @param userId 当前登录用户 ID。
 * @param request 提交请求体。
 * @param clientId 关联的客户档案 id；新会话时绑定到会话，当前会话提交时用于生辰预填。
 */
export async function commitDirectPaipanForOwnedUser(
  userId: string,
  request: PaipanCommitRequestDto,
  clientId?: string,
): Promise<ServiceResult<PaipanCommitResponseDto>> {
  if (request.target === 'new_session_from_preview') {
    if (!request.previewId) {
      return fail(400, '缺少 previewId');
    }

    const preview = await loadDirectPaipanPreviewRecord(request.previewId);
    if (!preview) {
      return fail(410, '预览结果已失效，请重新排盘');
    }
    if (preview.userId && preview.userId !== userId) {
      return fail(403, '无权提交该预览结果');
    }
    const runtimeId = preview.userId
      ? preview.runtimeId
      : getWebChatRuntimeId(userId);

    // 优先使用预览时已关联的客户；预览未关联时回落到本次提交携带的 clientId。
    const created = await createSessionWithBoardMessages({
      userId,
      runtimeId,
      sessionTitle: preview.sessionTitle,
      requestSummary: preview.requestSummary,
      skillContextEntry: preview.skillContextEntry,
      clientId: preview.clientId ?? clientId ?? null,
    });
    await deleteDirectPaipanPreviewRecord(request.previewId);

    logger.info(
      {
        userId,
        accountId: runtimeId,
        sessionId: created.session.id,
        skill: preview.skill,
        workflow: 'direct_paipan_commit',
      },
      '纯排盘预览已提交为新会话',
    );

    return ok({
      session: toChatSessionDto(created.session),
      requestMessage: created.requestMessage,
      resultMessage: created.resultMessage,
    });
  }

  if (request.target !== 'current_session') {
    return fail(400, '非法 target');
  }

  if (!request.sessionId) {
    return fail(400, '缺少 sessionId');
  }
  if (!request.skill) {
    return fail(400, '缺少 skill');
  }
  if (
    !request.input ||
    typeof request.input !== 'object' ||
    Array.isArray(request.input)
  ) {
    return fail(400, '缺少有效的 input');
  }

  const sessionResult = await verifyOwnedSession(userId, request.sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  try {
    // 当前会话提交：优先用本次携带的 clientId，否则沿用会话已绑定的客户做生辰预填。
    const prefillClientId =
      clientId ?? sessionResult.data.client_id ?? undefined;
    const effectiveInput = prefillClientId
      ? await applyClientProfilePrefill(userId, prefillClientId, request.input)
      : request.input;
    const execution = await executeDirectPaipan({
      accountId: sessionResult.data.account_id,
      userId,
      skillDir: request.skill,
      input: effectiveInput,
    });

    const appended = await appendBoardMessagesToExistingSession({
      userId,
      runtimeId: sessionResult.data.account_id,
      session: sessionResult.data,
      requestSummary: execution.requestSummary,
      skillContextEntry: execution.skillContextEntry,
    });

    logger.info(
      {
        userId,
        accountId: sessionResult.data.account_id,
        sessionId: sessionResult.data.id,
        skill: execution.skill.dir,
        workflow: 'direct_paipan_commit',
      },
      '纯排盘结果已插入当前会话',
    );

    return ok({
      session: toChatSessionDto(appended.session),
      requestMessage: appended.requestMessage,
      resultMessage: appended.resultMessage,
    });
  } catch (error) {
    return mapDirectPaipanError(error);
  }
}
