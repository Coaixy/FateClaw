'use client';

import React, { useMemo, useState } from 'react';
import { cn } from '@/utils/chart/cn';
import { CHART } from './chart-theme';

interface Star {
  name: string;
  brightness?: string;
  mutagen?: string;
}

interface Palace {
  name: string;
  isBodyPalace?: boolean;
  isOriginalPalace?: boolean;
  heavenlyStem: string;
  earthlyBranch: string;
  majorStars?: Star[];
  minorStars?: Star[];
  adjectiveStars?: Star[];
  changsheng12?: string;
  boshi12?: string;
  jiangqian12?: string;
  suiqian12?: string;
  decadal?: {
    range?: [number, number] | number[];
    heavenlyStem?: string;
    earthlyBranch?: string;
  };
}

interface ZiWeiData {
  solarDate?: string;
  lunarDate?: string;
  chineseDate?: string;
  time?: string;
  timeRange?: string;
  sign?: string;
  zodiac?: string;
  soul?: string;
  body?: string;
  fiveElementsClass?: string;
  palaces: Palace[];
}

const BRIGHTNESS_COLOR: Record<string, string> = {
  庙: `${CHART.primary} font-bold`,
  旺: `${CHART.earth} font-bold`,
  得地: `${CHART.warning} font-medium`,
  利益: `${CHART.body} font-medium`,
  平和: `${CHART.muted} font-medium`,
  不得地: `${CHART.mutedSoft}`,
  陷: `${CHART.mutedSoft}`,
  弱: `${CHART.mutedSoft}`,
};

const MUTAGEN_COLOR: Record<string, string> = {
  禄: CHART.success,
  权: CHART.primary,
  科: CHART.accentTeal,
  忌: CHART.error,
};

const COLUMN_CLASSES = [
  'col-start-1',
  'col-start-2',
  'col-start-3',
  'col-start-4',
];

