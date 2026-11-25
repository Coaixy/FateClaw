'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Scan, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useI18n } from '../../lib/i18n';
import { ResponsiveArtifactFrame } from './responsive-artifact-frame';

export function ArtifactViewer({
  title,
  children,
  onClose,
  layoutAspectRatio,
  minContentWidth = 0,
  chartClassName,
  visualization = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  layoutAspectRatio?: number;
  minContentWidth?: number;
  chartClassName: string;
  visualization?: boolean;
}) {
  const { t } = useI18n();
  const labelKey = visualization ? 'visualization' : 'artifact';
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [zoom, setZoom] = useState<number | undefined>(undefined);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const handleKeyDown = (event: KeyboardEvent) => {
      // Portal chart events follow their React owner, so sheet isolation belongs to the native dialog.
      if (event.key === 'Escape' || event.key === 'Tab')
        event.stopPropagation();
    };
    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-label={t(`${labelKey}.viewTitle`, { title })}
      onClose={onClose}
      className="chat-content fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-hidden bg-canvas p-0 text-ink backdrop:bg-black/60"
    >
      <div className="flex h-full min-h-0 flex-col pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]">
        <header className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2 sm:px-5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {title}
            {zoom !== undefined && (
              <span className="ml-2 text-xs text-muted">
                {Math.round(zoom * 100)}%
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => setZoom(undefined)}
            aria-pressed={zoom === undefined}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted aria-pressed:bg-surface-soft aria-pressed:text-ink"
          >
            <Scan size={16} />
            {t(`${labelKey}.fit`)}
          </button>
          <button
            type="button"
            onClick={() =>
              setZoom((value) => Math.max(0.5, (value ?? 1) - 0.25))
            }
            disabled={zoom === 0.5}
            aria-label={t(`${labelKey}.zoomOut`)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg hover:bg-surface-soft disabled:opacity-35"
          >
            <ZoomOut size={18} />
          </button>
          <button
            type="button"
            onClick={() => setZoom((value) => Math.min(3, (value ?? 1) + 0.25))}
            disabled={zoom === 3}
            aria-label={t(`${labelKey}.zoomIn`)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg hover:bg-surface-soft disabled:opacity-35"
          >
            <ZoomIn size={18} />
          </button>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label={t(`${labelKey}.close`)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg hover:bg-surface-soft"
          >
            <X size={20} />
          </button>
        </header>
        <div
          data-artifact-viewport
          className="min-h-0 flex-1 overflow-auto overscroll-contain p-3 sm:p-5"
        >
          <div className={`mx-auto w-full ${chartClassName}`}>
            <ResponsiveArtifactFrame
              zoom={zoom}
              minContentWidth={zoom === undefined ? minContentWidth : 720}
              layoutAspectRatio={layoutAspectRatio}
            >
              {children}
            </ResponsiveArtifactFrame>
          </div>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
