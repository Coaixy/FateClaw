import { describe, expect, it } from 'vitest';

import type { Message } from '@/features/chat/api';

import {
  canHostToolTraceFooter,
  filterProgressMessages,
  formatChatCost,
  formatChatCostLabels,
  formatChatDuration,
  hasFinalAssistantAfterLatestUser,
  isStreamingAssistantMessage,
  isToolTraceMessage,
} from '../../../../features/chat/utils/display';
import { sanitizeToolPath } from '../../../../features/chat/utils/tool-path';

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

    expect(
      hasFinalAssistantAfterLatestUser([
        oldFinal,
        latestUser,
        createMessage({
          id: 'error',
          isBot: true,
          metadata: { kind: 'error', turn_complete: true },
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

  it('hides direct paipan request messages but keeps ordinary matching text', () => {
    const boardRequest = createMessage({
      id: 'board-request',
      isBot: false,
      content: '大六壬排盘',
      metadata: {
        kind: 'board_request',
        workflow: 'direct_paipan',
        board_skill: 'liuren-paipan',
      },
    });
    const ordinaryUserMessage = createMessage({
      id: 'ordinary-user',
      isBot: false,
      content: '大六壬排盘',
    });
    const boardResult = createMessage({
      id: 'board-result',
      isBot: true,
      content: '已生成大六壬排盘。',
      metadata: {
        kind: 'board_result',
        workflow: 'direct_paipan',
        board_skill: 'liuren-paipan',
      },
    });

    expect(
      filterProgressMessages([
        boardRequest,
        ordinaryUserMessage,
        boardResult,
      ]),
    ).toEqual([ordinaryUserMessage, boardResult]);
  });

  it('hides simple workflow startup request messages', () => {
    const workflowRequest = createMessage({
      id: 'simple-workflow-request',
      isBot: false,
      content: '简易模式：占卜问事',
      metadata: {
        kind: 'board_request',
        workflow: 'simple_workflow',
      },
    });
    const boardResult = createMessage({
      id: 'simple-workflow-board',
      isBot: true,
      content: '已生成大衍筮法。',
      metadata: {
        kind: 'board_result',
        workflow: 'simple_workflow',
      },
    });
    const firstQuestion = createMessage({
      id: 'first-question',
      isBot: false,
      content: 'Can she and I get back together?',
    });

    expect(
      filterProgressMessages([workflowRequest, boardResult, firstQuestion]),
    ).toEqual([boardResult, firstQuestion]);
  });

  it('does not attach tool footers to transient thinking messages', () => {
    expect(
      canHostToolTraceFooter(
        createMessage({
          id: 'thinking',
          isBot: true,
          metadata: { kind: 'thinking' },
        }),
      ),
    ).toBe(false);

    expect(
      canHostToolTraceFooter(
        createMessage({
          id: 'streaming',
          isBot: true,
          metadata: { kind: 'streaming' },
        }),
      ),
    ).toBe(true);

    expect(
      canHostToolTraceFooter(
        createMessage({
          id: 'reconnecting',
          isBot: true,
          metadata: { kind: 'reconnecting' },
        }),
      ),
    ).toBe(false);
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

  it('formats assistant response credit cost labels', () => {
    expect(formatChatCost(0)).toBe('消耗 0.00 积分');
    expect(formatChatCost(1.236)).toBe('消耗 1.24 积分');
    expect(formatChatCost(-1)).toBeNull();
  });

  it('formats assistant response billing breakdown labels', () => {
    // 单层化后会员不再抵扣 AI 费用，breakdown 只剩"积分实扣"一条。
    expect(
      formatChatCostLabels({
        actual_charge_coins: 0,
      }),
    ).toEqual(['积分实扣 0.00 积分']);
    expect(formatChatCostLabels({ actual_charge_coins: 1.236 })).toEqual([
      '积分实扣 1.24 积分',
    ]);
  });
});

function createMessage({
  id,
  isBot,
  content = id,
  metadata = null,
}: {
  id: string;
  isBot: boolean;
  content?: string;
  metadata?: Message['metadata'];
}): Message {
  return {
    id,
    account_id: 'account-1',
    sender: isBot ? 'assistant' : 'user',
    sender_name: '',
    content,
    timestamp: '2026-05-28T00:00:00.000Z',
    is_from_me: isBot,
    is_bot_message: isBot,
    metadata,
  };
}
