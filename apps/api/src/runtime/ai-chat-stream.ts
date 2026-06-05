import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
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

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_CONTROL_PAYLOAD_BYTES = 125;
const STREAM_TICKET_BYTES = 32;
const STREAM_TICKET_TTL_SECONDS = 60;

interface AiChatStreamTicketPayload {
  userId: string;
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
 * 获取 AI Chat WebSocket 连接票据的有效秒数。
 *
 * @returns 当前服务端签发 stream ticket 时使用的 TTL 秒数。
 */
export function getAiChatStreamTicketTtlSeconds(): number {
  return STREAM_TICKET_TTL_SECONDS;
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
  await verifySessionOwner(args.userId, args.sessionId);

  const ticket = randomBytes(STREAM_TICKET_BYTES).toString('base64url');
  const expiresAt = new Date(
    Date.now() + STREAM_TICKET_TTL_SECONDS * 1000,
  ).toISOString();
  const payload: AiChatStreamTicketPayload = {
    userId: args.userId,
    sessionId: args.sessionId,
    expiresAt,
  };

  await getRedis().set(
    aiChatStreamTicketKey(ticket),
    JSON.stringify(payload),
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
  await getRedis().publish(
    aiChatStreamChannel(args.sessionId),
    JSON.stringify(args.event),
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

function computeAcceptKey(key: string): string {
  return createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
}

function writeFrame(socket: Duplex, opcode: number, payload: Buffer): void {
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.allocUnsafe(2)
      : length <= 0xffff
        ? Buffer.allocUnsafe(4)
        : Buffer.allocUnsafe(10);
  header[0] = 0x80 | opcode;

  if (length < 126) {
    header[1] = length;
  } else if (length <= 0xffff) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  socket.write(Buffer.concat([header, payload]));
}

function writeTextFrame(socket: Duplex, data: string): void {
  writeFrame(socket, 0x1, Buffer.from(data, 'utf8'));
}

function writeCloseFrame(socket: Duplex, code = 1000, reason = ''): void {
  const reasonBuffer = Buffer.from(reason, 'utf8').subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  writeFrame(socket, 0x8, payload);
}

function parseClientFrames(
  buffer: Buffer,
  socket: Duplex,
): { consumed: number; closeRequested: boolean } {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const longLength = buffer.readBigUInt64BE(offset + 2);
      if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { consumed: buffer.length, closeRequested: true };
      }
      length = Number(longLength);
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (offset + frameLength > buffer.length) break;

    const payloadStart = offset + headerLength + maskLength;
    const payload = Buffer.from(
      buffer.subarray(payloadStart, payloadStart + length),
    );
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, payloadStart);
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= mask[i % 4];
      }
    }

    if (opcode === 0x8) {
      return { consumed: offset + frameLength, closeRequested: true };
    }
    if (opcode === 0x9 && payload.length <= MAX_CONTROL_PAYLOAD_BYTES) {
      writeFrame(socket, 0xa, payload);
    }

    offset += frameLength;
  }

  return { consumed: offset, closeRequested: false };
}

function isAiChatStreamPath(pathname: string): boolean {
  return /^\/api\/chat-sessions\/s\/[^/]+\/stream$/.test(pathname);
}

function extractSessionId(pathname: string): string | null {
  const match = /^\/api\/chat-sessions\/s\/([^/]+)\/stream$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

async function authenticateUpgrade(
  _app: FastifyInstance,
  _request: IncomingMessage,
  url: URL,
  sessionId: string,
): Promise<string> {
  const ticket = url.searchParams.get('ticket') || '';
  if (!ticket) {
    throw new Error('missing_ticket');
  }
  const payload = await consumeAiChatStreamTicket(ticket, sessionId);
  return payload.userId;
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
    payload = JSON.parse(raw) as AiChatStreamTicketPayload;
  } catch {
    throw new Error('invalid_ticket');
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
  await verifySessionOwner(payload.userId, sessionId);
  return payload;
}

async function verifySessionOwner(
  userId: string,
  sessionId: string,
): Promise<void> {
  const session = await getChatSession(sessionId);
  if (!session) {
    throw new Error('session_not_found');
  }
  if (session.user_id !== userId) {
    throw new Error('forbidden');
  }
}

export function registerAiChatStreamWebSocket(app: FastifyInstance): void {
  app.post<{
    Params: { sessionId: string };
  }>('/api/chat-sessions/s/:sessionId/stream-ticket', async (request, reply) => {
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
  });

  app.addHook('onReady', (done) => {
    const server = app.server as Server;
    server.on('upgrade', (request, socket, head) => {
      void handleUpgrade(app, request, socket, head);
    });
    done();
  });
}

async function handleUpgrade(
  app: FastifyInstance,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const host = request.headers.host || 'localhost';
  const url = new URL(request.url || '/', `http://${host}`);
  if (!isAiChatStreamPath(url.pathname)) {
    rejectUpgrade(socket, 404, 'Not Found');
    return;
  }

  const sessionId = extractSessionId(url.pathname);
  const websocketKey = request.headers['sec-websocket-key'];
  if (!sessionId || typeof websocketKey !== 'string') {
    rejectUpgrade(socket, 400, 'Bad Request');
    return;
  }

  try {
    await authenticateUpgrade(app, request, url, sessionId);
  } catch (err) {
    logger.warn({ err, sessionId }, 'AI Chat WebSocket 鉴权失败');
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${computeAcceptKey(websocketKey)}`,
      '',
      '',
    ].join('\r\n'),
  );

  const subscriber = getRedis().duplicate();
  let frameBuffer = Buffer.from(head);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    socket.removeAllListeners('data');
    await subscriber.quit().catch(() => {});
    socket.destroy();
  };

  socket.on('data', (chunk) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);
    const result = parseClientFrames(frameBuffer, socket);
    frameBuffer = frameBuffer.subarray(result.consumed);
    if (result.closeRequested) {
      writeCloseFrame(socket);
      void close();
    }
  });
  socket.on('error', () => {
    void close();
  });
  socket.on('close', () => {
    void close();
  });

  try {
    await subscriber.connect();
    await subscriber.subscribe(aiChatStreamChannel(sessionId));
    subscriber.on('message', (_channel, message) => {
      if (!closed) {
        writeTextFrame(socket, message);
      }
    });
    writeTextFrame(
      socket,
      JSON.stringify(
        buildAiChatStreamEvent({
          event: { type: 'connected' },
          accountId: '',
          sessionId,
        }),
      ),
    );
  } catch (err) {
    logger.error({ err, sessionId }, 'AI Chat WebSocket 订阅失败');
    writeCloseFrame(socket, 1011, 'stream subscription failed');
    await close();
  }
}
