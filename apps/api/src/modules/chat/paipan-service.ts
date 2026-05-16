import crypto from 'crypto';

import type {
  MessageDto,
  PaipanCatalogItemDto,
  PaipanCommitRequestDto,
  PaipanCommitResponseDto,
  PaipanPreviewResponseDto,
  SkillContextEntryDto,
} from '@nanoclaw/contracts/chat';

import {
  createChatSession,
  getChatSession,
  storeMessage,
  touchChatSession,
} from '../../infrastructure/db.js';
import { logger } from '../../infrastructure/logger.js';
import { getRedis } from '../../infrastructure/redis.js';
import {
  toChatSessionDto,
  toMessageDto,
} from '../../contracts-adapter/chat-contract.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';
import type { ChatSession, NewMessage } from '../../shared/types.js';
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
const DIRECT_PAIPAN_NOTE_MAX_LENGTH = 40;

interface DirectPaipanPreviewRecord {
  previewId: string;
  userId: string;
  runtimeId: string;
  skill: string;
  requestSummary: string;
  sessionTitle: string;
  skillContextEntry: SkillContextEntryDto;
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

function normalizeDirectPaipanDisplayNote(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  // 备注会拼到术数名后展示，限制长度避免撑坏会话列表和盘面引用提示。
  return normalized.slice(0, DIRECT_PAIPAN_NOTE_MAX_LENGTH);
}

function appendDirectPaipanDisplayNote(args: {
  skillContextEntry: SkillContextEntryDto;
  requestSummary: string;
  sessionTitle: string;
  displayNote?: string;
}): {
  skillContextEntry: SkillContextEntryDto;
  requestSummary: string;
  sessionTitle: string;
} {
  if (!args.displayNote) {
    return {
      skillContextEntry: args.skillContextEntry,
      requestSummary: args.requestSummary,
      sessionTitle: args.sessionTitle,
    };
  }

  const baseTitle =
    args.skillContextEntry.artifactTitle ||
    args.sessionTitle ||
    args.requestSummary;
  const title = `${baseTitle} · ${args.displayNote}`;
  return {
    requestSummary: title,
    sessionTitle: title,
    skillContextEntry: {
      ...args.skillContextEntry,
      artifactTitle: title,
    },
  };
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
      content: `已生成：${title}`,
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
      typeof parsed.userId !== 'string' ||
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
    return parsed;
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
}): Promise<{
  session: ChatSession;
  requestMessage: MessageDto;
  resultMessage: MessageDto;
}> {
  const session = await createChatSession({
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    accountId: args.runtimeId,
    userId: args.userId,
    title: args.sessionTitle,
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

export async function listDirectPaipanCatalogForOwnedUser(
  userId: string,
): Promise<ServiceResult<PaipanCatalogItemDto[]>> {
  const catalog = await listDirectPaipanCatalog(userId);
  return ok(catalog);
}

export async function previewDirectPaipanForOwnedUser(args: {
  userId: string;
  skill: string;
  input: Record<string, unknown>;
}): Promise<ServiceResult<PaipanPreviewResponseDto>> {
  const runtimeId = getWebChatRuntimeId(args.userId);

  try {
    const execution = await executeDirectPaipan({
      accountId: runtimeId,
      userId: args.userId,
      skillDir: args.skill,
      input: args.input,
    });
    const previewId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + PAIPAN_PREVIEW_TTL_MS,
    ).toISOString();

    await storeDirectPaipanPreviewRecord({
      previewId,
      userId: args.userId,
      runtimeId,
      skill: execution.skill.dir,
      requestSummary: execution.requestSummary,
      sessionTitle: execution.sessionTitle,
      skillContextEntry: execution.skillContextEntry,
      createdAt,
      expiresAt,
    });

    logger.info(
      {
        userId: args.userId,
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

export async function commitDirectPaipanForOwnedUser(
  userId: string,
  request: PaipanCommitRequestDto,
): Promise<ServiceResult<PaipanCommitResponseDto>> {
  const displayNote = normalizeDirectPaipanDisplayNote(request.displayNote);

  if (request.target === 'new_session_from_preview') {
    if (!request.previewId) {
      return fail(400, '缺少 previewId');
    }

    const preview = await loadDirectPaipanPreviewRecord(request.previewId);
    if (!preview) {
      return fail(410, '预览结果已失效，请重新排盘');
    }
    if (preview.userId !== userId) {
      return fail(403, '无权提交该预览结果');
    }

    const commitPayload = appendDirectPaipanDisplayNote({
      requestSummary: preview.requestSummary,
      sessionTitle: preview.sessionTitle,
      skillContextEntry: preview.skillContextEntry,
      displayNote,
    });

    const created = await createSessionWithBoardMessages({
      userId,
      runtimeId: preview.runtimeId,
      sessionTitle: commitPayload.sessionTitle,
      requestSummary: commitPayload.requestSummary,
      skillContextEntry: commitPayload.skillContextEntry,
    });
    await deleteDirectPaipanPreviewRecord(request.previewId);

    logger.info(
      {
        userId,
        accountId: preview.runtimeId,
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
    const execution = await executeDirectPaipan({
      accountId: sessionResult.data.account_id,
      userId,
      skillDir: request.skill,
      input: request.input,
      displayNote,
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
