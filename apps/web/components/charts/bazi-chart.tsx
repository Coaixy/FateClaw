'use client';

import React, { useEffect, useState } from 'react';
import { CHART, WUXING_TEXT } from './chart-theme';

// ============ 浅色纸盘五行配色 ============
const STEM_WUXING: Record<string, string> = {
  甲: '木', 乙: '木',
  丙: '火', 丁: '火',
  戊: '土', 己: '土',
  庚: '金', 辛: '金',
  壬: '水', 癸: '水',
};

const BRANCH_WUXING: Record<string, string> = {
  子: '水', 丑: '土', 寅: '木', 卯: '木',
  辰: '土', 巳: '火', 午: '火', 未: '土',
  申: '金', 酉: '金', 戌: '土', 亥: '水',
};

function wuxingColor(char?: string): string {
  if (!char) return CHART.body;
  const wuxing = STEM_WUXING[char] ?? BRANCH_WUXING[char];
  return wuxing ? WUXING_TEXT[wuxing] : CHART.body;
}

function classNames(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

// ============ 数据接口 ============
interface HideHeavenStem {
  name: string;
  type?: string;
  element?: string;
}

interface Pillar {
  sixtyCycle: string;
  heavenStem?: { name: string; element?: string; yinYang?: string };
  earthBranch?: {
    name: string;
    element?: string;
    yinYang?: string;
    hideHeavenStems?: HideHeavenStem[];
  };
  sound?: string;
  tenStar?: string | null;
  terrain?: string;
}

interface Decade {
  sixtyCycle: string;
  heavenStem?: string;
  earthBranch?: string;
  startAge: number;
  endAge?: number;
  startYear?: number;
  endYear?: number;
  tenStar?: string;
}

interface AnnualFortuneItem {
  year: number;
  sixtyCycle: string;
  heavenStem?: string;
  earthBranch?: string;
  lunarYear?: string;
  age?: number;
  tenStar?: string;
  terrain?: string;
  sound?: string;
}

interface BaziArtifactData {
  bazi?: {
    birthTime?: string;
    gender?: string;
    baziString?: string;
    pillars?: { year?: Pillar; month?: Pillar; day?: Pillar; hour?: Pillar };
    specialSigns?: {
      fetalOrigin?: string;
      fetalBreath?: string;
      ownSign?: string;
      bodySign?: string;
      duty?: string;
      kongWang?: string[];
      xun?: string;
    };
  };
  fortune?: {
    decades?: Decade[];
    annuals?: AnnualFortuneItem[];
    annualStartYear?: number;
    annualEndYear?: number;
    currentAnnualYear?: number;
  };
  pattern?: { name?: string; description?: string; reliability?: string };
}

function getResolvedDecadeEndYear(
  decades: readonly Decade[],
  index: number,
  fallbackEndYear?: number,
): number | undefined {
  const decade = decades[index];
  if (!decade) return undefined;
  if (decade.endYear !== undefined) return decade.endYear;

  const nextStartYear = decades[index + 1]?.startYear;
  if (nextStartYear !== undefined) return nextStartYear - 1;

  return fallbackEndYear ?? decade.startYear;
}

function findDecadeIndexByYear(
  year: number | undefined,
  decades: readonly Decade[],
  fallbackEndYear?: number,
): number | null {
  if (year === undefined) return null;

  const matchedIndex = decades.findIndex((decade, index) => {
    if (decade.startYear === undefined) return false;
    const endYear = getResolvedDecadeEndYear(decades, index, fallbackEndYear);
    return year >= decade.startYear && (endYear === undefined || year <= endYear);
  });

  return matchedIndex === -1 ? null : matchedIndex;
}

function getAnnualsForDecade(
  annuals: readonly AnnualFortuneItem[],
  decades: readonly Decade[],
  decadeIndex: number | null,
  fallbackEndYear?: number,
): readonly AnnualFortuneItem[] {
  if (decadeIndex === null) return annuals;

  const decade = decades[decadeIndex];
  if (!decade || decade.startYear === undefined) return annuals;

  const startYear = decade.startYear;
  const endYear = getResolvedDecadeEndYear(decades, decadeIndex, fallbackEndYear);
  const matchedAnnuals = annuals.filter((item) => (
    item.year >= startYear &&
    (endYear === undefined || item.year <= endYear)
  ));

  return matchedAnnuals.length > 0 ? matchedAnnuals : annuals;
}

// ============ 主组件 ============

export default function BaziChart({ data }: { data: BaziArtifactData }) {
  const bazi = data?.bazi;
  const pillars = bazi?.pillars ?? {};
  const decades = data?.fortune?.decades ?? [];
  const annuals = data?.fortune?.annuals ?? [];
  const annualStartYear = data?.fortune?.annualStartYear ?? annuals[0]?.year;
  const annualEndYear = data?.fortune?.annualEndYear ?? annuals[annuals.length - 1]?.year;
  const specialSigns = bazi?.specialSigns;
  const kongWang = specialSigns?.kongWang ?? [];
  const defaultSelectedAnnualYear = data?.fortune?.currentAnnualYear ?? annuals[0]?.year;
  const defaultSelectedDecadeIndex =
    findDecadeIndexByYear(defaultSelectedAnnualYear, decades, annualEndYear) ??
    (decades.length > 0 ? 0 : null);
  const fortuneSignature = [
    bazi?.birthTime ?? '',
    decades.length,
    decades[0]?.startYear ?? '',
    decades[decades.length - 1]?.startYear ?? '',
    annuals.length,
    annualStartYear ?? '',
    annualEndYear ?? '',
    defaultSelectedAnnualYear ?? '',
  ].join(':');

  const hasPattern = Boolean(data?.pattern?.name || data?.pattern?.description);
  const [selectedDecadeIndex, setSelectedDecadeIndex] = useState<number | null>(
    defaultSelectedDecadeIndex,
  );
  const [selectedAnnualYear, setSelectedAnnualYear] = useState<number | undefined>(
    defaultSelectedAnnualYear,
  );

  useEffect(() => {
    setSelectedDecadeIndex(defaultSelectedDecadeIndex);
    setSelectedAnnualYear(defaultSelectedAnnualYear);
  }, [defaultSelectedAnnualYear, defaultSelectedDecadeIndex, fortuneSignature]);

  interface TransposedColumn {
    label: string;
    stem: string;
    branch: string;
    tenStarTop: string;
    hiddenStems: { stem: string; star: string }[];
    terrain: string;
    sound: string;
    isDay?: boolean;
    isHighlight?: boolean;
  }

  const columnsData: TransposedColumn[] = [];
  const visibleAnnuals = getAnnualsForDecade(
    annuals,
    decades,
    selectedDecadeIndex,
    annualEndYear,
  );
  const currentAnnual =
    visibleAnnuals.find((item) => item.year === selectedAnnualYear) ??
    visibleAnnuals.find((item) => item.year === defaultSelectedAnnualYear) ??
    visibleAnnuals[0];
  const activeYear = currentAnnual?.year;
  const matchedDecadeIndex =
    selectedDecadeIndex ??
    findDecadeIndexByYear(activeYear, decades, annualEndYear);
  const currentDecade =
    matchedDecadeIndex !== null ? decades[matchedDecadeIndex] : undefined;
  const visibleAnnualStartYear = visibleAnnuals[0]?.year ?? annualStartYear;
  const visibleAnnualEndYear =
    visibleAnnuals[visibleAnnuals.length - 1]?.year ?? annualEndYear;

  function handleDecadeSelect(index: number) {
    const decadeAnnuals = getAnnualsForDecade(annuals, decades, index, annualEndYear);
    const nextAnnualYear =
      decadeAnnuals.find((item) => item.year === selectedAnnualYear)?.year ??
      decadeAnnuals.find((item) => item.year === defaultSelectedAnnualYear)?.year ??
      decadeAnnuals[0]?.year;

    setSelectedDecadeIndex(index);
    if (nextAnnualYear !== undefined) {
      setSelectedAnnualYear(nextAnnualYear);
    }
  }

  function handleAnnualSelect(year: number) {
    setSelectedAnnualYear(year);

    const nextDecadeIndex = findDecadeIndexByYear(year, decades, annualEndYear);
    if (nextDecadeIndex !== null) {
      setSelectedDecadeIndex(nextDecadeIndex);
    }
  }

  // 1. 流年
  if (currentAnnual) {
    columnsData.push({
      label: '流年',
      stem: currentAnnual.heavenStem ?? currentAnnual.sixtyCycle[0] ?? '',
      branch: currentAnnual.earthBranch ?? currentAnnual.sixtyCycle[1] ?? '',
      tenStarTop: currentAnnual.tenStar ?? '',
      hiddenStems: [],
      terrain: currentAnnual.terrain ?? '',
      sound: currentAnnual.sound ?? '',
      isDay: false,
      isHighlight: true
    });
  }

  // 2. 大运
  if (currentDecade) {
    columnsData.push({
      label: '大运',
      stem: currentDecade.heavenStem ?? currentDecade.sixtyCycle?.[0] ?? '',
      branch: currentDecade.earthBranch ?? currentDecade.sixtyCycle?.[1] ?? '',
      tenStarTop: currentDecade.tenStar ?? '',
      hiddenStems: [],
      terrain: '',
      sound: '',
      isDay: false,
      isHighlight: true
    });
  }

  // 3. 四柱
  const PILLAR_KEYS = ['year', 'month', 'day', 'hour'] as const;
  const PILLAR_NAMES = ['年柱', '月柱', '日柱', '时柱'];

  PILLAR_KEYS.forEach((key, idx) => {
    const p = pillars[key as keyof typeof pillars];
    if (!p) {
      columnsData.push({
        label: PILLAR_NAMES[idx],
        stem: '', branch: '', tenStarTop: '',
        hiddenStems: [], terrain: '', sound: '',
        isDay: key === 'day'
      });
      return;
    }

    const stem = p.heavenStem?.name ?? p.sixtyCycle?.[0] ?? '';
    const branch = p.earthBranch?.name ?? p.sixtyCycle?.[1] ?? '';
    const hidden = p.earthBranch?.hideHeavenStems ?? [];

    columnsData.push({
      label: PILLAR_NAMES[idx],
      stem,
      branch,
      tenStarTop: p.tenStar ?? '',
      hiddenStems: hidden.map(h => ({ stem: h.name, star: h.type ?? '' })),
      terrain: p.terrain ?? '',
      sound: p.sound ?? '',
      isDay: key === 'day'
    });
  });

  return (
    <div className="w-full space-y-3 font-sans">
      {/* 顶部基础信息区 */}
      {(bazi?.birthTime || bazi?.baziString) && (
        <div className="flex flex-wrap items-center gap-x-2 sm:gap-x-3 gap-y-1 px-3 py-1.5 rounded-lg bg-surface-soft border border-hairline text-[11px] sm:text-xs">
          {bazi?.birthTime && <span className={CHART.body}>{bazi.birthTime}</span>}
          {bazi?.gender && <span className={CHART.muted}>{bazi.gender}</span>}
          {bazi?.baziString && (
            <span className="text-ink font-medium tracking-wider ml-auto">
              {bazi.baziString}
            </span>
          )}
        </div>
      )}

      {/* 主排盘区: 去掉 min-w 和 overflow-x-auto，强制自适应手机屏幕 */}
      <div className="bg-surface-card border border-hairline rounded-xl shadow-sm overflow-hidden">
        <table className="w-full table-fixed text-center border-collapse">
          <thead>
            <tr className="bg-surface-soft border-b border-hairline-soft">
              <th className="py-1.5 px-0.5 sm:px-1 text-muted-soft font-medium text-[10px] sm:text-[11px] w-8 sm:w-10 border-r border-hairline-soft">
                日期
              </th>
              {columnsData.map((col, idx) => (
                <th key={idx} className={classNames(
                  "py-1.5 px-0.5 text-muted font-medium text-[10px] sm:text-[11px] border-r border-hairline-soft last:border-r-0",
                  col.isHighlight && "bg-chart-highlight"
                )}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-[11px] sm:text-xs">
            {/* 主星 */}
            <tr className="border-b border-hairline-soft">
              <td className="py-1 text-muted-soft text-[10px] sm:text-[11px] bg-canvas border-r border-hairline-soft">主星</td>
              {columnsData.map((col, idx) => (
                <td key={idx} className={classNames(
                  "py-1 px-0.5 border-r border-hairline-soft last:border-r-0",
                  col.isDay ? CHART.body + ' font-semibold' : CHART.muted,
                  col.isHighlight && "bg-chart-highlight"
                )}>
                  {col.isDay ? (bazi?.gender === '女' ? '元女' : '元男') : col.tenStarTop || <span className="text-transparent">-</span>}
                </td>
              ))}
            </tr>
            {/* 天干 */}
            <tr className="border-b border-hairline-soft">
              <td className="py-1.5 text-muted-soft text-[10px] sm:text-[11px] bg-canvas border-r border-hairline-soft">天干</td>
              {columnsData.map((col, idx) => (
                <td key={idx} className={classNames(
                  `py-1.5 px-0.5 text-lg sm:text-xl font-bold border-r border-hairline-soft last:border-r-0 ${wuxingColor(col.stem)}`,
                  col.isHighlight && "bg-chart-highlight"
                )}>
                  {col.stem || <span className="text-transparent">-</span>}
                </td>
              ))}
            </tr>
            {/* 地支 */}
            <tr className="border-b border-hairline-soft">
              <td className="py-1.5 text-muted-soft text-[10px] sm:text-[11px] bg-canvas border-r border-hairline-soft">地支</td>
              {columnsData.map((col, idx) => (
                <td key={idx} className={classNames(
                  `py-1.5 px-0.5 text-lg sm:text-xl font-bold border-r border-hairline-soft last:border-r-0 ${wuxingColor(col.branch)}`,
                  col.isHighlight && "bg-chart-highlight"
                )}>
                  {col.branch || <span className="text-transparent">-</span>}
                </td>
              ))}
            </tr>
            {/* 藏干 */}
            <tr className="border-b border-hairline-soft">
              <td className="py-1 text-muted-soft text-[10px] sm:text-[11px] bg-canvas border-r border-hairline-soft align-top">藏干</td>
              {columnsData.map((col, idx) => (
                <td key={idx} className={classNames(
                  "py-1 px-0.5 align-top border-r border-hairline-soft last:border-r-0",
                  col.isHighlight && "bg-chart-highlight"
                )}>
                  {col.hiddenStems.length > 0 ? (
                    <div className="flex flex-col gap-0.5 items-center">
                      {col.hiddenStems.map((h, hIdx) => (
                        <div key={hIdx} className="flex items-center gap-[2px] text-[9px] sm:text-[10px] leading-none">
                          <span className={`${wuxingColor(h.stem)} font-medium`}>{h.stem}</span>
                          <span className={CHART.mutedSoft + ' scale-90'}>{h.star}</span>
                        </div>
                      ))}
                    </div>
                  ) : <span className="text-transparent">-</span>}
                </td>
              ))}
            </tr>
            {/* 星运 */}
            <tr className="border-b border-hairline-soft">
              <td className="py-1 text-muted-soft text-[10px] sm:text-[11px] bg-canvas border-r border-hairline-soft">星运</td>
              {columnsData.map((col, idx) => (
                <td key={idx} className={classNames(
                  "py-1 px-0.5 text-body border-r border-hairline-soft last:border-r-0",
                  col.isHighlight && "bg-chart-highlight"
                )}>
                  {col.terrain || <span className="text-transparent">-</span>}
                </td>
              ))}
            </tr>
            {/* 纳音 */}
            <tr className="border-b border-hairline-soft">
              <td className="py-1 text-muted-soft text-[10px] sm:text-[11px] bg-canvas border-r border-hairline-soft">纳音</td>
              {columnsData.map((col, idx) => (
                <td key={idx} className={classNames(
                  "py-1 px-0.5 text-muted text-[9px] sm:text-[10px] leading-tight border-r border-hairline-soft last:border-r-0",
                  col.isHighlight && "bg-chart-highlight"
                )}>
                  {col.sound || <span className="text-transparent">-</span>}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      {/* 补充信息：空亡、命宫等 */}
      {(kongWang.length > 0 || specialSigns?.ownSign || specialSigns?.bodySign) && (
        <div className="px-3 py-1.5 rounded-lg bg-surface-soft border border-hairline-soft flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] sm:text-xs">
          {specialSigns?.ownSign && (
            <span>
              <span className={CHART.mutedSoft + ' mr-1.5'}>命宫</span>
              <span className={CHART.body + ' font-medium'}>{specialSigns.ownSign}</span>
            </span>
          )}
          {specialSigns?.bodySign && (
            <span>
              <span className={CHART.mutedSoft + ' mr-1.5'}>身宫</span>
              <span className={CHART.body + ' font-medium'}>{specialSigns.bodySign}</span>
            </span>
          )}
          {kongWang.length > 0 && (
            <span>
              <span className={CHART.mutedSoft + ' mr-1.5'}>空亡</span>
              <span className={CHART.body + ' font-medium tabular-nums'}>{kongWang.join(' · ')}</span>
            </span>
          )}
        </div>
      )}

      {/* 大运流年统一时间轴 */}
      {(decades.length > 0 || annuals.length > 0) && (
        <div className="bg-surface-card border border-hairline rounded-xl overflow-hidden shadow-sm mt-3">
          {visibleAnnualStartYear && visibleAnnualEndYear && (
            <div className="flex items-center justify-between gap-2 border-b border-hairline-soft bg-surface-soft px-3 py-1.5 text-[10px] sm:text-[11px] text-muted">
              <span className="font-medium text-body">大运流年</span>
              <span className="tabular-nums">
                流年 {visibleAnnualStartYear}-{visibleAnnualEndYear} · {visibleAnnuals.length} 条
              </span>
            </div>
          )}
          {/* 大运轴 */}
          {decades.length > 0 && (
            <div className="flex border-b border-hairline-soft">
              <div className="w-8 sm:w-10 flex-none flex items-center justify-center bg-surface-soft border-r border-hairline-soft">
                <span className={CHART.muted + ' font-medium'} style={{ writingMode: 'vertical-lr' }}>大运</span>
              </div>
              <div className="flex-1 overflow-x-auto flex scrollbar-hide snap-x">
                {decades.map((d, i) => {
                  const stem = d.heavenStem ?? d.sixtyCycle?.[0] ?? '';
                  const branch = d.earthBranch ?? d.sixtyCycle?.[1] ?? '';
                  const isSelected = i === selectedDecadeIndex;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => handleDecadeSelect(i)}
                      aria-pressed={isSelected}
                      className={classNames(
                        'snap-start flex-none w-[44px] sm:w-[50px] flex flex-col items-center py-2 border-r border-hairline-soft last:border-r-0 transition-colors',
                        isSelected ? 'bg-surface-cream-strong' : 'hover:bg-chart-highlight',
                      )}
                    >
                      <span className="text-[10px] sm:text-[11px] text-body font-medium leading-none">{d.startYear ?? '-'}</span>
                      <span className={CHART.mutedSoft + ' mt-1 leading-none'}>{d.startAge}岁</span>
                      <div className="flex items-end gap-[1px] mt-1.5">
                        <span className={`text-[15px] sm:text-[16px] font-bold leading-none ${wuxingColor(stem)}`}>{stem}</span>
                        {d.tenStar && <span className={CHART.mutedSoft + ' leading-none mb-[1px]'}>{d.tenStar}</span>}
                      </div>
                      <div className="flex items-end gap-[1px] mt-0.5">
                        <span className={`text-[15px] sm:text-[16px] font-bold leading-none ${wuxingColor(branch)}`}>{branch}</span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          {/* 流年轴 */}
          {annuals.length > 0 && (
            <div className="flex">
              <div className="w-8 sm:w-10 flex-none flex items-center justify-center bg-surface-soft border-r border-hairline-soft">
                <span className={CHART.muted + ' font-medium'} style={{ writingMode: 'vertical-lr' }}>流年</span>
              </div>
              <div className="flex-1 overflow-x-auto flex scrollbar-hide snap-x">
                {visibleAnnuals.map((a, i) => {
                  const stem = a.heavenStem ?? a.sixtyCycle[0] ?? '';
                  const branch = a.earthBranch ?? a.sixtyCycle[1] ?? '';
                  const isSelected = a.year === activeYear;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => handleAnnualSelect(a.year)}
                      aria-pressed={isSelected}
                      className={classNames(
                        'snap-start flex-none w-[58px] sm:w-[64px] flex flex-col items-center py-2 border-r border-hairline-soft last:border-r-0 transition-colors',
                        isSelected ? 'bg-surface-cream-strong' : 'hover:bg-chart-highlight',
                      )}
                    >
                      <span className="text-[10px] sm:text-[11px] text-body font-medium leading-none">{a.year}</span>
                      {a.age !== undefined && (
                        <span className={CHART.mutedSoft + ' mt-1 leading-none'}>{a.age}岁</span>
                      )}
                      <div className="flex items-end gap-[1px] mt-1.5">
                        <span className={`text-[15px] sm:text-[16px] font-bold leading-none ${wuxingColor(stem)}`}>{stem}</span>
                        {a.tenStar && <span className={CHART.mutedSoft + ' leading-none mb-[1px]'}>{a.tenStar}</span>}
                      </div>
                      <div className="flex items-end gap-[1px] mt-0.5">
                        <span className={`text-[15px] sm:text-[16px] font-bold leading-none ${wuxingColor(branch)}`}>{branch}</span>
                        {a.terrain && <span className={CHART.mutedSoft + ' leading-none mb-[1px]'}>{a.terrain}</span>}
                      </div>
                      {a.sound && (
                        <span className={CHART.mutedSoft + ' mt-1 text-[8px] leading-none'}>{a.sound}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 格局 */}
      {hasPattern && (
        <div className="bg-surface-card border border-hairline rounded-xl p-2.5 shadow-sm text-xs mt-2.5">
          <div className="flex items-center flex-wrap gap-2 mb-1.5">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-chart-badge text-chart-earth border border-hairline font-medium">
              格局
            </span>
            {data.pattern?.name && (
              <span className="text-ink font-semibold">{data.pattern.name}</span>
            )}
            {data.pattern?.reliability && (
              <span className="text-[10px] text-muted-soft">
                可信度: {data.pattern.reliability}
              </span>
            )}
          </div>
          {data.pattern?.description && (
            <p className="text-muted leading-relaxed text-[11px] sm:text-xs">
              {data.pattern.description}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
