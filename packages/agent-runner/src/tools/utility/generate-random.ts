/**
 * generate_random 工具 — 密码学安全的随机数生成。
 *
 * 支持四种模式：范围随机数、掷骰子、随机选择、洗牌。
 * 使用 crypto.randomInt 保证随机性，避免 LLM 自身的随机偏差。
 */

import { randomInt } from 'node:crypto';

import type { ToolSpec } from '../../types.js';

/** Fisher-Yates 洗牌，使用 crypto.randomInt。 */
function shuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export const generateRandom: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'generate_random',
      description:
        '生成真随机数。支持范围随机数、掷骰子、随机选择、洗牌打乱顺序。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['number', 'dice', 'choice', 'shuffle'],
            description:
              '模式：number（范围随机数）、dice（掷骰子）、choice（从列表随机选一个）、shuffle（打乱列表顺序）',
          },
          min: {
            type: 'integer',
            description: 'number 模式的最小值（含），必须是整数，默认 1',
          },
          max: {
            type: 'integer',
            description: 'number 模式的最大值（含），必须是整数，默认 100',
          },
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            description:
              '生成数量：number 模式生成几个随机数，dice 模式掷几个骰子。必须是整数。number 模式范围 1-100，默认 1',
          },
          sides: {
            type: 'integer',
            minimum: 2,
            maximum: 100,
            description: 'dice 模式的骰子面数，必须是整数，默认 6，范围 2-100',
          },
          items: {
            type: 'array',
            items: { type: 'string' },
            description: 'choice/shuffle 模式的选项列表',
          },
        },
        required: ['mode'],
      },
    },
  },

  prompt: `## generate_random — 真随机数生成

使用密码学安全的随机数生成器，提供真正的随机结果。

### 四种模式

1. **number** — 范围随机整数
   - \`min\`：最小值（含），默认 1
   - \`max\`：最大值（含），默认 100
   - \`count\`：生成几个，默认 1

2. **dice** — 掷骰子
   - \`sides\`：骰子面数，默认 6
   - \`count\`：掷几个骰子，默认 1
   - 自动计算总和

3. **choice** — 随机选择
   - \`items\`：选项列表（必填）
   - 从列表中随机选一个

4. **shuffle** — 洗牌
   - \`items\`：选项列表（必填）
   - 返回打乱后的完整列表

### 使用场景
- 用户要求掷骰子、抛硬币、抽签、随机点名。
- 需要从多个选项中随机选择（选餐、选电影等）。
- 打乱顺序（发言顺序、题目顺序等）。
- 生成随机数字（验证码、抽奖号码等）。

### 注意
- 此工具使用密码学安全的随机数生成器（CSPRNG），结果是真随机的。
- 抛硬币可用 dice 模式 + sides=2（1=正面，2=反面）。
- 所有数值参数都必须传 JSON 数字，不能传字符串数字，例如 "0" 是错误的，应传 0。`,

  execute: async (args: Record<string, unknown>) => {
    const mode = args.mode as string;

    switch (mode) {
      case 'number': {
        const min = (args.min as number | undefined) ?? 1;
        const max = (args.max as number | undefined) ?? 100;
        const count = (args.count as number | undefined) ?? 1;

        if (!Number.isInteger(min) || !Number.isInteger(max)) {
          return {
            output:
              '参数错误：min 和 max 必须是整数。请传 JSON 数字，例如 {"mode":"number","min":0,"max":63,"count":2}',
            isError: true,
          };
        }
        if (min > max) {
          return { output: `min(${min}) 不能大于 max(${max})`, isError: true };
        }
        if (count < 1 || count > 100) {
          return {
            output: '参数错误：count 必须是 1-100 之间的整数',
            isError: true,
          };
        }

        const results: number[] = [];
        for (let i = 0; i < count; i++) {
          results.push(randomInt(min, max + 1));
        }

        if (count === 1) {
          return { output: `随机数: ${results[0]}` };
        }
        return {
          output: `随机数 (${count}个, 范围${min}-${max}): ${results.join(', ')}`,
        };
      }

      case 'dice': {
        const sides = (args.sides as number | undefined) ?? 6;
        const count = (args.count as number | undefined) ?? 1;

        if (sides < 2 || sides > 100) {
          return {
            output: '参数错误：骰子面数必须是 2-100 之间的整数',
            isError: true,
          };
        }
        if (count < 1 || count > 20) {
          return {
            output: '参数错误：骰子数量必须是 1-20 之间的整数',
            isError: true,
          };
        }

        const results: number[] = [];
        for (let i = 0; i < count; i++) {
          results.push(randomInt(1, sides + 1));
        }

        const total = results.reduce((a, b) => a + b, 0);
        if (count === 1) {
          return { output: `掷骰结果 (${sides}面): ${results[0]}` };
        }
        return {
          output: `掷骰结果 (${count}个${sides}面骰): ${results.join(', ')} (总和: ${total})`,
        };
      }

      case 'choice': {
        const items = args.items as string[] | undefined;
        if (!items || items.length === 0) {
          return { output: 'choice 模式需要提供 items 列表', isError: true };
        }

        const index = randomInt(0, items.length);
        return { output: `随机选中: ${items[index]}` };
      }

      case 'shuffle': {
        const items = args.items as string[] | undefined;
        if (!items || items.length === 0) {
          return { output: 'shuffle 模式需要提供 items 列表', isError: true };
        }

        const shuffled = shuffle(items);
        return {
          output: `打乱顺序:\n${shuffled.map((item, i) => `${i + 1}. ${item}`).join('\n')}`,
        };
      }

      default:
        return {
          output: `未知模式: ${mode}，支持 number/dice/choice/shuffle`,
          isError: true,
        };
    }
  },
};
