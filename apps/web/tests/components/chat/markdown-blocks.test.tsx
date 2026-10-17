import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';

import { splitMarkdownBlocks } from '@/components/chat/markdown-blocks';

describe('streaming Markdown block boundaries', () => {
  it('retains completed block content when more text arrives', () => {
    const first = splitMarkdownBlocks('First paragraph.\n\nGrowing');
    const next = splitMarkdownBlocks('First paragraph.\n\nGrowing answer.');

    expect(first[0]).toEqual({ content: 'First paragraph.\n\n', completed: true });
    expect(next[0]).toEqual(first[0]);
    expect(next[1]).toEqual({ content: 'Growing answer.', completed: false });
  });

  it.each([
    ['loose list', '- First\n\n- Second\n\nFollowing paragraph.'],
    ['nested list', '1. First\n\n   - Nested\n\n     Continuation\n\n2. Second'],
    ['fenced code', 'Before\n\n````ts\nconst x = 1;\n\n```\n````\n\nAfter'],
    ['indented code', '    first line\n\n    second line\n\nAfter'],
    ['blockquote', '> First\n>\n> Second\n\n> Third\n\nAfter'],
    ['table', '| A | B |\n| - | - |\n| one | two |\n\nAfter'],
    ['setext heading', 'Heading\n-------\n\nAfter'],
    ['reference link', '[Source][id]\n\nAfter\n\n[id]: https://example.test'],
    ['escaped reference label', '[Foo*bar\\]]:my_(url)\n\n[Foo*bar\\]]'],
    ['footnote', 'Answer[^1]\n\nAfter\n\n[^1]: Additional context'],
    ['HTML comment', 'Before\n\n<!-- hidden\n\nstill hidden -->\n\nAfter'],
    ['CRLF', 'Before\r\n\r\nAfter'],
  ])('preserves %s semantics', (_label, content) => {
    const blocks = splitMarkdownBlocks(content);
    const render = (text: string) => renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{text}</ReactMarkdown>,
    );
    const normalize = (html: string) => html.replace(/>\n+</g, '><');

    expect(blocks.map((block) => block.content).join('')).toBe(content);
    expect(normalize(blocks.map((block) => render(block.content)).join('\n')))
      .toBe(normalize(render(content)));
  });
});
