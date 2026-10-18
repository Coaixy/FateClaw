import websocket from '@fastify/websocket';
import {
  decodeRuntimeIpc,
  encodeRuntimeIpc,
  encodeControlIpc,
  decodeControlIpc,
} from './ipc-security.js';
import { StreamSubscriptions, attachStreamSocket } from './stream-sockets.js';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { getChatSession, getUserById } from '../infrastructure/db.js';
import { logger } from '../infrastructure/logger.js';
import { getRedis } from '../infrastructure/redis.js';
import type {
  ProgressIpcPayload,
  ResponseIpcPayload,
  SendMessageIpcPayload,
} from './ipc-payloads.js';

export type AiChatStreamEvent =
  | {
      type: 'connected';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
    }
  | {
      type: 'agent_start' | 'agent_end' | 'turn_start';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      turnIndex?: number;
      willRetry?: boolean;
      messageCount?: number;
    }
  | {
      type: 'assistant_delta';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      delta: string;
      snapshot: string;
      turnIndex?: number;
    }
  | {
      type: 'thinking_delta';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      delta: string;
      snapshot: string;
      turnIndex?: number;
    }
  | {
      type: 'assistant_message';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      text: string;
      turnIndex?: number;
    }
  | {
      type: 'tool_start' | 'tool_update' | 'tool_end';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      toolCallId: string;
      toolName: string;
      args?: unknown;
      partialResult?: unknown;
      result?: unknown;
      isError?: boolean;
    }
  | {
      type: 'progress';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      text: string;
      stage?: string;
      workflow?: string;
      metadata?: unknown;
    }
  | {
      type: 'message';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      text: string;
      metadata?: unknown;
      skillContext?: unknown;
    }
  | {
      type: 'final';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      text: string;
      status: 'success' | 'error';
      usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      };
      metadata?: unknown;
    }
  | {
      type: 'error';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      error: string;
      publicErrorText?: string;
      publicReasonCode?: string;
    }
  | {
      type: 'usage';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      usage: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      };
    };

const MAX_CLIENT_FRAME_BUFFER_BYTES = 1024 * 1024;
const STREAM_TICKET_BYTES = 32;
const STREAM_TICKET_TTL_SECONDS = 60;

interface AiChatStreamTicketPayload {
  userId: string;
  accountId: string;
  sessionId: string;
  expiresAt: string;
}

export function aiChatStreamChannel(sessionId: string): string {
  return `ipc:ai-chat:stream:${sessionId}`;
}

function aiChatStreamTicketKey(ticket: string): string {
  const digest = createHash('sha256').update(ticket).digest('hex');
  return `aichat:stream-ticket:${digest}`;
}

/**
 * 为指定用户和会话签发短期单用途 WebSocket 连接票据。
 *
 * @param args.userId 当前登录用户 ID。
 * @param args.sessionId 需要连接实时流的会话 ID。
 * @returns 原始票据和过期时间；原始票据只返回给调用方，Redis 中仅以哈希键保存。
 *
 * @throws 当会话不存在或不属于当前用户时抛出错误。
 */
export async function issueAiChatStreamTicket(args: {
  userId: string;
  sessionId: string;
}): Promise<{ ticket: string; expiresAt: string }> {
  const session = await verifySessionOwner(args.userId, args.sessionId);

  const ticket = randomBytes(STREAM_TICKET_BYTES).toString('base64url');
  const expiresAt = new Date(
    Date.now() + STREAM_TICKET_TTL_SECONDS * 1000,
  ).toISOString();
  const payload: AiChatStreamTicketPayload = {
    userId: args.userId,
    accountId: session.account_id,
    sessionId: args.sessionId,
    expiresAt,
  };

  await getRedis().set(
    aiChatStreamTicketKey(ticket),
    encodeControlIpc(
      'stream-ticket',
      aiChatStreamTicketKey(ticket),
      JSON.stringify(payload),
      STREAM_TICKET_TTL_SECONDS * 1000,
    ),
    'EX',
    STREAM_TICKET_TTL_SECONDS,
  );

  return { ticket, expiresAt };
}

