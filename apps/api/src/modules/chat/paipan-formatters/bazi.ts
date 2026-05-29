import { formatGenericPaipan } from './fallback.js';
import type { PaipanFormatter } from './types.js';
import {
  arrayField,
  asRecord,
  joinText,
  pushSection,
  recordField,
  scalarArray,
  textField,
} from './utils.js';

const PILLARS = [
  ['year', '年柱'],
  ['month', '月柱'],
  ['day', '日柱'],
  ['hour', '时柱'],
] as const;

const STEM_INFO: Record<string, { element: string; polarity: '阳' | '阴' }> = {
  甲: { element: '木', polarity: '阳' },
  乙: { element: '木', polarity: '阴' },
  丙: { element: '火', polarity: '阳' },
  丁: { element: '火', polarity: '阴' },
  戊: { element: '土', polarity: '阳' },
  己: { element: '土', polarity: '阴' },
  庚: { element: '金', polarity: '阳' },
  辛: { element: '金', polarity: '阴' },
  壬: { element: '水', polarity: '阳' },
  癸: { element: '水', polarity: '阴' },
};

const BRANCH_MAIN_STEM: Record<string, string> = {
  子: '癸',
  丑: '己',
  寅: '甲',
  卯: '乙',
  辰: '戊',
  巳: '丙',
  午: '丁',
  未: '己',
  申: '庚',
  酉: '辛',
  戌: '戊',
  亥: '壬',
};

const GENERATES: Record<string, string> = {
  木: '火',
  火: '土',
  土: '金',
  金: '水',
  水: '木',
};

const CONTROLS: Record<string, string> = {
  木: '土',
  土: '水',
  水: '火',
  火: '金',
  金: '木',
};

function formatStem(
  stem: Record<string, unknown> | undefined,
): string | undefined {
  if (!stem) return undefined;
  const name = textField(stem, 'name');
  if (!name) return undefined;
  const detail = joinText(
    [textField(stem, 'element'), textField(stem, 'yinYang')],
    '',
  );
  return detail ? `${name}（${detail}）` : name;
}

function formatHiddenStem(value: unknown): string | undefined {
  const stem = asRecord(value);
  if (!stem) return undefined;
  return joinText(
    [
      textField(stem, 'name'),
      textField(stem, 'type'),
      textField(stem, 'element'),
    ],
    '/',
  );
}

function formatBranch(
  branch: Record<string, unknown> | undefined,
): string | undefined {
  if (!branch) return undefined;
  const name = textField(branch, 'name');
  if (!name) return undefined;
  const hidden = arrayField(branch, 'hideHeavenStems')
    .map(formatHiddenStem)
    .filter((item): item is string => Boolean(item));
  return hidden.length > 0 ? `${name}（藏干 ${hidden.join('、')}）` : name;
}

function formatPillar(label: string, value: unknown): string | undefined {
  const pillar = asRecord(value);
  if (!pillar) return undefined;
  const heavenStem = recordField(pillar, 'heavenStem');
  const earthBranch = recordField(pillar, 'earthBranch');
  const state = joinText(
    [
      textField(pillar, 'terrain')
        ? `星运：${textField(pillar, 'terrain')}`
        : undefined,
      textField(pillar, 'wangXiang')
        ? `自坐：${textField(pillar, 'wangXiang')}`
        : undefined,
    ],
    ' ',
  );
  const parts = [
    textField(pillar, 'sixtyCycle'),
    heavenStem && textField(heavenStem, 'name')
      ? `天干 ${textField(heavenStem, 'name')}`
      : undefined,
    formatBranch(earthBranch) ? `地支 ${formatBranch(earthBranch)}` : undefined,
    state || undefined,
  ];
  const [cycle, ...details] = parts.filter((part): part is string =>
    Boolean(part),
  );
  const body = cycle
    ? `${cycle} ${details.join('；')}`.trim()
    : details.join('；');
  return body ? `${label}：${body}` : undefined;
}

function pipeList(values: Array<string | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).join(' | ');
}