function StarCell({ star, isMajor }: { star: Star; isMajor: boolean }) {
  const fontSize = isMajor
    ? 'text-[clamp(10px,3.5cqw,16px)]'
    : 'text-[clamp(8px,2.8cqw,12px)]';

  let colorClass = isMajor
    ? `${CHART.ink} font-bold`
    : `${CHART.muted} font-medium`;
  if (star.mutagen && MUTAGEN_COLOR[star.mutagen]) {
    colorClass = `${MUTAGEN_COLOR[star.mutagen]} font-bold`;
  } else if (star.brightness && isMajor) {
    colorClass = BRIGHTNESS_COLOR[star.brightness] ?? colorClass;
  }

  return (
    <div className="flex flex-col items-center leading-tight">
      <div className={cn('flex flex-col items-center', fontSize, colorClass)}>
        {Array.from(star.name).map((char, i) => (
          <span key={i} className="block">
            {char}
          </span>
        ))}
      </div>
      {(star.mutagen || (star.brightness && isMajor)) && (
        <div className="flex flex-col items-center leading-none mt-0.5">
          {star.mutagen && (
            <span
              className={cn(
                'text-[clamp(8px,2.5cqw,11px)] font-bold',
                MUTAGEN_COLOR[star.mutagen] ?? 'text-ink',
              )}
            >
              {star.mutagen}
            </span>
          )}
          {star.brightness && isMajor && !star.mutagen && (
            <span className="text-[clamp(7px,2.2cqw,10px)] text-muted">
              {star.brightness}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function SmallStarList({
  stars,
  className,
}: {
  stars: string[];
  className?: string;
}) {
  if (stars.length === 0) return null;

  return (
    <div
      className={cn(
        'basis-full flex flex-wrap gap-x-1 gap-y-0.5 text-[clamp(7px,2.4cqw,11px)] leading-tight',
        className,
      )}
    >
      {stars.map((star, index) => (
        <span key={`${star}-${index}`} className="whitespace-nowrap">
          {star}
        </span>
      ))}
    </div>
  );
}

function PalaceCell({
  palace,
  className,
  onClick,
  isSelected,
}: {
  palace?: Palace;
  className?: string;
  onClick?: () => void;
  isSelected?: boolean;
}) {
  if (!palace) {
    return <div className={cn('border border-hairline', className)} />;
  }

  const majorStars = palace.majorStars ?? [];
  const minorStars = palace.minorStars ?? [];
  const adjectiveStars = (palace.adjectiveStars ?? []).map((star) => star.name);
  const decorativeStars = [
    palace.changsheng12,
    palace.boshi12,
    palace.jiangqian12,
    palace.suiqian12,
  ].filter((star): star is string => Boolean(star));

  return (
    <button
      type="button"
      aria-label={`${palace.name} ${palace.heavenlyStem}${palace.earthlyBranch}`}
      aria-pressed={Boolean(isSelected)}
      className={cn(
        'relative min-h-0 min-w-0 overflow-hidden border border-hairline bg-surface-card text-left transition-shadow cursor-pointer focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-[-2px]',
        isSelected
          ? 'ring-2 ring-inset ring-primary z-10'
          : 'hover:ring-1 hover:ring-inset hover:ring-primary',
        className,
      )}
      onClick={onClick}
    >
      <div className="flex h-full min-h-0 flex-col justify-between p-[clamp(3px,1cqw,7px)]">
        {/* 星曜区 */}
        <div className="flex min-h-0 flex-1 flex-row items-start justify-start flex-wrap content-start gap-x-[clamp(2px,0.8cqw,5px)] gap-y-0.5">
          {majorStars.map((star, i) => (
            <StarCell key={`M-${i}`} star={star} isMajor />
          ))}
          {minorStars.map((star, i) => (
            <StarCell key={`m-${i}`} star={star} isMajor={false} />
          ))}
          <SmallStarList stars={adjectiveStars} className={CHART.mutedSoft} />
          <SmallStarList
            stars={decorativeStars}
            className={CHART.lineMutedText}
          />
        </div>

        {/* 底部：宫名、干支、大限 */}
        <div className="mt-1 flex shrink-0 items-end justify-between gap-0.5 border-t border-hairline-soft pt-1">
          {/* 左下：大限 */}
          <div className="flex flex-col items-start self-end">
            {palace.decadal?.range && palace.decadal.range.length === 2 && (
              <div className="text-[clamp(7px,2.4cqw,11px)] font-medium text-ink whitespace-nowrap">
                {palace.decadal.range[0]}-{palace.decadal.range[1]}
              </div>
            )}
          </div>

          {/* 右下：干支 + 宫名 */}
          <div className="flex items-end gap-0.5 text-right">
            <div className="flex flex-col items-center text-muted text-[clamp(8px,2.6cqw,12px)] leading-tight">
              <span>{palace.heavenlyStem}</span>
              <span>{palace.earthlyBranch}</span>
            </div>
            <div className="flex flex-col items-center justify-center">
              {Array.from(palace.name).map((char, i) => (
                <span
                  key={i}
                  className="block text-[clamp(10px,3.5cqw,16px)] font-bold text-ink leading-none"
                >
                  {char}
                </span>
              ))}
              {(palace.isBodyPalace || palace.isOriginalPalace) && (
                <span
                  className={cn(
                    'mt-0.5 text-[clamp(7px,2.2cqw,10px)] font-bold px-0.5 rounded-sm leading-none border',
                    palace.isBodyPalace
                      ? 'text-on-primary bg-primary border-primary-active'
                      : 'text-on-primary bg-accent-teal border-accent-teal',
                  )}
                >
                  {palace.isBodyPalace ? '身' : '来'}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </button>
  );
}

function PalaceDetails({
  palace,
  onClose,
}: {
  palace: Palace;
  onClose: () => void;
}) {
  const groups: [string, Star[]][] = [
    ['主星', palace.majorStars ?? []],
    ['辅星', palace.minorStars ?? []],
    ['杂曜', palace.adjectiveStars ?? []],
  ];
  return (
    <div className="w-full min-w-0 space-y-2 text-[clamp(10px,2.8cqw,14px)] leading-relaxed">
      <div className="flex items-center justify-between gap-1 border-b border-hairline pb-1">
        <span className="font-bold text-primary">
          {palace.name} · {palace.heavenlyStem}
          {palace.earthlyBranch}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="min-h-7 px-1 text-muted"
          aria-label="返回命盘信息"
        >
          返回
        </button>
      </div>
      {groups.map(
        ([label, stars]) =>
          stars.length > 0 && (
            <div key={label}>
              <div className="text-muted">{label}</div>
              <div className="flex flex-wrap gap-x-2">
                {stars.map((star, index) => (
                  <span
                    key={`${star.name}-${index}`}
                    className={
                      star.mutagen ? MUTAGEN_COLOR[star.mutagen] : 'text-ink'
                    }
                  >
                    {star.name}
                    {star.brightness ? `（${star.brightness}）` : ''}
                    {star.mutagen ? ` 化${star.mutagen}` : ''}
                  </span>
                ))}
              </div>
            </div>
          ),
      )}
      {[
        ['长生', palace.changsheng12],
        ['博士', palace.boshi12],
        ['将前', palace.jiangqian12],
        ['岁前', palace.suiqian12],
      ].map(
        ([label, value]) =>
          value && (
            <div key={label}>
              <span className="text-muted">{label} </span>
              {value}
            </div>
          ),
      )}
      {palace.decadal?.range?.length === 2 && (
        <div>
          <span className="text-muted">大限 </span>
          {palace.decadal.range.join('–')} 岁
        </div>
      )}
      {palace.isBodyPalace && <div className="text-primary">身宫</div>}
      {palace.isOriginalPalace && (
        <div className="text-accent-teal">来因宫</div>
      )}
    </div>
  );
}

export default function ZiWeiChart({ data }: { data: ZiWeiData }) {
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);

  const palaceMap = useMemo(() => {
    const map: Record<string, Palace> = {};
    (data?.palaces ?? []).forEach((p) => {
      if (p.earthlyBranch) map[p.earthlyBranch] = p;
    });
    return map;
  }, [data?.palaces]);

  if (!data || !data.palaces || data.palaces.length === 0) {
    return (
      <div className="text-center text-muted text-[12px] py-6">
        命盘数据为空
      </div>
    );
  }

  const ORDER = [
    '巳',
    '午',
    '未',
    '申',
    '辰',
    '酉',
    '卯',
    '戌',
    '寅',
    '丑',
    '子',
    '亥',
  ];
  const cellHeight = 'min-h-0';
  const selectedPalace = selectedBranch ? palaceMap[selectedBranch] : undefined;

  const click = (branch: string) =>
    setSelectedBranch((prev) => (prev === branch ? null : branch));

  return (
    <div className="@container/ziwei mx-auto w-full max-w-full">
      <div className="relative grid aspect-[2/3] grid-cols-4 grid-rows-[repeat(4,minmax(0,1fr))] border border-hairline bg-canvas">
        {/* 顶行：巳 午 未 申 */}
        {[0, 1, 2, 3].map((col) => {
          const branch = ORDER[col];
          return (
            <PalaceCell
              key={branch}
              palace={palaceMap[branch]}
              className={cn('row-start-1', COLUMN_CLASSES[col], cellHeight)}
              isSelected={selectedBranch === branch}
              onClick={() => click(branch)}
            />
          );
        })}

        {/* 第 2 行：辰 _ _ 酉 */}
        <PalaceCell
          palace={palaceMap['辰']}
          className={cn('row-start-2 col-start-1', cellHeight)}
          isSelected={selectedBranch === '辰'}
          onClick={() => click('辰')}
        />
        <PalaceCell
          palace={palaceMap['酉']}
          className={cn('row-start-2 col-start-4', cellHeight)}
          isSelected={selectedBranch === '酉'}
          onClick={() => click('酉')}
        />

        {/* 第 3 行：卯 _ _ 戌 */}
        <PalaceCell
          palace={palaceMap['卯']}
          className={cn('row-start-3 col-start-1', cellHeight)}
          isSelected={selectedBranch === '卯'}
          onClick={() => click('卯')}
        />
        <PalaceCell
          palace={palaceMap['戌']}
          className={cn('row-start-3 col-start-4', cellHeight)}
          isSelected={selectedBranch === '戌'}
          onClick={() => click('戌')}
        />

        {/* 底行：寅 丑 子 亥 */}
        {['寅', '丑', '子', '亥'].map((branch, col) => (
          <PalaceCell
            key={branch}
            palace={palaceMap[branch]}
            className={cn('row-start-4', COLUMN_CLASSES[col], cellHeight)}
            isSelected={selectedBranch === branch}
            onClick={() => click(branch)}
          />
        ))}

        {/* 中宫 */}
        <div className="row-start-2 row-end-4 col-start-2 col-end-4 m-px flex min-h-0 min-w-0 flex-col bg-surface-card p-1">
          <div
            className={cn(
              'flex h-full min-h-0 w-full min-w-0 flex-col border border-hairline bg-surface-soft p-[clamp(6px,2cqw,14px)]',
              selectedPalace
                ? 'overflow-y-auto'
                : 'items-center justify-center',
            )}
          >
            {selectedPalace ? (
              <PalaceDetails
                palace={selectedPalace}
                onClose={() => setSelectedBranch(null)}
              />
            ) : (
              <>
                <h2 className="mb-2 text-[clamp(14px,4cqw,22px)] font-medium tracking-widest text-primary">
                  紫微斗数
                </h2>
                <div className="grid w-full grid-cols-1 gap-x-2 gap-y-1 text-[clamp(10px,2.8cqw,14px)] text-ink @lg/ziwei:grid-cols-2">
                  {data.soul && (
                    <div className="flex gap-1.5">
                      <span className={cn(CHART.muted, 'shrink-0')}>命主:</span>
                      <span className="font-medium">{data.soul}</span>
                    </div>
                  )}
                  {data.body && (
                    <div className="flex gap-1.5">
                      <span className={cn(CHART.muted, 'shrink-0')}>身主:</span>
                      <span className="font-medium">{data.body}</span>
                    </div>
                  )}
                  {data.fiveElementsClass && (
                    <div className="flex gap-1.5 @lg/ziwei:col-span-2">
                      <span className={cn(CHART.muted, 'shrink-0')}>
                        五行局:
                      </span>
                      <span className="font-medium">
                        {data.fiveElementsClass}
                      </span>
                    </div>
                  )}
                </div>
                <div className="mt-2 w-full space-y-1 break-words border-t border-hairline-soft pt-2 text-[clamp(9px,2.6cqw,13px)] leading-relaxed text-muted">
                  {data.solarDate && <div>阳历 {data.solarDate}</div>}
                  {data.lunarDate && <div>农历 {data.lunarDate}</div>}
                  {data.chineseDate && (
                    <div className="text-primary tracking-wider">
                      {data.chineseDate}
                    </div>
                  )}
                  {data.time && (
                    <div>
                      {data.time}
                      {data.timeRange ? ` ${data.timeRange}` : ''}
                    </div>
                  )}
                </div>
                <p className="mt-2 text-[clamp(8px,2.4cqw,11px)] text-muted">
                  点选宫位查看详情
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
