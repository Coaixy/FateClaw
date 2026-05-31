'use client';

import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

interface MarkdownContentProps {
  content: string;
  isBot: boolean;
}

export function MarkdownContent({ content, isBot }: MarkdownContentProps) {
  // Bot 气泡：深色背景，用主题前景色
  // 用户气泡：亮色背景，用深色文字
  const codeBg = isBot ? 'bg-canvas/60' : 'bg-canvas/10';
  const codeText = isBot ? 'text-primary' : 'text-canvas';
  const blockquoteBorder = isBot ? 'border-primary/50' : 'border-canvas/30';
  const textMuted = isBot ? 'text-muted' : 'text-canvas/60';
  const borderColor = isBot ? 'border-hairline' : 'border-canvas/20';
  const listMarker = isBot ? 'marker:text-muted' : 'marker:text-canvas/70';

  const components: Components = {
    // 段落
    p: ({ children }) => (
      <p className="mb-2 last:mb-0 break-words leading-relaxed whitespace-pre-wrap">{children}</p>
    ),
    // 标题
    h1: ({ children }) => (
      <h1 className="text-[15px] font-semibold mb-2 mt-3 first:mt-0">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-[14px] font-semibold mb-1.5 mt-2.5 first:mt-0">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-[13px] font-semibold mb-1 mt-2 first:mt-0">{children}</h3>
    ),
    // 无序/有序列表
    ul: ({ children }) => (
      <ul className={`mb-2 list-outside list-disc space-y-0.5 pl-5 ${listMarker}`}>
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className={`mb-2 list-outside list-decimal space-y-0.5 pl-5 ${listMarker}`}>
        {children}
      </ol>
    ),
    li: ({ children }) => (
      <li className="break-words pl-0.5 leading-relaxed [&>p]:mb-0">{children}</li>
    ),
    // 行内代码
    code: ({ children, className }) => {
      // rehype-highlight 会在块级代码上设置 className="language-xxx hljs"
      const isBlock = className?.includes('hljs') || className?.includes('language-');
      if (isBlock) {
        return <code className={className}>{children}</code>;
      }
      return (
        <code className={`${codeBg} ${codeText} rounded px-1 py-0.5 text-[11px] font-mono`}>
          {children}
        </code>
      );
    },
    // 代码块容器
    pre: ({ children }) => (
      <pre className={`${codeBg} ${borderColor} border rounded-lg px-3 py-2.5 mb-2 overflow-x-auto text-[11px] font-mono leading-relaxed`}>
        {children}
      </pre>
    ),
    // 引用块
    blockquote: ({ children }) => (
      <blockquote className={`border-l-2 ${blockquoteBorder} pl-3 mb-2 ${textMuted} italic`}>
        {children}
      </blockquote>
    ),
    // 粗体/斜体
    strong: ({ children }) => (
      <strong className="font-semibold">{children}</strong>
    ),
    em: ({ children }) => (
      <em className="italic">{children}</em>
    ),
    // 链接
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
    // 分割线
    hr: () => (
      <hr className={`${borderColor} border-t my-3`} />
    ),
    // 表格
    table: ({ children }) => (
      <div className="overflow-x-auto mb-2">
        <table className={`w-full text-[12px] border-collapse ${borderColor}`}>
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
      <th className={`px-2 py-1.5 text-left border ${borderColor}`}>{children}</th>
    ),
    td: ({ children }) => (
      <td className={`px-2 py-1.5 border ${borderColor}`}>{children}</td>
    ),
    // 删除线 (GFM)
    del: ({ children }) => (
      <del className="line-through opacity-60">{children}</del>
    ),
  };

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={components}
      // react-markdown 默认即不解析 raw HTML（未启用 rehype-raw），但显式
      // 禁用脚本/嵌入类标签作为深度防御，防御未来误启 raw HTML 时泄露 XSS。
      skipHtml
      disallowedElements={['script', 'iframe', 'object', 'embed', 'style']}
    >
      {content}
    </ReactMarkdown>
  );
}
