'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { MarkdownContent } from '@/components/chat/markdown-content';
import { shouldCollapseMessage } from '@/features/chat/utils/display';

export function CollapsibleMessage({
  content,
  isBot,
  collapsedOverlayClassName,
  toggleClassName,
}: {
  content: string;
  isBot: boolean;
  collapsedOverlayClassName: string;
  toggleClassName: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const needsCollapse = shouldCollapseMessage(content);

  const contentNode = isBot ? (
    <MarkdownContent content={content} isBot={isBot} />
  ) : (
    <p className="whitespace-pre-wrap break-words">{content}</p>
  );

  if (!needsCollapse) {
    return contentNode;
  }

  return (
    <div>
      <div className={`relative ${expanded ? '' : 'max-h-[22em] overflow-hidden'}`}>
        {contentNode}
        {!expanded && <div className={collapsedOverlayClassName} />}
      </div>
      <button onClick={() => setExpanded(!expanded)} className={toggleClassName}>
        {expanded ? (
          <>
            收起 <ChevronUp size={11} />
          </>
        ) : (
          <>
            展开全文 <ChevronDown size={11} />
          </>
        )}
      </button>
    </div>
  );
}
