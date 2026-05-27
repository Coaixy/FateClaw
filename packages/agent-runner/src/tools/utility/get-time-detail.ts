/**
 * get_time_detail 工具 — 获取当前或指定时间的完整多格式数据。
 *
 * 一次性返回 ISO / 时间戳 / 农历 / 干支四柱 / 节气 / 生肖 / 星座 等字段，
 * 替代 get_current_time 和 get_bazi，并为排盘 skill 准备输入参数。
 */

import { SolarDay, SolarTime } from 'tyme4ts';

import type { ToolSpec } from '../../types.js';
import { getContext } from '../../context.js';

const CN_DIGIT = '〇一二三四五六七八九';
const CN_MONTH = [
  '',
  '正', '二', '三', '四', '五', '六',
  '七', '八', '九', '十', '冬', '腊',
];
const CN_DAY = [
  '',
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
];
const WEEKDAY_NAMES = [
  '星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六',
];

const SIGNS: Array<{ name: string; until: [number, number] }> = [
  { name: '摩羯座', until: [1, 19] },
  { name: '水瓶座', until: [2, 18] },
  { name: '双鱼座', until: [3, 20] },
  { name: '白羊座', until: [4, 19] },
  { name: '金牛座', until: [5, 20] },
  { name: '双子座', until: [6, 21] },
  { name: '巨蟹座', until: [7, 22] },
  { name: '狮子座', until: [8, 22] },
  { name: '处女座', until: [9, 22] },
  { name: '天秤座', until: [10, 23] },
  { name: '天蝎座', until: [11, 22] },
  { name: '射手座', until: [12, 21] },
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function yearToChinese(y: number): string {
  return String(y)
    .split('')
    .map((c) => CN_DIGIT[Number(c)])
    .join('');
}

function lunarDateText(
  year: number,
  month: number,
  day: number,
  isLeap: boolean,
): string {
  return `${yearToChinese(year)}年${isLeap ? '闰' : ''}${CN_MONTH[month]}月${CN_DAY[day]}`;
}

function getSign(month: number, day: number): string {
  for (const s of SIGNS) {
    const [m, d] = s.until;
    if (month < m || (month === m && day <= d)) return s.name;
  }
  return '摩羯座';
}

function getDayOfYear(y: number, m: number, d: number): number {
  const start = Date.UTC(y, 0, 1);
  const cur = Date.UTC(y, m - 1, d);
  return Math.floor((cur - start) / 86400000) + 1;
}

interface TimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  iso: string;
  timestampMs: number;
}

function getPartsInTimezone(d: Date, timezone: string): TimeParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });

  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;

  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: parts.hour === '24' ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdayMap[parts.weekday] ?? 0,
    iso: d.toISOString(),
    timestampMs: d.getTime(),
  };
}

function parseDatetime(s: string): Date {
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`无法解析的时间格式: ${s}`);
  }
  return d;
}

export const getTimeDetail: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'get_time_detail',
      description:
        '获取当前或指定时间的完整多格式数据：ISO、时间戳、农历、干支四柱、节气、生肖、星座、星期。不传 datetime 返回当前时间；传 datetime 解析指定时间。',
      parameters: {
        type: 'object',
        properties: {
          datetime: {
            type: 'string',
            description:
              '要解析的时间，支持 "YYYY-MM-DD HH:mm" / "YYYY-MM-DD"（默认 00:00）/ ISO 格式。不传则使用当前时间。',
          },
        },
      },
    },
  },

  prompt: `## get_time_detail — 完整时间元数据查询

返回指定时间（或当前时间）的全套时间元数据，一次调用拿到：
- 格式：ISO、秒/毫秒级时间戳、本地时区日期时间
- 日历：公历 + 农历（含闰月、中文月名日名）
- 干支：年柱、月柱、日柱、时柱（完整四柱）
- 节气：今天是否节气日、当前所处节气、距节气起始天数
- 其他：星期、生肖、西方星座、一年第几天

### 使用场景
- 用户问"现在几点 / 今天几号 / 今天什么节气 / 今天干支"
- 需要准确时间参数调用排盘 skill（bazi-paipan / ziwei-paipan / qimen-paipan / iching-paipan）
- 查询某个公历日期的四柱干支 / 农历日期 / 节气信息

### 参数
- **datetime**（可选）：\`"YYYY-MM-DD HH:mm"\` / \`"YYYY-MM-DD"\`（默认 00:00）/ ISO。不传则用当前时间。

### 换年规则
\`ganZhi.year\` 按**立春换年**（八字规则，跟随 tyme4ts）。
- 八字排盘可信任本字段
- **紫微斗数的流年应按春节换**，不要把本字段直接当"紫微流年"用；紫微请调 \`ziwei-paipan\` 的 \`horoscope.date\`

### 关键注意
- 本工具是**技术型历法查询**：它只做干支/历法换算，**不做命理解读**。
- 用户看自己的八字/命盘/大运/流年 → 必须走 \`bazi-paipan\` + \`prepare_xuanxue_interpretation\`，不能只靠本工具。`,

  execute: async (args: Record<string, unknown>) => {
    const timezone = getContext().timezone;
    const raw = args.datetime as string | undefined;

    try {
      const date = raw ? parseDatetime(raw) : new Date();
      const parts = getPartsInTimezone(date, timezone);
      const { year, month, day, hour, minute, second, weekday, iso, timestampMs } = parts;

      const st = SolarTime.fromYmdHms(year, month, day, hour, minute, second);
      const lh = st.getLunarHour();
      const ld = lh.getLunarDay();
      const lm = ld.getLunarMonth();
      const ly = lm.getLunarYear();

      const yearGZ = ly.getSixtyCycle();
      const monthGZ = lm.getSixtyCycle();
      const dayGZ = ld.getSixtyCycle();
      const hourGZ = lh.getSixtyCycle();

      const sd = SolarDay.fromYmd(year, month, day);
      const term = sd.getTerm();
      const termDay = sd.getTermDay();
      const termDayIndex = termDay.getDayIndex();
      const termStart = sd.next(-termDayIndex);
      const isTermDay = termDayIndex === 0;

      const result = {
        datetime: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`,
        date: `${year}-${pad(month)}-${pad(day)}`,
        time: `${pad(hour)}:${pad(minute)}:${pad(second)}`,
        iso,
        timestamp: Math.floor(timestampMs / 1000),
        timestampMs,
        timezone,
        year, month, day, hour, minute, second,
        weekday,
        weekdayName: WEEKDAY_NAMES[weekday],
        dayOfYear: getDayOfYear(year, month, day),
        lunar: {
          year: ly.getYear(),
          month: lm.getMonth(),
          day: ld.getDay(),
          isLeap: lm.isLeap(),
          dateText: lunarDateText(ly.getYear(), lm.getMonth(), ld.getDay(), lm.isLeap()),
        },
        ganZhi: {
          year: yearGZ.getName(),
          month: monthGZ.getName(),
          day: dayGZ.getName(),
          hour: hourGZ.getName(),
        },
        zodiac: yearGZ.getEarthBranch().getZodiac().getName(),
        sign: getSign(month, day),
        solarTerm: {
          today: isTermDay ? term.getName() : null,
          current: term.getName(),
          currentStart: `${termStart.getYear()}-${pad(termStart.getMonth())}-${pad(termStart.getDay())}`,
          daysSinceCurrent: termDayIndex,
        },
      };

      return { output: JSON.stringify(result, null, 2) };
    } catch (error) {
      return {
        output: `时间查询失败: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};
