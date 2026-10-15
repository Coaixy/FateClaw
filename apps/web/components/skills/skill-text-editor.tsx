'use client';

import { useMemo, useRef, useState } from 'react';

import type { TextSkillBundleFile } from '@/features/skills/api';

export function SkillTextEditor({
  file,
  readOnly,
  onChange,
}: {
  file: TextSkillBundleFile;
  readOnly: boolean;
  onChange: (content: string) => void;
}) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const lineCount = useMemo(
    () => file.content.split('\n').length,
    [file.content],
  );
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1).join('\n'),
    [lineCount],
  );
  const extension = file.path.split('.').pop()?.toLowerCase() ?? '';
  const language = /^(md|mdx)$/.test(extension)
    ? 'Markdown'
    : extension.toUpperCase();

  function updateCursor(textarea: HTMLTextAreaElement) {
    const beforeCursor = textarea.value.slice(0, textarea.selectionStart);
    const lines = beforeCursor.split('\n');
    setCursor({ line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 overflow-hidden bg-surface-raised font-mono text-[13px] leading-6">
        <div
          ref={gutterRef}
          aria-hidden="true"
          className="w-12 shrink-0 select-none overflow-hidden border-r border-hairline/50 bg-canvas/40 py-4 pr-3 text-right text-muted/50"
        >
          <div className="whitespace-pre">{lineNumbers}</div>
        </div>
        <textarea
          aria-label={`编辑 ${file.path}`}
          value={file.content}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          onChange={(event) => {
            onChange(event.currentTarget.value);
            updateCursor(event.currentTarget);
          }}
          onSelect={(event) => updateCursor(event.currentTarget)}
          onScroll={(event) => {
            if (gutterRef.current)
              gutterRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
          style={{ tabSize: 2 }}
          className="block h-full min-h-0 w-0 min-w-0 flex-1 resize-none overflow-auto border-0 bg-transparent px-4 py-4 font-mono text-[13px] leading-6 text-ink outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/25"
        />
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-hairline bg-canvas/60 px-3 text-[10px] tabular-nums text-muted sm:px-4 sm:text-[11px]">
        <span>
          第 {cursor.line} 行，第 {cursor.column} 列
        </span>
        <span className="flex items-center gap-3">
          <span>{lineCount.toLocaleString()} 行</span>
          <span className="hidden sm:inline">
            {file.content.length.toLocaleString()} 字
          </span>
          <span>{language}</span>
          <span className="hidden sm:inline">UTF-8</span>
        </span>
      </div>
    </div>
  );
}
