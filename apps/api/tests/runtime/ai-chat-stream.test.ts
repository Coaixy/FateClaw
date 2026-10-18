import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
  decodeControlIpc,
  encodeControlIpc,
  encodeRuntimeIpc,
} from '#runtime/ipc-security';
import Fastify from 'fastify';

const { mockGetChatSession, mockGetUserById, mockRedis } = vi.hoisted(() => ({
  mockGetChatSession: vi.fn(),
  mockGetUserById: vi.fn(),
  mockRedis: {
    eval: vi.fn(),
    set: vi.fn(),
    duplicate: vi.fn(),
  },
}));

vi.mock('#infrastructure/db', () => ({
  getChatSession: mockGetChatSession,
  getUserById: mockGetUserById,
}));

vi.mock('#infrastructure/redis', () => ({
  getRedis: () => mockRedis,
}));

import {
  registerAiChatStreamWebSocket,
  aiChatStreamChannel,
  consumeAiChatStreamTicket,
  issueAiChatStreamTicket,
  streamEventFromMessagePayload,
  streamEventFromProgressPayload,
  streamEventFromResponsePayload,
} from '#runtime/ai-chat-stream';

beforeEach(() => {
  vi.clearAllMocks();
  mockRedis.set.mockResolvedValue('OK');
  mockRedis.eval.mockResolvedValue(null);
  mockGetChatSession.mockResolvedValue({
    id: 'session-1',
    user_id: 'user-1',
    account_id: 'web:user-1',
  });
  mockGetUserById.mockResolvedValue({
    id: 'user-1',
    auth_token_version: 1,
  });
});

describe('AI Chat stream event helpers', () => {
  it('uses a stable per-session Redis channel', () => {
    expect(aiChatStreamChannel('session-1')).toBe(
      'ipc:ai-chat:stream:session-1',
    );
  });

  it('maps progress payloads to stream progress events', () => {
    const event = streamEventFromProgressPayload({
      payload: {
        type: 'progress',
        requestId: 'req-1',
        text: '查阅知识库',
        metadata: { stage: 'knowledge_section', workflow: 'xuanxue' },
      },
      accountId: 'web:user-1',
      sessionId: 'session-1',
    });

    expect(event).toMatchObject({
      type: 'progress',
      requestId: 'req-1',
      accountId: 'web:user-1',
      sessionId: 'session-1',
      text: '查阅知识库',
      stage: 'knowledge_section',
      workflow: 'xuanxue',
      metadata: { stage: 'knowledge_section', workflow: 'xuanxue' },
    });
    expect(event.timestamp).toEqual(expect.any(String));
  });

  it('maps successful responses to final stream events', () => {
    const event = streamEventFromResponsePayload({
      payload: {
        type: 'response',
        requestId: 'req-2',
        text: '完成',
        status: 'success',
        usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
      },
      accountId: 'web:user-1',
      sessionId: 'session-1',
      text: '完成',
      metadata: { kind: 'final' },
    });

    expect(event).toMatchObject({
      type: 'final',
      requestId: 'req-2',
      text: '完成',
      status: 'success',
      usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
      metadata: { kind: 'final' },
    });
  });

  it('maps error responses to public error stream events', () => {
    const event = streamEventFromResponsePayload({
      payload: {
        type: 'response',
        requestId: 'req-3',
        text: '内部错误',
        status: 'error',
        error: 'provider failed',
        publicErrorText: 'AI 服务暂时不可用',
        publicReasonCode: 'llm_unavailable',
      },
      accountId: 'web:user-1',
      sessionId: 'session-1',
      text: 'AI 服务暂时不可用',
      metadata: { kind: 'final' },
    });

    expect(event).toMatchObject({
      type: 'error',
      requestId: 'req-3',
      error: 'provider failed',
      publicErrorText: 'AI 服务暂时不可用',
      publicReasonCode: 'llm_unavailable',
    });
  });

  it('ignores blank intermediate message payloads', () => {
    expect(
      streamEventFromMessagePayload({
        payload: { type: 'message', requestId: 'req-4', text: '   ' },
        accountId: 'web:user-1',
        sessionId: 'session-1',
      }),
    ).toBeNull();
  });
});

