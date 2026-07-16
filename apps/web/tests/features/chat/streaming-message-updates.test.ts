import { describe, expect, it } from 'vitest';

import type { Message } from '@/features/chat/api';
import { mergeStreamingMessageUpdates } from '@/features/chat/hooks/use-chat-messages';

describe('mergeStreamingMessageUpdates', () => {
  it('keeps unchanged history references while replacing and appending stream rows', () => {
    const first = createMessage('first', '历史消息');
    const streaming = createMessage('streaming', '旧快照');
    const updatedStreaming = createMessage('streaming', '最新快照');
    const thinking = createMessage('thinking', '思考快照');

    const result = mergeStreamingMessageUpdates(
      [first, streaming],
      [updatedStreaming, thinking],
    );

    expect(result).toEqual([first, updatedStreaming, thinking]);
    expect(result[0]).toBe(first);
  });

  it('returns the original list when the frame has no pending updates', () => {
    const messages = [createMessage('first', '历史消息')];

    expect(mergeStreamingMessageUpdates(messages, [])).toBe(messages);
  });
});

/** 创建流式合并测试使用的最小消息。 */
function createMessage(id: string, content: string): Message {
  return {
    id,
    account_id: 'account-1',
    sender: 'assistant',
    sender_name: 'AI',
    content,
    timestamp: '2026-07-16T00:00:00.000Z',
    is_from_me: true,
    is_bot_message: true,
    metadata: { kind: 'streaming' },
  };
}