export function buildAiChatStreamEvent(args: {
  event: AiChatStreamEvent;
  requestId?: string;
  accountId: string;
  sessionId?: string;
}): AiChatStreamEvent {
  return {
    timestamp: new Date().toISOString(),
    requestId: args.requestId,
    accountId: args.accountId,
    sessionId: args.sessionId,
    ...args.event,
  } as AiChatStreamEvent;
}

export async function publishAiChatStreamEvent(args: {
  sessionId?: string;
  event: AiChatStreamEvent;
}): Promise<void> {
  if (!args.sessionId) return;
  if (!args.event.accountId) throw new Error('Stream event has no account');
  await getRedis().publish(
    aiChatStreamChannel(args.sessionId),
    encodeRuntimeIpc(
      args.event.accountId,
      aiChatStreamChannel(args.sessionId),
      JSON.stringify(args.event),
      60_000,
    ),
  );
}

export function streamEventFromMessagePayload(args: {
  payload: SendMessageIpcPayload;
  accountId: string;
  sessionId?: string;
}): AiChatStreamEvent | null {
  const text = args.payload.text?.trim();
  if (!text) return null;
  return buildAiChatStreamEvent({
    event: {
      type: 'message',
      text,
      metadata: args.payload.metadata,
      skillContext: args.payload.skillContext,
    },
    requestId: args.payload.requestId,
    accountId: args.accountId,
    sessionId: args.sessionId,
  });
}

export function streamEventFromProgressPayload(args: {
  payload: ProgressIpcPayload;
  accountId: string;
  sessionId?: string;
}): AiChatStreamEvent {
  return buildAiChatStreamEvent({
    event: {
      type: 'progress',
      text: args.payload.text?.trim() || '处理中',
      stage: args.payload.metadata?.stage,
      workflow: args.payload.metadata?.workflow,
      metadata: args.payload.metadata,
    },
    requestId: args.payload.requestId,
    accountId: args.accountId,
    sessionId: args.sessionId,
  });
}

export function streamEventFromResponsePayload(args: {
  payload: ResponseIpcPayload;
  accountId: string;
  sessionId?: string;
  text: string;
  metadata: Record<string, unknown>;
}): AiChatStreamEvent {
  if (args.payload.status === 'error') {
    return buildAiChatStreamEvent({
      event: {
        type: 'error',
        error: args.payload.error || args.text,
        publicErrorText: args.payload.publicErrorText,
        publicReasonCode: args.payload.publicReasonCode,
      },
      requestId: args.payload.requestId,
      accountId: args.accountId,
      sessionId: args.sessionId,
    });
  }

  return buildAiChatStreamEvent({
    event: {
      type: 'final',
      text: args.text,
      status: args.payload.status || 'success',
      usage: args.payload.usage,
      metadata: args.metadata,
    },
    requestId: args.payload.requestId,
    accountId: args.accountId,
    sessionId: args.sessionId,
  });
}

/**
 * 消费 AI Chat WebSocket 连接票据，并校验其绑定的会话。
 *
 * @param ticket 浏览器通过 WebSocket query 传入的短期票据。
 * @param sessionId WebSocket 路径中的目标会话 ID。
 * @returns 票据内绑定的用户和会话信息。
 *
 * @throws 当票据不存在、已消费、过期、会话不匹配或归属变化时抛出错误。
 */
export async function consumeAiChatStreamTicket(
  ticket: string,
  sessionId: string,
): Promise<AiChatStreamTicketPayload> {
  const raw = await getRedis().eval(
    `
local value = redis.call("GET", KEYS[1])
if not value then
  return nil
end
redis.call("DEL", KEYS[1])
return value
`,
    1,
    aiChatStreamTicketKey(ticket),
  );

  if (typeof raw !== 'string') {
    throw new Error('invalid_ticket');
  }

  let payload: AiChatStreamTicketPayload;
  try {
    payload = JSON.parse(
      decodeControlIpc('stream-ticket', aiChatStreamTicketKey(ticket), raw),
    ) as AiChatStreamTicketPayload;
  } catch (err) {
    throw new Error('invalid_ticket', { cause: err });
  }

  const expiresAtMs = Date.parse(payload.expiresAt);
  if (
    payload.sessionId !== sessionId ||
    !payload.userId ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= Date.now()
  ) {
    throw new Error('invalid_ticket');
  }

  // ticket 绑定会话和用户；消费时再次查库，防止签发后会话归属发生变化。
  const session = await verifySessionOwner(payload.userId, sessionId);
  return { ...payload, accountId: session.account_id };
}

