import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MarkdownContent } from '@/components/chat/markdown-content';

describe('MarkdownContent streaming code', () => {
  it('keeps unfinished code readable without syntax highlighting', () => {
    const html = renderToStaticMarkup(
      <MarkdownContent content={'```ts\nconst value = 1;'} isBot isStreaming />,
    );

    expect(html).toContain('<pre');
    expect(html).toContain('const value = 1;');
    expect(html).not.toContain('hljs');
  });

  it('highlights a completed code block while the next paragraph streams', () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        content={'```ts\nconst value = 1;\n```\n\nThe next paragraph'}
        isBot
        isStreaming
      />,
    );

    expect(html).toContain('hljs-keyword');
    expect(html).toContain('The next paragraph');
  });
});
