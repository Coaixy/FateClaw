import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function AnnouncementMarkdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-7 text-body-strong break-words [overflow-wrap:anywhere] [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ol]:my-3 [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-surface-card [&_pre]:p-4 [&_code]:font-mono [&_code]:text-xs [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-4 [&_h1]:my-4 [&_h1]:text-xl [&_h2]:my-4 [&_h2]:text-lg [&_h3]:my-3 [&_h3]:font-semibold [&_hr]:my-5 [&_table]:my-4 [&_table]:block [&_table]:overflow-x-auto [&_th]:border [&_th]:p-2 [&_td]:border [&_td]:p-2">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        disallowedElements={['img', 'input']}
        components={{
          a: ({ href, children: label }) => (
            <a
              href={href}
              target={href?.startsWith('https://') ? '_blank' : undefined}
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-4"
            >
              {label}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
