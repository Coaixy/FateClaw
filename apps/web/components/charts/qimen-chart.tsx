'use client';

import React, { useMemo } from 'react';
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
  SHEN_FULL_NAME,
  fullStarName,
} from '@/utils/chart/qimen-map';

const SHEN_WUXING: Record<string, '金' | '木' | '水' | '火' | '土'> = {
  符: '土', 蛇: '火', 阴: '金', 合: '木',
  勾: '土', 雀: '火',
  虎: '金', 地: '土', 天: '金', 玄: '水',
};

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
  const wx = SHEN_WUXING[shen];
  return wx ? WUXING_TEXT[wx] : CHART.ink;
}

interface QimenData {
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
  门?: Record<string, string>;
  星?: Record<string, string>;
  神?: Record<string, string>;
  暗干?: Record<string, string>;
  马星?: Record<string, string>;
  长生运?: {
    天盘?: Record<string, { 天干?: string; 长生?: Record<string, string> }>;
    地盘?: Record<string, { 天干?: string; 长生?: Record<string, string> }>;
  };
  门迫?: Array<{ 门?: string; 宫?: string }>;
  击刑?: Array<{ 宫1?: string; 宫2?: string; 类型?: string }>;
}

// 后天宫 → 先天宫（和 lyts-front 一致）
const HOU_TO_XIAN: Record<string, string> = {
  坎: '乾', 坤: '离', 震: '艮', 巽: '兑',
  中: '坤', 乾: '坎', 兑: '巽', 艮: '震', 离: '坤',
};

