import { describe, expect, it } from 'vitest';
import type { Message, SharedChatSession } from '@/features/chat/api';
import { getShareQuestion, wrapPosterText } from '@/features/chat/share-poster';

function message(patch: Partial<Message>): Message {
  return {
    id: 'question',
    account_id: 'shared',
    sender: 'user',
    sender_name: 'User',
    content: '今年适合换工作吗？',
    timestamp: '2026-10-23T10:00:00.000Z',
    is_from_me: false,
    is_bot_message: false,
    ...patch,
  };
}

function session(messages: Message[]): SharedChatSession {
  return {
    id: 'session',
    title: '事业方向',
    created_at: '2026-10-23T09:00:00.000Z',
    updated_at: '2026-10-23T11:00:00.000Z',
    messages,
  };
}

describe('share poster question', () => {
  it('uses the first actual question after manual chart creation', () => {
    const shared = session([
      message({
        content: '八字排盘：出生日期与地点',
        metadata: { kind: 'board_request' },
      }),
      message({ content: '已生成排盘', is_bot_message: true }),
      message({ id: 'actual-question', content: '  我适合从事什么行业？  ' }),
      message({
        content: '请再展开说说',
        timestamp: '2026-10-23T11:00:00.000Z',
      }),
    ]);
    expect(getShareQuestion(shared)).toBe('我适合从事什么行业？');
  });

  it('uses the earliest question without changing the message order', () => {
    const shared = session([
      message({
        id: 'later',
        content: '后续追问',
        timestamp: '2026-10-23T11:00:00.000Z',
      }),
      message({ id: 'first' }),
    ]);
    expect(getShareQuestion(shared)).toBe('今年适合换工作吗？');
    expect(shared.messages.map((item) => item.id)).toEqual(['later', 'first']);
  });

  it('uses the title for a chart-only conversation', () => {
    expect(
      getShareQuestion(
        session([
          message({ metadata: { kind: 'board_request' } }),
          message({ content: '排盘已生成', is_bot_message: true }),
        ]),
      ),
    ).toBe('事业方向');
  });
});

describe('poster text boundaries', () => {
  const measure = (value: string) =>
    Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
    ).length * 10;

  it('bounds a long question and includes the ellipsis inside the available width', () => {
    const { lines, truncated } = wrapPosterText(
      '事业方向应该如何选择？'.repeat(20),
      80,
      3,
      measure,
    );
    expect(truncated).toBe(true);
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toMatch(/…$/);
    expect(lines.every((line) => measure(line) <= 80)).toBe(true);
  });

  it('keeps emoji graphemes intact across line boundaries', () => {
    const { lines, truncated } = wrapPosterText('方向👩‍💻改变👨‍👩‍👧‍👦', 30, 3, measure);
    expect(lines).toEqual(['方向👩‍💻', '改变👨‍👩‍👧‍👦']);
    expect(truncated).toBe(false);
  });
});
