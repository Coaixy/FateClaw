import type {
  ChatSessionDto,
  MessageDto,
  QueryProcessResponseDto,
  QueryProcessStepDto,
  SessionMessageListResponseDto,
} from '@fateclaw/contracts/chat';

import type { ChatSession, NewMessage } from '../shared/types.js';
import { normalizeOwnedChatSessionTitle } from '../shared/chat-session-title-policy.js';

/**
 * 聊天域 DTO 映射。
 * 将宿主内部消息/会话模型转换为用户态稳定协议。
 */
export function toMessageDto(message: NewMessage): MessageDto {
  const metadata =
    message.metadata &&
    typeof message.metadata === 'object' &&
    !Array.isArray(message.metadata)
      ? (message.metadata as MessageDto['metadata'])
      : null;

  return {
    id: message.id,
    account_id: message.account_id,
    sender: message.sender,
    sender_name: message.sender_name,
    content: message.content,
    timestamp: message.timestamp,
    is_from_me: Boolean(message.is_from_me),
    is_bot_message: Boolean(message.is_bot_message),
    metadata,
    tool_context: message.tool_context ?? null,
  };
}

export function toChatSessionDto(session: ChatSession): ChatSessionDto {
  return {
    id: session.id,
    account_id: session.account_id,
    title: normalizeOwnedChatSessionTitle(session.title),
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}

export function toSessionMessageListResponseDto(
  messages: NewMessage[],
  processing: boolean,
): SessionMessageListResponseDto {
  return {
    messages: messages.map(toMessageDto),
    processing,
  };
}

export function toQueryProcessStepDtos(
  steps: QueryProcessStepDto[],
): QueryProcessStepDto[] {
  return steps;
}

export function toQueryProcessResponseDto(
  data: QueryProcessResponseDto,
): QueryProcessResponseDto {
  return {
    available: data.available,
    request_id: data.request_id,
    timeline: toQueryProcessStepDtos(data.timeline),
  };
}
