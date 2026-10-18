import { describe, expect, it, vi } from 'vitest';

vi.mock('#modules/chat/paipan-runtime', () => ({
  isDirectPaipanSkill: vi.fn((skill: string) =>
    ['bazi-paipan', 'qimen-paipan'].includes(skill),
  ),
}));

import { buildSessionBoardContexts } from '#modules/chat/active-board-context';

describe('buildSessionBoardContexts', () => {
  it('collects all official and pasted boards while selected id only marks current', () => {
    const boards = buildSessionBoardContexts(
      [
        {
          id: 'bazi-board',
          timestamp: '2026-05-28T09:00:00.000Z',
          tool_context: JSON.stringify([
            {
              skill: 'bazi-paipan',
              output: '{"raw":"must not leak"}',
              artifactTitle: '八字排盘',
              artifactData: {
                pillars: {
                  year: '庚午',
                  month: '丁丑',
                },
              },
            },
          ]),
        },
        {
          id: 'qimen-board',
          timestamp: '2026-05-28T10:00:00.000Z',
          tool_context: JSON.stringify([
            {
              skill: 'qimen-paipan',
              output: '奇门 formatter 文本',
              artifactTitle: '奇门遁甲排盘',
              artifactData: {
                排局: ['阳遁', '一局'],
              },
            },
          ]),
        },
        {
          id: 'pasted-board',
          timestamp: '2026-05-28T11:00:00.000Z',
          tool_context: JSON.stringify([
            {
              skill: 'user-pasted-board::六爻',
              output: '用户粘贴六爻原文',
              artifactTitle: '自贴盘面: 六爻',
              artifactData: {
                category: '六爻',
                content: '用户粘贴六爻原文',
                question: '看感情',
                source: 'user_pasted_board',
              },
            },
          ]),
        },
      ],
      {
        selectedBoardMessageId: 'bazi-board',
      },
    );

    expect(boards).toHaveLength(3);
    expect(boards.map((board) => board.sourceMessageId)).toEqual([
      'bazi-board',
      'pasted-board',
      'qimen-board',
    ]);
    expect(boards[0]).toMatchObject({
      sourceMessageId: 'bazi-board',
      source: 'official_paipan',
      isCurrent: true,
    });
    expect(boards[0]?.promptText).toContain('八字排盘（系统排盘结果）');
    expect(boards[0]?.promptText).toContain('year：庚午');
    expect(boards[0]?.promptText).not.toContain('{"raw":"must not leak"}');
    expect(boards[1]).toMatchObject({
      sourceMessageId: 'pasted-board',
      source: 'user_pasted_board',
      promptText: '用户粘贴六爻原文',
      isCurrent: false,
    });
  });

  it('defaults current to the newest valid board when no selected id is provided', () => {
    const boards = buildSessionBoardContexts([
      {
        id: 'old-board',
        timestamp: '2026-05-28T09:00:00.000Z',
        tool_context: JSON.stringify([
          {
            skill: 'bazi-paipan',
            output: '旧盘',
            artifactData: { value: '旧盘' },
          },
        ]),
      },
      {
        id: 'new-board',
        timestamp: '2026-05-28T10:00:00.000Z',
        tool_context: JSON.stringify([
          {
            skill: 'qimen-paipan',
            output: '新盘',
            artifactData: { value: '新盘' },
          },
        ]),
      },
    ]);

    expect(
      boards.map((board) => [board.sourceMessageId, board.isCurrent]),
    ).toEqual([
      ['new-board', true],
      ['old-board', false],
    ]);
  });
});
