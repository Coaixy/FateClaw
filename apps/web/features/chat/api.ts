import type {
  ChatInputKindDto,
  ChatSessionDto,
  ChatSessionSendRequestDto,
  ChatSessionSendResponseDto,
  MessageDto,
  SessionMessageListResponseDto,
  UserPastedBoardInputDto,
} from '@fateclaw/contracts/chat';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import { requestJson } from '@/lib/http/client';
import { getApiBase } from '@/lib/http/client';

export type Message = MessageDto;
export type ChatSession = ChatSessionDto;
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
      isError?: boolean;
    }
  | {
      type: 'progress';
      timestamp?: string;
      sessionId?: string;
      text: string;
      stage?: string;
      workflow?: string;
    }
  | {
      type: 'final';
      timestamp?: string;
      sessionId?: string;
      text: string;
      status: 'success' | 'error';
    }
  | {
      type: 'error';
      timestamp?: string;
      sessionId?: string;
      error: string;
      publicErrorText?: string;
    };

/**
 * Skill artifact context（来自 agent-runner 的 tool_context）。
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
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function buildChatSessionStreamUrl(sessionId: string, token: string) {
  const base = getApiBase();
  const path = `/api/chat-sessions/s/${encodeURIComponent(sessionId)}/stream?token=${encodeURIComponent(token)}`;
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

export const messagesApi = {
  list: (accountId: string, limit = 50, before?: string) =>
    requestJson<Message[]>(
      `/api/messages/${encodeURIComponent(accountId)}?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
    ),
};

let chatSessionListRequest: Promise<ChatSession[]> | null = null;

export function clearChatSessionsCache() {
  chatSessionListRequest = null;
}

export const chatSessionsApi = {
  list: () => {
    chatSessionListRequest ??= requestJson<ChatSession[]>(
      '/api/chat-sessions',
    ).finally(() => {
      chatSessionListRequest = null;
    });
    return chatSessionListRequest;
  },
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
  remove: (sessionId: string) =>
    requestJson<SuccessResponse>(
      `/api/chat-sessions/s/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    ).finally(clearChatSessionsCache),
  messages: (sessionId: string, limit = 50, before?: string) =>
    requestJson<SessionMessageListResponseDto>(
      `/api/chat-sessions/s/${encodeURIComponent(sessionId)}/messages?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
    ),
  send: (
    sessionId: string,
    content: string,
    options?: ChatSessionSendOptions,
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

    return requestJson<ChatSessionSendResponseDto>(
      `/api/chat-sessions/s/${encodeURIComponent(sessionId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify(body),
        exposeServerErrorMessage: true,
      },
    );
  },
};
