'use client';

import dynamic from 'next/dynamic';
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { SkillContextEntry } from '@/features/chat/api';
import { ChartErrorBoundary } from '@/components/charts/chart-error-boundary';
import { cn } from '@/utils/chart/cn';

const BaziChart = dynamic(() => import('@/components/charts/bazi-chart'), {
  ssr: false,
});
const ZiWeiChart = dynamic(() => import('@/components/charts/ziwei-chart'), {
  ssr: false,
});
const LiuyaoChart = dynamic(() => import('@/components/charts/liuyao-chart'), {
  ssr: false,
});
const QimenChart = dynamic(() => import('@/components/charts/qimen-chart'), {
  ssr: false,
});
const LiurenChart = dynamic(() => import('@/components/charts/liuren-chart'), {
  ssr: false,
});
const MeihuaChart = dynamic(() => import('@/components/charts/meihua-chart'), {
  ssr: false,
});
const JingzhanChart = dynamic(
  () => import('@/components/charts/jingzhan-chart'),
  { ssr: false },
);

interface ArtifactRendererProps {
  entries: SkillContextEntry[];
}

interface ArtifactFitState {
  width: number;
  height: number;
  scale: number;
}

/**
 * 图表保持较大的横向阅读面积；高度压缩交给各图表内部的行高和比例控制。
 */
const CHART_SHELL_CLASSNAME: Partial<Record<SkillContextEntry['skill'], string>> = {
  'qimen-paipan':
    'lg:max-w-[min(27rem,calc(100vh-20rem))] xl:max-w-[min(29rem,calc(100vh-21rem))]',
  'ziwei-paipan':
    'lg:max-w-[min(40rem,calc(100vh-14rem))] xl:max-w-[min(42rem,calc(100vh-15rem))]',
  'jingzhan-paipan':
    'lg:max-w-[min(29rem,calc(100vh-18rem))] xl:max-w-[min(31rem,calc(100vh-19rem))]',
  'meihua-paipan': 'lg:max-w-[900px] xl:max-w-[960px]',
  'liuren-paipan': 'lg:max-w-[960px] xl:max-w-[1020px]',
  'iching-paipan': 'lg:max-w-[920px] xl:max-w-[980px]',
  'bazi-paipan': 'lg:max-w-[880px] xl:max-w-[940px]',
};

/**
 * 盘面自适应外壳会读取可用宽高，短屏时整体等比缩放，避免盘面被内部 overflow 裁切。
 *
 * @param props.children 实际盘面节点。
 * @returns 自动适配当前视口宽高的盘面容器。
 */
function ResponsiveArtifactFrame({ children }: { children: ReactNode }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const heightProbeRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<ArtifactFitState>({
    width: 0,
    height: 0,
    scale: 1,
  });

  useEffect(() => {
    const updateFit = () => {
      const shell = shellRef.current;
      const board = boardRef.current;
      if (!shell || !board) return;

      const shellWidth = shell.clientWidth;
      const naturalWidth = Math.max(shellWidth, board.scrollWidth);
      const naturalHeight = board.scrollHeight;
      const probeHeight =
        heightProbeRef.current?.getBoundingClientRect().height ?? 0;
      const shellTop = shell.getBoundingClientRect().top;
      // 盘面可能出现在弹层或聊天输入框上方，按真实剩余视口高度兜底，避免底部固定操作区遮挡。
      const viewportRemainingHeight =
        typeof window === 'undefined'
          ? probeHeight
          : window.innerHeight - shellTop - 136;
      const availableHeight = Math.max(
        320,
        Math.min(
          probeHeight || viewportRemainingHeight,
          viewportRemainingHeight,
        ),
      );
      const widthScale =
        naturalWidth > 0 ? Math.min(1, shellWidth / naturalWidth) : 1;
      const heightScale =
        naturalHeight > 0
          ? Math.min(1, availableHeight / naturalHeight)
          : 1;
      const nextScale = Math.min(widthScale, heightScale);
      const nextFit = {
        width: naturalWidth,
        height: naturalHeight,
        scale: nextScale,
      };

      setFit((previous) => {
        const stable =
          Math.abs(previous.width - nextFit.width) < 0.5 &&
          Math.abs(previous.height - nextFit.height) < 0.5 &&
          Math.abs(previous.scale - nextFit.scale) < 0.001;
        return stable ? previous : nextFit;
      });
    };

    updateFit();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateFit);
      return () => window.removeEventListener('resize', updateFit);
    }

    const resizeObserver = new ResizeObserver(updateFit);
    if (shellRef.current) resizeObserver.observe(shellRef.current);
    if (boardRef.current) resizeObserver.observe(boardRef.current);
    if (heightProbeRef.current) {
      resizeObserver.observe(heightProbeRef.current);
    }
    window.addEventListener('resize', updateFit);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateFit);
    };
  }, []);

  const contentWidth = fit.width || undefined;
  const visualWidth = fit.width ? fit.width * fit.scale : undefined;
  const visualHeight = fit.height ? fit.height * fit.scale : undefined;

  return (
    <div ref={shellRef} className="relative w-full min-w-0">
      <div
        ref={heightProbeRef}
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 h-[var(--artifact-fit-max-height,calc(100dvh-11rem))] w-0 opacity-0"
      />
      <div
        className="mx-auto overflow-visible"
        style={{
          width: visualWidth ? `${visualWidth}px` : undefined,
          maxWidth: '100%',
          height: visualHeight ? `${visualHeight}px` : undefined,
        }}
      >
        <div
          ref={boardRef}
          className="min-w-0"
          style={{
            width: contentWidth ? `${contentWidth}px` : '100%',
            maxWidth: contentWidth ? undefined : '100%',
            transform:
              fit.scale === 1 ? undefined : `scale(${fit.scale})`,
            transformOrigin: 'top left',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function resolveChart(entry: SkillContextEntry) {
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

function ArtifactBlock({
  entry,
  index,
}: {
  entry: SkillContextEntry;
  index: number;
}) {
  const chart = resolveChart(entry);
  if (!chart || entry.artifactData == null) return null;

  const title = entry.artifactTitle ?? entry.skill;
  const shellClassName =
    CHART_SHELL_CLASSNAME[entry.skill] ?? 'lg:max-w-[880px] xl:max-w-[940px]';

  return (
    <div className="mt-1">
      <ChartErrorBoundary fallbackTitle={`${title} 渲染失败`}>
        <div
          key={index}
          className={cn(
            'w-full min-w-0 mx-auto',
            shellClassName,
          )}
        >
          <ResponsiveArtifactFrame>{chart}</ResponsiveArtifactFrame>
        </div>
      </ChartErrorBoundary>
    </div>
  );
}

export function ArtifactRenderer({ entries }: ArtifactRendererProps) {
  if (!entries || entries.length === 0) return null;
  return (
    <>
      {entries.map((entry, i) => (
        <ArtifactBlock key={`${entry.skill}-${i}`} entry={entry} index={i} />
      ))}
    </>
  );
}
