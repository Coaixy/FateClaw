import type {
  ChatSessionDto,
  SharedChatSessionDto,
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
    share_token: session.share_token ?? null,
    deleted_at: session.deleted_at ?? null,
  };
}

function toSharedMessageDto(message: NewMessage): MessageDto {
  const sourceMetadata =
    message.metadata &&
    typeof message.metadata === 'object' &&
    !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : null;
  const metadata =
    typeof sourceMetadata?.kind === 'string'
      ? ({
          kind: sourceMetadata.kind,
          stage:
            typeof sourceMetadata.stage === 'string'
              ? sourceMetadata.stage
              : undefined,
          workflow:
            typeof sourceMetadata.workflow === 'string'
              ? sourceMetadata.workflow
              : undefined,
          tool_call_id:
            typeof sourceMetadata.tool_call_id === 'string'
              ? sourceMetadata.tool_call_id
              : undefined,
          tool_name:
            typeof sourceMetadata.tool_name === 'string'
              ? sourceMetadata.tool_name
              : undefined,
          tool_label:
            typeof sourceMetadata.tool_label === 'string'
              ? sourceMetadata.tool_label
              : undefined,
          tool_status:
            sourceMetadata.tool_status === 'running' ||
            sourceMetadata.tool_status === 'completed' ||
            sourceMetadata.tool_status === 'failed'
              ? sourceMetadata.tool_status
              : undefined,
          tool_path:
            typeof sourceMetadata.tool_path === 'string'
              ? sourceMetadata.tool_path
              : undefined,
          turn_complete:
            typeof sourceMetadata.turn_complete === 'boolean'
              ? sourceMetadata.turn_complete
              : undefined,
        } satisfies MessageDto['metadata'])
      : null;

  return {
    id: message.id,
    account_id: 'shared',
    sender: message.is_bot_message ? 'assistant' : 'user',
    sender_name: message.sender_name,
    content: message.content,
    timestamp: message.timestamp,
    is_from_me: Boolean(message.is_from_me),
    is_bot_message: Boolean(message.is_bot_message),
    metadata,
    tool_context: message.tool_context ?? null,
  };
}

export function toSharedChatSessionDto(args: {
  session: ChatSession;
  messages: NewMessage[];
}): SharedChatSessionDto {
  return {
    id: args.session.id,
    title: normalizeOwnedChatSessionTitle(args.session.title),
    created_at: args.session.created_at,
    updated_at: args.session.updated_at,
    messages: args.messages.map(toSharedMessageDto),
  };
}

export function toSessionMessageListResponseDto(
  messages: NewMessage[],
  processing: boolean,
  options?: {
    continuationBlocked?: boolean;
    continuationBlockReason?: 'pi_session_missing';
    continuationBlockMessage?: string;
  },
): SessionMessageListResponseDto {
  return {
    messages: messages.map(toMessageDto),
    processing,
    continuation_blocked: options?.continuationBlocked,
    continuation_block_reason: options?.continuationBlockReason,
    continuation_block_message: options?.continuationBlockMessage,
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
