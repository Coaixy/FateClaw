'use client';

import dynamic from 'next/dynamic';

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
const JingzhanChart = dynamic(
  () => import('@/components/charts/jingzhan-chart'),
  { ssr: false },
);

interface ArtifactRendererProps {
  entries: SkillContextEntry[];
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
  'liuren-paipan': 'lg:max-w-[960px] xl:max-w-[1020px]',
  'iching-paipan': 'lg:max-w-[920px] xl:max-w-[980px]',
  'bazi-paipan': 'lg:max-w-[880px] xl:max-w-[940px]',
};

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
            'w-full mx-auto',
            shellClassName,
          )}
        >
          {chart}
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
