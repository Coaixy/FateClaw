import { describe, expect, it } from 'vitest';

import {
  aiChatStreamChannel,
  streamEventFromMessagePayload,
  streamEventFromProgressPayload,
  streamEventFromResponsePayload,
} from './ai-chat-stream.js';

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