function formatSpecialSigns(value: unknown): string | undefined {
  const signs = asRecord(value);
  if (!signs) return undefined;
  return pipeList([
    textField(signs, 'fetalOrigin')
      ? `胎元: ${textField(signs, 'fetalOrigin')}`
      : undefined,
    textField(signs, 'fetalBreath')
      ? `胎息: ${textField(signs, 'fetalBreath')}`
      : undefined,
    textField(signs, 'ownSign')
      ? `命宫: ${textField(signs, 'ownSign')}`
      : undefined,
    textField(signs, 'bodySign')
      ? `身宫: ${textField(signs, 'bodySign')}`
      : undefined,
    textField(signs, 'duty') ? `建除: ${textField(signs, 'duty')}` : undefined,
    scalarArray(signs.kongWang).length > 0
      ? `旬空: ${scalarArray(signs.kongWang).join('')}`
      : undefined,
    textField(signs, 'xun') ? `旬: ${textField(signs, 'xun')}` : undefined,
  ]);
}

function formatBirthOverview(bazi: Record<string, unknown>): string[] {
  const pillars = recordField(bazi, 'pillars');
  const day = pillars ? recordField(pillars, 'day') : undefined;
  const dayStem = day ? recordField(day, 'heavenStem') : undefined;
  return [
    textField(bazi, 'birthTime')
      ? `出生：${textField(bazi, 'birthTime')}`
      : undefined,
    textField(bazi, 'gender')
      ? `性别：${textField(bazi, 'gender')}`
      : undefined,
    textField(bazi, 'baziString')
      ? `四柱：${textField(bazi, 'baziString')}`
      : undefined,
    formatStem(dayStem) ? `日主：${formatStem(dayStem)}` : undefined,
    formatSpecialSigns(recordField(bazi, 'specialSigns'))
      ? `辅助信息：${formatSpecialSigns(recordField(bazi, 'specialSigns'))}`
      : undefined,
  ].filter((line): line is string => Boolean(line));
}

function resolveTenStar(
  dayStem: string | undefined,
  targetStem: string | undefined,
): string | undefined {
  if (!dayStem || !targetStem) return undefined;
  const day = STEM_INFO[dayStem];
  const target = STEM_INFO[targetStem];
  if (!day || !target) return undefined;
  const samePolarity = day.polarity === target.polarity;
  if (day.element === target.element) return samePolarity ? '比肩' : '劫财';
  if (GENERATES[day.element] === target.element) {
    return samePolarity ? '食神' : '伤官';
  }
  if (GENERATES[target.element] === day.element) {
    return samePolarity ? '偏印' : '正印';
  }
  if (CONTROLS[day.element] === target.element) {
    return samePolarity ? '偏财' : '正财';
  }
  if (CONTROLS[target.element] === day.element) {
    return samePolarity ? '七杀' : '正官';
  }
  return undefined;
}

function resolveBranchTenStar(
  dayStem: string | undefined,
  branch: string | undefined,
): string | undefined {
  return resolveTenStar(dayStem, branch ? BRANCH_MAIN_STEM[branch] : undefined);
}

function formatDecade(value: unknown): string | undefined {
  const decade = asRecord(value);
  if (!decade) return undefined;
  const name =
    textField(decade, 'label') || textField(decade, 'sixtyCycle') || '未命名运';
  const branchTenStar = resolveBranchTenStar(
    textField(decade, '_dayStem'),
    textField(decade, 'earthBranch'),
  );
  const yearRange =
    textField(decade, 'startYear') && textField(decade, 'endYear')
      ? `${textField(decade, 'startYear')}-${textField(decade, 'endYear')}年`
      : undefined;
  const ageRange =
    textField(decade, 'startAge') && textField(decade, 'endAge')
      ? `${textField(decade, 'startAge')}-${textField(decade, 'endAge')}岁`
      : undefined;
  const details = pipeList([
    yearRange,
    ageRange,
    textField(decade, 'tenStar')
      ? `天干十神: ${textField(decade, 'tenStar')}`
      : undefined,
    branchTenStar ? `地支十神: ${branchTenStar}` : undefined,
    textField(decade, 'sound')
      ? `纳音: ${textField(decade, 'sound')}`
      : undefined,
  ]);
  return details ? `- ${name}：${details}` : `- ${name}`;
}

