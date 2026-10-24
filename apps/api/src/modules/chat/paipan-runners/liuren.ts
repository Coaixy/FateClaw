import { getLiuRenByDate, getLiuRenByYueJiang } from 'liuren-ts-lib';

import { DirectPaipanError } from '../paipan-errors.js';

interface LiurenInput {
  method?: 'time' | 'yuejiang';
  yueJiang?: string;
  shiChen?: string;
  riGanZhi?: string;
  yueLing?: string;
  solarDate?: string;
  hour?: number;
  minute?: number;
  timeMode?: 'now' | 'custom' | 'random';
  randomNumber?: number;
}

type LiurenTimeInput = {
  solarDate: string;
  hour: number;
  minute: number;
  mode: 'now' | 'custom' | 'random';
  randomNumber?: number;
};

export type LiurenPaipanResult = ReturnType<typeof getLiuRenByDate> & {
  input:
    | LiurenTimeInput
    | {
        mode: 'yuejiang';
        yueJiang: string;
        shiChen: string;
        riGanZhi: string;
        yueLing?: string;
      };
};

const RANDOM_SHICHEN_START_HOURS = [
  23, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21,
] as const;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function parseSolarDate(solarDate: string): {
  year: number;
  month: number;
  day: number;
} {
  const [year, month, day] = solarDate.split('-').map(Number);
  if (!year || !month || !day) throw new Error(`非法 solarDate: ${solarDate}`);
  return { year, month, day };
}

function dateParts(date: Date): {
  solarDate: string;
  hour: number;
  minute: number;
} {
  return {
    solarDate: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
}

function normalizeRandomIndex(randomNumber: number | undefined): number {
  if (typeof randomNumber !== 'number' || Number.isNaN(randomNumber)) {
    return Math.floor(Math.random() * RANDOM_SHICHEN_START_HOURS.length);
  }
  return Math.abs(Math.trunc(randomNumber)) % RANDOM_SHICHEN_START_HOURS.length;
}

function resolveDateInput(input: LiurenInput): LiurenTimeInput {
  const now = new Date();
  const nowParts = dateParts(now);
  const hasDate =
    typeof input.solarDate === 'string' && input.solarDate.trim().length > 0;
  const hasHour = typeof input.hour === 'number' && !Number.isNaN(input.hour);

  if (input.timeMode === 'random') {
    const randomHour = hasHour
      ? (input.hour as number)
      : RANDOM_SHICHEN_START_HOURS[normalizeRandomIndex(input.randomNumber)];
    return {
      solarDate: hasDate ? (input.solarDate as string) : nowParts.solarDate,
      hour: randomHour,
      minute: input.minute ?? 0,
      mode: 'random',
      randomNumber: input.randomNumber,
    };
  }

  if (!hasDate && !hasHour && typeof input.randomNumber !== 'number') {
    return {
      ...nowParts,
      mode: 'now',
    };
  }

  if (hasDate && !hasHour) {
    const randomHour =
      RANDOM_SHICHEN_START_HOURS[normalizeRandomIndex(input.randomNumber)];
    return {
      solarDate: input.solarDate as string,
      hour: randomHour,
      minute: 0,
      mode: 'random',
      randomNumber: input.randomNumber,
    };
  }

  if (!hasDate && hasHour) {
    throw new Error(
      'solarDate 和 hour 必须同时传入，或只传 randomNumber 使用今日随机时辰',
    );
  }

  if (hasDate && hasHour) {
    return {
      solarDate: input.solarDate as string,
      hour: input.hour as number,
      minute: input.minute ?? 0,
      mode:
        input.timeMode === 'custom'
          ? 'custom'
          : typeof input.randomNumber === 'number'
            ? 'random'
            : 'custom',
      randomNumber: input.randomNumber,
    };
  }

  const randomHour =
    RANDOM_SHICHEN_START_HOURS[normalizeRandomIndex(input.randomNumber)];
  return {
    solarDate: nowParts.solarDate,
    hour: randomHour,
    minute: 0,
    mode: 'random',
    randomNumber: input.randomNumber,
  };
}

function buildDate(input: LiurenTimeInput): Date {
  const { year, month, day } = parseSolarDate(input.solarDate);
  if (input.hour < 0 || input.hour > 23)
    throw new Error(`非法 hour: ${input.hour}`);
  if (input.minute < 0 || input.minute > 59) {
    throw new Error(`非法 minute: ${input.minute}`);
  }
  return new Date(year, month - 1, day, input.hour, input.minute, 0);
}

/** 执行大六壬排盘，基于 liuren-ts-lib 返回完整天地盘、四课、三传和神煞。 */
export async function runLiurenPaipan(
  input: Record<string, unknown>,
): Promise<LiurenPaipanResult> {
  const {
    method = 'time',
    yueJiang,
    shiChen,
    riGanZhi,
    yueLing,
  } = input as LiurenInput;
  if (method === 'yuejiang') {
    if (!yueJiang || !shiChen || !riGanZhi) {
      throw new DirectPaipanError(
        'PAIPAN.PARAM_INVALID',
        '古籍式起盘必须填写月将、占时和日干支',
        400,
      );
    }
    if (
      ['solarDate', 'hour', 'minute', 'randomNumber', 'timeMode'].some(
        (key) => input[key] !== undefined,
      )
    ) {
      throw new DirectPaipanError(
        'PAIPAN.PARAM_INVALID',
        '古籍式起盘不能同时提供公历时间或随机时辰参数',
        400,
      );
    }
    return {
      ...getLiuRenByYueJiang(yueJiang, shiChen, riGanZhi, yueLing),
      input: {
        mode: 'yuejiang',
        yueJiang,
        shiChen,
        riGanZhi,
        ...(yueLing === undefined ? {} : { yueLing }),
      },
    };
  }
  if (
    method !== 'time' ||
    [yueJiang, shiChen, riGanZhi, yueLing].some((value) => value !== undefined)
  ) {
    throw new DirectPaipanError(
      'PAIPAN.PARAM_INVALID',
      '按月将、占时和日干支起盘时请选择 method=yuejiang',
      400,
    );
  }
  const resolvedInput = resolveDateInput(input as LiurenInput);
  return {
    ...getLiuRenByDate(buildDate(resolvedInput)),
    input: resolvedInput,
  };
}
