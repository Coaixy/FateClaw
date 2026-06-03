import crypto from 'node:crypto';

import type { ChatSessionDto, MessageDto } from '@fateclaw/contracts/chat';

import {
  createChatSessionForOwnedUser,
  listChatSessionsForOwnedUser,
  runOwnedChatSessionTurn,
} from './chat-session-service.js';
import {
  deleteWechatChatSessionLink,
  getChatSession,
  getWechatChatSessionLink,
  touchWechatChatSessionLink,
  upsertWechatChatSessionLink,
} from '../../infrastructure/db.js';
import { getRedis } from '../../infrastructure/redis.js';
import { logger } from '../../infrastructure/logger.js';
import { sessionProcessingLockKey } from '../../runtime/ipc-payloads.js';
import type { Account, User } from '../../shared/types.js';

const WECHAT_SESSION_LIST_LIMIT = 5;
const WECHAT_SESSION_LIST_CACHE_SECONDS = 600;
const WECHAT_DEFAULT_SESSION_TITLE = '微信对话';

export const WECHAT_CHAT_THINKING_ACK =
  '收到，正在思考。完成后会直接回复；期间新消息不会进入本轮。';

type WechatChatCommand =
  | { type: 'sessions' }
  | { type: 'resume'; target: string }
  | { type: 'new'; title?: string }
  | { type: 'where' }
  | { type: 'detach' }
  | { type: 'help' };

/**
 * 微信命令处理结果。
 *
 * @remarks handled 为 false 时调用方应继续普通消息流程；replyText 为空表示无需回复。
 */
export interface WechatChatCommandResult {
  handled: boolean;
  replyText?: string;
}

/**
 * 微信普通消息进入网页 AI Chat session 后的处理结果。
 *
 * @remarks discarded 表示本条消息未进入网页 session，也未触发模型。
 */
export interface WechatChatTurnResult {
  status: 'completed' | 'discarded';
  sessionId?: string;
  finalAssistantMessages?: MessageDto[];
}

