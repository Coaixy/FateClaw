'use client';

import { Fragment } from 'react';
import { cn } from '@/utils/chart/cn';
import { STEM_WUXING_MAP } from '@/utils/chart/qimen-map';
import { CHART, WUXING_TEXT } from './chart-theme';

const BRANCH_KEYS = [
  'zi',
  'chou',
  'yin',
  'mao',
  'chen',
  'si',
  'wu',
  'wei',
  'shen',
  'you',
  'xu',
  'hai',
] as const;

type BranchKey = (typeof BRANCH_KEYS)[number];

const BRANCH_LABELS: Record<BranchKey, string> = {
  zi: '子',
  chou: '丑',
  yin: '寅',
  mao: '卯',
  chen: '辰',
  si: '巳',
  wu: '午',
  wei: '未',
  shen: '申',
  you: '酉',
  xu: '戌',
  hai: '亥',
};

const BRANCH_TO_KEY = Object.fromEntries(
  BRANCH_KEYS.map((key) => [BRANCH_LABELS[key], key]),
) as Record<string, BranchKey>;

const BRANCH_WUXING: Record<string, '金' | '木' | '水' | '火' | '土'> = {
  子: '水',
  亥: '水',
  寅: '木',
  卯: '木',
  巳: '火',
  午: '火',
  申: '金',
  酉: '金',
  辰: '土',
  戌: '土',
  丑: '土',
  未: '土',
};

const JIANG_SHORT: Record<string, string> = {
  贵人: '贵',
  腾蛇: '蛇',
  螣蛇: '蛇',
  朱雀: '雀',
  六合: '合',
  勾陈: '勾',
  青龙: '龙',
  天空: '空',
  白虎: '虎',
  太常: '常',
  玄武: '玄',
  太阴: '阴',
  天后: '后',
};

const RELATION_SHORT: Record<string, string> = {
  父母: '父',
  兄弟: '兄',
  子孙: '孙',
  妻财: '财',
  官鬼: '官',
};

interface ShiErGong {
  zi?: string;
  chou?: string;
  yin?: string;
  mao?: string;
  chen?: string;
  si?: string;
  wu?: string;
  wei?: string;
  shen?: string;
  you?: string;
  xu?: string;
  hai?: string;
}

interface LiurenData {
  dateInfo?: {
    bazi?: string;
    date?: string;
    kong?: string[];
    yima?: string;
    yuejiang?: string;
    xun?: string;
    dingma?: string;
    tianma?: string;
  };
  input?: {
    mode?: 'now' | 'custom' | 'random';
    randomNumber?: number;
  };
  tianDiPan?: {
    tianPan?: ShiErGong;
    tianJiang?: ShiErGong;
  };
  siKe?: {
    ke1?: string[];
    ke2?: string[];
    ke3?: string[];
    ke4?: string[];
  };
  sanChuan?: {
    chuChuan?: string[];
    zhongChuan?: string[];
    moChuan?: string[];
    keTi?: string;
  };
  dunGan?: ShiErGong;
  shenSha?: Array<{ name?: string; value?: string }>;
  yinYangGuiRen?: {
    yangGuiRen?: ShiErGong;
    yinGuiRen?: ShiErGong;
  };
}

function valueColor(value?: string): string {
  if (!value) return CHART.mutedSoft;
  if (value === '○' || value === '◎') return CHART.mutedSoft;
  const first = value.slice(0, 1);
  const wuxing = STEM_WUXING_MAP[first] ?? BRANCH_WUXING[first];
  return wuxing ? WUXING_TEXT[wuxing] : CHART.ink;
}

function splitBazi(bazi?: string): string[] {
  return bazi?.split(/\s+/).filter(Boolean) ?? [];
}

function getValue(data: ShiErGong | undefined, key: BranchKey): string {
  return data?.[key] || '';
}

function branchKeyOf(value?: string): BranchKey | undefined {
  if (!value) return undefined;
  return BRANCH_TO_KEY[value.slice(0, 1)];
}

function shortJiang(value?: string): string {
  if (!value) return '○';
  return JIANG_SHORT[value] ?? value;
}

function shortRelation(value?: string): string {
  if (!value) return '○';
  return RELATION_SHORT[value] ?? value.slice(0, 1);
}

function displayMode(mode?: string): string {
  return mode === 'random' ? '随机' : '正时';
}

function ColoredText({ value, className }: { value?: string; className?: string }) {
  if (!value) return <span className={cn(CHART.mutedSoft, className)}>○</span>;
  return (
    <>
      {Array.from(value).map((char, index) => (
        <span key={`${char}-${index}`} className={cn(valueColor(char), className)}>
          {char}
        </span>
      ))}
    </>
  );
}

