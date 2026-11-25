'use client';

import dynamic from 'next/dynamic';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Copy, Maximize2 } from 'lucide-react';

import type { SkillContextEntryDto as SkillContextEntry } from '@fateclaw/contracts/chat';
import { ChartErrorBoundary } from '../charts/chart-error-boundary';
import { Button } from '../ui/button';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/use-toast';
import { cn } from '../../utils/chart/cn';
import { ArtifactViewer } from './artifact-viewer';
import { ResponsiveArtifactFrame } from './responsive-artifact-frame';
import { parseVisualizationArtifact } from '@fateclaw/contracts/visualization';

const VisualizationCanvas = dynamic(() => import('./visualization-canvas'), {
  ssr: false,
});

const BaziChart = dynamic(() => import('../charts/bazi-chart'), {
  ssr: false,
});
const ZiWeiChart = dynamic(() => import('../charts/ziwei-chart'), {
  ssr: false,
});
const LiuyaoChart = dynamic(() => import('../charts/liuyao-chart'), {
  ssr: false,
});
const QimenChart = dynamic(() => import('../charts/qimen-chart'), {
  ssr: false,
});
const LiurenChart = dynamic(() => import('../charts/liuren-chart'), {
  ssr: false,
});
const MeihuaChart = dynamic(() => import('../charts/meihua-chart'), {
  ssr: false,
});
const JingzhanChart = dynamic(
  () => import('../charts/jingzhan-chart'),
  { ssr: false },
);

interface ArtifactRendererProps {
  entries: SkillContextEntry[];
  /** Deduct content above the chart only inside a bounded preview. */
  fitViewportHeight?: boolean;
}

const CHART_PRESENTATION: Partial<
  Record<
    SkillContextEntry['skill'],
    {
      shellClassName: string;
      layoutAspectRatio?: number;
      minContentWidth?: number;
    }
  >
> = {
  'qimen-paipan': {
    shellClassName: 'max-w-[35rem]',
    // Keep the star name and stem-state columns intact before fitting narrow screens.
    minContentWidth: 320,
  },
  'ziwei-paipan': {
    shellClassName: 'max-w-[44rem]',
    layoutAspectRatio: 2 / 3,
    // Each palace needs an 80px layout column before uniform scaling preserves its contents.
    minContentWidth: 320,
  },
  'jingzhan-paipan': { shellClassName: 'max-w-[36rem]' },
  'meihua-paipan': { shellClassName: 'max-w-[50rem]' },
  'liuren-paipan': { shellClassName: 'max-w-[44rem]' },
  'iching-paipan': { shellClassName: 'max-w-[52rem]' },
  'bazi-paipan': { shellClassName: 'max-w-[55rem]' },
};

function resolveChart(entry: SkillContextEntry) {
  if (entry.artifactType === 'visualization') {
    const artifact = parseVisualizationArtifact(entry.artifactData);
    return artifact ? <VisualizationCanvas artifact={artifact} /> : null;
  }
  const data = entry.artifactData as never;
  switch (entry.skill) {
    case 'bazi-paipan':
      return <BaziChart data={data} />;
    case 'ziwei-paipan':
      return <ZiWeiChart data={data} />;
    case 'iching-paipan':
      return <LiuyaoChart data={data} />;
    case 'jingzhan-paipan':
      return <JingzhanChart data={data} />;
    case 'meihua-paipan':
      return <MeihuaChart data={data} />;
    case 'qimen-paipan':
      return <QimenChart data={data} />;
    case 'liuren-paipan':
      return <LiurenChart data={data} />;
    default:
      return null;
  }
}

function ArtifactChartMount({
  host,
  active = true,
}: {
  host: HTMLDivElement | null;
  active?: boolean;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot || !host || !active) return;
    // Reparent the portal container, preserving the chart's React state and event ownership.
    slot.appendChild(host);
    return () => {
      if (host.parentNode === slot) slot.removeChild(host);
    };
  }, [active, host]);
  return <div ref={slotRef} className="w-full min-w-0" />;
}

