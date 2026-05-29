'use client';

import type { ReactNode } from 'react';

interface PaipanStepFrameProps {
  title: string;
  description?: string;
  children: ReactNode;
}

/**
 * 单个引导步骤的内容外框。
 *
 * @param props 步骤标题、说明和具体字段内容。
 * @returns 带统一边框、间距和说明文案的步骤内容区域。
 */
export function PaipanStepFrame({
  title,
  description,
  children,
}: PaipanStepFrameProps) {
  return (
    <section className="rounded-[26px] border border-hairline bg-surface-card/35 p-3 sm:p-4">
      <div className="mb-3">
        <p className="text-[13px] font-semibold tracking-tight text-ink">
          {title}
        </p>
        {description && (
          <p className="mt-1 text-[11px] leading-5 text-muted">
            {description}
          </p>
        )}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