async function verifySessionOwner(
  userId: string,
  sessionId: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getChatSession>>>> {
  const session = await getChatSession(sessionId);
  if (!session) {
    throw new Error('session_not_found');
  }
  if (session.user_id !== userId) {
    throw new Error('forbidden');
  }
  return session;
}

export async function registerAiChatStreamWebSocket(
  app: FastifyInstance,
): Promise<void> {
  await app.register(websocket, {
    options: {
      maxPayload: MAX_CLIENT_FRAME_BUFFER_BYTES,
      perMessageDeflate: false,
    },
  });
  const subscriptions = new StreamSubscriptions(() =>
    getRedis().duplicate({
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      commandTimeout: 5_000,
      connectTimeout: 5_000,
    }),
  );
  const streamAccounts = new WeakMap<object, string>();
  app.addHook('onClose', async () => subscriptions.close());
  app.post<{
    Params: { sessionId: string };
  }>(
    '/api/chat-sessions/s/:sessionId/stream-ticket',
    async (request, reply) => {
      let userId: string;
      try {
        await request.jwtVerify();
        // stream ticket 是长期登录态换取的一次性凭证，这里复用普通 API 的 token 版本校验。
        if (typeof request.user.authTokenVersion !== 'number') {
          throw new Error('invalid_token_version');
        }
        const user = await getUserById(request.user.userId);
        if (
          !user ||
          (user.auth_token_version ?? 0) !== request.user.authTokenVersion
        ) {
          throw new Error('invalid_token_version');
        }
        userId = request.user.userId;
      } catch {
        return reply.code(401).send({ error: '登录状态已失效，请重新登录' });
      }

      try {
        return await issueAiChatStreamTicket({
          userId,
          sessionId: request.params.sessionId,
        });
      } catch {
        return reply.code(404).send({ error: '会话不存在或无权访问' });
      }
    },
  );

  app.get<{ Params: { sessionId: string }; Querystring: { ticket?: string } }>(
    '/api/chat-sessions/s/:sessionId/stream',
    {
      websocket: true,
      preValidation: async (request, reply) => {
        try {
          if (!request.query.ticket) throw new Error('missing_ticket');
          const ticket = await consumeAiChatStreamTicket(
            request.query.ticket,
            request.params.sessionId,
          );
          streamAccounts.set(request, ticket.accountId);
        } catch (err) {
          logger.warn(
            { err, sessionId: request.params.sessionId },
            'AI Chat WebSocket authentication failed',
          );
          return reply.code(401).send({ error: 'Unauthorized' });
        }
      },
    },
    (socket, request) => {
      const sessionId = request.params.sessionId;
      const accountId = streamAccounts.get(request);
      if (!accountId) {
        socket.terminate();
        return;
      }
      const seen = new Set<string>();
      attachStreamSocket(
        socket,
        subscriptions,
        aiChatStreamChannel(sessionId),
        JSON.stringify(
          buildAiChatStreamEvent({
            event: { type: 'connected' },
            accountId: '',
            sessionId,
          }),
        ),
        (raw) => {
          const plaintext = decodeRuntimeIpc(
            accountId,
            aiChatStreamChannel(sessionId),
            raw,
          );
          const event = JSON.parse(plaintext);
          if (
            event.accountId !== accountId ||
            event.sessionId !== sessionId ||
            typeof event.eventId !== 'string'
          )
            throw new Error('Stream event identity mismatch');
          if (seen.has(event.eventId)) return null;
          seen.add(event.eventId);
          if (seen.size > 1024) seen.delete(seen.values().next().value!);
          return plaintext;
        },
      );
    },
  );
}
