'use client';

import { Sparkles } from 'lucide-react';

/**
 * 渲染 AI 生成内容的显式提示标签。
 *
 * @param props.className 允许调用方按所在消息区域补充布局类名。
 * @returns 用于跟随 AI 回复展示的可见合规标识。
 */
export function AiGeneratedLabel({
  className = '',
}: {
  className?: string;
}) {
  return (
    <span
      aria-label="AI 生成内容标识"
      className={`inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/8 px-1.5 py-0.5 text-[9px] font-medium leading-4 text-primary shadow-sm ${className}`}
    >
      <Sparkles size={10} aria-hidden="true" />
      AI 生成内容，仅供参考
    </span>
  );
}
