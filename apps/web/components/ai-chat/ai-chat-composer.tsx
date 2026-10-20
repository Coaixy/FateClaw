'use client';

import type {
  ChangeEvent,
  ClipboardEvent,
  KeyboardEvent,
  RefObject,
  ReactNode,
} from 'react';
import { useLayoutEffect, useRef } from 'react';
import {
  ArrowUp,
  ClipboardPaste,
  Loader2,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';

const MAX_TEXTAREA_HEIGHT = 128;

interface ComposerKeyboardEvent {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

export function shouldSendOnEnter(
  event: ComposerKeyboardEvent,
  composing = false,
): boolean {
  return (
    event.key === 'Enter' &&
    !event.shiftKey &&
    !composing &&
    !event.isComposing &&
    !event.nativeEvent?.isComposing &&
    // Safari can end composition before dispatching the candidate-confirming Enter.
    event.keyCode !== 229 &&
    event.nativeEvent?.keyCode !== 229
  );
}

interface PasteChoicePanelProps {
  preview?: string;
  onUsePasteAsBoard: () => void;
  onKeepPasteAsMessage: () => void;
  onDismissPasteChoice: () => void;
}

interface ComposerPaipanAction {
  loading: boolean;
  disabled?: boolean;
  title: string;
  onOpen: () => void;
}

function syncTextareaHeight(
  textarea: HTMLTextAreaElement | null,
  value: string,
) {
  if (!textarea) {
    return;
  }

  if (!value) {
    textarea.style.height = '';
    return;
  }

  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
}

/**
 * AI 对话输入框，负责展示粘贴盘面选择、禁用提示、发送/停止按钮和 textarea 高度同步。
 *
 * @param props.inputRef 输入框 DOM 引用，用于父级聚焦和本组件同步高度。
 * @param props.input 当前输入内容。
 * @param props.sending 是否正在等待 AI 回复；为 true 时按钮切换为停止输出。
 * @param props.disabled 是否因业务规则禁用继续追问。
 * @param props.disabledMessage 禁用时展示在输入框上方的说明。
 * @param props.selectedSession 当前会话 ID，空值表示还未进入具体会话。
 * @param props.paipanAction 会话内排盘入口；未传入时不展示。
 * @param props.pasteChoiceOpen 是否展示粘贴内容处理选项。
 * @param props.pasteChoicePreview 粘贴内容预览。
 * @param props.onInputChange 输入内容变化回调。
 * @param props.onPaste 粘贴事件回调。
 * @param props.onKeyDown 键盘事件回调。
 * @param props.onUsePasteAsBoard 将粘贴内容作为盘面处理。
 * @param props.onKeepPasteAsMessage 将粘贴内容保留为普通消息。
 * @param props.onDismissPasteChoice 关闭粘贴处理选项。
 * @param props.onSend 发送当前输入。
 * @param props.onStop 停止当前 AI 输出。
 * @returns 可复用的 AI 聊天输入区域。
 */
export function AiChatComposer({
  inputRef,
  input,
  sending,
  stopping = false,
  disabled,
  disabledMessage,
  selectedSession,
  modelControl,
  sendDisabled,
  paipanAction,
  pasteChoiceOpen,
  pasteChoicePreview,
  onInputChange,
  onPaste,
  onKeyDown,
  onUsePasteAsBoard,
  onKeepPasteAsMessage,
  onDismissPasteChoice,
  onSend,
  onStop,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
  sending: boolean;
  stopping?: boolean;
  disabled?: boolean;
  disabledMessage?: string;
  selectedSession: string;
  modelControl?: ReactNode;
  sendDisabled?: boolean;
  paipanAction?: ComposerPaipanAction;
  pasteChoiceOpen: boolean;
  pasteChoicePreview?: string;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onUsePasteAsBoard: () => void;
  onKeepPasteAsMessage: () => void;
  onDismissPasteChoice: () => void;
  onSend: () => void;
  onStop: () => void;
}) {
  const { t } = useI18n();
  const composingRef = useRef(false);
  const composerDisabled = Boolean(disabled);
  const actionDisabled =
    stopping ||
    (!sending && (!input.trim() || Boolean(disabled) || Boolean(sendDisabled)));

  useLayoutEffect(() => {
    syncTextareaHeight(inputRef.current, input);
  }, [input, inputRef, selectedSession]);

  return (
    <div className="relative">
      {pasteChoiceOpen && (
        <PasteChoicePanel
          preview={pasteChoicePreview}
          onUsePasteAsBoard={onUsePasteAsBoard}
          onKeepPasteAsMessage={onKeepPasteAsMessage}
          onDismissPasteChoice={onDismissPasteChoice}
        />
      )}

      {disabledMessage && (
        <div className="mb-1.5 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-[12px] text-warning">
          {disabledMessage}
        </div>
      )}

      <div
        className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-x-1.5 rounded-[24px] border bg-surface-raised p-2 transition-all duration-200 touch-manipulation ${
          sending
            ? 'border-primary/40 shadow-sm'
            : 'border-hairline shadow-sm focus-within:border-primary/40 focus-within:shadow-md focus-within:shadow-primary/5'
        }`}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={onInputChange}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !shouldSendOnEnter(event, composingRef.current)
            ) {
              return;
            }
            onKeyDown(event);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          placeholder={
            disabled
              ? t('aiChat.composer.disabledPlaceholder')
              : selectedSession
                ? t('aiChat.composer.messagePlaceholder')
                : t('aiChat.composer.initialPlaceholder')
          }
          aria-label={
            sending
              ? t('aiChat.composer.nextDraftLabel')
              : t('aiChat.composer.inputLabel')
          }
          disabled={composerDisabled}
          rows={1}
          className="col-start-2 row-start-1 block min-h-7 max-h-32 w-full resize-none overflow-y-auto bg-transparent px-1 py-0.5 text-base leading-6 placeholder:text-muted/60 focus:outline-none! disabled:opacity-50"
        />
        {paipanAction && (
          <button
            type="button"
            onClick={paipanAction.onOpen}
            disabled={paipanAction.disabled || paipanAction.loading}
            title={paipanAction.title}
            aria-label={paipanAction.title}
            className="col-start-1 row-start-1 row-span-2 flex h-10 w-10 self-center shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/5 text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:text-muted disabled:opacity-50"
          >
            {paipanAction.loading ? (
              <Loader2 size={20} className="animate-spin" />
            ) : (
              <Sparkles size={20} />
            )}
          </button>
        )}
        {modelControl && (
          <div className="col-start-2 row-start-2 min-w-0">{modelControl}</div>
        )}
        <button
          type="button"
          onClick={sending ? onStop : onSend}
          disabled={actionDisabled}
          className="col-start-3 row-start-1 row-span-2 flex h-10 w-10 shrink-0 self-center cursor-pointer items-center justify-center rounded-full bg-primary text-on-primary transition-colors hover:bg-primary-active active:scale-95 disabled:cursor-not-allowed disabled:bg-primary/35"
          aria-label={
            stopping
              ? t('aiChat.composer.stopping')
              : sending
                ? t('aiChat.composer.stop')
                : t('aiChat.composer.send')
          }
          aria-busy={stopping || undefined}
        >
          {stopping ? (
            <Loader2 size={20} className="animate-spin" />
          ) : sending ? (
            <Square size={16} className="fill-current" />
          ) : (
            <ArrowUp size={24} />
          )}
        </button>
        <span role="status" className="sr-only">
          {stopping ? t('aiChat.composer.stopping') : ''}
        </span>
      </div>
    </div>
  );
}

function PasteChoicePanel({
  preview,
  onUsePasteAsBoard,
  onKeepPasteAsMessage,
  onDismissPasteChoice,
}: PasteChoicePanelProps) {
  const { t } = useI18n();

  return (
    <div className="mb-1.5 rounded-lg border border-primary/20 bg-primary/8 px-2.5 py-2 text-[12px] text-ink">
      <div className="flex items-start gap-2">
        <ClipboardPaste size={13} className="mt-0.5 shrink-0 text-primary" />
        <p className="min-w-0 flex-1 truncate text-muted">{preview}</p>
        <button
          type="button"
          onClick={onDismissPasteChoice}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink"
          aria-label={t('aiChat.composer.closePasteOptions')}
        >
          <X size={12} />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap justify-end gap-1.5">
        <button
          type="button"
          onClick={onKeepPasteAsMessage}
          className="h-9 rounded-md border border-hairline bg-surface-card px-2.5 text-[12px] text-muted transition-colors hover:border-primary/30 hover:text-ink"
        >
          {t('aiChat.composer.keepAsMessage')}
        </button>
        <button
          type="button"
          onClick={onUsePasteAsBoard}
          className="h-9 rounded-md bg-primary px-2.5 text-[12px] font-medium text-on-primary transition-colors hover:bg-primary-active"
        >
          {t('aiChat.composer.useAsBoard')}
        </button>
      </div>
    </div>
  );
}
