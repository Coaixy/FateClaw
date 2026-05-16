/**
 * convert_calendar 工具 — 农历↔公历双向转换。
 *
 * 使用 tyme4ts 库实现农历（阴历）与公历（阳历）的双向转换，
 * 填补排盘 skill 要求公历输入但用户常提供农历日期的缺口。
 */

import { LunarDay, SolarDay } from 'tyme4ts';

import type { ToolSpec } from '../../types.js';

export const convertCalendar: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'convert_calendar',
      description:
        '农历（阴历）与公历（阳历）双向转换。支持闰月处理，返回干支信息。',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['lunar_to_solar', 'solar_to_lunar'],
            description:
              '转换方向：lunar_to_solar（农历→公历）或 solar_to_lunar（公历→农历）',
          },
          year: { type: 'number', description: '年份，如 2026' },
          month: { type: 'number', description: '月份 1-12' },
          day: { type: 'number', description: '日 1-31' },
          is_leap_month: {
            type: 'boolean',
            description: '是否为闰月（仅 lunar_to_solar 方向有效），默认 false',
          },
        },
        required: ['direction', 'year', 'month', 'day'],
      },
    },
  },

  prompt: `## convert_calendar — 农历公历转换

在农历（阴历）和公历（阳历）之间进行双向转换。

### 转换方向

1. **lunar_to_solar**（农历→公历）
   - 输入农历日期，返回对应的公历日期。
   - 如果是闰月，设置 \`is_leap_month: true\`。
   - 例：农历 2026 年正月十五 → 公历日期。

2. **solar_to_lunar**（公历→农历）
   - 输入公历日期，返回对应的农历日期。
   - 例：公历 2026-02-13 → 农历日期。

### 使用场景
- 用户说"农历三月初五"但需要公历日期来调用排盘 skill（如 bazi-paipan）。
- 用户问"今年中秋节是几号"（中秋 = 农历八月十五，需转公历）。
- 用户提供农历生日，需要转换为公历再排八字。
- 查询某个公历日期对应的农历日期和干支。

### 返回内容
- 原始日期（输入）
- 转换后的日期
- 农历月名（正月、二月、腊月等）
- 农历日名（初一、十五等）
- 是否闰月
- 对应的干支年月日

### 注意
- 农历月份大小月不固定，大月 30 天、小月 29 天。
- 不是每年都有闰月，输入无效的闰月会返回错误。
- 此工具常与 bazi-paipan / get_time_detail 配合：先把农历转公历，再用排盘 skill 或 get_time_detail 查询。`,

  execute: async (args: Record<string, unknown>) => {
    const direction = args.direction as string;
    const year = args.year as number;
    const month = args.month as number;
    const day = args.day as number;
    const isLeapMonth = (args.is_leap_month as boolean | undefined) ?? false;

    try {
      if (direction === 'lunar_to_solar') {
        // 负月份表示闰月
        const lunarMonth = isLeapMonth ? -month : month;
        const lunarDay = LunarDay.fromYmd(year, lunarMonth, day);
        const solarDay = lunarDay.getSolarDay();
        const lunarMonthObj = lunarDay.getLunarMonth();

        const yearGanzhi = lunarDay.getYearSixtyCycle().getName();
        const monthGanzhi = lunarDay.getMonthSixtyCycle().getName();
        const dayGanzhi = lunarDay.getSixtyCycle().getName();

        const lines = [
          `农历: ${year}年${isLeapMonth ? '闰' : ''}${lunarMonthObj.getName()}${lunarDay.getName()}`,
          `公历: ${solarDay.getYear()}年${solarDay.getMonth()}月${solarDay.getDay()}日`,
          `干支: ${yearGanzhi}年 ${monthGanzhi}月 ${dayGanzhi}日`,
        ];

        return { output: lines.join('\n') };
      } else if (direction === 'solar_to_lunar') {
        const solarDay = SolarDay.fromYmd(year, month, day);
        const lunarDay = solarDay.getLunarDay();
        const lunarMonthObj = lunarDay.getLunarMonth();
        const isLeap = lunarMonthObj.isLeap();

        const yearGanzhi = lunarDay.getYearSixtyCycle().getName();
        const monthGanzhi = lunarDay.getMonthSixtyCycle().getName();
        const dayGanzhi = lunarDay.getSixtyCycle().getName();

        const lunarYear = lunarMonthObj.getLunarYear().getYear();

        const lines = [
          `公历: ${year}年${month}月${day}日`,
          `农历: ${lunarYear}年${isLeap ? '闰' : ''}${lunarMonthObj.getName()}${lunarDay.getName()}`,
          `干支: ${yearGanzhi}年 ${monthGanzhi}月 ${dayGanzhi}日`,
        ];

        return { output: lines.join('\n') };
      } else {
        return {
          output: `未知方向: ${direction}，支持 lunar_to_solar 或 solar_to_lunar`,
          isError: true,
        };
      }
    } catch (error) {
      return {
        output: `日历转换失败: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};
