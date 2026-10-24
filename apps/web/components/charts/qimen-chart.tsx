'use client';

import React, { useMemo } from 'react';
import { fullQimenGodName } from '@fateclaw/contracts/chat';
import { cn } from '@/utils/chart/cn';
import { CHART, WUXING_TEXT } from './chart-theme';
import {
  LUOSHU_ORDER,
  GUA_TO_GONG_NUMBER,
  GUA_TO_BRANCHES,
  MEN_WUXING,
  STAR_WUXING,
  STEM_WUXING_MAP,
  JIA_LIUYI_MAP,
  fullStarName,
} from '@/utils/chart/qimen-map';

const SHEN_WUXING: Record<string, '金' | '木' | '水' | '火' | '土'> = {
  值符: '土',
  腾蛇: '火',
  太阴: '金',
  六合: '木',
  勾陈: '土',
  朱雀: '火',
  太常: '土',
  白虎: '金',
  九地: '土',
  九天: '金',
  玄武: '水',
};
const CELL_MARK_TEXT = 'text-[clamp(8px,calc(6cqw_+_2px),13px)]';
const CELL_SIDE_TEXT = 'text-[clamp(9px,calc(6cqw_+_2px),14px)]';
const CELL_MAIN_TEXT = 'text-[clamp(11px,calc(18cqw_-_7px),30px)]';
const CELL_STEM_TEXT = 'text-[clamp(12px,calc(20cqw_-_8px),32px)]';
const CELL_STATE_TEXT = 'text-[clamp(8px,calc(7cqw_+_1px),15px)]';

function stemColor(stem?: string): string {
  if (!stem) return CHART.ink;
  const wx = STEM_WUXING_MAP[stem];
  return wx ? WUXING_TEXT[wx] : CHART.ink;
}
function menColor(men?: string): string {
  if (!men) return CHART.ink;
  const wx = MEN_WUXING[men];
  return wx ? WUXING_TEXT[wx] : CHART.ink;
}
function starColor(star?: string): string {
  if (!star) return CHART.ink;
  const wx = STAR_WUXING[star];
  return wx ? WUXING_TEXT[wx] : CHART.ink;
}
function shenColor(shen?: string): string {
  if (!shen) return CHART.ink;
  const wx = SHEN_WUXING[fullQimenGodName(shen)];
  return wx ? WUXING_TEXT[wx] : CHART.ink;
}

interface QimenData {
  盘式?: string;
  排盘方式?: string;
  干支?: string;
  旬首?: string;
  旬空?: { 日空?: string; 时空?: string };
  局日?: string;
  排局?: string;
  节气?: string;
  值符值使?: {
    值符天干?: string[];
    值符星宫?: string[];
    值使门宫?: string[];
  };
  天乙?: string;
  天盘?: Record<string, string>;
  地盘?: Record<string, string>;
  寄干?: Record<string, string>;
  寄宫干?: Record<string, string>;
  天盘寄干?: Record<string, string>;
  地盘寄干?: Record<string, string>;
  门?: Record<string, string>;
  星?: Record<string, string>;
  神?: Record<string, string>;
  暗干?: Record<string, string>;
  暗支?: Record<string, string>;
  马星?: Record<string, string>;
  长生运?: {
    天盘?: Record<string, { 天干?: string; 长生?: Record<string, string> }>;
    地盘?: Record<string, { 天干?: string; 长生?: Record<string, string> }>;
  };
  门迫?: Array<{ 门?: string; 宫?: string }>;
  击刑?: Array<{
    宫1?: string;
    宫2?: string;
    类型?: string;
    六仪?: string;
    落宫?: string;
  }>;
}

// 后天宫 → 先天宫（和 lyts-front 一致）
const HOU_TO_XIAN: Record<string, string> = {
  坎: '乾',
  坤: '离',
  震: '艮',
  巽: '兑',
  中: '坤',
  乾: '坎',
  兑: '巽',
  艮: '震',
  离: '坤',
};

// 长生运节点：{天干, 长生:{支:状态,...}} → 把状态值按地支顺序拼成短文案
function extractChangSheng(node?: {
  天干?: string;
  长生?: Record<string, string>;
}): string {
  if (!node || !node.长生) return '';
  const states = Object.values(node.长生).filter(Boolean);
  if (states.length === 0) return '';
  if (states.length === 1) return states[0];
  return states.join('·');
}

