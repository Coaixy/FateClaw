import {
  dayan,
  decodePan,
  lueshifa,
  manualQiGua,
  numberArrayQiGua,
  solarToLunar,
  threeNumberQiGua,
  timeQiGua,
  type PanResult,
  type YaoString,
} from 'iching-shifa';

const METHODS = [
  'dayan',
  'lueshifa',
  'manual',
  'three',
  'array',
  'time',
] as const;

type JingzhanMethod = (typeof METHODS)[number];

interface JingzhanInput {
  method?: JingzhanMethod;
  yao?: string;
  numbers?: number[];
  datetime?: string;
  question?: string;
}

export type JingzhanPaipanResult = PanResult & {
  method: JingzhanMethod;
  question?: string;
};

function parseDatetime(value: string | undefined): Date {
  if (!value) return new Date();
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) throw new Error(`非法 datetime: ${value}`);
  return date;
}

function hourToZhiIndex(hour: number): number {
  if (hour === 23 || hour === 0) return 1;
  return Math.floor((hour + 1) / 2) + 1;
}

function generateYao(
  method: JingzhanMethod,
  input: JingzhanInput,
  when: Date,
): YaoString {
  const { yao, numbers } = input;
  switch (method) {
    case 'dayan':
      return dayan();
    case 'lueshifa':
      return lueshifa();
    case 'manual':
      if (!yao)
        throw new Error('method=manual 需要 yao（6位爻字符串，如 "789678"）');
      return manualQiGua(yao);
    case 'three':
      if (!Array.isArray(numbers) || numbers.length !== 3) {
        throw new Error('method=three 需要 numbers 长度为 3');
      }
      return threeNumberQiGua(
        numbers[0] ?? 0,
        numbers[1] ?? 0,
        numbers[2] ?? 0,
      );
    case 'array': {
      if (!Array.isArray(numbers) || numbers.length < 2) {
        throw new Error('method=array 需要 numbers 长度 >= 2');
      }
      return numberArrayQiGua(numbers, hourToZhiIndex(when.getHours()));
    }
    case 'time': {
      const lunar = solarToLunar(
        when.getFullYear(),
        when.getMonth() + 1,
        when.getDate(),
        when.getHours(),
      );
      return timeQiGua(
        when.getFullYear(),
        when.getMonth() + 1,
        when.getDate(),
        when.getHours(),
        lunar.month,
        lunar.day,
        lunar.yearGanZhi.di,
        lunar.hourGanZhi.di,
      );
    }
  }
}

/** 执行经占排盘，直接透传 iching-shifa 1.4 的结构化盘面。 */
export async function runJingzhanPaipan(
  input: Record<string, unknown>,
): Promise<JingzhanPaipanResult> {
  const { method = 'dayan', question, datetime } = input as JingzhanInput;

  if (!METHODS.includes(method)) {
    throw new Error(`method 必须是 ${METHODS.join('/')} 之一`);
  }

  const when = parseDatetime(datetime);
  const yaoString = generateYao(method, input as JingzhanInput, when);

  const pan = decodePan(yaoString, {
    year: when.getFullYear(),
    month: when.getMonth() + 1,
    day: when.getDate(),
    hour: when.getHours(),
    minute: when.getMinutes(),
  });

  return {
    method,
    question,
    ...pan,
  };
}
