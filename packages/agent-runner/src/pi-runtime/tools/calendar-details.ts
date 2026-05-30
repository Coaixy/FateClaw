import {
  LunarHour,
  LunarSect2EightCharProvider,
  type SolarTime,
} from 'tyme4ts';

/** Pi 时间工具支持的八字流派标识。 */
export type PiEightCharProvider = 'default' | 'lunar_sect2';

/** 四柱和完整八字字符串。 */
export interface PiGanZhiPillars {
  year: string;
  month: string;
  day: string;
  hour: string;
  eightChar: string;
}

/**
 * Pi 时间工具统一输出的日历详情。
 *
 * 字段：
 * - solar：tyme4ts 格式化后的公历时间。
 * - lunar：tyme4ts 格式化后的农历时辰。
 * - solarTerm：所在节气。
 * - gregorian：规范化后的公历字段。
 * - lunarDate：规范化后的农历字段，monthWithLeap 用负数表示闰月。
 * - ganzhi：四柱干支。
 */
export interface PiCalendarDetails {
  solar: string;
  lunar: string;
  solarTerm: string;
  gregorian: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
  lunarDate: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    isLeapMonth: boolean;
    monthWithLeap: number;
  };
  ganzhi: PiGanZhiPillars;
}

/**
 * 标准化八字流派参数。
 *
 * 参数：模型传入的未知值。
 * 返回：内部支持的八字流派标识。
 * 注意：未知值回退到 tyme4ts 默认流派，避免因为模型拼写错误导致硬失败。
 */
export function normalizeEightCharProvider(
  value: unknown,
): PiEightCharProvider {
  return value === 'lunar_sect2' ? 'lunar_sect2' : 'default';
}

/**
 * 在指定八字流派下执行计算。
 *
 * 参数：
 * - provider：八字流派。
 * - compute：需要在该流派下执行的计算函数。
 *
 * 返回：compute 的返回值。
 * 注意：tyme4ts 使用全局 LunarHour.provider，这里必须在 finally 中恢复，避免串扰同进程其他调用。
 */
export function withEightCharProvider<T>(
  provider: PiEightCharProvider,
  compute: () => T,
): T {
  const previous = LunarHour.provider;
  try {
    if (provider === 'lunar_sect2') {
      LunarHour.provider = new LunarSect2EightCharProvider();
    }
    return compute();
  } finally {
    LunarHour.provider = previous;
  }
}

/**
 * 校验 IANA 时区名称。
 *
 * 参数：timezone。
 * 返回：是否可被 Intl.DateTimeFormat 识别。
 * 注意：本校验只验证名称合法性，不改变 SolarTime 的本地民用时间字段。
 */
export function isValidIanaTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * 将 tyme4ts SolarTime 展开成 Pi 工具统一使用的日历/干支详情。
 *
 * 参数：
 * - solarTime：明确的本地民用时间。
 * - provider：八字流派。
 *
 * 返回：公历、农历、节气和干支详情。
 */
export function buildCalendarDetailsFromSolarTime(
  solarTime: SolarTime,
  provider: PiEightCharProvider,
): PiCalendarDetails {
  return withEightCharProvider(provider, () => {
    const lunarHour = solarTime.getLunarHour();
    const lunarDay = lunarHour.getLunarDay();
    const lunarMonth = lunarDay.getLunarMonth();
    const eightChar = lunarHour.getEightChar();
    return {
      solar: solarTime.toString(),
      lunar: lunarHour.toString(),
      solarTerm: solarTime.getTerm().toString(),
      gregorian: {
        year: solarTime.getYear(),
        month: solarTime.getMonth(),
        day: solarTime.getDay(),
        hour: solarTime.getHour(),
        minute: solarTime.getMinute(),
        second: solarTime.getSecond(),
      },
      lunarDate: {
        year: lunarDay.getYear(),
        month: lunarDay.getMonth(),
        day: lunarDay.getDay(),
        hour: lunarHour.getHour(),
        minute: lunarHour.getMinute(),
        second: lunarHour.getSecond(),
        isLeapMonth: lunarMonth.isLeap(),
        monthWithLeap: lunarMonth.getMonthWithLeap(),
      },
      ganzhi: {
        year: eightChar.getYear().toString(),
        month: eightChar.getMonth().toString(),
        day: eightChar.getDay().toString(),
        hour: eightChar.getHour().toString(),
        eightChar: eightChar.getName(),
      },
    };
  });
}