function sha256Short(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/**
 * 构建微信 sender 的去标识化哈希。
 *
 * @param accountId - 微信 Claw 账号 ID。
 * @param sender - iLink 来信发送方 ID。
 * @returns 32 位十六进制哈希。
 */
export function buildWechatSenderHash(
  accountId: string,
  sender: string,
): string {
  return sha256Short(`${accountId}:${sender}`);
}

/**
 * 构建微信消息进入网页 session 时使用的确定性消息 ID。
 *
 * @param accountId - 微信 Claw 账号 ID。
 * @param messageId - iLink message_id 或兜底消息 ID。
 * @returns 可写入 messages.id 的去标识化 ID。
 */
export function buildWechatSessionUserMessageId(
  accountId: string,
  messageId: string,
): string {
  return `wxmsg-${sha256Short(`${accountId}:${messageId}`)}`;
}

function sessionListCacheKey(accountId: string, senderHash: string): string {
  return `wechat:sessions:list:${accountId}:${senderHash}`;
}

function formatSessionTime(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  return time.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatSessionTitle(session: ChatSessionDto): string {
  return session.title?.trim() || '新对话';
}

function formatSessionList(sessions: ChatSessionDto[]): string {
  if (sessions.length === 0) {
    return '还没有网页 AI Chat 会话。发送 /new 新建一个微信对话。';
  }
  const rows = sessions.map(
    (session, index) =>
      `${index + 1}. ${formatSessionTitle(session)} · ${formatSessionTime(session.updated_at)}`,
  );
  return [
    '选择要接续的网页会话：',
    '',
    ...rows,
    '',
    '发送 /resume 1 接续；发送 /new 新建微信对话。',
  ].join('\n');
}

function helpText(): string {
  return [
    '微信 Claw 命令：',
    '/sessions 查看最近网页会话',
    '/resume 1 接续指定会话',
    '/resume 最近 接续最近会话',
    '/new 新建并接续网页会话',
    '/where 查看当前接续',
    '/detach 断开当前接续',
  ].join('\n');
}

async function listRecentSessions(userId: string): Promise<ChatSessionDto[]> {
  const result = await listChatSessionsForOwnedUser(userId);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.data.slice(0, WECHAT_SESSION_LIST_LIMIT);
}

async function cacheSessionList(input: {
  accountId: string;
  senderHash: string;
  sessions: ChatSessionDto[];
}): Promise<void> {
  await getRedis().set(
    sessionListCacheKey(input.accountId, input.senderHash),
    JSON.stringify(input.sessions.map((session) => session.id)),
    'EX',
    WECHAT_SESSION_LIST_CACHE_SECONDS,
  );
}

async function resolveCachedSessionId(input: {
  accountId: string;
  senderHash: string;
  target: string;
}): Promise<string | null> {
  const index = Number.parseInt(input.target, 10);
  if (!Number.isInteger(index) || index < 1) return null;
  const raw = await getRedis().get(
    sessionListCacheKey(input.accountId, input.senderHash),
  );
  if (!raw) return null;
  try {
    const ids = JSON.parse(raw);
    if (!Array.isArray(ids)) return null;
    const sessionId = ids[index - 1];
    return typeof sessionId === 'string' && sessionId ? sessionId : null;
  } catch {
    return null;
  }
}

async function resolveResumeSessionId(input: {
  userId: string;
  accountId: string;
  senderHash: string;
  target: string;
}): Promise<
  { ok: true; sessionId: string } | { ok: false; replyText: string }
> {
  const normalized = input.target.trim();
  if (!normalized) {
    return {
      ok: false,
      replyText: '请发送 /resume 1，或先发送 /sessions 查看列表。',
    };
  }
  if (normalized === '最近') {
    const sessions = await listRecentSessions(input.userId);
    const latest = sessions[0];
    if (!latest) {
      return {
        ok: false,
        replyText: '还没有网页 AI Chat 会话。发送 /new 新建一个。',
      };
    }
    return { ok: true, sessionId: latest.id };
  }
  const cached = await resolveCachedSessionId(input);
  if (!cached) {
    return {
      ok: false,
      replyText: '未找到这个编号。请先发送 /sessions 查看最新列表。',
    };
  }
  return { ok: true, sessionId: cached };
}

async function bindSenderToSession(input: {
  accountId: string;
  senderHash: string;
  userId: string;
  sessionId: string;
}): Promise<ChatSessionDto | null> {
  const session = await getChatSession(input.sessionId);
  if (!session || session.user_id !== input.userId) return null;
  await upsertWechatChatSessionLink(input);
  return {
    id: session.id,
    account_id: session.account_id,
    title: session.title,
    created_at: session.created_at,
    updated_at: session.updated_at,
    share_token: session.share_token ?? null,
  };
}

function parseWechatChatCommand(content: string): WechatChatCommand | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return null;
  const [commandRaw = '', ...parts] = trimmed.split(/\s+/);
  const command = commandRaw.toLowerCase();
  const rest = parts.join(' ').trim();
  if (command === '/sessions') return { type: 'sessions' };
  if (command === '/resume') return { type: 'resume', target: rest };
  if (command === '/new') return { type: 'new', title: rest || undefined };
  if (command === '/where') return { type: 'where' };
  if (command === '/detach') return { type: 'detach' };
  if (command === '/help') return { type: 'help' };
  return { type: 'help' };
}

/**
 * 处理微信 Claw 的 AI Chat session 命令。
 *
 * @param input - 当前微信消息上下文与平台用户。
 * @returns handled 为 true 时由调用方发送 replyText；handled 为 false 时继续普通消息流程。
 */
export async function handleWechatChatCommand(input: {
  account: Account;
  owner: Pick<User, 'id'>;
  sender: string;
  content: string;
}): Promise<WechatChatCommandResult> {
  const command = parseWechatChatCommand(input.content);
  if (!command) return { handled: false };

  const senderHash = buildWechatSenderHash(input.account.id, input.sender);
  if (command.type === 'sessions') {
    const sessions = await listRecentSessions(input.owner.id);
    await cacheSessionList({
      accountId: input.account.id,
      senderHash,
      sessions,
    });
    return { handled: true, replyText: formatSessionList(sessions) };
  }

  if (command.type === 'resume') {
    const resolved = await resolveResumeSessionId({
      userId: input.owner.id,
      accountId: input.account.id,
      senderHash,
      target: command.target,
    });
    if (!resolved.ok) return { handled: true, replyText: resolved.replyText };
    const session = await bindSenderToSession({
      accountId: input.account.id,
      senderHash,
      userId: input.owner.id,
      sessionId: resolved.sessionId,
    });
    if (!session) return { handled: true, replyText: '会话不存在或已删除。' };
    return {
      handled: true,
      replyText: `已接续网页会话：${formatSessionTitle(session)}`,
    };
  }

  if (command.type === 'new') {
    const sessionResult = await createChatSessionForOwnedUser(
      input.owner.id,
      command.title || WECHAT_DEFAULT_SESSION_TITLE,
    );
    if (!sessionResult.ok) {
      return { handled: true, replyText: sessionResult.error };
    }
    await upsertWechatChatSessionLink({
      accountId: input.account.id,
      senderHash,
      userId: input.owner.id,
      sessionId: sessionResult.data.id,
    });
    return {
      handled: true,
      replyText: `已新建并接续网页会话：${formatSessionTitle(sessionResult.data)}`,
    };
  }

  if (command.type === 'where') {
    const link = await getWechatChatSessionLink(input.account.id, senderHash);
    if (!link) return { handled: true, replyText: '当前没有接续网页会话。' };
    const session = await getChatSession(link.session_id);
    if (!session || session.user_id !== input.owner.id) {
      await deleteWechatChatSessionLink(input.account.id, senderHash);
      return { handled: true, replyText: '当前没有接续网页会话。' };
    }
    return {
      handled: true,
      replyText: `当前接续：${session.title || '新对话'}`,
    };
  }

  if (command.type === 'detach') {
    await deleteWechatChatSessionLink(input.account.id, senderHash);
    return { handled: true, replyText: '已断开当前网页会话接续。' };
  }

  return { handled: true, replyText: helpText() };
}

async function ensureWechatLinkedSession(input: {
  account: Account;
  owner: Pick<User, 'id'>;
  senderHash: string;
}): Promise<ChatSessionDto> {
  const link = await getWechatChatSessionLink(
    input.account.id,
    input.senderHash,
  );
  if (link) {
    const session = await getChatSession(link.session_id);
    if (session && session.user_id === input.owner.id) {
      return {
        id: session.id,
        account_id: session.account_id,
        title: session.title,
        created_at: session.created_at,
        updated_at: session.updated_at,
        share_token: session.share_token ?? null,
      };
    }
    await deleteWechatChatSessionLink(input.account.id, input.senderHash);
  }

  const sessionResult = await createChatSessionForOwnedUser(
    input.owner.id,
    WECHAT_DEFAULT_SESSION_TITLE,
  );
  if (!sessionResult.ok) {
    throw new Error(sessionResult.error);
  }
  await upsertWechatChatSessionLink({
    accountId: input.account.id,
    senderHash: input.senderHash,
    userId: input.owner.id,
    sessionId: sessionResult.data.id,
  });
  return sessionResult.data;
}

/**
 * 将微信普通消息作为网页 AI Chat session 的一轮输入执行。
 *
 * @param input - 微信消息上下文、平台用户和可选 ACK 回调。
 * @returns completed 时包含网页最终 assistant 消息；discarded 表示本条已被忙碌锁丢弃。
 */
export async function runWechatChatSessionTurn(input: {
  account: Account;
  owner: Pick<User, 'id'>;
  sender: string;
  messageId: string;
  content: string;
  onAccepted?: () => Promise<void>;
}): Promise<WechatChatTurnResult> {
  const senderHash = buildWechatSenderHash(input.account.id, input.sender);
  const session = await ensureWechatLinkedSession({
    account: input.account,
    owner: input.owner,
    senderHash,
  });
  const processingRequestId = await getRedis().get(
    sessionProcessingLockKey(session.id),
  );
  if (processingRequestId) {
    logger.info(
      {
        accountId: input.account.id,
        senderHash,
        sessionId: session.id,
        messageId: input.messageId,
      },
      '微信消息因网页会话处理中被丢弃',
    );
    return { status: 'discarded', sessionId: session.id };
  }

  const result = await runOwnedChatSessionTurn(
    input.owner.id,
    session.id,
    {
      content: input.content,
      inputKind: 'normal',
      pastedBoard: undefined,
    },
    {
      userMessageId: buildWechatSessionUserMessageId(
        input.account.id,
        input.messageId,
      ),
      sourceMetadata: {
        source_channel: 'wechat',
        wechat_account_id: input.account.id,
        sender_hash: senderHash,
      },
      onProcessingClaimed: input.onAccepted,
    },
  );
  if (!result.ok) {
    if (result.statusCode === 409) {
      logger.info(
        {
          accountId: input.account.id,
          senderHash,
          sessionId: session.id,
          messageId: input.messageId,
          reason: result.error,
        },
        '微信消息因网页会话忙碌或重复被丢弃',
      );
      return { status: 'discarded', sessionId: session.id };
    }
    throw new Error(result.error);
  }

  await touchWechatChatSessionLink(input.account.id, senderHash);
  return {
    status: 'completed',
    sessionId: session.id,
    finalAssistantMessages: result.data.finalAssistantMessages,
  };
}
