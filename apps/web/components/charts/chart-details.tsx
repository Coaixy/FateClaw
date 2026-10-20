'use client';

import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export function ChartDetails({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details
      data-artifact-details
      className="group border-t border-hairline bg-canvas"
    >
      <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 px-3 text-[12px] text-chart-earth [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown
          size={14}
          className="shrink-0 transition-transform group-open:rotate-180"
        />
      </summary>
      {children}
    </details>
  );
}
