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

function StarCell({ star, isMajor }: { star: Star; isMajor: boolean }) {
  const fontSize = isMajor ? 'text-[10px] sm:text-[12px]' : 'text-[9px] sm:text-[11px]';

  let colorClass = isMajor ? `${CHART.ink} font-bold` : `${CHART.muted} font-medium`;
  if (star.mutagen && MUTAGEN_COLOR[star.mutagen]) {
    colorClass = `${MUTAGEN_COLOR[star.mutagen]} font-bold`;
  } else if (star.brightness && isMajor) {
    colorClass = BRIGHTNESS_COLOR[star.brightness] ?? colorClass;
  }

  return (
    <div className="flex flex-col items-center leading-tight">
      <div className={cn('flex flex-col items-center', fontSize, colorClass)}>
        {Array.from(star.name).map((char, i) => (
          <span key={i} className="block">{char}</span>
        ))}
      </div>
      {(star.mutagen || (star.brightness && isMajor)) && (
        <div className="flex flex-col items-center leading-none mt-0.5">
          {star.mutagen && (
            <span
              className={cn(
                'text-[7px] font-bold scale-90',
                MUTAGEN_COLOR[star.mutagen] ?? 'text-ink',
              )}
            >
              {star.mutagen}
            </span>
          )}
          {star.brightness && isMajor && !star.mutagen && (
            <span className="text-[7px] text-muted-soft scale-75">
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
        'basis-full flex flex-wrap gap-x-1 gap-y-0.5 text-[8px] sm:text-[9px] leading-tight',
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
    <div
      className={cn(
        'relative border border-hairline bg-surface-card transition-all cursor-pointer',
        isSelected ? 'ring-2 ring-primary z-10' : 'hover:ring-1 hover:ring-primary',
        className,
      )}
      onClick={onClick}
    >
      <div className="flex flex-col h-full justify-between p-1 min-h-[inherit]">
        {/* 星曜区 */}
        <div className="flex-1 flex flex-row items-start justify-start flex-wrap content-start gap-x-1 gap-y-0.5">
          {majorStars.map((star, i) => (
            <StarCell key={`M-${i}`} star={star} isMajor />
          ))}
          {minorStars.map((star, i) => (
            <StarCell key={`m-${i}`} star={star} isMajor={false} />
          ))}
          <SmallStarList
            stars={adjectiveStars}
            className={CHART.mutedSoft}
          />
          <SmallStarList
            stars={decorativeStars}
            className={CHART.lineMutedText}
          />
        </div>

        {/* 底部：宫名、干支、大限 */}
        <div className="mt-1 pt-0.5 border-t border-hairline-soft flex justify-between items-end shrink-0">
          {/* 左下：大限 */}
          <div className="flex flex-col items-start min-w-[36px]">
            {palace.decadal?.range && palace.decadal.range.length === 2 && (
              <div className="text-[9px] sm:text-[10px] font-bold text-ink whitespace-nowrap">
                {palace.decadal.range[0]}-{palace.decadal.range[1]}
              </div>
            )}
          </div>

          {/* 右下：干支 + 宫名 */}
          <div className="flex items-end gap-1 text-right">
            <div className="flex flex-col items-center text-muted text-[9px] sm:text-[11px] leading-tight">
              <span>{palace.heavenlyStem}</span>
              <span>{palace.earthlyBranch}</span>
            </div>
            <div className="flex flex-col items-center justify-center min-w-[18px] sm:min-w-[24px]">
              {Array.from(palace.name).map((char, i) => (
                <span
                  key={i}
                  className="text-[12px] sm:text-[14px] font-bold text-ink leading-none block"
                >
                  {char}
                </span>
              ))}
              {(palace.isBodyPalace || palace.isOriginalPalace) && (
                <span
                  className={cn(
                    'mt-0.5 text-[8px] font-bold px-1 rounded-sm leading-none border',
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

  const ORDER = ['巳', '午', '未', '申', '辰', '酉', '卯', '戌', '寅', '丑', '子', '亥'];
  const cellHeight = 'min-h-[96px] sm:min-h-[112px]';

  const click = (branch: string) =>
    setSelectedBranch((prev) => (prev === branch ? null : branch));

  return (
    <div className="w-full max-w-full mx-auto">
      <div className="relative grid grid-cols-4 grid-rows-4 border-2 border-hairline bg-canvas">
        {/* 顶行：巳 午 未 申 */}
        {[0, 1, 2, 3].map((col) => {
          const branch = ORDER[col];
          return (
            <PalaceCell
              key={branch}
              palace={palaceMap[branch]}
              className={cn(`row-start-1 col-start-${col + 1}`, cellHeight)}
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
            className={cn(`row-start-4 col-start-${col + 1}`, cellHeight)}
            isSelected={selectedBranch === branch}
            onClick={() => click(branch)}
          />
        ))}

        {/* 中宫 */}
        <div className="row-start-2 row-end-4 col-start-2 col-end-4 flex flex-col items-center justify-center p-1 sm:p-2 bg-surface-card m-[1px]">
          <div className="border-2 border-double border-hairline p-2 sm:p-3 w-full h-full flex flex-col items-center justify-center bg-surface-soft">
            <h2 className="text-[14px] sm:text-lg font-bold text-primary mb-1.5 sm:mb-2 tracking-widest">
              紫微斗数
            </h2>
            <div className="grid grid-cols-2 gap-x-2.5 gap-y-0.5 text-[10px] sm:text-[11px] text-ink w-full">
              {data.soul && (
                <div className="flex gap-1.5">
                  <span className={CHART.muted}>命主:</span>
                  <span className="font-medium">{data.soul}</span>
                </div>
              )}
              {data.body && (
                <div className="flex gap-1.5">
                  <span className={CHART.muted}>身主:</span>
                  <span className="font-medium">{data.body}</span>
                </div>
              )}
              {data.fiveElementsClass && (
                <div className="flex gap-1.5 col-span-2">
                  <span className={CHART.muted}>五行局:</span>
                  <span className="font-medium">{data.fiveElementsClass}</span>
                </div>
              )}
            </div>
            <div className="mt-1.5 sm:mt-2 pt-1.5 border-t border-hairline-soft w-full text-[9px] sm:text-[10px] text-muted space-y-0.5">
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
          </div>
        </div>
      </div>
    </div>
  );
}
