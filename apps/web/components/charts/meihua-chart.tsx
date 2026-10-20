'use client';

import { CHART, WUXING_TEXT } from './chart-theme';

type MeihuaLineValue = 'yin' | 'yang';

interface MeihuaTrigram {
  name?: string;
  nature?: string;
  element?: string;
}

interface MeihuaHexagram {
  fullName?: string;
  name?: string;
  lines?: readonly MeihuaLineValue[];
  upperTrigram?: MeihuaTrigram;
  lowerTrigram?: MeihuaTrigram;
}

interface MeihuaRole {
  position?: 'upper' | 'lower';
  trigram?: MeihuaTrigram;
  element?: string;
}

interface MeihuaRelation {
  kind?: string;
}

interface MeihuaDateTime {
  text?: string;
}

interface MeihuaPillar {
  name?: string;
}

interface MeihuaTimeInfo {
  solar?: MeihuaDateTime;
  lunar?: MeihuaDateTime;
  ganzhi?: {
    year?: MeihuaPillar;
    month?: MeihuaPillar;
    day?: MeihuaPillar;
    hour?: MeihuaPillar;
  };
  dayVoidBranches?: Array<{ name?: string }>;
}

interface MeihuaData {
  method?: string;
  mainHexagram?: MeihuaHexagram;
  mutualHexagram?: MeihuaHexagram;
  changedHexagram?: MeihuaHexagram;
  oppositeHexagram?: MeihuaHexagram;
  reversedHexagram?: MeihuaHexagram;
  movingLine?: number;
  body?: MeihuaRole;
  use?: MeihuaRole;
  elementRelation?: MeihuaRelation;
  time?: MeihuaTimeInfo;
}

const METHOD_LABELS: Record<string, string> = {
  time: '时间起卦',
  counts: '数值起卦',
  trigrams: '指定上下卦',
};

const RELATION_LABELS: Record<string, string> = {
  same: '体用比和',
  useGeneratesBody: '用生体',
  bodyGeneratesUse: '体生用',
  useControlsBody: '用克体',
  bodyControlsUse: '体克用',
};

const ELEMENT_LABELS: Record<string, string> = {
  wood: '木',
  fire: '火',
  earth: '土',
  metal: '金',
  water: '水',
};

function formatMethod(method?: string): string | undefined {
  return method ? (METHOD_LABELS[method] ?? method) : undefined;
}

function formatElement(element?: string): string | undefined {
  if (!element) return undefined;
  return ELEMENT_LABELS[element] ?? element;
}

function getElementClassName(element?: string): string {
  const label = formatElement(element);
  return label ? (WUXING_TEXT[label] ?? CHART.muted) : CHART.muted;
}

function formatTrigram(trigram?: MeihuaTrigram): string {
  if (!trigram?.name) return '-';
  const element = formatElement(trigram.element);
  return `${trigram.name}${element ?? ''}`;
}

function formatTrigramName(trigram?: MeihuaTrigram): string {
  return trigram?.name ?? '-';
}

function formatPillars(time?: MeihuaTimeInfo): string | undefined {
  const values = [
    time?.ganzhi?.year?.name,
    time?.ganzhi?.month?.name,
    time?.ganzhi?.day?.name,
    time?.ganzhi?.hour?.name,
  ].filter(Boolean);
  return values.length > 0 ? values.join(' ') : undefined;
}

function roleLabelForPosition(
  data: MeihuaData,
  position: 'upper' | 'lower',
): '体' | '用' | '' {
  if (data.body?.position === position) return '体';
  if (data.use?.position === position) return '用';
  return '';
}

function YaoLine({
  value,
  moving,
}: {
  value: MeihuaLineValue;
  moving?: boolean;
}) {
  const lineClassName = moving ? CHART.primaryBg : CHART.line;
  return (
    <div className="relative flex h-5 items-center justify-center @[480px]/artifact:h-6">
      {value === 'yang' ? (
        <span
          className={`h-2 w-full rounded-[2px] @[480px]/artifact:h-2.5 ${lineClassName}`}
        />
      ) : (
        <span className="grid w-full grid-cols-[1fr_18%_1fr] items-center">
          <span className={`h-2 rounded-[2px] @[480px]/artifact:h-2.5 ${lineClassName}`} />
          <span />
          <span className={`h-2 rounded-[2px] @[480px]/artifact:h-2.5 ${lineClassName}`} />
        </span>
      )}
      {moving && (
        <span className="absolute -right-3 h-1.5 w-1.5 rounded-full bg-primary @[480px]/artifact:-right-4 @[480px]/artifact:h-2 @[480px]/artifact:w-2" />
      )}
    </div>
  );
}

function HexagramDiagram({
  hexagram,
  movingLine,
}: {
  hexagram?: MeihuaHexagram;
  movingLine?: number;
}) {
  const lines = hexagram?.lines;
  if (!lines || lines.length === 0) return null;

  return (
    <div className="mx-auto flex w-full max-w-[5.7rem] flex-col gap-1.5 @[480px]/artifact:gap-2">
      {[...lines].reverse().map((line, displayIndex) => {
        const position = lines.length - displayIndex;
        return (
          <YaoLine
            key={`${position}-${line}`}
            value={line}
            moving={movingLine === position}
          />
        );
      })}
    </div>
  );
}