// 长生运节点：{天干, 长生:{支:状态,...}} → 把状态值按地支顺序拼成短文案
function extractChangSheng(node?: { 天干?: string; 长生?: Record<string, string> }): string {
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

function StemStack({
  stem,
  state,
  stateClassName,
  className,
}: {
  stem: string;
  state?: string;
  stateClassName: string;
  className?: string;
}) {
  if (!stem) return null;

  return (
    <div className="grid min-w-[1.35rem] shrink-0 justify-items-center gap-y-[1px]">
      <div className={cn(
        'text-[12px] sm:text-[14px] font-bold leading-none',
        stemColor(stem),
        className,
      )}>
        {stem}
      </div>
      {state && (
        <div
          className={cn(
            // 长生运是天干的附属信息，保持可读字号并限制宽度，避免小屏被压没、大屏被拉散。
            'max-w-[4.5em] truncate whitespace-nowrap text-[8px] sm:text-[10px] font-medium leading-none',
            stateClassName,
          )}
          title={state}
        >
          {state}
        </div>
      )}
    </div>
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

  if (isCenter) {
    return (
      <div className="relative p-1 aspect-square flex flex-col items-center justify-center bg-surface-soft border border-hairline rounded-md shadow-sm">
        <div className={cn('absolute top-0.5 right-1 text-[9px] sm:text-[11px] font-medium', CHART.mutedSoft)}>
          {gongNumber ?? 5}
        </div>
        <div className="flex flex-col items-center text-center px-0.5">
          <div className={cn('text-[8px] sm:text-[10px] font-medium mb-0.5', CHART.muted)}>
            {hexagramName ? '时干演卦' : '中宫'}
          </div>
          {hexagramName ? (
            <div className={cn('text-[11px] sm:text-base font-bold leading-tight', CHART.ink)}>
              {hexagramName}
            </div>
          ) : (
            <>
              {tianGan && (
                <div className={cn('text-[12px] sm:text-[15px] font-bold leading-none', stemColor(tianGan))}>
                  {tianGan}
                </div>
              )}
              {data.排局 && (
                <div className={cn('text-[8px] sm:text-[10px] mt-0.5 leading-tight truncate max-w-full', CHART.body)}>
                  {data.排局}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  const shenFull = SHEN_FULL_NAME[shen] ?? shen;
  const starFull = star ? fullStarName(star) : '';
  const menFull = men ? `${men}门` : '';
  const hasZhifuMark = star && star === zhifuStar;
  const hasZhishiMark = men && men === zhishiMen;

  return (
    <div className="relative grid aspect-square grid-rows-[auto_minmax(0,1fr)_auto] gap-y-0.5 overflow-hidden rounded-md border border-hairline bg-surface-card p-1 shadow-sm sm:p-1.5">
      {/* 顶部：标记 + 宫号 */}
      <div className="flex justify-between items-start gap-0.5">
        <div className="flex gap-0.5 flex-wrap">
          {isMaxing && (
            <span className="text-[8px] sm:text-[10px] px-0.5 bg-chart-badge text-chart-earth border border-hairline rounded leading-tight font-medium">
              马
            </span>
          )}
          {isKongWang && (
            <span className="text-[8px] sm:text-[10px] px-0.5 bg-chart-badge text-chart-earth border border-hairline rounded leading-tight font-medium">
              空
            </span>
          )}
        </div>
        <div className={cn('text-[8px] sm:text-[11px] font-medium whitespace-nowrap shrink-0', CHART.muted)}>
          {xianTianNumber ? `${xianTianNumber}→${gongNumber}` : gongNumber}
        </div>
      </div>

      {/* 中间：神居中 + 星/天盘一行。内容组设置最大宽度，避免宽屏时左右信息被宫格边缘拉开。 */}
      <div className="grid min-h-0 content-center gap-y-0.5">
        {shen && (
          <div className="mx-auto flex w-full max-w-[5.75rem] justify-center">
            <div className={cn('truncate text-[11px] sm:text-[13px] font-semibold leading-tight', shenColor(shen))}>
              {shenFull}
            </div>
          </div>
        )}
        <div className="mx-auto grid w-full max-w-[5.75rem] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1">
          <div className="min-w-0">
            {star && (
              <div className={cn(
                'truncate text-[11px] sm:text-[13px] font-semibold leading-tight',
                starColor(star),
                hasZhifuMark && 'underline decoration-error decoration-2 underline-offset-2',
              )}>
                {starFull}
              </div>
            )}
          </div>
          <StemStack
            stem={tianGan}
            state={tianState}
            stateClassName={CHART.muted}
            className={cn(
              tianGan === dayGan && 'underline decoration-success decoration-2 underline-offset-2',
              tianGan === hourGan && 'underline decoration-warning decoration-2 underline-offset-2',
            )}
          />
        </div>
      </div>

      {/* 底部：门 + 地盘干 */}
      <div className="mx-auto grid w-full max-w-[5.75rem] grid-cols-[minmax(0,1fr)_auto] items-end gap-x-1">
        <div className="min-w-0">
          {men && (
            <span className={cn(
              'block truncate text-[11px] sm:text-[13px] font-semibold whitespace-nowrap leading-tight',
              menColor(men),
              hasZhishiMark && 'underline decoration-primary decoration-2 underline-offset-2',
            )}>
              {menFull}
              {hasMenPo && (
                <span className="ml-0.5 text-[8px] sm:text-[10px] text-error font-bold">迫</span>
              )}
              {hasJiXing && (
                <span className="ml-0.5 text-[8px] sm:text-[10px] text-warning font-bold">刑</span>
              )}
            </span>
          )}
        </div>
        <StemStack
          stem={diGan}
          state={diState}
          stateClassName={CHART.mutedSoft}
        />
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
  const dayGan = dayGanRaw === '甲' ? (JIA_LIUYI_MAP[`甲${dayZhi}`] ?? dayGanRaw) : dayGanRaw;
  const hourGan = hourGanRaw === '甲' ? (JIA_LIUYI_MAP[`甲${hourZhi}`] ?? hourGanRaw) : hourGanRaw;

  const zhifuStar = data?.值符值使?.值符星宫?.[0] ?? '';
  const zhifuGong = data?.值符值使?.值符星宫?.[1] ?? '';
  const zhishiMen = data?.值符值使?.值使门宫?.[0] ?? '';
  const zhishiGong = data?.值符值使?.值使门宫?.[1] ?? '';

  const menPoGuas = useMemo(
    () => new Set((data?.门迫 ?? []).map((m) => (m.宫 ?? '').replace('宫', '')).filter(Boolean)),
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
    const arr: string[] = [];
    const shi = data?.旬空?.时空 ?? '';
    const ri = data?.旬空?.日空 ?? '';
    arr.push(...Array.from(shi));
    arr.push(...Array.from(ri));
    return arr;
  }, [data?.旬空]);

  const maxingBranches = useMemo(
    () => (Object.values(data?.马星 ?? {}) as string[]).filter(Boolean),
    [data?.马星],
  );

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
      <div className="p-1.5 sm:p-2.5 border-b border-hairline bg-surface-soft">
        {/* 四柱 */}
        <div className="flex gap-1 sm:gap-2">
          {(['年柱', '月柱', '日柱', '时柱'] as const).map((label, idx) => (
            <div
              key={idx}
              className="flex-1 min-w-0 py-1 bg-canvas border border-hairline rounded flex flex-col items-center shadow-sm"
            >
              <div className="text-[8px] sm:text-[10px] text-chart-earth leading-none mb-0.5">
                {label}
              </div>
              <div className="text-[11px] sm:text-sm font-semibold text-ink tracking-tight">
                {sizhu[idx] || '-'}
              </div>
            </div>
          ))}
        </div>
        {/* 局数/旬首/值符/值使 */}
        <div className="mt-1 sm:mt-1.5 grid grid-cols-2 gap-1 sm:gap-1.5 text-[10px] sm:text-xs">
          <div className="flex items-center justify-between bg-canvas border border-hairline-soft px-1.5 py-1 rounded">
            <span className={cn('font-medium shrink-0', CHART.muted)}>排局</span>
            <span className="text-ink font-semibold ml-1 truncate">{data.排局 ?? '-'}</span>
          </div>
          <div className="flex items-center justify-between bg-canvas border border-hairline-soft px-1.5 py-1 rounded">
            <span className={cn('font-medium shrink-0', CHART.muted)}>旬首</span>
            <span className="text-ink font-semibold ml-1 truncate">{data.旬首 ?? '-'}</span>
          </div>
          <div className="flex items-center justify-between bg-canvas border border-hairline-soft px-1.5 py-1 rounded">
            <span className={cn('font-medium shrink-0', CHART.muted)}>值符</span>
            <span className="text-ink font-semibold ml-1 truncate">
              {zhifuStar ? `${fullStarName(zhifuStar)}·${zhifuGong}` : '-'}
            </span>
          </div>
          <div className="flex items-center justify-between bg-canvas border border-hairline-soft px-1.5 py-1 rounded">
            <span className={cn('font-medium shrink-0', CHART.muted)}>值使</span>
            <span className="text-ink font-semibold ml-1 truncate">
              {zhishiMen ? `${zhishiMen}门·${zhishiGong}` : '-'}
            </span>
          </div>
        </div>
      </div>

      {/* 3x3 九宫格 */}
      <div className="p-1 sm:p-2">
        <div className="grid grid-cols-3 gap-1 sm:gap-2">
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
      <div className="px-2 sm:px-3 py-1 border-t border-hairline-soft bg-surface-soft flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] sm:text-[10px] text-muted">
        <span>
          <span className="underline decoration-error decoration-2 underline-offset-2">值符</span>
        </span>
        <span>
          <span className="underline decoration-primary decoration-2 underline-offset-2">值使</span>
        </span>
        <span>
          <span className="underline decoration-success decoration-2 underline-offset-2">日干</span>
        </span>
        <span>
          <span className="underline decoration-warning decoration-2 underline-offset-2">时干</span>
        </span>
        <span className="text-error font-bold">迫</span>
        <span className="text-warning font-bold">刑</span>
      </div>
    </div>
  );
}
