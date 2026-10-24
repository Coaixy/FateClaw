'use client';

import type { ReactNode } from 'react';

interface PaipanFormProps {
  children: ReactNode;
  finalContent?: ReactNode;
  finalAction?: ReactNode;
  resultContent?: ReactNode;
}

export function PaipanForm({
  children,
  finalContent,
  finalAction,
  resultContent,
}: PaipanFormProps) {
  if (resultContent) return resultContent;

  return (
    <div className="space-y-3">
      {children}
      {finalContent}
      {finalAction && <div className="flex justify-end">{finalAction}</div>}
    </div>
  );
}
