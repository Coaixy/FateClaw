'use client';

import type {
  ChangeEvent,
  ClipboardEvent,
  KeyboardEvent,
  RefObject,
} from 'react';
import { ClipboardPaste, Send, Square, X } from 'lucide-react';

interface PasteChoicePanelProps {
  preview?: string;
  onUsePasteAsBoard: () => void;
  onKeepPasteAsMessage: () => void;
  onDismissPasteChoice: () => void;
}

export function AiChatComposer({
  inputRef,
  input,
  sending,
  disabled,
  disabledMessage,
  selectedSession,
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
  disabled?: boolean;
  disabledMessage?: string;
  selectedSession: string;
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
  const composerDisabled = sending || Boolean(disabled);
  const actionDisabled = sending ? false : !input.trim() || Boolean(disabled);
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
        <div className="mb-1.5 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-[11px] text-warning">
          {disabledMessage}
        </div>
      )}

      <div
        className={`flex items-end gap-0 rounded-xl border bg-surface-card transition-all duration-200 touch-manipulation ${
          sending
            ? 'border-primary/40 shadow-lg shadow-primary/5'
            : 'border-hairline focus-within:shadow-lg focus-within:shadow-primary/10'
        }`}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={onInputChange}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          placeholder={
            disabled
              ? '此对话无法继续追问'
              : sending
                ? '思考中...'
                : selectedSession
                  ? '输入消息...'
                  : '有什么想问的？'
          }
          disabled={composerDisabled}
          rows={1}
          className="min-h-12 flex-1 resize-none bg-transparent px-3 py-3 text-[14px] lg:text-[12px] leading-6 placeholder:text-muted/60 focus:outline-none disabled:opacity-50 max-h-24 overflow-y-auto"
          onInput={(event) => {
            const target = event.target as HTMLTextAreaElement;
            target.style.height = 'auto';
            target.style.height = `${Math.min(target.scrollHeight, 96)}px`;
          }}
        />
        <button
          type="button"
          onClick={sending ? onStop : onSend}
          disabled={actionDisabled}
          className={`shrink-0 w-10 h-10 m-1 rounded-lg flex items-center justify-center transition-all duration-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-20 bg-primary text-on-primary hover:bg-primary-active active:scale-90 ${
            sending ? 'scale-110' : 'hover:scale-105'
          }`}
          aria-label={sending ? '停止' : '发送'}
        >
          {sending ? (
            <Square size={13} className="fill-current" />
          ) : (
            <Send size={14} />
          )}
        </button>
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
  return (
    <div className="mb-1.5 rounded-lg border border-primary/20 bg-primary/8 px-2.5 py-2 text-[11px] text-ink">
      <div className="flex items-start gap-2">
        <ClipboardPaste size={13} className="mt-0.5 shrink-0 text-primary" />
        <p className="min-w-0 flex-1 truncate text-muted">{preview}</p>
        <button
          type="button"
          onClick={onDismissPasteChoice}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink"
          aria-label="关闭粘贴选项"
        >
          <X size={12} />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap justify-end gap-1.5">
        <button
          type="button"
          onClick={onKeepPasteAsMessage}
          className="h-9 rounded-md border border-hairline bg-surface-card px-2.5 text-[11px] text-muted transition-colors hover:border-primary/30 hover:text-ink"
        >
          作为消息
        </button>
        <button
          type="button"
          onClick={onUsePasteAsBoard}
          className="h-9 rounded-md bg-primary px-2.5 text-[11px] font-medium text-on-primary transition-colors hover:bg-primary-active"
        >
          作为盘面
        </button>
      </div>
    </div>
  );
}
