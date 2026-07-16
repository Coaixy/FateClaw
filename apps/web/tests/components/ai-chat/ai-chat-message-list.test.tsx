import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AiChatMessageList } from '@/components/ai-chat/ai-chat-message-list';
import type { Message } from '@/features/chat/api';
import { I18nProvider } from '@/lib/i18n';

describe('AiChatMessageList trajectory collapse', () => {
  it('keeps a streaming thinking block collapsed initially', () => {
    const html = renderMessages(
      [
        createMessage({
          id: 'thinking',
          content: '这里是默认不应显示的思考详情',
          metadata: { kind: 'thinking' },
        }),
      ],
      true,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('思考与执行过程');
    expect(html).not.toContain('这里是默认不应显示的思考详情');
  });

  it('keeps standalone tool traces inside one collapsed frame', () => {
    const html = renderMessages([
      createMessage({
        id: 'board-tool',
        content: '盘面',
        metadata: {
          kind: 'tool_trace',
          tool_name: 'get_session_board',
          tool_status: 'completed',
          tool_path: 'private/board.txt',
        },
      }),
      createMessage({
        id: 'read-tool',
        content: '查阅',
        metadata: {
          kind: 'tool_trace',
          tool_name: 'read',
          tool_status: 'completed',
          tool_path: 'lichunwen-liuyao/SKILL.md',
        },
      }),
      createMessage({
        id: 'final',
        content: '最终回复',
        metadata: { kind: 'final' },
      }),
    ]);

    expect(html.match(/aria-expanded="false"/g)).toHaveLength(1);
    expect(html).toContain('思考与执行过程');
    expect(html).toContain('2 项');
    expect(html).not.toContain('lichunwen-liuyao/SKILL.md');
  });

  it('merges thinking and tool traces into one collapsed frame', () => {
    const html = renderMessages([
      createMessage({
        id: 'thinking',
        content: '合并框内的思考详情',
        metadata: { kind: 'thinking' },
      }),
      createMessage({
        id: 'read-tool',
        content: '查阅',
        metadata: {
          kind: 'tool_trace',
          tool_name: 'read',
          tool_status: 'completed',
          tool_path: 'merged/SKILL.md',
        },
      }),
      createMessage({
        id: 'final',
        content: '最终回复',
        metadata: { kind: 'final' },
      }),
    ]);

    expect(html.match(/aria-expanded="false"/g)).toHaveLength(1);
    expect(html).toContain('思考与执行过程');
    expect(html).toContain('2 项');
    expect(html).not.toContain('合并框内的思考详情');
    expect(html).not.toContain('merged/SKILL.md');
  });
});

/** 渲染带中文多语言上下文的消息列表，供折叠态断言使用。 */
function renderMessages(messages: Message[], sending = false): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <AiChatMessageList
        messages={messages}
        loading={false}
        sending={sending}
        progressLabel={null}
        selectedSession="session-1"
        switchingSession={false}
        showCenteredComposer={false}
        composer={null}
      />
    </I18nProvider>,
  );
}

/** 创建测试所需的最小机器人消息。 */
function createMessage({
  id,
  content,
  metadata,
}: {
  id: string;
  content: string;
  metadata: Message['metadata'];
}): Message {
  return {
    id,
    account_id: 'account-1',
    sender: 'assistant',
    sender_name: 'AI',
    content,
    timestamp: '2026-07-16T00:00:00.000Z',
    is_from_me: false,
    is_bot_message: true,
    metadata,
  };
}
