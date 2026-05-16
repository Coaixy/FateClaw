/**
 * reverse_bazi 工具 — 从干支（八字/三柱）反查公历日期。
 *
 * 使用 tyme4ts 的 EightChar.getSolarTimes 和 ThreePillars.getSolarDays
 * 在指定年份范围内搜索匹配的公历日期。
 */

import { EightChar, ThreePillars } from 'tyme4ts';

import type { ToolSpec } from '../../types.js';

const MAX_RESULTS = 20;

export const reverseBazi: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'reverse_bazi',
      description:
        '从干支（年柱、月柱、日柱、可选时柱）反查匹配的公历日期。是 get_time_detail 的逆向操作。',
      parameters: {
        type: 'object',
        properties: {
          year_ganzhi: {
            type: 'string',
            description: '年柱干支，如 "甲子"、"丙寅"',
          },
          month_ganzhi: {
            type: 'string',
            description: '月柱干支，如 "庚子"',
          },
          day_ganzhi: {
            type: 'string',
            description: '日柱干支，如 "甲午"',
          },
          hour_ganzhi: {
            type: 'string',
            description:
              '时柱干支，如 "丙寅"（可选，不提供则只匹配年月日三柱）',
          },
          start_year: {
            type: 'number',
            description: '搜索起始年份，默认 1900',
          },
          end_year: {
            type: 'number',
            description: '搜索结束年份，默认 2100',
          },
        },
        required: ['year_ganzhi', 'month_ganzhi', 'day_ganzhi'],
      },
    },
  },

  prompt: `## reverse_bazi — 干支反查公历日期

根据干支（年柱、月柱、日柱，可选时柱）反查在指定年份范围内匹配的所有公历日期。
这是 get_time_detail 的逆向操作。

### 参数说明
- **year_ganzhi**（必填）：年柱，如"甲子""丙寅"。
- **month_ganzhi**（必填）：月柱，如"庚子"。
- **day_ganzhi**（必填）：日柱，如"甲午"。
- **hour_ganzhi**（可选）：时柱，如"丙寅"。不提供则只用三柱匹配，结果更多。
- **start_year**（可选）：搜索起始年份，默认 1900。
- **end_year**（可选）：搜索结束年份，默认 2100。

### 使用场景
- 用户问"甲子年庚子月甲午日是什么时候"。
- 已知八字，想查对应哪些公历日期。
- 验证某个八字组合在某年份范围内是否存在。
- 历法研究：查找特定干支组合的出现规律。

### 返回内容
- 匹配的公历日期列表（最多 ${MAX_RESULTS} 条）。
- 每条包含公历日期和完整八字信息。

### 注意
- 干支 60 年一循环，200 年范围内通常有 3-4 个匹配结果。
- 四柱完整匹配（含时柱）结果更精确但更少。
- 三柱匹配（不含时柱）结果更多，每个匹配日期有 12 个可能的时柱。`,

  execute: async (args: Record<string, unknown>) => {
    const yearGanzhi = args.year_ganzhi as string;
    const monthGanzhi = args.month_ganzhi as string;
    const dayGanzhi = args.day_ganzhi as string;
    const hourGanzhi = args.hour_ganzhi as string | undefined;
    const startYear = (args.start_year as number | undefined) ?? 1900;
    const endYear = (args.end_year as number | undefined) ?? 2100;

    if (endYear - startYear > 500) {
      return {
        output: '搜索范围不能超过 500 年，请缩小 start_year 和 end_year 的范围',
        isError: true,
      };
    }

    try {
      if (hourGanzhi) {
        // 四柱精确匹配
        const eightChar = new EightChar(
          yearGanzhi,
          monthGanzhi,
          dayGanzhi,
          hourGanzhi,
        );
        const solarTimes = eightChar.getSolarTimes(startYear, endYear);

        if (solarTimes.length === 0) {
          return {
            output: `在 ${startYear}-${endYear} 年范围内未找到匹配 "${yearGanzhi} ${monthGanzhi} ${dayGanzhi} ${hourGanzhi}" 的日期`,
          };
        }

        const results = solarTimes.slice(0, MAX_RESULTS);
        const lines = [
          `八字 "${yearGanzhi} ${monthGanzhi} ${dayGanzhi} ${hourGanzhi}" 在 ${startYear}-${endYear} 年匹配 ${solarTimes.length} 个结果:`,
          '',
        ];

        for (const st of results) {
          const sd = st.getSolarDay();
          lines.push(
            `公历: ${sd.getYear()}年${sd.getMonth()}月${sd.getDay()}日 ${st.getHour()}:${String(st.getMinute()).padStart(2, '0')}`,
          );
        }

        if (solarTimes.length > MAX_RESULTS) {
          lines.push(`\n(仅显示前 ${MAX_RESULTS} 条)`);
        }

        return { output: lines.join('\n') };
      } else {
        // 三柱匹配（不含时柱）
        const threePillars = new ThreePillars(
          yearGanzhi,
          monthGanzhi,
          dayGanzhi,
        );
        const solarDays = threePillars.getSolarDays(startYear, endYear);

        if (solarDays.length === 0) {
          return {
            output: `在 ${startYear}-${endYear} 年范围内未找到匹配 "${yearGanzhi} ${monthGanzhi} ${dayGanzhi}" 的日期`,
          };
        }

        const results = solarDays.slice(0, MAX_RESULTS);
        const lines = [
          `三柱 "${yearGanzhi} ${monthGanzhi} ${dayGanzhi}" 在 ${startYear}-${endYear} 年匹配 ${solarDays.length} 个结果:`,
          '',
        ];

        for (const sd of results) {
          const lunarDay = sd.getLunarDay();
          const lunarMonth = lunarDay.getLunarMonth();
          lines.push(
            `公历: ${sd.getYear()}年${sd.getMonth()}月${sd.getDay()}日 | 农历: ${isLeap(lunarMonth) ? '闰' : ''}${lunarMonth.getName()}${lunarDay.getName()}`,
          );
        }

        if (solarDays.length > MAX_RESULTS) {
          lines.push(`\n(仅显示前 ${MAX_RESULTS} 条)`);
        }

        return { output: lines.join('\n') };
      }
    } catch (error) {
      return {
        output: `干支反查失败: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};

/** 提取闰月判断，避免内联时类型推断问题。 */
function isLeap(month: { isLeap(): boolean }): boolean {
  return month.isLeap();
}
