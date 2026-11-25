import type {
  ChatInputKindDto,
  ChatSessionDto,
  ChatSessionStreamTicket,
  SessionBoardListResponseDto,
  ChatSessionShareResponseDto,
  ChatSessionSendRequestDto,
  ChatSessionSendResponseDto,
  MessageDto,
  SessionMessageListResponseDto,
  SharedChatSessionDto,
  UserPastedBoardInputDto,
} from '@fateclaw/contracts/chat';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import { requestJson } from '@/lib/http/client';
import { getApiBase } from '@/lib/http/client';
import { createAuthScopedInFlightCache } from '@/lib/auth-scoped-cache';

export type Message = MessageDto;
export type ChatSession = ChatSessionDto;
export type ChatSessionShareResponse = ChatSessionShareResponseDto;
export type SharedChatSession = SharedChatSessionDto;
export type ChatInputKind = ChatInputKindDto;
export type UserPastedBoardInput = UserPastedBoardInputDto;

type NormalChatSessionSendOptions = {
  selectedBoardMessageId?: string;
  inputKind?: 'normal';
  pastedBoard?: never;
};

type UserPastedBoardChatSessionSendOptions = {
  selectedBoardMessageId?: string;
  inputKind: 'user_pasted_board';
  pastedBoard: UserPastedBoardInput;
};

export type ChatSessionSendOptions =
  NormalChatSessionSendOptions | UserPastedBoardChatSessionSendOptions;

export type ChatSessionRequestOptions = {
  signal?: AbortSignal;
};

export type {
  ChatSessionStreamEvent,
  ChatSessionStreamTicket,
} from '@fateclaw/contracts/chat';

export type { SkillContextEntryDto as SkillContextEntry } from '@fateclaw/contracts/chat';
export { parseToolContext } from './utils/tool-context';

export function buildChatSessionStreamUrl(sessionId: string, ticket: string) {
  const base = getApiBase();
  const path = `/api/chat-sessions/s/${encodeURIComponent(sessionId)}/stream?ticket=${encodeURIComponent(ticket)}`;
  const sameOriginUrl = (targetPath: string) => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${targetPath}`;
  };
  if (!base) {
    return sameOriginUrl(path);
  }
  if (!/^https?:\/\//.test(base)) {
    return sameOriginUrl(`${base.replace(/\/$/, '')}${path}`);
  }
  const url = new URL(path, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

const chatSessionListRequestCache = createAuthScopedInFlightCache<
  ChatSession[]
>({
  maxAgeMs: 30_000,
});

function archiveChatSessionRequest(sessionId: string) {
  return requestJson<SuccessResponse>(
    `/api/chat-sessions/s/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  ).finally(clearChatSessionsCache);
}

/**
 * 清理聊天会话列表的请求和结果缓存。
 *
 * @returns 无返回值。
 */
export function clearChatSessionsCache() {
  chatSessionListRequestCache.clear();
}

