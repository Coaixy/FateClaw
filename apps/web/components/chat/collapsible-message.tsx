'use client';

import { lazy, memo, Suspense } from 'react';
import { replaceVisualizationReferences } from '@fateclaw/contracts/visualization';
import { useI18n } from '@/lib/i18n';

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
  const { t } = useI18n();
  return isBot ? (
    <Suspense
      fallback={
        <p className="whitespace-pre-wrap break-words">
          {replaceVisualizationReferences(content, () =>
            t('visualization.loading'),
          )}
        </p>
      }
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
