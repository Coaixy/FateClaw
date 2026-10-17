'use client';

import { lazy, memo, Suspense } from 'react';

const MarkdownContent = lazy(() =>
  import('@/components/chat/markdown-content').then((module) => ({
    default: module.MarkdownContent,
  })),
);

export const CollapsibleMessage = memo(function CollapsibleMessage({
  content,
  isBot,
  isStreaming = false,
}: {
  content: string;
  isBot: boolean;
  isStreaming?: boolean;
}) {
  return isBot ? (
    <Suspense
      fallback={<p className="whitespace-pre-wrap break-words">{content}</p>}
    >
      <MarkdownContent
        content={content}
        isBot={isBot}
        isStreaming={isStreaming}
      />
    </Suspense>
  ) : (
    <p className="whitespace-pre-wrap break-words">{content}</p>
  );
});
