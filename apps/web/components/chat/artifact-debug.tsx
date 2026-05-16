'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, Code } from 'lucide-react';
import type { SkillContextEntry } from '@/features/chat/api';

interface ArtifactDebugProps {
  entries: SkillContextEntry[];
}

export function ArtifactDebug({ entries }: ArtifactDebugProps) {
  const [expanded, setExpanded] = useState(false);

  // 仅 dev 模式显示
  if (process.env.NODE_ENV !== 'development') return null;
  if (entries.length === 0) return null;

  return (
    <div className="mt-3 border border-dashed border-amber-500/50 rounded-lg overflow-hidden bg-amber-500/5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-amber-600 hover:bg-amber-500/10 transition-colors cursor-pointer"
      >
        <Code size={12} />
        <span className="font-medium">
          Debug: {entries.length} artifact{entries.length > 1 ? 's' : ''}
        </span>
        <span className="flex-1" />
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {expanded && (
        <div className="border-t border-dashed border-amber-500/30">
          <pre className="text-[10px] text-amber-700 p-3 overflow-auto max-h-80 whitespace-pre-wrap break-words">
            {JSON.stringify(entries, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
