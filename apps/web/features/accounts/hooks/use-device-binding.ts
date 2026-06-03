'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { accountsApi } from '@/features/accounts/api';

export type BindStep =
  | 'idle'
  | 'loading'
  | 'scanning'
  | 'scanned'
  | 'done'
  | 'error';

const MAX_BIND_POLL_ATTEMPTS = 80;
const BIND_POLL_INTERVAL = 1500;
const MAX_BIND_POLL_ERRORS = 3;
const DONE_CLOSE_DELAY = 1600;

function normalizeBindStatus(status: string) {
  return status === 'scanned' ? 'scaned' : status;
}

export function useDeviceBinding(onBound: () => Promise<unknown>) {
  const [bindStep, setBindStep] = useState<BindStep>('idle');
  const [qrUrl, setQrUrl] = useState('');
  const [bindError, setBindError] = useState('');
  const pollingRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (!closeTimerRef.current) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const closeLater = useCallback(
    (delay: number) => {
      clearCloseTimer();
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null;
        setBindStep('idle');
      }, delay);
    },
    [clearCloseTimer],
  );

  const stop = useCallback(() => {
    clearCloseTimer();
    pollingRef.current = false;
    setBindStep('idle');
  }, [clearCloseTimer]);

  const pollStatus = useCallback(
    async (qr: string) => {
      let attempts = 0;
      let errors = 0;
      while (pollingRef.current && attempts < MAX_BIND_POLL_ATTEMPTS) {
        attempts += 1;
        try {
          const res = await accountsApi.pollQrStatus(qr);
          if (!pollingRef.current) break;
          errors = 0;
          const status = normalizeBindStatus(res.status);
          if (status === 'scaned') {
            setBindStep('scanned');
          } else if (status === 'confirmed') {
            setBindStep('done');
            pollingRef.current = false;
            closeLater(DONE_CLOSE_DELAY);
            void onBound().catch(() => undefined);
            return;
          } else if (status === 'expired') {
            setBindError('二维码已过期，请重试');
            setBindStep('error');
            pollingRef.current = false;
            return;
          }
        } catch (err) {
          errors += 1;
          if (errors >= MAX_BIND_POLL_ERRORS) {
            setBindError(
              err instanceof Error ? err.message : '扫码状态确认失败，请重试',
            );
            setBindStep('error');
            pollingRef.current = false;
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, BIND_POLL_INTERVAL));
      }

      if (pollingRef.current) {
        pollingRef.current = false;
        setBindError('扫码超时，请重新获取二维码');
        setBindStep('error');
      }
    },
    [closeLater, onBound],
  );

  const start = useCallback(async () => {
    clearCloseTimer();
    setBindStep('loading');
    setBindError('');
    try {
      const res = await accountsApi.getQrCode();
      setQrUrl(res.qrcode_url);
      setBindStep('scanning');
      pollingRef.current = true;
      void pollStatus(res.qrcode);
    } catch (err) {
      setBindError(err instanceof Error ? err.message : '获取二维码失败');
      setBindStep('error');
    }
  }, [clearCloseTimer, pollStatus]);

  useEffect(() => {
    return () => {
      clearCloseTimer();
      pollingRef.current = false;
    };
  }, [clearCloseTimer]);

  return {
    bindStep,
    qrUrl,
    bindError,
    showModal: bindStep !== 'idle',
    start,
    stop,
  };
}
