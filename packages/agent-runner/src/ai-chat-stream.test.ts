import { describe, expect, it } from 'vitest';

import { aiChatStreamChannel, enrichAiChatStreamEvent } from './ai-chat-stream.js';

describe('agent-runner AI Chat stream helpers', () => {
  it('uses the API stream channel contract', () => {
    expect(aiChatStreamChannel('session-1')).toBe(
      'ipc:ai-chat:stream:session-1',
    );
  });

  it('adds request envelope fields without overriding event payload fields', () => {
    const event = enrichAiChatStreamEvent({
      requestId: 'req-1',
      accountId: 'web:user-1',
      sessionId: 'session-1',
      event: {
        type: 'assistant_delta',
        delta: '好',
        snapshot: '好',
      },
    });

    expect(event).toMatchObject({
      type: 'assistant_delta',
      requestId: 'req-1',
      accountId: 'web:user-1',
      sessionId: 'session-1',
      delta: '好',
      snapshot: '好',
    });
    expect(event.timestamp).toEqual(expect.any(String));
  });
});