function parseSizhu(ganzhi?: string): [string, string, string, string] {
  if (!ganzhi) return ['', '', '', ''];
  const m = ganzhi.match(/(\S{2})年(\S{2})月(\S{2})日(\S{2})时/);
  if (!m) return ['', '', '', ''];
  return [m[1], m[2], m[3], m[4]];
}

function stemMarkClass(stem: string, dayGan: string, hourGan: string): string {
  return cn(
    stem === dayGan &&
      'underline decoration-success decoration-2 underline-offset-2',
    stem === hourGan &&
      'underline decoration-warning decoration-2 underline-offset-2',
  );
}

function StemGlyph({
  stem,
  dayGan,
  hourGan,
  className,
}: {
  stem: string;
  dayGan: string;
  hourGan: string;
  className?: string;
}) {
  if (!stem) return null;

  return (
    <span
      className={cn(
        stemColor(stem),
        stemMarkClass(stem, dayGan, hourGan),
        className,
      )}
    >
      {stem}
    </span>
  );
}

function StemColumn({
  state,
  stems,
  dayGan,
  hourGan,
  stateClassName,
}: {
  state?: string;
  stems: string[];
  dayGan: string;
  hourGan: string;
  stateClassName: string;
}) {
  const visibleStems = stems.filter(Boolean);
  if (visibleStems.length === 0) return null;

  return (
    <div className="grid justify-items-end gap-y-[1px] text-right">
      {state && (
        <div
          className={cn(
            CELL_STATE_TEXT,
            'max-w-[5.5em] truncate whitespace-nowrap font-medium leading-none',
            stateClassName,
          )}
          title={state}
        >
          {state}
        </div>
      )}
      <div
        className={cn(
          CELL_STEM_TEXT,
          'inline-flex items-baseline justify-end gap-[0.04em] font-bold leading-none',
        )}
      >
        {visibleStems.map((stem, index) => (
          <StemGlyph
            key={`${stem}-${index}`}
            stem={stem}
            dayGan={dayGan}
            hourGan={hourGan}
          />
        ))}
      </div>
    </div>
  );
}

function resolveSkyJiGan(gua: string, data: QimenData): string {
  if (data.盘式 === '鸣法') return '';
  // 天盘中宫随天禽寄到芮禽所在宫；若后端显式给天盘寄干，则优先使用。
  const centerGan = data.天盘?.中 ?? '';
  const star = data.星?.[gua] ?? '';
  return (
    data.天盘寄干?.[gua] ??
    data.寄干?.[gua] ??
    (centerGan && star.includes('禽') ? centerGan : '')
  );
}

function resolveEarthJiGan(gua: string, data: QimenData): string {
  if (data.盘式 === '鸣法') return '';
  // 地盘中宫固定寄坤；若后端显式给地盘寄干，则优先使用。
  return (
    data.地盘寄干?.[gua] ??
    data.寄宫干?.[gua] ??
    (gua === '坤' ? (data.地盘?.中 ?? data.天盘?.中 ?? '') : '')
  );
}

