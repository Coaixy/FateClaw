/**
 * convert_time 工具 — 时间戳与可读时间互转。
 *
 * 自动检测输入是时间戳还是日期字符串，进行双向转换。
 * 支持秒级和毫秒级时间戳的自动识别。
 */

import type { ToolSpec } from '../../types.js';
import { getContext } from '../../context.js';
import { formatLocalDateTime } from '../../utils/format-time.js';

export const convertTime: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'convert_time',
      description:
        '时间戳与可读时间互转。传入 Unix 时间戳（秒或毫秒）返回可读时间，传入日期字符串返回时间戳。',
      parameters: {
        type: 'object',
        properties: {
          value: {
            type: 'string',
            description:
              '要转换的值：Unix 时间戳（如 "1711699200" 或 "1711699200000"）或日期字符串（如 "2024-03-29 16:00:00"）',
          },
        },
        required: ['value'],
      },
    },
  },

  prompt: `## convert_time — 时间格式转换

在 Unix 时间戳和人类可读的日期时间格式之间进行双向转换。

### 自动检测输入格式
- 纯数字输入自动识别为 Unix 时间戳：
  - 10 位及以下 → 秒级时间戳（自动乘以 1000 转为毫秒）
  - 11 位及以上 → 毫秒级时间戳
- 非纯数字输入自动识别为日期字符串。

### 输入示例
- 时间戳：\`1711699200\`（秒）或 \`1711699200000\`（毫秒）
- 日期字符串：\`2024-03-29 16:00:00\`、\`2024-03-29T16:00:00+08:00\`

### 返回内容
无论哪种输入，都会同时返回：
- 本地时间（用户时区，含星期）
- UTC 时间（ISO 8601 格式）
- 秒级时间戳
- 毫秒级时间戳

### 使用场景
- Skill 脚本需要 Unix 时间戳参数，但用户提供的是自然语言日期。
- 需要将 API 返回的时间戳转为用户可读格式。
- 对话中涉及时间计算或时区转换。

### 重要提示
- 当 skill 脚本需要时间戳参数时，**必须使用此工具获取准确时间戳**，禁止自行计算。
- 此工具能正确处理时区转换，避免手动计算导致的时区偏差。`,

  execute: async (args: Record<string, unknown>) => {
    const timezone = getContext().timezone;
    const raw = (args.value as string).trim();

    // 判断是否为纯数字（时间戳）
    if (/^\d+$/.test(raw)) {
      let ms = parseInt(raw, 10);
      // 10 位视为秒级时间戳，转为毫秒
      if (raw.length <= 10) {
        ms *= 1000;
      }
      const date = new Date(ms);
      if (Number.isNaN(date.getTime())) {
        return { output: `无效的时间戳: "${raw}"`, isError: true };
      }

      const local = formatLocalDateTime(date, timezone);

      return {
        output: [
          `时间戳: ${raw}`,
          `本地时间: ${local} (${timezone})`,
          `UTC: ${date.toISOString()}`,
          `秒级时间戳: ${Math.floor(date.getTime() / 1000)}`,
          `毫秒级时间戳: ${date.getTime()}`,
        ].join('\n'),
      };
    }

    // 否则视为日期字符串
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      return { output: `无法解析的时间格式: "${raw}"`, isError: true };
    }

    const local = formatLocalDateTime(date, timezone);

    return {
      output: [
        `输入: ${raw}`,
        `本地时间: ${local} (${timezone})`,
        `UTC: ${date.toISOString()}`,
        `秒级时间戳: ${Math.floor(date.getTime() / 1000)}`,
        `毫秒级时间戳: ${date.getTime()}`,
      ].join('\n'),
    };
  },
};
