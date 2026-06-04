import {
  qiGuaByCounts,
  qiGuaByTime,
  qiGuaByTrigrams,
  type CountQiGuaMethod,
  type MeihuaChart,
  type MovingLine,
  type TrigramInputKey,
} from 'meihua-ts-lib';

const METHODS = ['time', 'counts', 'trigrams'] as const;
const COUNT_METHODS = [
  'number',
  'word',
  'sound',
  'object',
  'direction',
  'external',
] as const;
const TRIGRAMS = ['乾', '兑', '离', '震', '巽', '坎', '艮', '坤'] as const;

type MeihuaMethod = (typeof METHODS)[number];
type TrigramName = (typeof TRIGRAMS)[number];

interface MeihuaInput {
  method?: MeihuaMethod;
  datetime?: string;
  upper?: number;
  lower?: number;
  moving?: number;
  countMethod?: CountQiGuaMethod;
  upperTrigram?: TrigramName;
  lowerTrigram?: TrigramName;
  movingLine?: number;
  label?: string;
}

export type MeihuaPaipanResult = MeihuaChart & {
  method: MeihuaMethod;
};

function parseDatetime(value: string | undefined): Date {
  if (!value) return new Date();
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) throw new Error(`非法 datetime: ${value}`);
  return date;
}

function requireInteger(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${fieldName} 必须是整数`);
  }
  return value;
}

function optionalInteger(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireInteger(value, fieldName);
}

function normalizeCountMethod(value: unknown): CountQiGuaMethod {
  if (value === undefined || value === null) return 'number';
  if (COUNT_METHODS.includes(value as CountQiGuaMethod)) {
    return value as CountQiGuaMethod;
  }
  throw new Error(`countMethod 必须是 ${COUNT_METHODS.join('/')} 之一`);
}

function normalizeTrigram(value: unknown, fieldName: string): TrigramInputKey {
  if (TRIGRAMS.includes(value as TrigramName)) {
    return value as TrigramInputKey;
  }
  throw new Error(`${fieldName} 必须是八卦之一：${TRIGRAMS.join('、')}`);
}

function normalizeMovingLine(value: unknown): MovingLine {
  const movingLine = requireInteger(value, 'movingLine');
  if (movingLine < 1 || movingLine > 6) {
    throw new Error('movingLine 必须在 1 到 6 之间');
  }
  return movingLine as MovingLine;
}

function runByTime(input: MeihuaInput): MeihuaChart {
  const when = parseDatetime(input.datetime);
  return qiGuaByTime({
    calendar: 'solar',
    year: when.getFullYear(),
    month: when.getMonth() + 1,
    day: when.getDate(),
    hour: when.getHours(),
    minute: when.getMinutes(),
  });
}

function runByCounts(input: MeihuaInput): MeihuaChart {
  return qiGuaByCounts({
    method: normalizeCountMethod(input.countMethod),
    upper: requireInteger(input.upper, 'upper'),
    lower: requireInteger(input.lower, 'lower'),
    moving: optionalInteger(input.moving, 'moving'),
    label: input.label,
  });
}

function runByTrigrams(input: MeihuaInput): MeihuaChart {
  return qiGuaByTrigrams({
    upper: normalizeTrigram(input.upperTrigram, 'upperTrigram'),
    lower: normalizeTrigram(input.lowerTrigram, 'lowerTrigram'),
    movingLine: normalizeMovingLine(input.movingLine),
    label: input.label,
  });
}

/** 执行梅花易数排盘，返回本卦、互卦、变卦、错卦、综卦和体用关系。 */
export async function runMeihuaPaipan(
  input: Record<string, unknown>,
): Promise<MeihuaPaipanResult> {
  const { method = 'time' } = input as MeihuaInput;

  if (!METHODS.includes(method)) {
    throw new Error(`method 必须是 ${METHODS.join('/')} 之一`);
  }

  const chart =
    method === 'counts'
      ? runByCounts(input as MeihuaInput)
      : method === 'trigrams'
        ? runByTrigrams(input as MeihuaInput)
        : runByTime(input as MeihuaInput);

  return {
    method,
    ...chart,
  };
}
