import type {
  ChatInputKindDto,
  ChatSessionDto,
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
  | NormalChatSessionSendOptions
  | UserPastedBoardChatSessionSendOptions;

export type ChatSessionRequestOptions = {
  signal?: AbortSignal;
};

export type ChatSessionStreamTicket = {
  ticket: string;
  expiresAt: string;
};

export type ChatSessionStreamEvent =
  | { type: 'connected'; timestamp?: string; sessionId?: string }
  | {
      type: 'agent_start' | 'agent_end' | 'turn_start';
      timestamp?: string;
      sessionId?: string;
      turnIndex?: number;
      willRetry?: boolean;
      messageCount?: number;
    }
  | {
      type: 'assistant_delta';
      timestamp?: string;
      sessionId?: string;
      delta: string;
      snapshot: string;
      turnIndex?: number;
    }
  | {
      type: 'thinking_delta';
      timestamp?: string;
      sessionId?: string;
      delta: string;
      snapshot: string;
      turnIndex?: number;
    }
  | {
      type: 'assistant_message';
      timestamp?: string;
      sessionId?: string;
      text: string;
      turnIndex?: number;
    }
  | {
      type: 'tool_start' | 'tool_update' | 'tool_end';
      timestamp?: string;
      sessionId?: string;
      toolCallId: string;
      toolName: string;
      args?: unknown;
      result?: unknown;
      partialResult?: unknown;
      isError?: boolean;
    }
  | {
      type: 'progress';
      timestamp?: string;
      sessionId?: string;
      text: string;
      stage?: string;
      workflow?: string;
      metadata?: unknown;
    }
  | {
      type: 'final';
      timestamp?: string;
      sessionId?: string;
      text: string;
      status: 'success' | 'error';
      metadata?: unknown;
    }
  | {
      type: 'error';
      timestamp?: string;
      sessionId?: string;
      error: string;
      publicErrorText?: string;
    };

/**
 * Skill artifact context（来自 agent-runtime 的 tool_context）。
 * 当前仍属于前端展示协议，后续可以继续下沉到 contracts。
 */
export interface SkillContextEntry {
  skill: string;
  output: string;
  artifactType?: string;
  artifactTitle?: string;
  artifactData?: unknown;
}

export function parseToolContext(raw?: string | null): SkillContextEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 过滤掉 null / 非对象元素：渲染层会直接访问 entry.skill / entry.output 等字段，
    // 历史脏数据里混入 null 或基础类型会让渲染期抛 TypeError，这里在解析边界统一收紧。
    return parsed.filter(
      (entry): entry is SkillContextEntry =>
        Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
    );
  } catch {
    return [];
  }
}

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

const chatSessionListRequestCache =
  createAuthScopedInFlightCache<ChatSession[]>();

function archiveChatSessionRequest(sessionId: string) {
  return requestJson<SuccessResponse>(
    `/api/chat-sessions/s/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  ).finally(clearChatSessionsCache);
}

/**
 * 清理聊天会话列表的 in-flight 请求缓存。
 *
 * @returns 无返回值。
 */
export function clearChatSessionsCache() {
  chatSessionListRequestCache.clear();
}

export const chatSessionsApi = {
  list: () =>
    chatSessionListRequestCache.get(() =>
      requestJson<ChatSession[]>('/api/chat-sessions'),
    ),
  archived: () => requestJson<ChatSession[]>('/api/chat-sessions/archived'),
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
    ),
  archive: archiveChatSessionRequest,
  remove: archiveChatSessionRequest,
  restore: (sessionId: string) =>
    requestJson<ChatSession>(
      `/api/chat-sessions/s/${encodeURIComponent(sessionId)}/restore`,
      { method: 'POST' },
    ).finally(clearChatSessionsCache),
  share: (sessionId: string) =>
    requestJson<ChatSessionShareResponse>(
      `/api/chat-sessions/s/${encodeURIComponent(sessionId)}/share`,
      { method: 'POST' },
    ).finally(clearChatSessionsCache),
  shared: (token: string) =>
    requestJson<SharedChatSession>(
      `/api/chat-sessions/shared/${encodeURIComponent(token)}`,
    ),
  createStreamTicket: (sessionId: string) =>
    requestJson<ChatSessionStreamTicket>(
      `/api/chat-sessions/s/${encodeURIComponent(sessionId)}/stream-ticket`,
      { method: 'POST' },
    ),
  cancel: (sessionId: string) =>
    requestJson<SuccessResponse>(
      `/api/chat-sessions/s/${encodeURIComponent(sessionId)}/messages/cancel`,
      { method: 'POST' },
    ),
  messages: (sessionId: string, limit = 50, before?: string) =>
    requestJson<SessionMessageListResponseDto>(
      `/api/chat-sessions/s/${encodeURIComponent(sessionId)}/messages?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
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
    );
  },
};
