import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AiChatMessageList, ToolResultSources } from '@/components/ai-chat/ai-chat-message-list';
import type { Message } from '@/features/chat/api';
import { I18nProvider } from '@/lib/i18n';

describe('AiChatMessageList trajectory collapse', () => {
  it('offers an accessible copy action only after the answer settles', () => {
    const finalHtml = renderMessages([
      createMessage({ id: 'final', content: '可复用的回答', metadata: { kind: 'final' } }),
    ]);
    const streamingHtml = renderMessages([
      createMessage({ id: 'streaming', content: '尚未完成的回答', metadata: { kind: 'streaming' } }),
    ], true);

    expect(finalHtml).toContain('aria-label="复制回答"');
    expect(streamingHtml).not.toContain('aria-label="复制回答"');
  });

  it('links only absolute web sources and shows the actual destination domain', () => {
    const html = renderToStaticMarkup(
      <ToolResultSources items={[
        { title: 'Article', url: 'https://example.test/article', domain: 'unrelated.test' },
        { title: 'Local document', url: 'file:///private/document' },
        { title: 'Script', url: 'javascript:alert(1)' },
        { title: 'Relative', url: '/internal/document' },
      ]} />,
    );

    expect(html).toContain('href="https://example.test/article"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('example.test');
    expect(html).not.toContain('unrelated.test');
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('Local document');
    expect(html).toContain('Script');
    expect(html).toContain('Relative');
  });

  it('renders final replies with multiple headings without delivery cards', () => {
    const html = renderMessages([
      createMessage({
        id: 'final',
        content: '## Analysis\nReading details\n\n## ⚠ Notes\nAdditional context',
        metadata: { kind: 'final' },
      }),
    ]);

    expect(html).toContain('Reading details');
    expect(html).toContain('Additional context');
    expect(html).not.toContain('复制给客户');
    expect(html).not.toContain('仅卦师可见');
    expect(html).not.toContain('aria-expanded=');
  });

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