function formatAnnual(value: unknown): string | undefined {
  const annual = asRecord(value);
  if (!annual) return undefined;
  const year = textField(annual, 'year');
  const cycle = textField(annual, 'sixtyCycle');
  if (!year && !cycle) return undefined;
  const age = textField(annual, 'age');
  const title =
    `${year ? `${year}年` : ''}${age ? `（${age}岁）` : ''}${cycle ? ` ${cycle}` : ''}`.trim();
  const branchTenStar = resolveBranchTenStar(
    textField(annual, '_dayStem'),
    textField(annual, 'earthBranch'),
  );
  const details = pipeList([
    textField(annual, 'tenStar')
      ? `天干十神: ${textField(annual, 'tenStar')}`
      : undefined,
    branchTenStar ? `地支十神: ${branchTenStar}` : undefined,
    textField(annual, 'sound')
      ? `纳音: ${textField(annual, 'sound')}`
      : undefined,
  ]);
  return details ? `- ${title}：${details}` : `- ${title}`;
}

function formatChildLimit(value: unknown): string | undefined {
  const childLimit = asRecord(value);
  if (!childLimit) return undefined;
  const direction =
    typeof childLimit.isForward === 'boolean'
      ? childLimit.isForward
        ? '顺行'
        : '逆行'
      : undefined;
  return pipeList([
    textField(childLimit, 'startAge')
      ? `${textField(childLimit, 'startAge')}岁起运`
      : undefined,
    textField(childLimit, 'yearCount')
      ? `${textField(childLimit, 'yearCount')}年`
      : undefined,
    textField(childLimit, 'monthCount')
      ? `${textField(childLimit, 'monthCount')}个月`
      : undefined,
    textField(childLimit, 'dayCount')
      ? `${textField(childLimit, 'dayCount')}天`
      : undefined,
    textField(childLimit, 'startTime')
      ? `起运时间 ${textField(childLimit, 'startTime')}`
      : undefined,
    direction,
  ]);
}

function withDayStem(items: unknown[], dayStem: string | undefined): unknown[] {
  return items.map((item) => {
    const record = asRecord(item);
    return record ? { ...record, _dayStem: dayStem } : item;
  });
}

/** 八字 formatter：按命盘、起运、大运和流年重排结构化结果。 */
export const formatBaziPaipan: PaipanFormatter = (artifactData) => {
  const root = asRecord(artifactData);
  if (!root) return formatGenericPaipan(artifactData);

  const bazi = recordField(root, 'bazi');
  const fortune = recordField(root, 'fortune');
  if (!bazi && !fortune) {
    return recordField(root, 'pattern')
      ? ''
      : formatGenericPaipan(artifactData);
  }

  const lines: string[] = [];
  const pillars = bazi ? recordField(bazi, 'pillars') : undefined;
  const day = pillars ? recordField(pillars, 'day') : undefined;
  const dayStemRecord = day ? recordField(day, 'heavenStem') : undefined;
  const dayStem = dayStemRecord ? textField(dayStemRecord, 'name') : undefined;

  if (bazi) {
    pushSection(lines, '命盘概要', formatBirthOverview(bazi));
    if (pillars) {
      pushSection(
        lines,
        '四柱明细',
        PILLARS.map(([key, label]) => formatPillar(label, pillars[key])),
      );
    }
  }

  if (fortune) {
    pushSection(lines, '起运信息', [
      formatChildLimit(recordField(fortune, 'childLimit')),
      textField(fortune, 'annualStartYear') &&
      textField(fortune, 'annualEndYear')
        ? `流年范围：${textField(fortune, 'annualStartYear')}-${textField(fortune, 'annualEndYear')}年`
        : undefined,
      textField(fortune, 'currentAnnualYear')
        ? `当前流年参考：${textField(fortune, 'currentAnnualYear')}年`
        : undefined,
    ]);
    pushSection(
      lines,
      '小运与大运',
      withDayStem(arrayField(fortune, 'decades'), dayStem).map(formatDecade),
    );
    pushSection(
      lines,
      '逐年流年',
      withDayStem(arrayField(fortune, 'annuals'), dayStem).map(formatAnnual),
    );
  }

  return lines.join('\n').trim();
};
