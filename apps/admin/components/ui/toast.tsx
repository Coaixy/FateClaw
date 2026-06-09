'use client';

import { useState, useCallback, useRef } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Info } from 'lucide-react';
import { ToastContext, ToastItem, ToastType } from '@/lib/use-toast';

const MAX_VISIBLE = 3;

const icons: Record<ToastType, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const styles: Record<ToastType, string> = {
  success: 'bg-success text-on-primary',
  error: 'bg-error text-white',
  warning: 'bg-warning text-on-primary',
  info: 'bg-surface-card text-ink border border-primary/30',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 200);
  }, []);

  const toast = useCallback(
    (type: ToastType, message: string, duration = 2500) => {
      const id = ++idRef.current;
      setToasts((prev) => {
        const next = [...prev, { id, type, message }];
        return next.slice(-MAX_VISIBLE);
      });
      setTimeout(() => removeToast(id), duration);
    },
    [removeToast],
  );

  return (
    <ToastContext value={{ toast }}>
      {children}
      <div
        className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[100] flex flex-col-reverse items-center gap-2 pointer-events-none"
        role="alert"
        aria-live="assertive"
      >
        {toasts.map((t) => {
          const Icon = icons[t.type];
          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-center gap-2 px-4 py-2.5 rounded-xl text-[12px] font-medium shadow-lg backdrop-blur-sm whitespace-nowrap ${styles[t.type]} ${
                t.exiting ? 'animate-toast-exit' : 'animate-toast-enter'
              }`}
            >
              <Icon size={14} className="shrink-0" />
              {t.message}
            </div>
          );
        })}
      </div>
    </ToastContext>
  );
}