describe('AI Chat stream tickets', () => {
  it('issues short-lived single-session tickets for the session owner', async () => {
    const result = await issueAiChatStreamTicket({
      userId: 'user-1',
      sessionId: 'session-1',
    });

    expect(result.ticket).toEqual(expect.any(String));
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
    expect(mockGetChatSession).toHaveBeenCalledWith('session-1');
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^aichat:stream-ticket:[a-f0-9]{64}$/),
      expect.any(String),
      'EX',
      60, // 与源码 STREAM_TICKET_TTL_SECONDS 保持一致
    );
    expect(mockRedis.set.mock.calls[0][0]).not.toContain(result.ticket);
    const [key, raw] = mockRedis.set.mock.calls[0];
    expect(raw).not.toContain('"userId"');
    expect(
      JSON.parse(decodeControlIpc('stream-ticket', key, raw)),
    ).toMatchObject({ userId: 'user-1', sessionId: 'session-1' });
  });

  it('rejects ticket issuing when the session does not belong to the user', async () => {
    mockGetChatSession.mockResolvedValueOnce({
      id: 'session-1',
      user_id: 'other-user',
    });

    await expect(
      issueAiChatStreamTicket({
        userId: 'user-1',
        sessionId: 'session-1',
      }),
    ).rejects.toThrow('forbidden');
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('consumes a ticket once and validates its session owner', async () => {
    mockRedis.eval.mockResolvedValueOnce(
      encodeControlIpc(
        'stream-ticket',
        `aichat:stream-ticket:${createHash('sha256').update('ticket-1').digest('hex')}`,
        JSON.stringify({
          userId: 'user-1',
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }),
        60_000,
      ),
    );

    await expect(
      consumeAiChatStreamTicket('ticket-1', 'session-1'),
    ).resolves.toMatchObject({
      userId: 'user-1',
      sessionId: 'session-1',
    });
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("DEL"'),
      1,
      expect.stringMatching(/^aichat:stream-ticket:[a-f0-9]{64}$/),
    );
    expect(mockGetChatSession).toHaveBeenCalledWith('session-1');
  });

  it('rejects missing, expired, or wrong-session tickets', async () => {
    await expect(
      consumeAiChatStreamTicket('reused-ticket', 'session-1'),
    ).rejects.toThrow('invalid_ticket');

    mockRedis.eval.mockResolvedValueOnce(
      JSON.stringify({
        userId: 'user-1',
        sessionId: 'session-2',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    );
    await expect(
      consumeAiChatStreamTicket('wrong-session-ticket', 'session-1'),
    ).rejects.toThrow('invalid_ticket');

    mockRedis.eval.mockResolvedValueOnce(
      JSON.stringify({
        userId: 'user-1',
        sessionId: 'session-1',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    await expect(
      consumeAiChatStreamTicket('expired-ticket', 'session-1'),
    ).rejects.toThrow('invalid_ticket');
  });
});

describe('AI Chat WebSocket routes', () => {
  it('rejects invalid tickets before upgrading', async () => {
    const app = Fastify();
    await registerAiChatStreamWebSocket(app);
    await app.ready();
    await expect(
      app.injectWS('/api/chat-sessions/s/session-1/stream'),
    ).rejects.toThrow('401');
    expect(mockRedis.duplicate).not.toHaveBeenCalled();
    await app.close();
  });

  it('shares subscriptions and preserves the stream contract and ping/pong', async () => {
    const subscriber = Object.assign(new EventEmitter(), {
      connect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(1),
      unsubscribe: vi.fn().mockResolvedValue(0),
      disconnect: vi.fn(),
    });
    mockRedis.duplicate.mockReturnValue(subscriber);
    mockRedis.eval.mockImplementation(async (_script, _count, key) =>
      encodeControlIpc(
        'stream-ticket',
        key,
        JSON.stringify({
          userId: 'user-1',
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }),
        60_000,
      ),
    );
    const app = Fastify();
    await registerAiChatStreamWebSocket(app);
    await app.ready();
    const first = await app.injectWS(
      '/api/chat-sessions/s/session-1/stream?ticket=one',
    );
    const second = await app.injectWS(
      '/api/chat-sessions/s/session-1/stream?ticket=two',
    );
    await vi.waitFor(() =>
      expect(subscriber.subscribe).toHaveBeenCalledTimes(1),
    );
    expect(mockRedis.duplicate).toHaveBeenCalledTimes(1);
    const received = new Promise<string>((resolve) =>
      second.on('message', (data) => {
        if (data.toString().includes('assistant_delta'))
          resolve(data.toString());
      }),
    );
    const event = JSON.stringify({
      type: 'assistant_delta',
      delta: 'hello',
      snapshot: 'hello',
      accountId: 'web:user-1',
      sessionId: 'session-1',
    });
    subscriber.emit(
      'message',
      aiChatStreamChannel('session-1'),
      JSON.stringify({ type: 'assistant_delta', snapshot: 'forged' }),
    );
    subscriber.emit(
      'message',
      aiChatStreamChannel('session-1'),
      encodeRuntimeIpc('web:user-1', aiChatStreamChannel('session-1'), event),
    );
    expect(JSON.parse(await received)).toMatchObject(JSON.parse(event));
    const pong = new Promise<void>((resolve) =>
      second.once('pong', () => resolve()),
    );
    second.ping('probe');
    await pong;
    const serverSockets = [...app.websocketServer.clients];
    serverSockets[0].terminate();
    await new Promise<void>((resolve) => first.once('close', () => resolve()));
    expect(subscriber.unsubscribe).not.toHaveBeenCalled();
    serverSockets[1].terminate();
    await vi.waitFor(() =>
      expect(subscriber.unsubscribe).toHaveBeenCalledWith(
        aiChatStreamChannel('session-1'),
      ),
    );
    await app.close();
    expect(subscriber.disconnect).toHaveBeenCalled();
  });
});
