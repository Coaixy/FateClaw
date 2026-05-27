import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { getChatSession } from '../infrastructure/db.js';
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

export function aiChatStreamChannel(sessionId: string): string {
  return `ipc:ai-chat:stream:${sessionId}`;
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
  app: FastifyInstance,
  request: IncomingMessage,
  url: URL,
): Promise<string> {
  const authorization = request.headers.authorization;
  const bearer =
    typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : '';
  const token = bearer || url.searchParams.get('token') || '';
  if (!token) {
    throw new Error('missing_token');
  }
  const verified = await app.jwt.verify<{ userId: string }>(token);
  if (!verified.userId) {
    throw new Error('invalid_token');
  }
  return verified.userId;
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
    const userId = await authenticateUpgrade(app, request, url);
    await verifySessionOwner(userId, sessionId);
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
