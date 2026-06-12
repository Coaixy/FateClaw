'use client';

import { CheckCircle2, Loader2, QrCode, XCircle } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

import { BottomSheet } from '@/components/ui/bottom-sheet';
import { useI18n } from '@/lib/i18n';

type BindStep = 'idle' | 'loading' | 'scanning' | 'scanned' | 'done' | 'error';

export function DeviceBindSheet({
  open,
  bindStep,
  qrUrl,
  bindError,
  onClose,
  onRetry,
}: {
  open: boolean;
  bindStep: BindStep;
  qrUrl: string;
  bindError: string;
  onClose: () => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();

  if (!open) return null;

  return (
    <BottomSheet
      open
      onClose={onClose}
      variant="sheet"
      size="sm"
      title={
        <span className="inline-flex items-center gap-2">
          <QrCode size={16} className="text-primary" />
          {t('pages.devices.sheetTitle')}
        </span>
      }
    >
      <div className="px-6 pt-4 pb-8 flex flex-col items-center text-center">
        <p className="text-[13px] text-muted mb-6 font-medium">
          {t('pages.devices.sheetDescription')}
        </p>

        {bindStep === 'loading' && (
          <div className="flex flex-col items-center justify-center h-[240px] w-full rounded-2xl bg-canvas/50 border border-hairline/50 border-dashed">
            <Loader2 size={32} className="animate-spin text-primary" />
            <p className="text-[13px] font-medium text-muted mt-4">
              {t('pages.devices.initializing')}
            </p>
          </div>
        )}

        {(bindStep === 'scanning' || bindStep === 'scanned') && (
          <div className="flex flex-col items-center">
            <div className="relative group">
              <div className="absolute inset-0 bg-primary/20 blur-2xl group-hover:bg-primary/30 transition-colors duration-500 rounded-[32px]" />
              <div className="relative bg-white p-4 rounded-3xl border border-white/20 shadow-xl overflow-hidden">
                <QRCodeSVG value={qrUrl} size={200} level="M" />
                {bindStep === 'scanned' && (
                  <div className="absolute inset-0 bg-white/80 backdrop-blur-sm flex flex-col items-center justify-center animate-fade-in">
                    <CheckCircle2
                      size={48}
                      className="text-success mb-3 drop-shadow-sm"
                    />
                    <p className="text-[15px] font-bold text-black tracking-tight">
                      {t('pages.devices.scanned')}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {bindStep === 'scanning' && (
              <div className="flex items-center gap-2 mt-6 px-4 py-2 rounded-full bg-canvas border border-hairline">
                <div className="w-2 h-2 rounded-full bg-primary animate-ping" />
                <span className="text-[12px] font-bold text-primary uppercase tracking-wider">
                  {t('pages.devices.waitingScan')}
                </span>
              </div>
            )}
          </div>
        )}

        {bindStep === 'done' && (
          <div className="flex flex-col items-center justify-center h-[240px] w-full">
            <div className="w-20 h-20 rounded-full bg-success/10 flex items-center justify-center mb-4 relative">
              <div className="absolute inset-0 rounded-full bg-success/20 animate-ping" />
              <CheckCircle2 size={40} className="text-success relative z-10" />
            </div>
            <p className="text-[18px] font-bold tracking-tight">
              {t('pages.devices.authSuccess')}
            </p>
            <p className="text-[13px] text-muted mt-2">
              {t('pages.devices.syncing')}
            </p>
          </div>
        )}

        {bindStep === 'error' && (
          <div className="flex flex-col items-center justify-center h-[240px] w-full rounded-2xl bg-red-500/5 border border-red-500/20">
            <XCircle size={32} className="text-red-500 mb-4" />
            <p className="text-[14px] font-bold text-red-500 mb-1">
              {t('pages.devices.connectionInterrupted')}
            </p>
            <p className="text-[12px] text-muted mb-5 max-w-[200px]">
              {bindError}
            </p>
            <button
              onClick={onRetry}
              className="h-9 px-6 rounded-xl bg-red-500 text-white text-[13px] font-bold hover:bg-red-600 transition-colors shadow-sm cursor-pointer"
            >
              {t('pages.devices.retryQr')}
            </button>
          </div>
        )}
      </div>
    </BottomSheet>
  );
}
