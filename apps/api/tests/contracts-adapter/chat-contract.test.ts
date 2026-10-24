import { describe, expect, it, vi } from 'vitest';

vi.mock('#modules/chat/paipan-runtime', () => ({
  isDirectPaipanSkill: (skill: string) => skill === 'qimen-paipan',
}));

import {
  toMessageDto,
  toSharedChatSessionDto,
} from '#contracts-adapter/chat-contract';
import { buildSessionBoardContexts } from '#modules/chat/active-board-context';
import type { NewMessage } from '#shared/types';

describe('historical Qimen exports', () => {
  it('returns the same refreshed text for copying and AI reading without rewriting storage', () => {
    const originalContext = JSON.stringify([
      { skill: 'other-skill', output: 'Keep this text verbatim.' },
      {
        skill: 'qimen-paipan',
        output: 'Legacy incomplete text',
        artifactData: {
          盘式: '鸣法',
          值符值使: { 值符天干: ['甲申', '庚'] },
          神: { 艮: '符' },
          天乙: '庚',
          长生运: { 天盘: { 艮: { 天干: '庚', 长生: { 寅: '绝' } } } },
        },
      },
    ]);
    const message: NewMessage = {
      id: 'historical-chart',
      account_id: 'web:user-1',
      sender: 'assistant',
      sender_name: 'assistant',
      content: '',
      timestamp: '2026-10-01T00:00:00.000Z',
      is_bot_message: true,
      tool_context: originalContext,
    };
    const [{ promptText }] = buildSessionBoardContexts([message]);
    const owned = toMessageDto(message);
    const shared = toSharedChatSessionDto({
      session: {
        id: 'session-1',
        user_id: 'user-1',
        account_id: 'web:user-1',
        title: 'Qimen',
        created_at: message.timestamp,
        updated_at: message.timestamp,
        deleted_at: null,
      },
      messages: [message],
    }).messages[0];

    for (const dto of [owned, shared]) {
      const entries = JSON.parse(dto.tool_context!);
      expect(entries[1].output).toBe(promptText);
      expect(entries[1].output).toContain('神 值符');
      expect(entries[1].output).toContain('天乙：庚');
      expect(entries[1].output).toContain('艮宫（庚）：寅:绝');
      expect(entries[0]).toEqual(JSON.parse(originalContext)[0]);
    }
    expect(message.tool_context).toBe(originalContext);
  });

  it.each(['invalid JSON', 'null', '{}', '[null]'])(
    'retains malformed historical context safely: %s',
    (tool_context) => {
      const dto = toMessageDto({
        id: 'message-1',
        account_id: 'web:user-1',
        sender: 'assistant',
        sender_name: 'assistant',
        content: '',
        timestamp: '',
        tool_context,
      });
      expect(dto.tool_context).toBe(tool_context);
    },
  );
});
