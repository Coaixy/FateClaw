'use client';

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/utils/chart/cn';
import type { IchingGua, IchingYao } from '@/utils/chart/iching-utils';
import { CHART } from './chart-theme';

interface GanZhi {
  tian?: string;
  di?: string;
  gz?: string;
}

interface LiuyaoData {
  method?: string;
  benGua: IchingGua;
  zhiGua: IchingGua;
  huGua?: IchingGua;
  ganZhiYear?: GanZhi;
  ganZhiMonth?: GanZhi;
  ganZhiDay?: GanZhi;
  ganZhiHour?: GanZhi;
  solarTerm?: string;
  dayKong?: string;
  hourKong?: string;
  monthJian?: string;
  dongYaoCount?: number;
  shenSha?: ShenShaData;
  explanation?: string;
}

type ShenShaData = Record<string, string[] | undefined>;

interface FuShenDisplay {
  kind: '伏' | '旁';
  liuQin: string;
  naJiaWuXing: string;
  naYin?: string;
}

const YAO_META_BADGE_CLASS =
  'inline-flex w-fit rounded-md border border-hairline-soft bg-chart-badge px-1 py-px text-[10px] sm:text-[11px] font-medium leading-tight whitespace-nowrap';
const YAO_CORE_BADGE_CLASS =
  'inline-flex w-fit items-center justify-center rounded-md border border-hairline bg-canvas px-1 py-0.5 text-[11px] sm:text-base font-semibold leading-tight whitespace-nowrap';
const YAO_LIUSHOU_BADGE_CLASS =
  'inline-flex min-w-[1.55rem] sm:min-w-[2rem] items-center justify-center rounded-md border border-primary bg-primary px-1 py-0.5 text-[11px] sm:text-base font-bold leading-tight text-on-primary whitespace-nowrap';

const METHOD_LABEL: Record<string, string> = {
  dayan: '大衍筮法',
  lueshifa: '略筮法',
  manual: '手动指定',
  three: '三数起卦',
  array: '数字起卦',
  time: '时间起卦',
};

function formatMethod(method?: string): string {
  if (!method) return '';
  // 后端保留英文 method code，盘面展示时转成中文，避免 lueshifa 这类内部值破坏视觉一致性。
  return METHOD_LABEL[method] ?? method;
}

function formatFuShenNaJia(
  fu: NonNullable<IchingGua['fuShen']>[number],
): string {
  return `${fu.fuNaJia ?? ''}${fu.fuWuXing ?? ''}`;
}

function resolveFuShenHostIndex(
  fu: NonNullable<IchingGua['fuShen']>[number],
): number | null {
  const hostPosition = Number(fu.hostPosition);
  if (
    !Number.isInteger(hostPosition) ||
    hostPosition < 1 ||
    hostPosition > 6
  ) {
    return null;
  }
  return hostPosition - 1;
}

function buildFuShenByHost(
  gua: IchingGua | undefined,
): Record<number, FuShenDisplay[]> {
  const map: Record<number, FuShenDisplay[]> = {};
  if (!gua?.yaoList) return map;

  const addRows = (
    rows: NonNullable<IchingGua['fuShen']> | undefined,
    kind: FuShenDisplay['kind'],
  ) => {
    if (!rows?.length) return;

    rows.forEach((fu) => {
      const hostIndex = resolveFuShenHostIndex(fu);
      if (hostIndex == null) return;

      map[hostIndex] = [
        ...(map[hostIndex] ?? []),
        {
          kind,
          liuQin: fu.fuLiuQin,
          naJiaWuXing: formatFuShenNaJia(fu),
          naYin: fu.fuNaYin,
        },
      ];
    });
  };

  addRows(gua.fuShen, '伏');
  addRows(gua.pangFuShen, '旁');
  return map;
}

function formatShenShaItems(shenSha?: ShenShaData) {
  if (!shenSha) return [];

  return Object.entries(shenSha)
    .map(([name, value]) => {
      const target = value?.filter(Boolean).join('·') ?? '';
      return target ? { name, target } : null;
    })
    .filter((item): item is { name: string; target: string } =>
      Boolean(item),
    );
}

function YaoBar({ isYang: yang }: { isYang: boolean }) {
  const base = CHART.line;
  const h = 'h-2.5 sm:h-3.5';
  if (yang) {
    return <div className={`w-8 sm:w-16 ${h} ${base} rounded-[2px]`} />;
  }
  return (
    <div className="flex w-8 sm:w-16 justify-between">
      <div className={`w-[42%] ${h} ${base} rounded-[2px]`} />
      <div className={`w-[42%] ${h} ${base} rounded-[2px]`} />
    </div>
  );
}

