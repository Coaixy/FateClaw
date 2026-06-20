'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, ScrollText, X } from 'lucide-react';

import { useI18n } from '@/lib/i18n';

interface InterpretationScriptPanelProps {
  open: boolean;
  /** AI 汇总出的解读稿初始文本。 */
  script: string;
  onClose: () => void;
}

/**
 * 「整理为解读稿」可编辑面板。
 *
 * 展示 AI 把整段断卦汇总出的解读稿，卦师可就地润色后复制带走。
 * 定位为复盘素材而非直发客户的成品（见产品约束：AI 输出必经人工润色）。
 *
 * @param open 是否展示面板。
 * @param script 汇总稿初始文本；每次打开或拿到新稿时重置可编辑草稿。
 * @param onClose 关闭回调。
 */
export function InterpretationScriptPanel({
  open,
  script,
  onClose,
}: InterpretationScriptPanelProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(script);
  const [copied, setCopied] = useState(false);

  // 每次打开或拿到新稿时，用最新汇总稿重置可编辑草稿。
  useEffect(() => {
    if (open) {
      setDraft(script);
      setCopied(false);
    }
  }, [open, script]);

  if (!open) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 复制失败时静默，用户仍可手动选中文本。
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85dvh] w-full max-w-2xl flex-col rounded-2xl border border-hairline bg-surface-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-3.5">
          <div className="flex items-center gap-2">
            <ScrollText size={16} className="text-primary" />
            <h2 className="text-[14px] font-semibold text-ink">
              {t('aiChat.compileScript.title')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-md p-1 text-muted transition-colors hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <p className="mb-3 rounded-lg bg-amber-400/10 px-3 py-2 text-[12px] leading-5 text-amber-600">
            {t('aiChat.compileScript.hint')}
          </p>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-[40dvh] w-full resize-y rounded-xl border border-hairline bg-canvas/60 p-3.5 text-[13px] leading-relaxed text-ink focus:border-primary/45 focus:outline-none"
          />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-full border border-hairline px-4 text-[13px] text-muted transition-colors hover:text-ink"
          >
            {t('common.close')}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied
              ? t('aiChat.compileScript.copied')
              : t('aiChat.compileScript.copy')}
          </button>
        </div>
      </div>
    </div>
  );
}
