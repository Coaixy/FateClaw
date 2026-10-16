import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IssueMarkdown as PublicMarkdown } from '@/components/issues/issue-markdown';
import { IssueMarkdown as AdminMarkdown } from '../../../../admin/components/issues/issue-markdown';

describe.each([
  ['public', PublicMarkdown],
  ['admin', AdminMarkdown],
] as const)('%s issue content', (_name, Markdown) => {
  it('renders formatting while refusing active HTML, unsafe links and remote images', () => {
    const html = renderToStaticMarkup(
      <Markdown>
        {
          '**Safe text**\n\n<script>alert(1)</script>\n\n<img src="https://tracker.invalid/pixel">\n\n![pixel](https://tracker.invalid/remote)\n\n[bad](javascript:alert%281%29)\n\n[data](data:text/html,evil)\n\n[good](https://example.test/docs)'
        }
      </Markdown>,
    );
    expect(html).toContain('<strong>Safe text</strong>');
    expect(html).toContain('href="https://example.test/docs"');
    expect(html).toContain('noopener noreferrer nofollow ugc');
    for (const value of [
      '<script',
      '<img',
      'tracker.invalid',
      'javascript:',
      'data:text/html',
      'onerror=',
    ])
      expect(html).not.toContain(value);
  });
});