function formatSuiXian(yao: IchingYao): string | null {
  if (!yao.suiXian) return null;
  return `岁限 ${yao.suiXian.startAge}-${yao.suiXian.endAge}`;
}

function formatYaoExtra(yao: IchingYao): string | null {
  // 星宿 / 锁泊在盘面上只展示值，保持每爻信息紧凑。
  const items = [
    yao.xingXiu,
    yao.suoBo,
  ].filter(Boolean);
  return items.length > 0 ? items.join(' · ') : null;
}

function YaoRow({
  benYao,
  bianYao,
  fuShen,
}: {
  benYao: IchingYao;
  bianYao: IchingYao;
  fuShen?: FuShenDisplay[];
}) {
  const isMoving = benYao.isMoving || benYao.yaoValue !== bianYao.yaoValue;
  const benIsYang = benYao.yaoValue === 7 || benYao.yaoValue === 9;
  const bianIsYang = bianYao.yaoValue === 7 || bianYao.yaoValue === 9;
  const fuShenRows = fuShen ?? [];
  const benSuiXian = formatSuiXian(benYao);
  const bianSuiXian = formatSuiXian(bianYao);
  const benExtra = formatYaoExtra(benYao);
  const bianExtra = formatYaoExtra(bianYao);

  return (
    <div className="flex items-center justify-between py-1.5 sm:py-2.5 border-b border-hairline-soft last:border-0 hover:bg-chart-highlight">
      {/* LEFT: 本卦 */}
      <div className="flex-1 flex items-center justify-end gap-0.5 sm:gap-2 relative">
        {/* 六兽 */}
        <span className={cn(YAO_LIUSHOU_BADGE_CLASS, 'select-none shrink-0')}>
          {benYao.liuShou}
        </span>

        {/* 六亲 + 纳甲五行 */}
        <div className="grid grid-cols-[auto_auto] items-center justify-end justify-items-end gap-x-0.5 sm:gap-x-1 whitespace-nowrap min-w-[4.25rem] sm:min-w-[5.25rem]">
          <span className={cn(YAO_CORE_BADGE_CLASS, CHART.ink)}>
            {benYao.liuQin}
          </span>
          <span className={cn(YAO_CORE_BADGE_CLASS, CHART.ink)}>
            {benYao.naJia}
            {benYao.wuXing}
          </span>
          {(benYao.naYin || benSuiXian) && (
            <span
              className={cn(
                'col-span-2 mt-0.5 justify-self-end',
                YAO_META_BADGE_CLASS,
                CHART.muted,
              )}
            >
              {[benYao.naYin ? `纳音 ${benYao.naYin}` : null, benSuiXian]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
          {benExtra && (
            <span
              className={cn(
                'col-span-2 mt-0.5 justify-self-end',
                YAO_META_BADGE_CLASS,
                CHART.earth,
              )}
            >
              {benExtra}
            </span>
          )}
          {fuShenRows.length > 0 && (
            <div className="col-span-2 mt-0.5 flex flex-col items-end gap-0.5 sm:gap-1 leading-none">
              {fuShenRows.map((item, index) => (
                <div
                  key={`${item.kind}-${index}-${item.naJiaWuXing}`}
                  className={cn(
                    'inline-grid grid-cols-[0.9rem_auto_auto] items-center justify-end gap-x-0.5 rounded-md border border-primary/20 bg-primary/10 px-1 py-px text-[10px] sm:text-[11px] font-semibold leading-tight whitespace-nowrap',
                    CHART.primary,
                  )}
                >
                  <span>{item.kind}</span>
                  <span>{item.liuQin}</span>
                  <span>
                    {item.naJiaWuXing}
                    {item.naYin ? ` ${item.naYin}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 世应 */}
        <div className="w-3 sm:w-6 flex items-center justify-center shrink-0">
          <span
            className={`text-[9px] sm:text-xs font-bold ${
              benYao.shiYing === '世' ? CHART.primary : CHART.muted
            }`}
          >
            {benYao.shiYing === '世' || benYao.shiYing === '應' || benYao.shiYing === '应'
              ? benYao.shiYing === '應'
                ? '应'
                : benYao.shiYing
              : ''}
          </span>
        </div>

        {/* 爻条 */}
        <div className="relative flex items-center justify-center w-9 sm:w-20 shrink-0">
          <YaoBar isYang={benIsYang} />
        </div>
      </div>

      {/* CENTER: 动爻箭头 */}
      <div className={cn('flex items-center justify-center w-6 sm:w-16 shrink-0 text-[9px] sm:text-xs select-none', CHART.muted)}>
        {isMoving && (
          <span className="flex items-center transform scale-75 sm:scale-100">
            <span className={CHART.primary}>X</span> <span className={cn('mx-0.5 sm:mx-1', CHART.lineMutedText)}>→</span>
          </span>
        )}
      </div>

      {/* RIGHT: 变卦 */}
      <div
        className={`flex-1 flex items-center justify-start gap-0.5 sm:gap-2 ${
          isMoving ? 'opacity-100' : 'opacity-60 grayscale'
        }`}
      >
        <div className="relative flex items-center justify-center w-9 sm:w-20 shrink-0">
          <YaoBar isYang={bianIsYang} />
        </div>
        <div className="w-3 sm:w-6 flex items-center justify-center shrink-0">
          <span
            className={`text-[9px] sm:text-xs font-bold ${
              bianYao.shiYing === '世' ? CHART.primary : CHART.muted
            }`}
          >
            {bianYao.shiYing === '世' || bianYao.shiYing === '應' || bianYao.shiYing === '应'
              ? bianYao.shiYing === '應'
                ? '应'
                : bianYao.shiYing
              : ''}
          </span>
        </div>
        <div className="flex flex-col items-start min-w-0">
          <div className="flex items-center gap-0.5 sm:gap-1 whitespace-nowrap">
            <span className={cn(YAO_CORE_BADGE_CLASS, CHART.ink)}>{bianYao.liuQin}</span>
            <span className={cn(YAO_CORE_BADGE_CLASS, CHART.ink)}>
              {bianYao.naJia}
              {bianYao.wuXing}
            </span>
          </div>
          {(bianYao.naYin || bianSuiXian) && (
            <div
              className={cn(
                'mt-0.5',
                YAO_META_BADGE_CLASS,
                CHART.muted,
              )}
            >
              {[bianYao.naYin ? `纳音 ${bianYao.naYin}` : null, bianSuiXian]
                .filter(Boolean)
                .join(' · ')}
            </div>
          )}
          {bianExtra && (
            <div
              className={cn(
                'mt-0.5',
                YAO_META_BADGE_CLASS,
                CHART.earth,
              )}
            >
              {bianExtra}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function gzLabel(g?: GanZhi): string {
  if (!g) return '';
  if (g.gz) return g.gz;
  return `${g.tian ?? ''}${g.di ?? ''}`;
}

export default function LiuyaoChart({ data }: { data: LiuyaoData }) {
  const {
    benGua,
    zhiGua,
    huGua,
    method,
    solarTerm,
    monthJian,
    dayKong,
    hourKong,
    dongYaoCount,
    ganZhiYear,
    ganZhiMonth,
    ganZhiDay,
    ganZhiHour,
    shenSha,
  } = data;

  const [scriptureOpen, setScriptureOpen] = useState(false);
  const hasScripture = !!(
    benGua?.yaoCi?.length ||
    benGua?.tuanCi ||
    zhiGua?.yaoCi?.length ||
    zhiGua?.tuanCi
  );

  const fuShenByHost = useMemo(() => buildFuShenByHost(benGua), [benGua]);
  const shenShaItems = useMemo(() => formatShenShaItems(shenSha), [shenSha]);

  if (!benGua?.yaoList || !zhiGua?.yaoList) {
    return (
      <div className="text-center text-muted text-[12px] py-6 bg-surface-card rounded-lg">
        六爻盘数据为空
      </div>
    );
  }

  const sizhu = [
    gzLabel(ganZhiYear),
    gzLabel(ganZhiMonth),
    gzLabel(ganZhiDay),
    gzLabel(ganZhiHour),
  ];
  const hasSizhu = sizhu.some(Boolean);

  // 空亡按柱位置对齐：日空→日柱(2)，时空→时柱(3)
  const kongCell = ['', '', dayKong ?? '', hourKong ?? ''];

  const indexOrder = [5, 4, 3, 2, 1, 0];
  const methodDisplay = formatMethod(method);

  return (
    <div className="w-full bg-surface-card border border-hairline rounded-lg shadow-sm overflow-hidden text-ink font-sans">
      {/* 起卦副信息 */}
      {(method || solarTerm || monthJian || typeof dongYaoCount === 'number') && (
        <div className="px-2 sm:px-5 py-2 sm:py-3 border-b border-hairline bg-surface-soft">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] sm:text-xs">
            {methodDisplay && (
              <div className="flex items-baseline gap-1 whitespace-nowrap">
                <span className="text-chart-earth font-medium">起卦</span>
                <span className="font-semibold text-ink">{methodDisplay}</span>
              </div>
            )}
            {solarTerm && (
              <div className="flex items-baseline gap-1 whitespace-nowrap">
                <span className="text-chart-earth font-medium">节气</span>
                <span className="font-semibold text-ink">{solarTerm}</span>
              </div>
            )}
            {monthJian && (
              <div className="flex items-baseline gap-1 whitespace-nowrap">
                <span className="text-chart-earth font-medium">月建</span>
                <span className="font-semibold text-ink">{monthJian}</span>
              </div>
            )}
            {typeof dongYaoCount === 'number' && (
              <div className="flex items-baseline gap-1 whitespace-nowrap">
                <span className="text-chart-earth font-medium">动爻</span>
                <span className="font-semibold text-ink">{dongYaoCount}爻</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 1. 干支 / 空亡 / 神煞 表 */}
      {hasSizhu && (
        <div className="border-b border-hairline">
          <div className="flex divide-x divide-hairline border-b border-hairline text-xs sm:text-sm text-center">
            <div className="w-10 sm:w-12 py-1.5 font-medium text-chart-earth bg-surface-soft flex items-center justify-center shrink-0">
              干支
            </div>
            {sizhu.map((bz, i) => (
              <div key={i} className="flex-1 py-1.5 font-bold text-ink bg-canvas">
                {bz || '-'}
              </div>
            ))}
          </div>
          <div className="flex divide-x divide-hairline text-xs sm:text-sm text-center bg-canvas">
            <div className="w-10 sm:w-12 py-1.5 font-medium text-chart-earth bg-surface-soft flex items-center justify-center shrink-0">
              空亡
            </div>
            {kongCell.map((v, i) => (
              <div key={i} className="flex-1 py-1.5 text-muted">
                {v || '-'}
              </div>
            ))}
          </div>
          {shenShaItems.length > 0 && (
            <div className="flex divide-x divide-hairline border-t border-hairline text-xs sm:text-sm bg-canvas">
              <div className="w-10 sm:w-12 py-1.5 font-medium text-chart-earth bg-surface-soft flex items-center justify-center shrink-0">
                神煞
              </div>
              <div className="flex-1 px-1.5 sm:px-2 py-1.5">
                <div className="flex flex-wrap items-center gap-1 text-[10px] sm:text-xs">
                  {shenShaItems.map((item) => (
                    <span
                      key={item.name}
                      className="inline-flex max-w-full flex-wrap items-baseline gap-x-1 rounded border border-hairline-soft bg-surface-soft px-1.5 py-0.5"
                    >
                      <span className="text-chart-earth font-medium">
                        {item.name}
                      </span>
                      <span className="text-ink font-semibold">
                        {item.target}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 2. 卦名 + 卦辞 */}
      <div className="flex items-start w-full px-1 sm:px-5 py-2.5 sm:py-3 bg-canvas">
        <div className="flex-1 flex flex-col justify-center items-center gap-1">
          <div className="font-bold text-sm sm:text-lg text-ink leading-none">
            {benGua.guaName ?? '本卦'}
          </div>
          {benGua.guaCi && (
            <div className="text-[10px] sm:text-xs text-body text-center leading-tight px-1">
              {benGua.guaCi}
            </div>
          )}
        </div>
        <div className="w-6 sm:w-16 shrink-0" />
        <div className="flex-1 flex flex-col justify-center items-center gap-1">
          <div className="font-bold text-sm sm:text-lg text-ink leading-none">
            {zhiGua.guaName ?? '变卦'}
          </div>
          {zhiGua.guaCi && (
            <div className="text-[10px] sm:text-xs text-body text-center leading-tight px-1">
              {zhiGua.guaCi}
            </div>
          )}
        </div>
      </div>

      {/* 3. 六爻主体 */}
      <div className="w-full pb-3 sm:pb-4">
        <div className="w-full px-1 sm:px-5">
          {indexOrder.map((i) => {
            const benYao = benGua.yaoList[i];
            const bianYao = zhiGua.yaoList[i];
            if (!benYao || !bianYao) return null;
            return (
              <YaoRow
                key={i}
                benYao={benYao}
                bianYao={bianYao}
                // 伏神按新版 hostPosition 存为 1 基爻位；这里用当前爻位换算到数组索引取对应伏神。
                fuShen={fuShenByHost[benYao.position - 1]}
              />
            );
          })}
        </div>
      </div>

      {/* 4. Footer 本卦 / 变卦 */}
      <div className="flex items-center w-full px-1 sm:px-5 py-1.5 sm:py-2 text-xs sm:text-sm font-bold text-primary bg-canvas border-t border-hairline-soft">
        <div className="flex-1 text-center">
          <span className="text-primary">
            本卦 {benGua.palace ? `(${benGua.palace}宫)` : ''}
          </span>
        </div>
        <div className="w-6 sm:w-16 shrink-0" />
        <div className="flex-1 text-center">
          <span className="text-primary">
            变卦 {zhiGua.palace ? `(${zhiGua.palace}宫)` : ''}
          </span>
        </div>
      </div>

      {/* 5. 互卦 */}
      {huGua?.guaName && (
        <div className="px-2 sm:px-5 py-1.5 border-t border-hairline flex items-center gap-2 text-xs sm:text-sm bg-canvas">
          <span className="text-muted shrink-0">互卦</span>
          <span className="text-ink font-medium">{huGua.guaName}</span>
          {huGua.palace && <span className="text-muted-soft">({huGua.palace}宫)</span>}
        </div>
      )}

      {/* 6. 经文（爻辞 / 彖辞）可折叠 */}
      {hasScripture && (
        <div className="border-t border-hairline bg-canvas">
          <button
            type="button"
            onClick={() => setScriptureOpen((v) => !v)}
            className="w-full flex items-center justify-between px-2 sm:px-5 py-1.5 text-xs sm:text-sm text-chart-earth hover:bg-chart-highlight transition-colors"
          >
            <span className="font-medium">卦爻辞 · 彖辞</span>
            {scriptureOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {scriptureOpen && (
            <div className="px-2 sm:px-5 pb-2.5 pt-0 space-y-2 text-[11px] sm:text-[12px] text-body leading-relaxed">
              <ScriptureBlock label="本卦" gua={benGua} />
              {zhiGua.guaName && zhiGua.guaName !== benGua.guaName && (
                <ScriptureBlock label="变卦" gua={zhiGua} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScriptureBlock({ label, gua }: { label: string; gua: IchingGua }) {
  const movingSet = useMemo(
    () => new Set((gua.yaoList ?? []).filter((y) => y.isMoving).map((y) => y.position)),
    [gua.yaoList],
  );

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-1.5 pt-1 border-t border-hairline-soft">
        <span className="text-[10px] sm:text-xs text-chart-earth font-medium whitespace-nowrap">
          {label}
        </span>
        <span className="text-ink font-semibold">{gua.guaName ?? '-'}</span>
        {gua.palace && (
          <span className="text-[10px] sm:text-xs text-muted-soft">({gua.palace}宫)</span>
        )}
      </div>

      {gua.guaCi && (
        <p className="text-body">
          <span className="text-muted mr-1">卦辞</span>
          {gua.guaCi}
        </p>
      )}

      {gua.yaoCi && gua.yaoCi.length > 0 && (
        <ul className="space-y-1">
          {gua.yaoCi.map((line, idx) => {
            const pos = idx + 1; // 爻辞索引 0..5 → 爻位 1..6
            const isMoving = movingSet.has(pos);
            return (
              <li
                key={idx}
                className={`flex gap-1.5 ${isMoving ? 'text-primary font-medium' : 'text-body'}`}
              >
                {isMoving && (
                  <span className="shrink-0 text-[10px] sm:text-xs text-primary mt-[1px]">●</span>
                )}
                <span className="flex-1">{line}</span>
              </li>
            );
          })}
        </ul>
      )}

      {gua.tuanCi && (
        <div>
          <div className="text-[10px] sm:text-xs text-muted mb-0.5">彖辞</div>
          <p className="text-body leading-relaxed">{gua.tuanCi}</p>
        </div>
      )}
    </div>
  );
}