function ShenShaLines({ items }: { items?: LiurenData['shenSha'] }) {
  const visibleItems = (items ?? []).slice(0, 18);
  if (visibleItems.length === 0) return null;

  return (
    <div className="mx-auto mt-2.5 flex max-w-[46rem] flex-wrap justify-center gap-x-2.5 gap-y-1 text-[11px] font-semibold leading-4 @[480px]/artifact:text-[12px]">
      {visibleItems.map((item) => (
        <span key={`${item.name}-${item.value}`} className="whitespace-nowrap text-muted">
          {item.name}
          <span className="text-muted-soft">-</span>
          <span className={valueColor(item.value)}>{item.value || '○'}</span>
        </span>
      ))}
    </div>
  );
}

function PassageTable({ data }: { data: LiurenData }) {
  const rows = [
    data.sanChuan?.chuChuan,
    data.sanChuan?.zhongChuan,
    data.sanChuan?.moChuan,
  ];

  return (
    <div className="mx-auto grid w-full max-w-[34rem] grid-cols-[repeat(5,minmax(3.1rem,1fr))] items-center gap-x-3 gap-y-1.5 text-center">
      {['昼将', '夜将', '六亲', '遁干', '三传'].map((label) => (
        <div key={label} className="text-[12px] font-semibold text-muted @[480px]/artifact:text-[13px]">
          {label}
        </div>
      ))}
      {rows.map((row, rowIndex) => {
        const branch = row?.[0];
        const branchKey = branchKeyOf(branch);
        const nightJiang = branchKey
          ? getValue(data.tianDiPan?.tianJiang, branchKey)
          : '';
        const values = [
          shortJiang(row?.[1]),
          shortJiang(nightJiang),
          shortRelation(row?.[2]),
          row?.[3] || '○',
          branch || '○',
        ];
        return values.map((value, columnIndex) => (
          <div
            key={`passage-${rowIndex}-${columnIndex}`}
            className={cn(
              'text-[17px] font-bold leading-none @[480px]/artifact:text-[19px]',
              columnIndex === 0 || columnIndex === 1 || columnIndex === 2
                ? CHART.ink
                : valueColor(value),
            )}
          >
            <ColoredText value={value} />
          </div>
        ));
      })}
    </div>
  );
}

function orderedCourses(data: LiurenData): Array<string[] | undefined> {
  return [
    data.siKe?.ke2,
    data.siKe?.ke3,
    data.siKe?.ke4,
    data.siKe?.ke1,
  ];
}

function coursePair(course?: string[]): string[] {
  const pair = Array.from(course?.[0] ?? '');
  return [pair[0] || '○', pair[1] || '○'];
}

