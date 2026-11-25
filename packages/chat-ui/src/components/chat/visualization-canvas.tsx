'use client';

import { useEffect, useRef, useState } from 'react';
import type { VisualizationArtifact } from '@fateclaw/contracts/visualization';
import { useI18n } from '../../lib/i18n';
import { mountVisualization } from './visualization-runtime';

export default function VisualizationCanvas({
  artifact,
}: {
  artifact: VisualizationArtifact;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const { t } = useI18n();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let revision = 0;
    let cleanup: (() => void) | undefined;
    const render = () => {
      const current = ++revision;
      cleanup?.();
      cleanup = undefined;
      setStatus('loading');
      // Each async render owns a separate node so stale completion cannot erase a newer chart.
      const target = document.createElement('div');
      host.replaceChildren(target);
      const fail = () => {
        if (!disposed && revision === current) {
          target.replaceChildren();
          setStatus('error');
        }
      };
      void mountVisualization(target, artifact, fail)
        .then((release) => {
          if (disposed || revision !== current) {
            release();
            return;
          }
          cleanup = release;
          setStatus('ready');
        })
        .catch(fail);
    };
    render();
    const observer = new MutationObserver(render);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => {
      disposed = true;
      observer.disconnect();
      cleanup?.();
    };
  }, [artifact]);

  return (
    <div
      className="visualization-canvas w-full min-w-0"
      role="group"
      aria-label={`${artifact.title}。${artifact.summary}`}
      aria-busy={status === 'loading'}
    >
      {status !== 'ready' && (
        <p
          role="status"
          className={`px-4 py-8 text-center text-sm ${status === 'error' ? 'text-muted' : 'animate-pulse text-muted-soft'}`}
        >
          {t(
            status === 'error'
              ? 'visualization.failed'
              : 'visualization.loading',
          )}
        </p>
      )}
      <div
        ref={hostRef}
        className={status === 'error' ? 'hidden' : undefined}
      />
    </div>
  );
}
