'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, Terminal } from 'lucide-react';

import { useToast } from '@/lib/use-toast';

export function CopyButton({
  value,
  label = '复制',
  dark = false,
}: {
  value: string;
  label?: string;
  dark?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    setCopied(false);
  }, [value]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      toast('error', '复制失败，请手动选择并复制');
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? '已复制' : label}
      className={`inline-flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-[11px] transition-colors ${dark ? 'text-on-dark-soft hover:bg-white/5 hover:text-on-dark' : 'text-muted hover:bg-surface-soft hover:text-ink'}`}
    >
      {copied ? (
        <Check size={13} aria-hidden="true" />
      ) : (
        <Copy size={13} aria-hidden="true" />
      )}
      <span aria-live="polite">{copied ? '已复制' : label}</span>
    </button>
  );
}

export function CodeBlock({
  children,
  language = 'text',
  title,
}: {
  children: string;
  language?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-white/10 bg-surface-dark text-on-dark">
      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-white/10 px-4">
        <span className="inline-flex min-w-0 items-center gap-2 font-mono text-[11px] text-on-dark-soft">
          <Terminal size={13} aria-hidden="true" />
          <span className="truncate">{title || language}</span>
        </span>
        <CopyButton value={children} label="复制代码" dark />
      </div>
      <pre
        tabIndex={0}
        aria-label={`${language} 代码示例`}
        className="overflow-x-auto p-4 font-mono text-[12px] leading-7 sm:p-5"
      >
        <code>{children}</code>
      </pre>
    </div>
  );
}
