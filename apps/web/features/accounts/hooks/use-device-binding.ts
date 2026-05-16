'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { accountsApi } from '@/features/accounts/api';

export type BindStep = 'idle' | 'loading' | 'scanning' | 'scanned' | 'done' | 'error';

const MAX_BIND_POLL_ATTEMPTS = 80;
const BIND_POLL_INTERVAL = 1500;

export function useDeviceBinding(onBound: () => Promise<unknown>) {
  const [bindStep, setBindStep] = useState<BindStep>('idle');
  const [qrUrl, setQrUrl] = useState('');
  const [bindError, setBindError] = useState('');
  const pollingRef = useRef(false);

  const stop = useCallback(() => {
    pollingRef.current = false;
    setBindStep('idle');
  }, []);

  const pollStatus = useCallback(
    async (qr: string) => {
      let attempts = 0;
      while (pollingRef.current && attempts < MAX_BIND_POLL_ATTEMPTS) {
        attempts += 1;
        try {
          const res = await accountsApi.pollQrStatus(qr);
          if (!pollingRef.current) break;
          if (res.status === 'scaned') {
            setBindStep('scanned');
          } else if (res.status === 'confirmed') {
            setBindStep('done');
            pollingRef.current = false;
            await onBound();
            setTimeout(() => setBindStep('idle'), 1500);
            return;
          } else if (res.status === 'expired') {
            setBindError('二维码已过期，请重试');
            setBindStep('error');
            pollingRef.current = false;
            return;
          }
        } catch {
          // 扫码状态短暂失败不打断轮询，下一轮会继续确认。
        }
        await new Promise((resolve) => setTimeout(resolve, BIND_POLL_INTERVAL));
      }

      if (pollingRef.current) {
        pollingRef.current = false;
        setBindError('扫码超时，请重新获取二维码');
        setBindStep('error');
      }
    },
    [onBound],
  );

  const start = useCallback(async () => {
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
  }, [pollStatus]);

  useEffect(() => {
    return () => {
      pollingRef.current = false;
    };
  }, []);

  return { bindStep, qrUrl, bindError, showModal: bindStep !== 'idle', start, stop };
}
