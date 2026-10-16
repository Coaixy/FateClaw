import ReactMarkdown from 'react-markdown';

export function IssueMarkdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-7 text-body-strong break-words [overflow-wrap:anywhere] [&_p]:my-3 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-surface-card [&_pre]:p-4 [&_code]:font-mono [&_code]:text-xs [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-4 [&_h1]:text-xl [&_h2]:text-lg [&_h3]:font-semibold">
      <ReactMarkdown
        skipHtml
        allowedElements={[
          'p',
          'a',
          'strong',
          'em',
          'del',
          'code',
          'pre',
          'blockquote',
          'ul',
          'ol',
          'li',
          'h1',
          'h2',
          'h3',
          'hr',
          'br',
        ]}
        urlTransform={(url) => {
          try {
            const parsed = new URL(url);
            return ['https:', 'http:'].includes(parsed.protocol) &&
              !parsed.username &&
              !parsed.password
              ? parsed.href
              : '';
          } catch {
            return '';
          }
        }}
        components={{
          a: ({ href, children: label }) =>
            href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow ugc"
                className="text-primary underline underline-offset-4"
              >
                {label}
              </a>
            ) : (
              <span>{label}</span>
            ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
