import { describe, expect, it } from 'vitest';

import type { Message } from '@/features/chat/api';

import {
  filterProgressMessages,
  formatChatCost,
  formatChatCostLabels,
  formatChatDuration,
  hasFinalAssistantAfterLatestUser,
  isStreamingAssistantMessage,
  isToolTraceMessage,
} from './display';
import { sanitizeToolPath } from './tool-path';

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

  it('keeps tool trace progress messages visible', () => {
    const hiddenProgress = createMessage({
      id: 'progress',
      isBot: true,
      metadata: { kind: 'progress', stage: 'general_running' },
    });
    const toolTrace = createMessage({
      id: 'tool-trace',
      isBot: true,
      metadata: {
        kind: 'tool_trace',
        stage: 'tool_completed',
        tool_call_id: 'call-1',
        tool_name: 'read',
        tool_status: 'completed',
      },
    });

    expect(isToolTraceMessage(toolTrace)).toBe(true);
    expect(filterProgressMessages([hiddenProgress, toolTrace])).toEqual([
      toolTrace,
    ]);
  });

  it('hides local text skill paths in tool traces', () => {
    expect(
      sanitizeToolPath(
        '/Users/coaixy/Documents/Code/FateClaw/.fateclaw/text-skills/a3f5d6c9-b68b-421d-8c2b-5fcc4e7455af/user-我的-skill-89edafe8-fe9a-4afc-889d-4796ccb40a73/SKILL.md',
      ),
    ).toBe('我的-skill/SKILL.md');
  });

  it('formats assistant response duration labels', () => {
    expect(formatChatDuration(900)).toBe('耗时 0.9s');
    expect(formatChatDuration(1234)).toBe('耗时 1.2s');
    expect(formatChatDuration(12_300)).toBe('耗时 12s');
    expect(formatChatDuration(65_000)).toBe('耗时 1m 5s');
    expect(formatChatDuration(-1)).toBeNull();
  });

  it('formats assistant response soft currency cost labels', () => {
    expect(formatChatCost(0)).toBe('消耗 软妹币 0.00');
    expect(formatChatCost(1.236)).toBe('消耗 软妹币 1.24');
    expect(formatChatCost(-1)).toBeNull();
  });

  it('formats assistant response billing breakdown labels', () => {
    expect(
      formatChatCostLabels({
        actual_charge_coins: 0,
        membership_covered_coins: 0.63,
      }),
    ).toEqual(['会员抵扣 软妹币 0.63', '钱包实扣 软妹币 0.00']);
    expect(formatChatCostLabels({ actual_charge_coins: 1.236 })).toEqual([
      '钱包实扣 软妹币 1.24',
    ]);
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
