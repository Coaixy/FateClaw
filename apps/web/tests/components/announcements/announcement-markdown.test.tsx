import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnnouncementMarkdown as PublicMarkdown } from '@/components/announcements/announcement-markdown';
import { AnnouncementMarkdown as AdminMarkdown } from '../../../../admin/components/announcements/announcement-markdown';

describe.each([
  ['public', PublicMarkdown],
  ['preview', AdminMarkdown],
] as const)('%s announcement content', (_name, Markdown) => {
  it('renders Markdown and internal links without executing embedded HTML or unsafe URLs', () => {
    const html = renderToStaticMarkup(
      <Markdown>
        {
          '## 更新\n\n**已上线**\n\n[查看](/settings)\n\n[官网](https://example.test)\n\n<script>alert(1)</script>\n\n![image](https://tracker.invalid/pixel)\n\n[bad](javascript:alert%281%29)\n\n| 功能 | 状态 |\n| --- | --- |\n| 公告 | 上线 |'
        }
      </Markdown>,
    );
    expect(html).toContain('<h2>更新</h2>');
    expect(html).toContain('<strong>已上线</strong>');
    expect(html).toContain('href="/settings"');
    expect(html).toContain('href="https://example.test"');
    expect(html).toContain('<table>');
    for (const value of ['<script', '<img', 'javascript:', 'tracker.invalid'])
      expect(html).not.toContain(value);
  });
});
