import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MessageDto } from '@fateclaw/contracts/chat';

import { MessageTimeline } from '../components/messages/message-timeline';
import { ToastProvider } from '../components/ui/toast';
import type { AdminMessage } from '../lib/admin-api';

function message(
  id: string,
  content: string,
  metadata: MessageDto['metadata'],
  overrides: Partial<AdminMessage & MessageDto> = {},
): AdminMessage & MessageDto {
  return {
    id,
    account_id: 'account-1',
    session_id: 'session-1',
    session_title: '测试会话',
    deleted_at: null,
    session_deleted_at: null,
    sender: 'assistant',
    sender_name: 'AI',
    content,
    timestamp: '2026-10-25T10:00:00.000Z',
    is_from_me: false,
    is_bot_message: true,
    metadata,
    ...overrides,
  };
}

function renderTimeline(
  messages: AdminMessage[],
  searchText = '',
  fullMessages?: MessageDto[],
) {
  return renderToStaticMarkup(
    <ToastProvider>
      <MessageTimeline
        messages={messages}
        fullMessages={fullMessages}
        searchText={searchText}
        emptyText="当前会话暂无消息"
      />
    </ToastProvider>,
  );
}

describe('admin conversation rendering', () => {
  it('enriches summaries with authorized details before frontend filtering and rendering', () => {
    const fullMessages = [
      message('4-final', '最终回复', { kind: 'final' }),
      message('3-thinking', '不应直接展示的思考详情', { kind: 'thinking' }),
      message('2-progress', '不应展示的普通进度', { kind: 'progress' }),
      message(
        '1-board-request',
        '不应展示的排盘操作记录',
        { kind: 'board_request', workflow: 'direct_paipan' },
        { is_bot_message: false, sender: 'user' },
      ),
    ];
    const summaries = fullMessages.map(({ metadata: _metadata, ...summary }) => summary);
    const html = renderTimeline(summaries, '', fullMessages);

    expect(html).toContain('思考与执行过程');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="复制回答"');
    expect(html).not.toContain('不应直接展示的思考详情');
    expect(html).not.toContain('不应展示的普通进度');
    expect(html).not.toContain('不应展示的排盘操作记录');
  });

  it('keeps deleted audit rows outside the detail response and preserves chronological search', () => {
    const newer = message('newer', '较新的消息', { kind: 'final' }, {
      timestamp: '2026-10-25T11:00:00.000Z',
    });
    const deleted = message('older', '较早的已删除消息', { kind: 'final' }, {
      deleted_at: '2026-10-25T12:00:00.000Z',
    });
    const summaries = [newer, deleted];
    const html = renderTimeline(summaries, '', [newer]);
    const filtered = renderTimeline(summaries, '较新的', [newer]);

    expect(html.indexOf('较早的已删除消息')).toBeLessThan(html.indexOf('较新的消息'));
    expect(html).toContain('已删除');
    expect(filtered).toContain('较新的消息');
    expect(filtered).not.toContain('较早的已删除消息');
  });

  it('keeps a matching process message visible when search excludes its final reply', () => {
    const html = renderTimeline([
      message('thinking', '待搜索的思考内容', { kind: 'thinking' }),
      message('final', '最终回复', { kind: 'final' }),
    ], '待搜索');

    expect(html).toContain('思考与执行过程');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('最终回复');
  });

  it('does not expose user-account recovery actions in admin', () => {
    const html = renderTimeline([
      message('error', '积分不足，请充值后继续使用', { kind: 'error' }),
    ]);

    expect(html).toContain('积分不足');
    expect(html).not.toContain('href="/membership"');
  });
});
