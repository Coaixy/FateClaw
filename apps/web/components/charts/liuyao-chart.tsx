'use client';

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/utils/chart/cn';
import {
  getShiYingLabel,
  type IchingGua,
  type IchingYao,
} from '@/utils/chart/iching-utils';
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

const YAO_BOARD_GRID_CLASS =
  'grid grid-cols-[clamp(1.75rem,5.5cqw,3.5rem)_clamp(3.5rem,13cqw,7rem)_minmax(0,1fr)_clamp(0.9rem,2.5cqw,2rem)_minmax(0,1fr)] gap-x-[clamp(0.15rem,0.85cqw,0.5rem)]';
const YAO_TEXT_CLASS =
  'text-[clamp(11px,2.55cqw,15px)]';
const YAO_SUB_TEXT_CLASS =
  'text-[clamp(9px,2.1cqw,13px)]';

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
  const h = 'h-[clamp(0.5rem,1.65cqw,0.875rem)]';
  const w = 'w-[clamp(1.75rem,7.8cqw,4rem)]';
  if (yang) {
    return <div className={`${w} ${h} ${base} rounded-[2px]`} />;
  }
  return (
    <div className={`flex ${w} justify-between`}>
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

function formatFuShenMobileDetail(item: FuShenDisplay): string {
  return `${item.kind}${item.liuQin} ${item.naJiaWuXing}${
    item.naYin ? ` ${item.naYin}` : ''
  }`;
}

function formatYaoMainExtra(yao: IchingYao): string {
  const extra = formatYaoExtra(yao);
  return extra ? `(${extra.replaceAll(' · ', ',')})` : '';
}

function formatYaoSubLine(yao: IchingYao): string {
  return [yao.naYin, formatSuiXian(yao)].filter(Boolean).join(' · ');
}

function formatFuShenMain(item: FuShenDisplay): string {
  return `${shortLiuQin(item.liuQin)}${item.naJiaWuXing.replace(
    /[金木水火土]$/,
    '',
  )}`;
}

function shortLiuQin(liuQin: string): string {
  const shortName: Record<string, string> = {
    兄弟: '兄',
    子孙: '子',
    妻财: '妻',
    父母: '父',
    官鬼: '官',
  };
  return shortName[liuQin] ?? liuQin;
}

function movingMark(yao: IchingYao, isMoving: boolean): string {
  if (!isMoving) return '';
  return yao.yaoValue === 6 ? 'x' : 'o';
}

function isMovingYao(benYao: IchingYao, bianYao: IchingYao): boolean {
  return benYao.isMoving || benYao.yaoValue !== bianYao.yaoValue;
}

function hasMovingYao(benGua: IchingGua, zhiGua: IchingGua): boolean {
  return benGua.yaoList.some((benYao, index) => {
    const bianYao = zhiGua.yaoList[index];
    return bianYao ? isMovingYao(benYao, bianYao) : false;
  });
}

function FuShenCell({ rows }: { rows: FuShenDisplay[] }) {
  if (rows.length === 0) {
    return <div aria-hidden="true" />;
  }

  return (
    <div className="min-w-0 space-y-0.5 self-start pt-0.5">
      {rows.map((item, index) => (
        <div
          key={`${item.kind}-${index}-${item.naJiaWuXing}`}
          className="min-w-0"
          title={formatFuShenMobileDetail(item)}
        >
          <div
            className={cn(
              YAO_TEXT_CLASS,
              'whitespace-nowrap font-semibold leading-tight',
              CHART.ink,
            )}
          >
            {formatFuShenMain(item)}
          </div>
          {item.naYin && (
            <div
              className={cn(
                YAO_SUB_TEXT_CLASS,
                'whitespace-normal break-keep leading-tight',
                CHART.body,
              )}
            >
              {item.naYin}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function GuaYaoCell({
  yao,
  isYang,
  dimmed,
  compact = false,
}: {
  yao: IchingYao;
  isYang: boolean;
  dimmed?: boolean;
  compact?: boolean;
}) {
  const shiYingLabel = getShiYingLabel(yao.shiYing);
  const subLine = formatYaoSubLine(yao);
  const mainExtra = formatYaoMainExtra(yao);
  const visibleMainExtra = compact ? '' : mainExtra;
  const naJiaWuXing = `${yao.naJia ?? ''}${yao.wuXing}`;
  const title = [yao.liuQin, naJiaWuXing, mainExtra, subLine]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cn('min-w-0', dimmed && 'opacity-[0.55]')} title={title}>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1 sm:gap-x-2">
        <div
          className={cn(
            compact ? 'text-[12px]' : YAO_TEXT_CLASS,
            'min-w-0 break-all font-semibold leading-tight sm:whitespace-nowrap sm:break-normal',
            CHART.ink,
          )}
        >
          <span>{shortLiuQin(yao.liuQin)}</span>
          <span>
            {naJiaWuXing}
            {visibleMainExtra}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-x-0.5 sm:gap-x-1">
          <span
            className={cn(
              'inline-flex w-[clamp(0.75rem,2.4cqw,1.2rem)] justify-center text-[clamp(10px,2.1cqw,15px)] font-bold leading-none',
              shiYingLabel ? CHART.ink : CHART.body,
            )}
          >
            {shiYingLabel}
          </span>
          <YaoBar isYang={isYang} />
        </div>
      </div>
      <div
        className={cn(
          compact ? 'text-[10px]' : YAO_SUB_TEXT_CLASS,
          'mt-0.5 min-h-[1em] whitespace-normal break-keep leading-tight',
          CHART.body,
        )}
      >
        {subLine}
      </div>
    </div>
  );
}

function YaoRow({
  benYao,
  bianYao,
  fuShen,
  hasMovingGua,
}: {
  benYao: IchingYao;
  bianYao: IchingYao;
  fuShen?: FuShenDisplay[];
  hasMovingGua: boolean;
}) {
  const isMoving = isMovingYao(benYao, bianYao);
  const benIsYang = benYao.yaoValue === 7 || benYao.yaoValue === 9;
  const bianIsYang = bianYao.yaoValue === 7 || bianYao.yaoValue === 9;
  const fuShenRows = fuShen ?? [];
  const dimBianYao = !hasMovingGua || !isMoving;

  return (
    <div
      className={cn(
        YAO_BOARD_GRID_CLASS,
        'items-start border-b border-hairline-soft py-[clamp(0.35rem,1.05cqw,0.5rem)] last:border-0 hover:bg-chart-highlight',
      )}
    >
      <div
        className={cn(
          YAO_TEXT_CLASS,
          'whitespace-nowrap pt-0.5 font-semibold leading-tight',
          CHART.ink,
        )}
      >
        {benYao.liuShou}
      </div>
      <FuShenCell rows={fuShenRows} />
      <GuaYaoCell yao={benYao} isYang={benIsYang} />
      <div
        className={cn(
          'flex min-h-[clamp(1rem,3.2cqw,1.25rem)] items-center justify-center pt-0.5 text-[clamp(11px,2.5cqw,18px)] font-bold leading-none select-none',
          CHART.ink,
        )}
      >
        {movingMark(benYao, isMoving)}
      </div>
      <GuaYaoCell yao={bianYao} isYang={bianIsYang} dimmed={dimBianYao} />
    </div>
  );
}

function MobileYaoRow({
  benYao,
  bianYao,
  fuShen,
  hasMovingGua,
}: {
  benYao: IchingYao;
  bianYao: IchingYao;
  fuShen?: FuShenDisplay[];
  hasMovingGua: boolean;
}) {
  const isMoving = isMovingYao(benYao, bianYao);
  const benIsYang = benYao.yaoValue === 7 || benYao.yaoValue === 9;
  const bianIsYang = bianYao.yaoValue === 7 || bianYao.yaoValue === 9;
  const fuShenRows = fuShen ?? [];
  const dimBianYao = !hasMovingGua || !isMoving;
  const mark = movingMark(benYao, isMoving);
  const pangFuShenRows = fuShenRows.filter((item) => item.kind === '旁');
  const mainFuShenRows = fuShenRows.filter((item) => item.kind === '伏');

  return (
    <div className="border-b border-hairline-soft px-1.5 py-1 last:border-0">
      <div className="mb-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] leading-tight">
        <span className={cn('shrink-0 font-semibold', CHART.ink)}>
          {benYao.liuShou}
        </span>
        {mark && (
          <span className={cn('ml-auto shrink-0 text-[13px] font-bold', CHART.ink)}>
            {mark}
          </span>
        )}
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-1.5">
        <div className="min-w-0 rounded-md border border-hairline-soft bg-canvas/60 px-1.5 py-1">
          <GuaYaoCell yao={benYao} isYang={benIsYang} compact />
        </div>
        <div className="min-w-0 rounded-md border border-hairline-soft bg-canvas/60 px-1.5 py-1">
          <GuaYaoCell
            yao={bianYao}
            isYang={bianIsYang}
            dimmed={dimBianYao}
            compact
          />
        </div>
      </div>
      {fuShenRows.length > 0 && (
        <MobileFuShenRow
          pangRows={pangFuShenRows}
          fuRows={mainFuShenRows}
        />
      )}
    </div>
  );
}

function MobileFuShenRow({
  pangRows,
  fuRows,
}: {
  pangRows: FuShenDisplay[];
  fuRows: FuShenDisplay[];
}) {
  const groups = [
    { label: '伏', rows: fuRows },
    { label: '旁', rows: pangRows },
  ].filter((group) => group.rows.length > 0);

  return (
    <div className="mt-0.5 min-w-0 rounded-md border border-hairline-soft bg-surface-soft px-1.5 py-0.5 text-[10px] leading-tight">
      <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-0.5">
        {groups.map((group) => (
          <div key={group.label} className="min-w-0 max-w-full">
            <span className="mr-1 font-medium text-chart-earth">
              {group.label}
            </span>
            {group.rows.map((item, index) => (
              <span
                key={`${item.kind}-${index}-${item.naJiaWuXing}`}
                className="mr-2 inline-block min-w-0 max-w-full"
                title={formatFuShenMobileDetail(item)}
              >
                <span className="font-semibold text-ink">
                  {item.liuQin}
                  {item.naJiaWuXing}
                </span>
                {item.naYin && (
                  <span className="ml-1 text-body">
                    {item.naYin}
                  </span>
                )}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
function gzLabel(g?: GanZhi): string {
  if (!g) return '';
  if (g.gz) return g.gz;
  return `${g.tian ?? ''}${g.di ?? ''}`;
}

function guaHeaderLabel(gua: IchingGua, fallback: string): string {
  const palaceLabel = `${gua.palace ?? ''}${gua.palaceLevel ?? ''}`;
  return [gua.guaName ?? fallback, palaceLabel].filter(Boolean).join(' ');
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
  const hasMovingGua = useMemo(
    () => (benGua?.yaoList && zhiGua?.yaoList ? hasMovingYao(benGua, zhiGua) : false),
    [benGua, zhiGua],
  );
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
  const dimStaticZhiGua = !hasMovingGua;

  return (
    <div className="w-full min-w-0 [container-type:inline-size] bg-surface-card border border-hairline rounded-lg shadow-sm overflow-hidden text-ink font-sans">
      {/* 起卦副信息 */}
      {(method || solarTerm || monthJian || typeof dongYaoCount === 'number') && (
        <div className="border-b border-hairline bg-surface-soft px-1.5 py-1 sm:px-5 sm:py-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] sm:gap-x-3 sm:gap-y-1 sm:text-[clamp(11px,2cqw,13px)]">
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
          <div className="flex divide-x divide-hairline border-b border-hairline text-center text-[10px] sm:text-[clamp(12px,2.35cqw,15px)]">
            <div className="flex w-8 shrink-0 items-center justify-center bg-surface-soft py-1 font-medium text-chart-earth sm:w-12 sm:py-1.5">
              干支
            </div>
            {sizhu.map((bz, i) => (
              <div key={i} className="flex-1 bg-canvas py-1 font-bold text-ink sm:py-1.5">
                {bz || '-'}
              </div>
            ))}
          </div>
          <div className="flex divide-x divide-hairline bg-canvas text-center text-[10px] sm:text-[clamp(12px,2.35cqw,15px)]">
            <div className="flex w-8 shrink-0 items-center justify-center bg-surface-soft py-1 font-medium text-chart-earth sm:w-12 sm:py-1.5">
              空亡
            </div>
            {kongCell.map((v, i) => (
              <div key={i} className="flex-1 py-1 text-muted sm:py-1.5">
                {v || '-'}
              </div>
            ))}
          </div>
          {shenShaItems.length > 0 && (
            <div className="flex divide-x divide-hairline border-t border-hairline bg-canvas text-[10px] sm:text-[clamp(12px,2.35cqw,15px)]">
              <div className="flex w-8 shrink-0 items-center justify-center bg-surface-soft py-1 font-medium text-chart-earth sm:w-12 sm:py-1.5">
                神煞
              </div>
              <div className="flex-1 px-1 py-1 sm:px-2 sm:py-1.5">
                <div className="flex flex-wrap items-center gap-0.5 text-[10px] sm:gap-1 sm:text-[clamp(11px,2cqw,13px)]">
                  {shenShaItems.map((item) => (
                    <span
                      key={item.name}
                      className="inline-flex max-w-full flex-wrap items-baseline gap-x-1 rounded border border-hairline-soft bg-surface-soft px-1 py-0.5 sm:px-1.5"
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

      {/* 2. 列头：桌面端和六爻主体共用列轨，确保标题、伏神、本卦、变卦一眼对齐。 */}
      <div
        className={cn(
          YAO_BOARD_GRID_CLASS,
          'hidden w-full items-start border-b border-hairline-soft bg-canvas px-[clamp(0.5rem,2.6cqw,1.25rem)] py-[clamp(0.65rem,1.8cqw,0.75rem)] sm:grid',
        )}
      >
        <div
          className={cn(
            YAO_TEXT_CLASS,
            'text-center font-bold leading-tight',
            CHART.ink,
          )}
        >
          六神
        </div>
        <div
          className={cn(
            YAO_TEXT_CLASS,
            'text-center font-bold leading-tight',
            CHART.ink,
          )}
        >
          伏神
        </div>
        <div className="flex min-w-0 flex-col items-center justify-center gap-1">
          <div className="whitespace-normal break-keep text-center text-[clamp(12px,2.55cqw,18px)] font-bold leading-tight text-ink">
            {guaHeaderLabel(benGua, '本卦')}
          </div>
          {benGua.guaCi && (
            <div className="max-w-full whitespace-normal break-keep px-1 text-center text-[clamp(8px,1.6cqw,12px)] leading-tight text-body">
              {benGua.guaCi}
            </div>
          )}
        </div>
        <div aria-hidden="true" />
        <div
          className={cn(
            'flex min-w-0 flex-col items-center justify-center gap-1',
            dimStaticZhiGua && 'opacity-[0.55]',
          )}
        >
          <div className="whitespace-normal break-keep text-center text-[clamp(12px,2.55cqw,18px)] font-bold leading-tight text-ink">
            {guaHeaderLabel(zhiGua, '变卦')}
          </div>
          {zhiGua.guaCi && (
            <div className="max-w-full whitespace-normal break-keep px-1 text-center text-[clamp(8px,1.6cqw,12px)] leading-tight text-body">
              {zhiGua.guaCi}
            </div>
          )}
        </div>
      </div>

      {/* 移动端改为分块布局，避免五列表格在窄屏挤压本卦、变卦和伏神文本。 */}
      <div className="grid grid-cols-2 gap-2 border-b border-hairline-soft bg-canvas px-2 py-1.5 sm:hidden">
        <div className="min-w-0 text-center">
          <div className="break-keep text-[13px] font-bold leading-tight text-ink">
            {guaHeaderLabel(benGua, '本卦')}
          </div>
        </div>
        <div className={cn('min-w-0 text-center', dimStaticZhiGua && 'opacity-[0.55]')}>
          <div className="break-keep text-[13px] font-bold leading-tight text-ink">
            {guaHeaderLabel(zhiGua, '变卦')}
          </div>
        </div>
      </div>

      {/* 3. 六爻主体 */}
      <div className="hidden w-full pb-3 sm:block sm:pb-4">
        <div className="w-full px-[clamp(0.5rem,2.6cqw,1.25rem)]">
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
                hasMovingGua={hasMovingGua}
              />
            );
          })}
        </div>
      </div>
      <div className="w-full pb-2 sm:hidden">
        {indexOrder.map((i) => {
          const benYao = benGua.yaoList[i];
          const bianYao = zhiGua.yaoList[i];
          if (!benYao || !bianYao) return null;
          return (
            <MobileYaoRow
              key={i}
              benYao={benYao}
              bianYao={bianYao}
              fuShen={fuShenByHost[benYao.position - 1]}
              hasMovingGua={hasMovingGua}
            />
          );
        })}
      </div>

      {/* 4. Footer 本卦 / 变卦 */}
      <div
        className={cn(
          YAO_BOARD_GRID_CLASS,
          'hidden w-full items-center border-t border-hairline-soft bg-canvas px-[clamp(0.5rem,2.6cqw,1.25rem)] py-[clamp(0.4rem,1.2cqw,0.5rem)] text-[clamp(9px,1.8cqw,14px)] font-bold text-ink sm:grid',
        )}
      >
        <div aria-hidden="true" />
        <div aria-hidden="true" />
        <div className="min-w-0 text-center">
          <span className="text-ink">
            本卦 {benGua.palace ? `(${benGua.palace}宫)` : ''}
          </span>
        </div>
        <div aria-hidden="true" />
        <div className={cn('min-w-0 text-center', dimStaticZhiGua && 'opacity-[0.55]')}>
          <span className="text-ink">
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
                className={`flex gap-1.5 ${isMoving ? 'text-ink font-medium' : 'text-body'}`}
              >
                {isMoving && (
                  <span className="shrink-0 text-[10px] sm:text-xs text-ink mt-[1px]">●</span>
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
