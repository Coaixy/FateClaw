'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, Code } from 'lucide-react';
import type { SkillContextEntry } from '@/features/chat/api';

interface ArtifactDebugProps {
  entries: SkillContextEntry[];
}

function formatDebugJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * 按需展示 artifact 的 formatter 文本和结构化数据，便于核对模型实际可见内容。
 */
export function ArtifactDebug({ entries }: ArtifactDebugProps) {
  const [expanded, setExpanded] = useState(false);

  // 调试面板会打断盘面阅读，默认不在本地会话流里展示；需要排查结构化数据时再显式打开。
  if (process.env.NEXT_PUBLIC_SHOW_ARTIFACT_DEBUG !== '1') return null;
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
        <div className="border-t border-dashed border-amber-500/30 divide-y divide-dashed divide-amber-500/20">
          {entries.map((entry, index) => (
            <div key={`${entry.skill}-${index}`} className="p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold text-amber-700">
                <span>#{index + 1}</span>
                <span>{entry.artifactTitle ?? entry.skill}</span>
                <span className="text-amber-700/60">{entry.skill}</span>
              </div>
              <div>
                <div className="mb-1 text-[10px] font-medium text-amber-700/80">
                  formatter result / 模型可见文本
                </div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-amber-500/20 bg-amber-50/50 p-2 text-[10px] leading-relaxed text-amber-800">
                  {entry.output || '（空）'}
                </pre>
              </div>
              <div>
                <div className="mb-1 text-[10px] font-medium text-amber-700/80">
                  artifactData / 原始结构化数据
                </div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-amber-500/20 bg-amber-50/50 p-2 text-[10px] leading-relaxed text-amber-800">
                  {formatDebugJson(entry.artifactData)}
                </pre>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
