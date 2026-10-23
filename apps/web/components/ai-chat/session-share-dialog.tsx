'use client';

import { useEffect, useReducer, useState } from 'react';
import { Copy, Download, Loader2, RotateCcw, Share2 } from 'lucide-react';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import {
  chatSessionsApi,
  type ChatSessionShareResponse,
} from '@/features/chat/api';
import {
  getShareQuestion,
  renderSharePoster,
} from '@/features/chat/share-poster';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/http/client';
import { useToast } from '@/lib/use-toast';

type ShareState = {
  url: string;
  poster: { src: string; blob: Blob } | null;
  error: string;
};

export function SessionShareDialog({
  sessionId,
  createShare,
  onClose,
}: {
  sessionId: string;
  createShare: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<ChatSessionShareResponse>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [attempt, retry] = useReducer((value: number) => value + 1, 0);
  const [state, setState] = useState<ShareState>({
    url: '',
    poster: null,
    error: '',
  });
  const [saving, setSaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let posterUrl: string | undefined;
    setState({ url: '', poster: null, error: '' });
    async function generate() {
      try {
        const shared = await createShare(sessionId, controller.signal);
        if (controller.signal.aborted) return;
        const url = new URL(shared.share_url_path, window.location.origin).href;
        setState({ url, poster: null, error: '' });
        const session = await chatSessionsApi.shared(shared.share_token, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const blob = await renderSharePoster({
          question: getShareQuestion(session),
          url,
          copy: {
            appName: t('common.appName'),
            nature: t('sharePoster.nature'),
            systems: t('sharePoster.systems'),
            questionLabel: t('sharePoster.questionLabel'),
            scanTitle: t('sharePoster.scanTitle'),
            scanHint: t('sharePoster.scanHint'),
          },
        });
        if (controller.signal.aborted) return;
        posterUrl = URL.createObjectURL(blob);
        setState({ url, poster: { src: posterUrl, blob }, error: '' });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((previous) => ({
          ...previous,
          error:
            error instanceof ApiError
              ? error.message
              : t('sharePoster.generateFailed'),
        }));
      }
    }
    void generate();
    return () => {
      controller.abort();
      if (posterUrl) URL.revokeObjectURL(posterUrl);
    };
  }, [sessionId, createShare, t, attempt]);

  async function saveImage() {
    if (!state.poster || saving) return;
    setSaving(true);
    try {
      const file = new File([state.poster.blob], `${t('common.appName')}.png`, {
        type: 'image/png',
      });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else {
        const link = document.createElement('a');
        link.href = state.poster.src;
        link.download = file.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        toast('error', t('sharePoster.saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  }

  async function copyLink() {
    if (!state.url || copying) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(state.url);
      toast('success', t('sidebar.shareCopied'));
    } catch {
      setManualCopy(true);
      toast('error', t('sharePoster.copyFailed'));
    } finally {
      setCopying(false);
    }
  }

  return (
    <BottomSheet
      open
      onClose={onClose}
      size="sm"
      zIndex={140}
      title={
        <span className="flex items-center gap-2">
          <Share2 size={16} />
          {t('sharePoster.title')}
        </span>
      }
      aria-label={t('sharePoster.title')}
      footer={
        <div className="grid grid-cols-2 gap-3 px-4 py-4 sm:px-5">
          <Button
            onClick={() => void saveImage()}
            disabled={!state.poster}
            loading={saving}
            icon={<Download size={16} />}
          >
            {t('sharePoster.saveImage')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void copyLink()}
            disabled={!state.url}
            loading={copying}
            icon={<Copy size={16} />}
          >
            {t('sharePoster.copyLink')}
          </Button>
        </div>
      }
    >
      <div className="bg-surface-soft px-5 py-5">
        {state.poster ? (
          <>
            {/* The preview and download use the same PNG; mobile browsers can save it by long press. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={state.poster.src}
              width={1080}
              height={1440}
              alt={t('sharePoster.imageAlt')}
              className="mx-auto block h-auto w-full max-w-[min(100%,calc((100dvh-240px)*0.75))] rounded-sm shadow-lg"
            />
            <p className="mt-3 text-center text-xs text-muted sm:hidden">
              {t('sharePoster.longPress')}
            </p>
          </>
        ) : state.error ? (
          <div
            className="flex min-h-64 flex-col items-center justify-center gap-3 px-2 text-center"
            role="alert"
          >
            <p className="break-words text-sm text-ink">{state.error}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={retry}
              icon={<RotateCcw size={14} />}
            >
              {t('sharePoster.retry')}
            </Button>
          </div>
        ) : (
          <div
            className="flex min-h-64 flex-col items-center justify-center gap-3 text-sm text-muted"
            role="status"
          >
            <Loader2 size={22} className="animate-spin text-primary" />
            {t('sharePoster.generating')}
          </div>
        )}
        {state.url && (state.error || manualCopy) ? (
          <input
            aria-label={t('sharePoster.copyLink')}
            readOnly
            value={state.url}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-3 w-full rounded-lg border border-hairline bg-canvas p-2 text-xs text-muted"
          />
        ) : null}
      </div>
    </BottomSheet>
  );
}