export const chatSessionsApi = {
  readListSnapshot: chatSessionListRequestCache.peek,
  list: () =>
    chatSessionListRequestCache.get(() =>
      requestJson<ChatSession[]>('/api/chat-sessions'),
    ),
  archived: (options: ChatSessionRequestOptions = {}) =>
    requestJson<ChatSession[]>('/api/chat-sessions/archived', {
      signal: options.signal,
      timeoutMs: 15_000,
    }),
  /** 某客户名下的全部会话（活跃 + 已归档），客户档案历史视图用。 */
  byClient: (clientId: string) =>
    requestJson<ChatSession[]>(
      `/api/chat-sessions/by-client/${encodeURIComponent(clientId)}`,
    ),
  create: (title?: string) =>
    requestJson<ChatSession>('/api/chat-sessions', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }).finally(clearChatSessionsCache),
  update: (sessionId: string, title: string) =>
    requestJson<SuccessResponse>(
      `/api/chat-sessions/s/${encodeURIComponent(sessionId)}`,
      { method: 'PATCH', body: JSON.stringify({ title }) },
    ).finally(clearChatSessionsCache),
  archive: archiveChatSessionRequest,
  remove: archiveChatSessionRequest,
  restore: (sessionId: string) =>
    requestJson<ChatSession>(
      `/api/chat-sessions/s/${encodeURIComponent(sessionId)}/restore`,
      { method: 'POST', timeoutMs: 15_000 },
    ).finally(clearChatSessionsCache),
  share: (sessionId: string, options: ChatSessionRequestOptions = {}) =>
    requestJson<ChatSessionShareResponse>(
      `/api/chat-sessions/s/${encodeURIComponent(sessionId)}/share`,
      { method: 'POST', signal: options.signal, timeoutMs: 15_000 },
    ).finally(clearChatSessionsCache),
  shared: (token: string, options: ChatSessionRequestOptions = {}) =>
    requestJson<SharedChatSession>(
      `/api/chat-sessions/shared/${encodeURIComponent(token)}`,
      { signal: options.signal, timeoutMs: 15_000 },
    ),
  createStreamTicket: (
    sessionId: string,
    options: ChatSessionRequestOptions = {},
  ) =>
    requestJson<ChatSessionStreamTicket>(
      `/api/chat-sessions/s/${encodeURIComponent(sessionId)}/stream-ticket`,
      { method: 'POST', signal: options.signal, timeoutMs: 15_000 },
    ),
  cancel: (sessionId: string) =>
    requestJson<SuccessResponse>(
      `/api/chat-sessions/s/${encodeURIComponent(sessionId)}/messages/cancel`,
      // 取消请求本应很快返回；加兜底超时，避免连接降级时（正是「回复较慢」一键重试
      // 入口存在的场景）无限挂起、拖住 retrySending 后续的重置与重发。超时会被
      // requestJson 归一化为 ApiError，调用方 catch 后照常继续。
      { method: 'POST', timeoutMs: 15_000 },
    ),
  boards: (sessionId: string) =>
    requestJson<SessionBoardListResponseDto>(
      `/api/chat-sessions/s/${encodeURIComponent(sessionId)}/boards`,
      { timeoutMs: 15_000 },
    ),
  messages: (
    sessionId: string,
    limit = 50,
    before?: string,
    beforeId?: string,
  ) =>
    requestJson<SessionMessageListResponseDto>(
      `/api/chat-sessions/s/${encodeURIComponent(sessionId)}/messages?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}${before && beforeId ? `&before_id=${encodeURIComponent(beforeId)}` : ''}`,
      { timeoutMs: 15_000 },
    ),
  send: (
    sessionId: string,
    content: string,
    options?: ChatSessionSendOptions,
    requestOptions?: ChatSessionRequestOptions,
  ) => {
    let body: ChatSessionSendRequestDto;

    if (options?.inputKind === 'user_pasted_board') {
      const pastedBoard = options.pastedBoard;
      if (!pastedBoard) {
        throw new Error('pastedBoard is required for user_pasted_board input');
      }
      body = {
        content,
        selected_board_message_id: options.selectedBoardMessageId,
        input_kind: 'user_pasted_board',
        pasted_board: pastedBoard,
      };
    } else {
      body = {
        content,
        selected_board_message_id: options?.selectedBoardMessageId,
        input_kind: options?.inputKind,
      };
    }

    const fetchOptions: Parameters<typeof requestJson>[1] = {
      method: 'POST',
      body: JSON.stringify(body),
      exposeServerErrorMessage: true,
      headers: {
        'x-no-compression': '1',
      },
      // 纵深防御兜底，不是本次卡死场景的根因修复——正常情况下这个请求会很快
      // 返回（后端排队即提前 accept），真正长时间无响应更可能是连接层面异常。
      timeoutMs: 90_000,
    };

    if (requestOptions?.signal) {
      fetchOptions.signal = requestOptions.signal;
    }

    return requestJson<ChatSessionSendResponseDto>(
      `/api/chat-sessions/s/${encodeURIComponent(sessionId)}/messages`,
      fetchOptions,
    ).finally(clearChatSessionsCache);
  },
};
