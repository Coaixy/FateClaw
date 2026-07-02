'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ConfirmContext, ConfirmOptions } from '@/lib/use-confirm';

interface DialogState extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setDialog({ ...options, resolve });
    });
  }, []);

  const handleClose = useCallback(
    (result: boolean) => {
      dialog?.resolve(result);
      setDialog(null);
    },
    [dialog],
  );

  useEffect(() => {
    if (!dialog) return;
    // Focus the cancel button on open (safer default)
    cancelRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose(false);
      }
      // Trap focus between cancel and confirm
      if (e.key === 'Tab') {
        const els = [cancelRef.current, confirmRef.current].filter(Boolean) as HTMLElement[];
        if (els.length < 2) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [dialog, handleClose]);

  const isDanger = dialog?.variant === 'danger';

  return (
    <ConfirmContext value={{ confirm }}>
      {children}
      {dialog && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          aria-describedby="confirm-message"
        >
          {/* Overlay */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-dialog-overlay"
            onClick={() => handleClose(false)}
          />

          {/* Content */}
          <div className="relative w-full max-w-[360px] bg-surface-raised border border-hairline rounded-2xl p-6 shadow-2xl animate-dialog-content">
            {isDanger && (
              <div className="w-10 h-10 rounded-full bg-error/10 flex items-center justify-center mb-4">
                <AlertTriangle size={20} className="text-error" />
              </div>
            )}

            <h3 id="confirm-title" className="text-[15px] font-semibold mb-1.5">
              {dialog.title}
            </h3>
            <p id="confirm-message" className="text-[13px] text-muted leading-relaxed mb-6 whitespace-pre-line">
              {dialog.message}
            </p>

            <div className="flex items-center justify-end gap-2.5">
              <button
                ref={cancelRef}
                onClick={() => handleClose(false)}
                className="h-9 px-4 rounded-lg text-[13px] font-medium text-muted hover:text-ink hover:bg-surface-soft transition-colors cursor-pointer"
              >
                {dialog.cancelLabel || '取消'}
              </button>
              <button
                ref={confirmRef}
                onClick={() => handleClose(true)}
                className={`h-9 px-4 rounded-lg text-[13px] font-medium transition-all cursor-pointer active:scale-[0.97] ${
                  isDanger
                    ? 'bg-error text-on-primary hover:opacity-90'
                    : 'bg-ink text-canvas hover:opacity-90'
                }`}
              >
                {dialog.confirmLabel || '确认'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext>
  );
}
