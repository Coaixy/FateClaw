import { describe, expect, it } from 'vitest';

import type { Message } from '@/features/chat/api';

import {
  hasFinalAssistantAfterLatestUser,
  isStreamingAssistantMessage,
} from './display';

describe('chat display message state helpers', () => {
  it('detects streaming assistant messages', () => {
    expect(
      isStreamingAssistantMessage(
        createMessage({
          id: 'streaming',
          isBot: true,
          metadata: { kind: 'streaming' },
        }),
      ),
    ).toBe(true);

    expect(
      isStreamingAssistantMessage(
        createMessage({
          id: 'final',
          isBot: true,
          metadata: { kind: 'final' },
        }),
      ),
    ).toBe(false);
  });

  it('waits for a final assistant message after the latest user turn', () => {
    const oldFinal = createMessage({
      id: 'old-final',
      isBot: true,
      metadata: { kind: 'final' },
    });
    const latestUser = createMessage({ id: 'latest-user', isBot: false });
    const progress = createMessage({
      id: 'progress',
      isBot: true,
      metadata: { kind: 'progress' },
    });

    expect(
      hasFinalAssistantAfterLatestUser([oldFinal, latestUser, progress]),
    ).toBe(false);

    expect(
      hasFinalAssistantAfterLatestUser([
        oldFinal,
        latestUser,
        progress,
        createMessage({
          id: 'new-final',
          isBot: true,
          metadata: { kind: 'final' },
        }),
      ]),
    ).toBe(true);
  });
});

function createMessage({
  id,
  isBot,
  metadata = null,
}: {
  id: string;
  isBot: boolean;
  metadata?: Message['metadata'];
}): Message {
  return {
    id,
    account_id: 'account-1',
    sender: isBot ? 'assistant' : 'user',
    sender_name: '',
    content: id,
    timestamp: '2026-05-28T00:00:00.000Z',
    is_from_me: isBot,
    is_bot_message: isBot,
    metadata,
  };
}
