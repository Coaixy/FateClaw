'use client';

import { lazy, Suspense, useState } from 'react';
import { Check, ChevronDown, Copy, EyeOff } from 'lucide-react';

import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';
import {
  buildClientDeliveryText,
  type GuashiScript,
  type GuashiScriptSection,
} from '@/features/chat/utils/guashi-script';

// 复用通用 Markdown 渲染器渲染每节正文;懒加载与 CollapsibleMessage 保持一致。
const MarkdownContent = lazy(() =>
  import('@/components/chat/markdown-content').then((module) => ({
    default: module.MarkdownContent,
  })),
);

/** 单个话术稿章节卡片:点击标题折叠/展开;分寸提示节用虚线 + 徽标标识为「仅卦师可见」。 */
function SectionCard({ section }: { section: GuashiScriptSection }) {
  const { t } = useI18n();
  // 默认展开:卦师需要快速通读全文念给客户。
  const [open, setOpen] = useState(true);

  return (
    <div
      className={`min-w-0 overflow-hidden rounded-lg border ${
        section.guashiOnly
          ? 'border-dashed border-hairline bg-canvas/30'
          : 'border-hairline bg-canvas/40'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 px-3 py-2.5 text-left sm:flex sm:items-center sm:gap-2 sm:py-2"
      >
        <ChevronDown
          size={14}
          className={`mt-0.5 shrink-0 text-muted transition-transform sm:mt-0 ${open ? '' : '-rotate-90'}`}
        />
        <span className="min-w-0 break-words text-[13px] font-semibold leading-snug sm:flex-1">
          {section.title}
        </span>
        {section.guashiOnly ? (
          <span className="col-start-2 inline-flex w-fit max-w-full items-center gap-1 rounded bg-canvas/60 px-1.5 py-0.5 text-[10px] font-medium text-muted sm:ml-auto sm:shrink-0">
            <EyeOff size={10} />
            {t('aiChat.messageList.guashiScript.guashiOnlyBadge')}
          </span>
        ) : null}
      </button>
      {open && section.body ? (
        <div className="min-w-0 break-words px-3 pb-3 text-[13px] leading-7">
          <Suspense
            fallback={
              <p className="whitespace-pre-wrap break-words">{section.body}</p>
            }
          >
            <MarkdownContent content={section.body} isBot />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 话术稿分节卡片。
 *
 * 把解析后的话术稿渲染成顶部操作条 + 逐节可折叠卡片。顶部「复制给客户」按钮会调用
 * buildClientDeliveryText 生成剔除分寸提示节的纯文本并写入剪贴板,卦师可直接粘贴发给客户。
 */
export function GuashiScriptCard({ script }: { script: GuashiScript }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildClientDeliveryText(script));
      setCopied(true);
      toast('success', t('aiChat.messageList.guashiScript.copied'));
      // 2 秒后复位按钮状态,给一次性的「已复制」视觉反馈。
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('error', t('aiChat.messageList.guashiScript.copyFailed'));
    }
  };

  return (
    <div className="min-w-0 flex flex-col gap-2">
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-[11px] font-medium text-muted">
          {t('aiChat.messageList.guashiScript.label')}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex h-8 w-full shrink-0 items-center justify-center gap-1.5 rounded-lg border border-primary/25 bg-primary/10 px-2.5 text-[12px] font-medium text-primary transition-colors hover:bg-primary/15 sm:h-7 sm:w-auto"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied
            ? t('aiChat.messageList.guashiScript.copied')
            : t('aiChat.messageList.guashiScript.copyForClient')}
        </button>
      </div>
      {script.preamble ? (
        <div className="min-w-0 break-words text-[13px] leading-7">
          <Suspense
            fallback={
              <p className="whitespace-pre-wrap break-words">
                {script.preamble}
              </p>
            }
          >
            <MarkdownContent content={script.preamble} isBot />
          </Suspense>
        </div>
      ) : null}
      {script.sections.map((section, index) => (
        <SectionCard key={index} section={section} />
      ))}
    </div>
  );
}