function CourseTable({ data }: { data: LiurenData }) {
  const courses = orderedCourses(data);
  const topBranches = courses.map((course) => coursePair(course)[0]);

  const rows = [
    {
      label: '遁干',
      values: topBranches.map((branch) => {
        const key = branchKeyOf(branch);
        return key ? getValue(data.dunGan, key) || '○' : '○';
      }),
    },
    {
      label: '昼将',
      values: courses.map((course) => shortJiang(course?.[1])),
      muted: true,
    },
    {
      label: '夜将',
      values: topBranches.map((branch) => {
        const key = branchKeyOf(branch);
        return key ? shortJiang(getValue(data.tianDiPan?.tianJiang, key)) : '○';
      }),
      muted: true,
    },
  ];

  return (
    <div className="mx-auto w-full max-w-[34rem]">
      <div className="grid grid-cols-[3rem_repeat(4,minmax(3.7rem,1fr))] gap-x-3 gap-y-1.5 text-center">
        {rows.map((row) => (
          <Fragment key={row.label}>
            <div className="text-left text-[12px] font-semibold text-muted @[480px]/artifact:text-[13px]">
              {row.label}
            </div>
            {row.values.map((value, index) => (
              <div
                key={`${row.label}-${index}`}
                className={cn(
                  'text-[17px] font-bold leading-none @[480px]/artifact:text-[19px]',
                  row.muted ? CHART.ink : valueColor(value),
                )}
              >
                <ColoredText value={value} />
              </div>
            ))}
          </Fragment>
        ))}

        <div className="text-left text-[12px] font-semibold text-muted @[480px]/artifact:text-[13px]">
          四课
        </div>
        {courses.map((course, index) => {
          const [top, bottom] = coursePair(course);
          return (
            <div key={`course-${index}`} className="grid justify-items-center gap-0.5">
              <div className="text-[19px] font-bold leading-none @[480px]/artifact:text-[22px]">
                <ColoredText value={top} />
              </div>
              <div className="text-[19px] font-bold leading-none @[480px]/artifact:text-[22px]">
                <ColoredText value={bottom} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlateRow({
  label,
  values,
  muted = false,
}: {
  label: string;
  values: string[];
  muted?: boolean;
}) {
  return (
    <>
      <div className="text-left text-[10px] font-semibold text-muted @[480px]/artifact:text-[12px]">
        {label}
      </div>
      {values.map((value, index) => (
        <div
          key={`${label}-${index}`}
          className={cn(
            'min-w-0 text-[13px] font-bold leading-none @[480px]/artifact:text-[16px]',
            muted ? CHART.body : valueColor(value),
          )}
        >
          <ColoredText value={value} />
        </div>
      ))}
    </>
  );
}

function PlateTable({ data }: { data: LiurenData }) {
  const kong = data.dateInfo?.kong ?? [];
  const rows = [
    {
      label: '遁干',
      values: BRANCH_KEYS.map((key) => getValue(data.dunGan, key) || '◎'),
      muted: false,
    },
    {
      label: '昼将',
      values: BRANCH_KEYS.map((key) => shortJiang(getValue(data.yinYangGuiRen?.yangGuiRen, key))),
      muted: true,
    },
    {
      label: '夜将',
      values: BRANCH_KEYS.map((key) => shortJiang(getValue(data.yinYangGuiRen?.yinGuiRen, key))),
      muted: true,
    },
    {
      label: '天盘',
      values: BRANCH_KEYS.map((key) => getValue(data.tianDiPan?.tianPan, key) || '○'),
      muted: false,
    },
    {
      label: '地盘',
      values: BRANCH_KEYS.map((key) => {
        const branch = BRANCH_LABELS[key];
        return kong.includes(branch) ? '○' : branch;
      }),
      muted: false,
    },
  ];

  return (
    <div className="mt-5 pb-1">
      <div className="mx-auto grid w-full max-w-[52rem] grid-cols-[2rem_repeat(12,minmax(0,1fr))] gap-x-[clamp(1px,0.5cqw,3px)] gap-y-2 text-center @[480px]/artifact:grid-cols-[3.7rem_repeat(12,minmax(0,1fr))] @[480px]/artifact:gap-x-3">
        {rows.map((row) => (
          <PlateRow
            key={row.label}
            label={row.label}
            values={row.values}
            muted={row.muted}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 大六壬排盘图表，按传统排盘图的阅读顺序展示四柱、三传、四课与天地盘。
 *
 * @param props.data 后端 liuren-ts-lib 排盘结果；字段缺失时按空位兜底显示。
 * @returns 可嵌入聊天 Artifact 的大六壬可视化盘面。
 */
export default function LiurenChart({ data }: { data: LiurenData }) {
  const bazi = splitBazi(data.dateInfo?.bazi);
  const [yearPillar, monthPillar, dayPillar, hourPillar] = bazi;

  return (
    <div className="w-full rounded-xl border border-hairline bg-surface-card px-2.5 py-3 font-serif text-body shadow-sm @[480px]/artifact:px-4 @[480px]/artifact:py-4">
      <header className="text-center">
        <div className="flex flex-wrap items-baseline justify-center gap-x-2.5 gap-y-0.5 text-[20px] font-bold leading-tight @[480px]/artifact:text-[24px]">
          {bazi.map((pillar, index) => (
            <span key={`${pillar}-${index}`}>
              <ColoredText value={pillar} />
            </span>
          ))}
          <span className="text-[15px] text-muted @[480px]/artifact:text-[17px]">
            ({displayMode(data.input?.mode)})
          </span>
          <span className="text-chart-water">
            {data.dateInfo?.yuejiang || '○'}将
          </span>
        </div>

        <div className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-0.5 text-[13px] font-semibold leading-5 @[480px]/artifact:text-[15px]">
          <span>{data.dateInfo?.xun || '○'}</span>
          <span>
            {data.dateInfo?.kong?.join('') || '○'}空
          </span>
          <span>
            驿马:<ColoredText value={data.dateInfo?.yima} />
          </span>
          <span>
            丁马:<ColoredText value={data.dateInfo?.dingma} />
          </span>
          <span>
            天马:<ColoredText value={data.dateInfo?.tianma} />
          </span>
          {data.input?.randomNumber !== undefined && (
            <span className="text-muted">随机数:{data.input.randomNumber}</span>
          )}
        </div>

        <ShenShaLines items={data.shenSha} />
      </header>

      <main>
        <section className="mt-8 @[480px]/artifact:mt-9">
          <PassageTable data={data} />
        </section>

        <section className="mt-7 @[480px]/artifact:mt-8">
          <CourseTable data={data} />
        </section>

        <PlateTable data={data} />
      </main>

      <footer className="sr-only">
        {yearPillar} {monthPillar} {dayPillar} {hourPillar}
      </footer>
    </div>
  );
}