function HexagramColumn({
  label,
  hexagram,
  movingLine,
}: {
  label: string;
  hexagram?: MeihuaHexagram;
  movingLine?: number;
}) {
  return (
    <div className="grid min-w-0 grid-rows-[2.75rem_9.25rem_2rem] items-center justify-items-center gap-1 @[480px]/artifact:grid-rows-[3rem_10.5rem_2rem]">
      <div className="flex min-w-0 flex-col items-center justify-end gap-1 text-center">
        <div className="max-w-full text-[12px] font-semibold leading-tight text-ink @[480px]/artifact:text-[14px]">
          {hexagram?.fullName ?? hexagram?.name ?? '-'}
        </div>
        <div className="text-[9px] leading-none text-muted @[480px]/artifact:text-[10px]">
          {formatTrigram(hexagram?.upperTrigram)} /{' '}
          {formatTrigram(hexagram?.lowerTrigram)}
        </div>
      </div>
      <HexagramDiagram hexagram={hexagram} movingLine={movingLine} />
      <div className="text-[11px] font-semibold text-ink @[480px]/artifact:text-[12px]">
        [{label}]
      </div>
    </div>
  );
}

function MetaChip({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <span className="inline-flex min-h-7 items-center gap-1 rounded-md border border-hairline bg-canvas/40 px-2 text-[11px] text-body">
      <span className="text-chart-earth">{label}</span>
      <span className="font-medium text-ink">{value}</span>
    </span>
  );
}

/**
 * 梅花易数盘面图表，按本卦、互卦、变卦、错卦、综卦五列展示卦象与体用关系。
 *
 * @param props.data 后端 meihua-ts-lib 排盘结果；字段缺失时会显示空盘提示。
 * @returns 可嵌入聊天 artifact 的梅花易数排盘视图。
 */
export default function MeihuaChart({ data }: { data: MeihuaData }) {
  const {
    mainHexagram,
    mutualHexagram,
    changedHexagram,
    oppositeHexagram,
    reversedHexagram,
    movingLine,
    time,
  } = data;

  if (!mainHexagram?.lines || !changedHexagram?.lines) {
    return (
      <div className="rounded-xl border border-hairline bg-surface-card py-6 text-center text-[12px] text-muted">
        梅花盘数据为空
      </div>
    );
  }

  const relation = data.elementRelation?.kind
    ? (RELATION_LABELS[data.elementRelation.kind] ?? data.elementRelation.kind)
    : undefined;
  const dayVoid = time?.dayVoidBranches
    ?.map((branch) => branch.name)
    .filter(Boolean)
    .join('、');

  return (
    <div className="w-full overflow-hidden rounded-xl border border-hairline bg-surface-card font-sans text-ink shadow-sm">
      <div className="border-b border-hairline bg-surface-soft px-3 py-2.5">
        <div className="flex flex-wrap gap-1.5">
          <MetaChip label="起卦" value={formatMethod(data.method)} />
          <MetaChip
            label="动爻"
            value={
              typeof movingLine === 'number' ? `${movingLine}爻` : undefined
            }
          />
          <MetaChip label="体用" value={relation} />
          <MetaChip label="四柱" value={formatPillars(time)} />
          <MetaChip label="日空" value={dayVoid} />
        </div>
      </div>

      <div className="bg-canvas px-2 py-4 @[480px]/artifact:px-4 @[480px]/artifact:py-5">
        <div className="grid grid-cols-[1.25rem_repeat(5,minmax(0,1fr))] gap-2 @[480px]/artifact:grid-cols-[1.75rem_repeat(5,minmax(0,1fr))] @[480px]/artifact:gap-4">
          <div className="grid grid-rows-[2.75rem_9.25rem_2rem] items-center justify-items-center gap-1 @[480px]/artifact:grid-rows-[3rem_10.5rem_2rem]">
            <span />
            <div className="grid h-full grid-rows-2 items-center text-[18px] font-semibold text-ink @[480px]/artifact:text-[20px]">
              <span>{roleLabelForPosition(data, 'upper')}</span>
              <span>{roleLabelForPosition(data, 'lower')}</span>
            </div>
            <span />
          </div>
          <HexagramColumn
            label="本卦"
            hexagram={mainHexagram}
            movingLine={movingLine}
          />
          <HexagramColumn label="互卦" hexagram={mutualHexagram} />
          <HexagramColumn label="变卦" hexagram={changedHexagram} />
          <HexagramColumn label="错卦" hexagram={oppositeHexagram} />
          <HexagramColumn label="综卦" hexagram={reversedHexagram} />
        </div>
      </div>

      <div className="grid gap-2 border-t border-hairline bg-surface-soft px-3 py-3 text-[12px] text-body @[480px]/artifact:grid-cols-2 @[480px]/artifact:px-4">
        <div className="rounded-lg border border-hairline bg-canvas/35 px-3 py-2">
          <span className="text-muted">体卦</span>
          <span className="ml-2 font-semibold text-ink">
            {formatTrigramName(data.body?.trigram)}
          </span>
          <span className={`ml-2 ${getElementClassName(data.body?.element)}`}>
            {formatElement(data.body?.element)}
          </span>
        </div>
        <div className="rounded-lg border border-hairline bg-canvas/35 px-3 py-2">
          <span className="text-muted">用卦</span>
          <span className="ml-2 font-semibold text-ink">
            {formatTrigramName(data.use?.trigram)}
          </span>
          <span className={`ml-2 ${getElementClassName(data.use?.element)}`}>
            {formatElement(data.use?.element)}
          </span>
        </div>
        {(time?.solar?.text || time?.lunar?.text) && (
          <div className="rounded-lg border border-hairline bg-canvas/35 px-3 py-2 @[480px]/artifact:col-span-2">
            <span className="text-muted">时间</span>
            <span className="ml-2 text-ink">
              {[time?.solar?.text, time?.lunar?.text]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
