'use client';

import { lazy, Suspense } from 'react';

const MarkdownContent = lazy(() =>
  import('@/components/chat/markdown-content').then((module) => ({
    default: module.MarkdownContent,
  })),
);

export function CollapsibleMessage({
  content,
  isBot,
}: {
  content: string;
  isBot: boolean;
}) {
  return isBot ? (
    <Suspense
      fallback={<p className="whitespace-pre-wrap break-words">{content}</p>}
    >
      <MarkdownContent content={content} isBot={isBot} />
    </Suspense>
  ) : (
    <p className="whitespace-pre-wrap break-words">{content}</p>
  );
}