function ArtifactBlock({
  entry,
  fitViewportHeight,
}: {
  entry: SkillContextEntry;
  fitViewportHeight: boolean;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [chartHost, setChartHost] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    setChartHost(document.createElement('div'));
  }, []);
  const chart = useMemo(() => resolveChart(entry), [entry]);
  if (!chart || entry.artifactData == null) return null;

  const visualization =
    entry.artifactType === 'visualization'
      ? parseVisualizationArtifact(entry.artifactData)
      : null;
  const title = visualization?.title ?? entry.artifactTitle ?? entry.skill;
  const { shellClassName, layoutAspectRatio, minContentWidth } =
    CHART_PRESENTATION[entry.skill] ?? { shellClassName: 'max-w-[55rem]' };

  // entry.output 是后端为盘面生成的 formatter 文本（已分小节、预标回头生克/进退神），
  // 给卦师一个「复制盘面文本」入口，方便拿去复盘或归档。导出内容即 formatter 正文原文。
  // entry.output 理论上是 formatter 文本字符串，但历史脏数据 / 被截断的 tool_context
  // 可能把它写成 null 或非字符串，render 期直接 .trim() 会抛 TypeError 触发整页报错，
  // 这里收紧为安全取值（非字符串按空文本处理，复制入口随之自然隐藏）。
  const exportText =
    visualization?.summary ??
    (typeof entry.output === 'string' ? entry.output.trim() : '');
  const handleCopyBoardText = async () => {
    if (!exportText) {
      toast('error', t('artifact.copyEmpty'));
      return;
    }
    try {
      await navigator.clipboard.writeText(exportText);
      toast('success', t('artifact.copied'));
    } catch {
      // 剪贴板 API 在非安全上下文或权限被拒时会抛错，统一兜底提示。
      toast('error', t('artifact.copyFailed'));
    }
  };

  return (
    <div
      className={
        entry.artifactType === 'visualization'
          ? 'my-4 rounded-xl border border-hairline bg-surface-soft/40 px-3 py-3 sm:px-4'
          : 'mt-1'
      }
    >
      {entry.artifactType === 'visualization' && (
        <div className="mb-3">
          <p className="text-sm font-medium text-ink">{title}</p>
          <p className="mt-1 whitespace-pre-wrap text-[13px] leading-6 text-muted">
            {exportText}
          </p>
        </div>
      )}
      <ChartErrorBoundary fallbackTitle={`${title} 渲染失败`}>
        <div className={cn('w-full min-w-0 mx-auto', shellClassName)}>
          {visualization ? (
            <ArtifactChartMount host={chartHost} active={!expanded} />
          ) : (
            <ResponsiveArtifactFrame
              fitViewportHeight={fitViewportHeight}
              minContentWidth={minContentWidth}
              layoutAspectRatio={layoutAspectRatio}
            >
              <ArtifactChartMount host={chartHost} active={!expanded} />
            </ResponsiveArtifactFrame>
          )}
        </div>
      </ChartErrorBoundary>
      <div
        className={cn('mx-auto mt-1.5 flex justify-end gap-1', shellClassName)}
      >
        <Button
          variant="ghost"
          size="sm"
          icon={<Maximize2 size={14} />}
          onClick={() => setExpanded(true)}
        >
          {t('artifact.expand')}
        </Button>
        {exportText ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<Copy size={14} />}
            onClick={() => void handleCopyBoardText()}
          >
            {t(
              entry.artifactType === 'visualization'
                ? 'visualization.copyDescription'
                : 'artifact.copyText',
            )}
          </Button>
        ) : null}
      </div>
      {chartHost &&
        createPortal(
          <ChartErrorBoundary fallbackTitle={`${title} 渲染失败`}>
            {chart}
          </ChartErrorBoundary>,
          chartHost,
        )}
      {expanded && (
        <ArtifactViewer
          title={title}
          visualization={entry.artifactType === 'visualization'}
          chartClassName={shellClassName}
          layoutAspectRatio={layoutAspectRatio}
          minContentWidth={minContentWidth}
          onClose={() => setExpanded(false)}
        >
          <ArtifactChartMount host={chartHost} />
        </ArtifactViewer>
      )}
    </div>
  );
}

/**
 * Render structured chart artifacts inside their measured presentation boundary.
 *
 * @param props.entries Tool context entries containing chart data.
 * @param props.fitViewportHeight Deduct the preview's preceding content from its height budget.
 * @returns Charts and their reading and text-export actions.
 */
export function ArtifactRenderer({
  entries,
  fitViewportHeight = false,
}: ArtifactRendererProps) {
  if (!entries || entries.length === 0) return null;
  return (
    <>
      {entries.map((entry, i) => (
        <ArtifactBlock
          key={`${entry.skill}-${i}`}
          entry={entry}
          fitViewportHeight={fitViewportHeight}
        />
      ))}
    </>
  );
}