function PalaceCell({
  gua,
  data,
  dayGan,
  hourGan,
  zhifuStar,
  zhishiMen,
  hasMenPo,
  hasJiXing,
  kongwangBranches,
  maxingBranches,
  hexagramName,
}: {
  gua: string;
  data: QimenData;
  dayGan: string;
  hourGan: string;
  zhifuStar: string;
  zhishiMen: string;
  hasMenPo: boolean;
  hasJiXing: boolean;
  kongwangBranches: string[];
  maxingBranches: string[];
  hexagramName?: string;
}) {
  const isCenter = gua === '中';
  const tianGan = data.天盘?.[gua] ?? '';
  const diGan = data.地盘?.[gua] ?? '';
  const darkGan = data.暗干?.[gua] ?? '';
  const darkZhi = data.暗支?.[gua] ?? '';
  const skyJiGan = resolveSkyJiGan(gua, data);
  const earthJiGan = resolveEarthJiGan(gua, data);
  const men = data.门?.[gua] ?? '';
  const star = data.星?.[gua] ?? '';
  const shen = data.神?.[gua] ?? '';
  const tianState = extractChangSheng(data.长生运?.天盘?.[gua]);
  const diState = extractChangSheng(data.长生运?.地盘?.[gua]);
  const gongNumber = GUA_TO_GONG_NUMBER[gua];
  const branches = GUA_TO_BRANCHES[gua] ?? [];
  const isKongWang = branches.some((b) => kongwangBranches.includes(b));
  const isMaxing = branches.some((b) => maxingBranches.includes(b));
  const xianTian = HOU_TO_XIAN[gua];
  const xianTianNumber = xianTian ? GUA_TO_GONG_NUMBER[xianTian] : null;

  if (isCenter && data.盘式 !== '鸣法') {
    return (
      <div className="relative aspect-square [container-type:inline-size] flex flex-col items-center justify-center bg-surface-soft border border-hairline rounded-md shadow-sm [padding:clamp(0.25rem,2cqw,0.625rem)]">
        <div
          className={cn(
            'absolute top-0.5 right-1 font-medium',
            CELL_SIDE_TEXT,
            CHART.mutedSoft,
          )}
        >
          {gongNumber ?? 5}
        </div>
        <div className="flex flex-col items-center text-center px-0.5">
          <div
            className={cn(CELL_STATE_TEXT, 'font-medium mb-0.5', CHART.muted)}
          >
            {hexagramName ? '时干演卦' : '中宫'}
          </div>
          {hexagramName ? (
            <div
              className={cn(
                CELL_MAIN_TEXT,
                'font-bold leading-tight',
                CHART.ink,
              )}
            >
              {hexagramName}
            </div>
          ) : (
            <>
              {tianGan && (
                <div
                  className={cn(
                    CELL_STEM_TEXT,
                    'font-bold leading-none',
                    stemColor(tianGan),
                  )}
                >
                  {tianGan}
                </div>
              )}
              {data.排局 && (
                <div
                  className={cn(
                    CELL_STATE_TEXT,
                    'mt-0.5 leading-tight truncate max-w-full',
                    CHART.body,
                  )}
                >
                  {data.排局}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  const shenFull = fullQimenGodName(shen);
  const starFull = star ? fullStarName(star) : '';
  const menFull = men ? `${men}门` : '';
  const hasZhifuMark = star && star === zhifuStar;
  const hasZhishiMark = men && men === zhishiMen;
  const upperStems = [
    skyJiGan && skyJiGan !== tianGan ? skyJiGan : '',
    tianGan,
  ];
  const lowerStems = [
    earthJiGan && earthJiGan !== diGan ? earthJiGan : '',
    diGan,
  ];

  return (
    <div className="relative grid aspect-square [container-type:inline-size] grid-rows-[auto_minmax(0,1fr)_auto] gap-y-[clamp(0.125rem,1cqw,0.375rem)] overflow-hidden rounded-md border border-hairline bg-surface-card [padding:clamp(0.25rem,2cqw,0.625rem)] shadow-sm">
      {/* 顶部：轻量标记 + 宫号 */}
      <div className="flex justify-between items-start gap-0.5">
        <div className="flex gap-0.5 flex-wrap">
          {isMaxing && (
            <span className={cn(CELL_MARK_TEXT, 'leading-none')} title="马星">
              🐎
            </span>
          )}
          {isKongWang && (
            <span
              className={cn(
                CELL_MARK_TEXT,
                'font-semibold leading-none text-chart-earth',
              )}
              title="空亡"
            >
              ○
            </span>
          )}
        </div>
        <div
          className={cn(
            CELL_SIDE_TEXT,
            'font-medium whitespace-nowrap shrink-0',
            CHART.muted,
          )}
        >
          {xianTianNumber ? `${xianTianNumber}→${gongNumber}` : gongNumber}
        </div>
      </div>

      {/* 主体：参考传统盘式，左侧放神、暗干/星、门，右侧竖列放天盘干与寄干/地盘干。 */}
      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_auto] items-stretch gap-x-[clamp(0.25rem,2.2cqw,0.875rem)]">
        <div className="grid min-w-0 content-around gap-y-[clamp(0.125rem,1cqw,0.375rem)]">
          {shen && (
            <div
              className={cn(
                CELL_MAIN_TEXT,
                'truncate font-semibold leading-tight',
                shenColor(shen),
              )}
            >
              {shenFull}
            </div>
          )}
          {(star || darkGan || darkZhi) && (
            <div
              className={cn(
                CELL_MAIN_TEXT,
                'flex min-w-0 items-baseline gap-[0.08em] font-semibold leading-tight',
              )}
            >
              {darkGan && (
                <StemGlyph
                  stem={darkGan}
                  dayGan={dayGan}
                  hourGan={hourGan}
                  className={CHART.muted}
                />
              )}
              {darkZhi && (
                <span
                  className={cn(CELL_SIDE_TEXT, 'shrink-0', CHART.muted)}
                  title="暗支"
                >
                  {darkZhi}
                </span>
              )}
              {star && (
                <span
                  className={cn(
                    'min-w-0 truncate',
                    starColor(star),
                    hasZhifuMark &&
                      'underline decoration-error decoration-2 underline-offset-2',
                  )}
                >
                  {starFull}
                </span>
              )}
            </div>
          )}
          {men && (
            <span
              className={cn(
                CELL_MAIN_TEXT,
                'block truncate font-semibold whitespace-nowrap leading-tight',
                menColor(men),
                hasZhishiMark &&
                  'underline decoration-primary decoration-2 underline-offset-2',
              )}
            >
              {menFull}
              {hasMenPo && (
                <span
                  className={cn(CELL_MARK_TEXT, 'ml-0.5 text-error font-bold')}
                >
                  迫
                </span>
              )}
              {hasJiXing && (
                <span
                  className={cn(
                    CELL_MARK_TEXT,
                    'ml-0.5 text-warning font-bold',
                  )}
                >
                  刑
                </span>
              )}
            </span>
          )}
        </div>
        <div className="grid min-w-[clamp(1.35rem,18cqw,4.5rem)] content-around justify-items-end">
          <StemColumn
            state={tianState}
            stems={upperStems}
            dayGan={dayGan}
            hourGan={hourGan}
            stateClassName={CHART.muted}
          />
          <StemColumn
            state={diState}
            stems={lowerStems}
            dayGan={dayGan}
            hourGan={hourGan}
            stateClassName={CHART.mutedSoft}
          />
        </div>
      </div>
    </div>
  );
}

export default function QimenChart({ data }: { data: QimenData }) {
  const sizhu = useMemo(() => parseSizhu(data?.干支), [data?.干支]);
  const dayPillar = sizhu[2];
  const hourPillar = sizhu[3];
  const dayGanRaw = dayPillar[0] ?? '';
  const dayZhi = dayPillar[1] ?? '';
  const hourGanRaw = hourPillar[0] ?? '';
  const hourZhi = hourPillar[1] ?? '';
  const dayGan =
    dayGanRaw === '甲'
      ? (JIA_LIUYI_MAP[`甲${dayZhi}`] ?? dayGanRaw)
      : dayGanRaw;
  const hourGan =
    hourGanRaw === '甲'
      ? (JIA_LIUYI_MAP[`甲${hourZhi}`] ?? hourGanRaw)
      : hourGanRaw;

  const zhifuStar = data?.值符值使?.值符星宫?.[0] ?? '';
  const zhifuGong = data?.值符值使?.值符星宫?.[1] ?? '';
  const zhishiMen = data?.值符值使?.值使门宫?.[0] ?? '';
  const zhishiGong = data?.值符值使?.值使门宫?.[1] ?? '';

  const menPoGuas = useMemo(
    () =>
      new Set(
        (data?.门迫 ?? [])
          .map((m) => (m.宫 ?? '').replace('宫', ''))
          .filter(Boolean),
      ),
    [data?.门迫],
  );
  const jiXingGuas = useMemo(() => {
    const s = new Set<string>();
    (data?.击刑 ?? []).forEach((j) => {
      if (j.宫1) s.add(j.宫1.replace('宫', ''));
      if (j.宫2) s.add(j.宫2.replace('宫', ''));
    });
    return s;
  }, [data?.击刑]);

  const kongwangBranches = useMemo(() => {
    const shi = data?.旬空?.时空 ?? '';
    // 奇门九宫空亡按时旬空落宫；旧数据缺时空时再退回日空。
    return Array.from(shi || data?.旬空?.日空 || '');
  }, [data?.旬空]);

  const maxingBranches = useMemo(() => {
    const yiMa = data?.马星?.驿马 ?? '';
    return yiMa ? [yiMa] : [];
  }, [data?.马星]);

  if (!data || !data.天盘) {
    return (
      <div className="text-center text-muted text-[12px] py-6 bg-surface-card border border-hairline rounded-lg">
        奇门盘数据为空
      </div>
    );
  }

  return (
    <div className="w-full bg-surface-card border border-hairline rounded-lg shadow-sm overflow-hidden font-sans text-ink">
      {/* 顶部信息 */}
      <div className="p-1.5 @[480px]/artifact:p-2.5 border-b border-hairline bg-surface-soft">
        {data.盘式 && (
          <div className="mb-1 text-[10px] font-medium text-muted @[480px]/artifact:text-xs">
            {data.盘式} · {data.排盘方式 || '拆补'}
          </div>
        )}
        {/* 四柱 */}
        <div className="flex gap-1 @[480px]/artifact:gap-2">
          {(['年柱', '月柱', '日柱', '时柱'] as const).map((label, idx) => (
            <div
              key={idx}
              className="flex-1 min-w-0 py-1 bg-canvas border border-hairline rounded flex flex-col items-center shadow-sm"
            >
              <div className="text-[8px] @[480px]/artifact:text-[10px] text-chart-earth leading-none mb-0.5">
                {label}
              </div>
              <div className="text-[11px] @[480px]/artifact:text-sm font-semibold text-ink tracking-tight">
                {sizhu[idx] || '-'}
              </div>
            </div>
          ))}
        </div>
        {/* 局数/旬首/值符/值使 */}
        <div className="mt-1 @[480px]/artifact:mt-1.5 grid grid-cols-2 gap-1 @[480px]/artifact:gap-1.5 text-[10px] @[480px]/artifact:text-xs">
          <div className="flex items-center justify-between bg-canvas border border-hairline-soft px-1.5 py-1 rounded">
            <span className={cn('font-medium shrink-0', CHART.muted)}>
              排局
            </span>
            <span className="text-ink font-semibold ml-1 truncate">
              {data.排局 ?? '-'}
            </span>
          </div>
          <div className="flex items-center justify-between bg-canvas border border-hairline-soft px-1.5 py-1 rounded">
            <span className={cn('font-medium shrink-0', CHART.muted)}>
              旬首
            </span>
            <span className="text-ink font-semibold ml-1 truncate">
              {data.旬首 ?? '-'}
            </span>
          </div>
          <div className="flex items-center justify-between bg-canvas border border-hairline-soft px-1.5 py-1 rounded">
            <span className={cn('font-medium shrink-0', CHART.muted)}>
              值符
            </span>
            <span className="text-ink font-semibold ml-1 truncate">
              {zhifuStar ? `${fullStarName(zhifuStar)}·${zhifuGong}` : '-'}
            </span>
          </div>
          <div className="flex items-center justify-between bg-canvas border border-hairline-soft px-1.5 py-1 rounded">
            <span className={cn('font-medium shrink-0', CHART.muted)}>
              值使
            </span>
            <span className="text-ink font-semibold ml-1 truncate">
              {zhishiMen ? `${zhishiMen}门·${zhishiGong}` : '-'}
            </span>
          </div>
        </div>
      </div>

      {/* 3x3 九宫格 */}
      <div className="p-1 @[480px]/artifact:p-2">
        <div className="grid grid-cols-3 gap-1 @[480px]/artifact:gap-2">
          {LUOSHU_ORDER.map((gua) => (
            <PalaceCell
              key={gua}
              gua={gua}
              data={data}
              dayGan={dayGan}
              hourGan={hourGan}
              zhifuStar={zhifuStar}
              zhishiMen={zhishiMen}
              hasMenPo={menPoGuas.has(gua)}
              hasJiXing={jiXingGuas.has(gua)}
              kongwangBranches={kongwangBranches}
              maxingBranches={maxingBranches}
            />
          ))}
        </div>
      </div>

      {/* 图例 */}
      <div className="px-2 @[480px]/artifact:px-3 py-1 border-t border-hairline-soft bg-surface-soft flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] @[480px]/artifact:text-[10px] text-muted">
        <span>
          <span className="underline decoration-error decoration-2 underline-offset-2">
            值符
          </span>
        </span>
        <span>
          <span className="underline decoration-primary decoration-2 underline-offset-2">
            值使
          </span>
        </span>
        <span>
          <span className="underline decoration-success decoration-2 underline-offset-2">
            日干
          </span>
        </span>
        <span>
          <span className="underline decoration-warning decoration-2 underline-offset-2">
            时干
          </span>
        </span>
        <span className="text-error font-bold">迫</span>
        <span className="text-warning font-bold">刑</span>
      </div>
    </div>
  );
}
