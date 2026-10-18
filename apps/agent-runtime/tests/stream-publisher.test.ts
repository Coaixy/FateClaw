import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAiChatStreamPublisher } from '#agent/ai-chat-stream';
import type { AiChatStreamEvent } from '#agent/types';

describe('request-scoped stream publisher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces text bursts without losing the snapshot or delta', () => {
    const publish = vi.fn();
    const stream = createAiChatStreamPublisher(publish);
    for (let i = 1; i <= 100; i++) {
      stream.publish({
        type: 'assistant_delta',
        delta: 'x',
        snapshot: 'x'.repeat(i),
      });
    }
    expect(publish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      type: 'assistant_delta',
      delta: 'x'.repeat(100),
      snapshot: 'x'.repeat(100),
    });
    stream.close();
  });

  it('flushes text before tool and turn boundaries without delaying them', () => {
    const events: AiChatStreamEvent[] = [];
    const stream = createAiChatStreamPublisher((event) => events.push(event));
    stream.publish({ type: 'assistant_delta', delta: 'a', snapshot: 'a' });
    stream.publish({
      type: 'tool_start',
      toolCallId: 't1',
      toolName: 'read_soul',
    });
    stream.publish({ type: 'turn_start', turnIndex: 2 });
    stream.publish({ type: 'assistant_delta', delta: 'b', snapshot: 'b' });
    stream.close();
    expect(events.map((event) => event.type)).toEqual([
      'assistant_delta',
      'tool_start',
      'turn_start',
      'assistant_delta',
    ]);
    vi.runAllTimers();
    expect(events).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not merge different streams, turns, or replacement snapshots', () => {
    const publish = vi.fn();
    const stream = createAiChatStreamPublisher(publish);
    stream.publish({
      type: 'thinking_delta',
      delta: 'old',
      snapshot: 'old',
      turnIndex: 1,
    });
    stream.publish({
      type: 'thinking_delta',
      delta: 'new',
      snapshot: 'new',
      turnIndex: 1,
    });
    stream.publish({
      type: 'thinking_delta',
      delta: 'next',
      snapshot: 'next',
      turnIndex: 2,
    });
    stream.publish({
      type: 'assistant_delta',
      delta: 'answer',
      snapshot: 'answer',
    });
    stream.close();
    expect(publish.mock.calls.map(([event]) => event.delta)).toEqual([
      'old',
      'new',
      'next',
      'answer',
    ]);
  });

  it('keeps concurrent requests isolated and ignores events after close', () => {
    const first = vi.fn();
    const second = vi.fn();
    const a = createAiChatStreamPublisher(first);
    const b = createAiChatStreamPublisher(second);
    a.publish({ type: 'assistant_delta', delta: 'a', snapshot: 'a' });
    b.publish({ type: 'assistant_delta', delta: 'b', snapshot: 'b' });
    a.close();
    a.publish({ type: 'assistant_delta', delta: 'late', snapshot: 'late' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(second).toHaveBeenCalledExactlyOnceWith({
      type: 'assistant_delta',
      delta: 'b',
      snapshot: 'b',
    });
    b.close();
  });
});
