'use client';

import { MarkdownContent } from '@/components/chat/markdown-content';

export function CollapsibleMessage({
  content,
  isBot,
}: {
  content: string;
  isBot: boolean;
}) {
  return isBot ? (
    <MarkdownContent content={content} isBot={isBot} />
  ) : (
    <p className="whitespace-pre-wrap break-words">{content}</p>
  );
}
