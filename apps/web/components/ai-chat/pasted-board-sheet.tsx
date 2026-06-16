'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardPaste } from 'lucide-react';

import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import type { UserPastedBoardInput } from '@/features/chat/pasted-board-input';
import type { PaipanCatalogItem } from '@/features/paipan/api';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

interface PastedBoardSheetProps {
  open: boolean;
  initialContent: string;
  catalog: PaipanCatalogItem[];
  submitBlockedMessage?: string;
  onClose: () => void;
  onSubmit: (input: UserPastedBoardInput) => Promise<void> | void;
}

/**
 * 渲染自贴盘面输入弹层。
 *
 * @param props.open 是否打开弹层。
 * @param props.initialContent 初始盘面原文，通常来自输入框或粘贴内容。
 * @param props.catalog 可选术数目录，用于提供类型候选。
 * @param props.submitBlockedMessage 提交被业务权限拦截时展示的提示；为空时按表单校验和提交流程继续。
 * @param props.onClose 关闭弹层回调；提交中会被阻止，避免丢失正在发送的盘面。
 * @param props.onSubmit 通过基础校验后的提交回调。
 */
export function PastedBoardSheet({
  open,
  initialContent,
  catalog,
  submitBlockedMessage = '',
  onClose,
  onSubmit,
}: PastedBoardSheetProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const categoryOptions = useMemo(() => {
    return catalog.map((item) => item.name);
  }, [catalog]);

  const [category, setCategory] = useState(categoryOptions[0] ?? '');
  const [content, setContent] = useState(initialContent);
  const [submitting, setSubmitting] = useState(false);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      setSubmitting(false);
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setCategory(categoryOptions[0] ?? '');
    setContent(initialContent);
  }, [categoryOptions, initialContent, open]);

  const trimmedCategory = category.trim();
  const trimmedContent = content.trim();
  const busy = submitting;

  const handleSubmit = async () => {
    if (busy) return;
    if (submitBlockedMessage) {
      toast('error', submitBlockedMessage);
      return;
    }
    if (!trimmedCategory) {
      toast('error', t('aiChat.pastedBoard.missingCategory'));
      return;
    }
    if (!trimmedContent) {
      toast('error', t('aiChat.pastedBoard.missingContent'));
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        category: trimmedCategory,
        content: trimmedContent,
        question: t('aiChat.pastedBoard.defaultQuestion'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (busy) return;
    onClose();
  };

  const footer = (
    <div className="flex gap-2 px-3 py-2.5 sm:justify-end sm:px-6">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={busy}
        onClick={handleClose}
        className="h-9 flex-1 rounded-xl text-[12px] sm:flex-none sm:rounded-lg"
      >
        {t('common.cancel')}
      </Button>
      <Button
        type="button"
        size="sm"
        loading={busy}
        disabled={busy}
        icon={<ClipboardPaste size={14} />}
        onClick={() => void handleSubmit()}
        className="h-9 flex-1 rounded-xl text-[12px] sm:flex-none sm:rounded-lg"
      >
        {t('aiChat.pastedBoard.submit')}
      </Button>
    </div>
  );

  return (
    <BottomSheet
      open={open}
      onClose={handleClose}
      closeOnOverlay={!busy}
      variant="fullscreen-sheet"
      size="md"
      title={t('aiChat.pastedBoard.title')}
      footer={footer}
    >
      <div className="space-y-3.5 px-4 py-3.5 sm:space-y-4 sm:px-6 sm:py-5">
        <div>
          <label
            htmlFor="pasted-board-category"
            className="mb-1.5 block text-[12px] font-medium text-ink"
          >
            {t('aiChat.pastedBoard.categoryLabel')}
          </label>
          <input
            id="pasted-board-category"
            list={
              categoryOptions.length > 0
                ? 'pasted-board-category-suggestions'
                : undefined
            }
            value={category}
            onChange={(event) => setCategory(event.currentTarget.value)}
            disabled={busy}
            placeholder={t('aiChat.pastedBoard.categoryPlaceholder')}
            className="w-full rounded-2xl border border-hairline bg-surface-card px-3 py-2.5 text-[13px] text-ink focus:border-primary/40 focus:outline-none disabled:opacity-50"
          />
          {categoryOptions.length > 0 && (
            <datalist id="pasted-board-category-suggestions">
              {categoryOptions.map((option, index) => (
                <option key={`${option}-${index}`} value={option} />
              ))}
            </datalist>
          )}
          <p className="mt-1 text-[10px] leading-relaxed text-muted/80">
            {t('aiChat.pastedBoard.categoryHint')}
          </p>
        </div>

        <div>
          <label
            htmlFor="pasted-board-content"
            className="mb-1.5 block text-[12px] font-medium text-ink"
          >
            {t('aiChat.pastedBoard.contentLabel')}
          </label>
          <textarea
            id="pasted-board-content"
            value={content}
            onChange={(event) => setContent(event.currentTarget.value)}
            disabled={busy}
            rows={10}
            className="min-h-[180px] max-h-[38dvh] w-full resize-y rounded-2xl border border-hairline bg-surface-card px-3 py-2.5 text-[13px] leading-6 text-ink placeholder:text-muted/60 focus:border-primary/40 focus:outline-none disabled:opacity-50 sm:min-h-[220px] sm:max-h-none"
          />
        </div>
      </div>
    </BottomSheet>
  );
}
