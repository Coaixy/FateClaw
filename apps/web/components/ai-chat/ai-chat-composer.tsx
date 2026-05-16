'use client';

import type {
  ChangeEvent,
  ClipboardEvent,
  ComponentType,
  KeyboardEvent,
  RefObject,
} from 'react';
import { ClipboardPaste, Send, X } from 'lucide-react';

export type SlashCommand = {
  name: string;
  description: string;
  icon: ComponentType<{ size?: number; className?: string }>;
};

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
  chatAvailable,
  selectedSession,
  selectedBoardLabel,
  pasteChoiceOpen,
  pasteChoicePreview,
  showCommands,
  filteredCommands,
  selectedCommandIndex,
  onInputChange,
  onPaste,
  onKeyDown,
  onOpenPastedBoard,
  onClearSelectedBoard,
  onHideCommands,
  onHighlightCommand,
  onSelectCommand,
  onUsePasteAsBoard,
  onKeepPasteAsMessage,
  onDismissPasteChoice,
  onSend,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
  sending: boolean;
  chatAvailable: boolean;
  selectedSession: string;
  selectedBoardLabel?: string | null;
  pasteChoiceOpen: boolean;
  pasteChoicePreview?: string;
  showCommands: boolean;
  filteredCommands: readonly SlashCommand[];
  selectedCommandIndex: number;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onOpenPastedBoard: () => void;
  onClearSelectedBoard: () => void;
  onHideCommands: () => void;
  onHighlightCommand: (index: number) => void;
  onSelectCommand: (commandName: string) => void;
  onUsePasteAsBoard: () => void;
  onKeepPasteAsMessage: () => void;
  onDismissPasteChoice: () => void;
  onSend: () => void;
}) {
  return (
    <div className="relative">
      {showCommands && filteredCommands.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-1.5 rounded-lg border border-hairline bg-surface-card shadow-xl overflow-hidden z-10 animate-scale-in">
          <div className="px-2.5 py-1.5 text-[9px] text-muted border-b border-hairline font-medium tracking-wide uppercase">
            指令
          </div>
          {filteredCommands.map((command, index) => {
            const Icon = command.icon;

            return (
              <button
                key={command.name}
                className={`w-full flex items-center gap-2 px-2.5 py-2.5 text-left text-[12px] transition-colors cursor-pointer min-h-[44px] ${
                  index === selectedCommandIndex
                    ? 'bg-primary/10'
                    : 'hover:bg-surface-cream-strong'
                }`}
                onMouseEnter={() => onHighlightCommand(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelectCommand(command.name);
                }}
              >
                <div
                  className={`w-6 h-6 rounded-md flex items-center justify-center ${
                    index === selectedCommandIndex
                      ? 'bg-primary/20 text-primary'
                      : 'bg-surface-cream-strong text-muted'
                  }`}
                >
                  <Icon size={13} />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-ink">/{command.name}</span>
                  <span className="text-muted text-[11px] ml-1.5">
                    {command.description}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {pasteChoiceOpen && (
        <PasteChoicePanel
          preview={pasteChoicePreview}
          onUsePasteAsBoard={onUsePasteAsBoard}
          onKeepPasteAsMessage={onKeepPasteAsMessage}
          onDismissPasteChoice={onDismissPasteChoice}
        />
      )}

      {selectedBoardLabel && (
        <div className="mb-1.5 flex items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/8 px-2.5 py-1.5 text-[11px] text-ink">
          <span className="min-w-0 flex-1 truncate">
            当前将围绕这张盘提问：{selectedBoardLabel}
          </span>
          <button
            type="button"
            onClick={onClearSelectedBoard}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink"
            aria-label="清除选中的盘面"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div
        className={`flex items-end gap-0 rounded-xl border bg-surface-card transition-all duration-200 touch-manipulation ${
          sending
            ? 'border-primary/40 shadow-lg shadow-primary/5'
            : 'border-hairline focus-within:border-primary focus-within:shadow-lg focus-within:shadow-primary/10'
        }`}
      >
        <button
          type="button"
          onClick={onOpenPastedBoard}
          disabled={sending || !chatAvailable}
          className="mb-1 ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted transition-all duration-200 hover:bg-surface-cream-strong hover:text-ink active:scale-90 disabled:cursor-not-allowed disabled:opacity-20"
          aria-label="自贴盘面"
        >
          <ClipboardPaste size={14} />
        </button>
        <textarea
          ref={inputRef}
          value={input}
          onChange={onInputChange}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(onHideCommands, 150)}
          placeholder={sending ? '思考中...' : selectedSession ? '输入消息...' : '有什么想问的？'}
          disabled={sending || !chatAvailable}
          rows={1}
          className="flex-1 resize-none bg-transparent px-3 py-2 text-[14px] lg:text-[12px] leading-6 placeholder:text-muted/60 focus:outline-none disabled:opacity-50 max-h-24 overflow-y-auto"
          onInput={(event) => {
            const target = event.target as HTMLTextAreaElement;
            target.style.height = 'auto';
            target.style.height = `${Math.min(target.scrollHeight, 96)}px`;
          }}
        />
        <button
          onClick={onSend}
          disabled={!input.trim() || sending || !chatAvailable}
          className={`shrink-0 w-10 h-10 m-1 rounded-lg flex items-center justify-center transition-all duration-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-20 bg-primary text-on-primary hover:bg-primary-active active:scale-90 ${
            sending ? 'scale-110' : 'hover:scale-105'
          }`}
          aria-label={sending ? '停止' : '发送'}
        >
          <Send size={14} />
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
        <ClipboardPaste
          size={13}
          className="mt-0.5 shrink-0 text-primary"
        />
        <p className="min-w-0 flex-1 truncate text-muted">
          {preview}
        </p>
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
