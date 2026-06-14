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
  /**
   * 是否按当前视口剩余高度等比缩放盘面。
   *
   * 聊天流里的盘面会随着新消息插入被推到视口下方，如果按当前位置计算剩余高度，
   * 旧盘面会被误判成空间不足而持续缩小；只有弹层预览这类固定视窗才需要开启。
   */
  fitViewportHeight?: boolean;
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
 * 盘面自适应外壳默认只按容器宽度缩放；固定视窗场景可额外按可用高度缩放。
 *
 * @param props.children 实际盘面节点。
 * @param props.fitViewportHeight 是否把当前视口剩余高度纳入缩放计算。
 * @returns 自动适配展示区域的盘面容器。
 */
function ResponsiveArtifactFrame({
  children,
  fitViewportHeight = false,
}: {
  children: ReactNode;
  fitViewportHeight?: boolean;
}) {
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
      const widthScale =
        naturalWidth > 0 ? Math.min(1, shellWidth / naturalWidth) : 1;
      let heightScale = 1;

      // 小屏弹层本身可纵向滚动，强行按高度缩放会让六爻等信息密集盘面变得难读。
      const shouldFitHeight =
        fitViewportHeight &&
        (typeof window === 'undefined' ||
          window.matchMedia('(min-width: 640px)').matches);

      if (shouldFitHeight) {
        const probeHeight =
          heightProbeRef.current?.getBoundingClientRect().height ?? 0;
        const shellTop = shell.getBoundingClientRect().top;
        // 弹层内的盘面需要考虑底部固定操作区；聊天流禁用该逻辑，避免滚动位置影响盘面尺寸。
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
        heightScale =
          naturalHeight > 0
            ? Math.min(1, availableHeight / naturalHeight)
            : 1;
      }

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
  }, [fitViewportHeight]);

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
  fitViewportHeight,
}: {
  entry: SkillContextEntry;
  index: number;
  fitViewportHeight: boolean;
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
          <ResponsiveArtifactFrame fitViewportHeight={fitViewportHeight}>
            {chart}
          </ResponsiveArtifactFrame>
        </div>
      </ChartErrorBoundary>
    </div>
  );
}

/**
 * 渲染 Agent 工具产生的结构化盘面，并按使用场景选择尺寸适配策略。
 *
 * @param props.entries 需要展示的工具上下文列表。
 * @param props.fitViewportHeight 是否按视口剩余高度缩放，聊天流默认关闭以保持可读尺寸。
 * @returns 可直接嵌入聊天消息或排盘弹层的盘面节点。
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
          index={i}
          fitViewportHeight={fitViewportHeight}
        />
      ))}
    </>
  );
}
