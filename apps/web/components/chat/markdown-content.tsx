'use client';

import { createContext, Fragment, memo, useContext, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { splitMarkdownBlocks } from './markdown-blocks';
import { VisualizationReference } from './visualization-context';

interface MarkdownContentProps {
  content: string;
  isBot: boolean;
  isStreaming?: boolean;
}

const CodeBlockContext = createContext(false);
const REMARK_PLUGINS = [remarkGfm];
const HIGHLIGHT_PLUGINS: Parameters<typeof ReactMarkdown>[0]['rehypePlugins'] =
  [[rehypeHighlight, { ignoreMissing: true, plainText: ['visualization'] }]];
const NO_REHYPE_PLUGINS: [] = [];
const DISALLOWED_ELEMENTS = ['script', 'iframe', 'object', 'embed', 'style'];

function createComponents(isBot: boolean): Components {
  const codeBg = isBot ? 'bg-canvas/60' : 'bg-canvas/10';
  const codeText = isBot ? 'text-primary' : 'text-canvas';
  const blockquoteBorder = isBot ? 'border-primary/50' : 'border-canvas/30';
  const textMuted = isBot ? 'text-muted' : 'text-canvas/60';
  const borderColor = isBot ? 'border-hairline' : 'border-canvas/20';
  const listMarker = isBot ? 'marker:text-muted' : 'marker:text-canvas/70';

  return {
    p: ({ children }) => (
      <p className="mb-4 last:mb-0 break-words whitespace-pre-wrap">
        {children}
      </p>
    ),
    // Keep answer headings in the body face and scale them with the reading text.
    h1: ({ children }) => (
      <h1 className="font-sans text-[1.35em] font-semibold leading-normal mb-3 mt-6 first:mt-0">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-[1.2em] font-semibold leading-normal mb-3 mt-6 first:mt-0">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-[1.075em] font-semibold leading-normal mb-2 mt-5 first:mt-0">
        {children}
      </h3>
    ),
    ul: ({ children }) => (
      <ul
        className={`mb-4 list-outside list-disc space-y-1 pl-5 ${listMarker}`}
      >
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol
        className={`mb-4 list-outside list-decimal space-y-1 pl-5 ${listMarker}`}
      >
        {children}
      </ol>
    ),
    li: ({ children }) => (
      <li className="break-words pl-0.5 [&>p]:mb-0">{children}</li>
    ),
    code: function MarkdownCode({ children, className }) {
      const isBlock = useContext(CodeBlockContext);
      if (isBlock) {
        return <code className={className}>{children}</code>;
      }
      return (
        <code
          className={`${codeBg} ${codeText} rounded px-1 py-0.5 text-[0.85em] font-mono`}
        >
          {children}
        </code>
      );
    },
    pre: ({ children, node }) => {
      const code = node?.children[0];
      if (
        isBot &&
        code?.type === 'element' &&
        code.tagName === 'code' &&
        Array.isArray(code.properties.className) &&
        code.properties.className.includes('language-visualization')
      ) {
        const artifactId = code.children
          .map((child) => (child.type === 'text' ? child.value : ''))
          .join('')
          .trim();
        return <VisualizationReference artifactId={artifactId} />;
      }
      return (
        <pre
          className={`${codeBg} ${borderColor} border rounded-lg px-4 py-3 mb-4 overflow-x-auto text-[13px] font-mono leading-relaxed`}
        >
          <CodeBlockContext value>{children}</CodeBlockContext>
        </pre>
      );
    },
    blockquote: ({ children }) => (
      <blockquote
        className={`border-l-2 ${blockquoteBorder} pl-4 mb-4 ${textMuted}`}
      >
        {children}
      </blockquote>
    ),
    strong: ({ children }) => (
      <strong className="font-semibold">{children}</strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${isBot ? 'text-primary' : 'text-canvas'} underline underline-offset-2 hover:opacity-80`}
      >
        {children}
      </a>
    ),
    hr: () => <hr className={`${borderColor} border-t my-6`} />,
    table: ({ children }) => (
      <div className="max-w-full overflow-x-auto mb-4">
        <table
          className={`w-full text-[14px] leading-7 border-collapse ${borderColor}`}
        >
          {children}
        </table>
      </div>
    ),
    thead: ({ children }) => (
      <thead className={`${codeBg} font-semibold`}>{children}</thead>
    ),
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => (
      <tr className={`border-b ${borderColor}`}>{children}</tr>
    ),
    th: ({ children }) => (
      <th className={`px-2 py-1.5 text-left border ${borderColor}`}>
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className={`px-2 py-1.5 border ${borderColor}`}>{children}</td>
    ),
    del: ({ children }) => (
      <del className="line-through opacity-60">{children}</del>
    ),
  };
}

const BOT_COMPONENTS = createComponents(true);
const USER_COMPONENTS = createComponents(false);

const MarkdownBlockContent = memo(function MarkdownBlockContent({
  content,
  isBot,
  highlight,
}: {
  content: string;
  isBot: boolean;
  highlight: boolean;
}) {
  const highlightCode = highlight && /`{3}|~{3}|^ {4}|^\t/m.test(content);
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={highlightCode ? HIGHLIGHT_PLUGINS : NO_REHYPE_PLUGINS}
      components={isBot ? BOT_COMPONENTS : USER_COMPONENTS}
      skipHtml
      disallowedElements={DISALLOWED_ELEMENTS}
    >
      {content}
    </ReactMarkdown>
  );
});

export const MarkdownContent = memo(function MarkdownContent({
  content,
  isBot,
  isStreaming = false,
}: MarkdownContentProps) {
  // Historical answers need one document pass; only growing answers benefit
  // from retaining independent blocks between stream updates.
  const blocks = useMemo(
    () =>
      isStreaming
        ? splitMarkdownBlocks(content)
        : [{ content, completed: true }],
    [content, isStreaming],
  );

  return blocks.map((block, index) => (
    <Fragment key={index}>
      {index > 0 ? '\n' : null}
      <MarkdownBlockContent
        content={block.content}
        isBot={isBot}
        highlight={!isStreaming || block.completed}
      />
    </Fragment>
  ));
});
