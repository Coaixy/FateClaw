/**
 * schedule_reminder 工具 — 创建一次性或周期性提醒。
 *
 * 支持 cron 表达式、固定间隔（毫秒）和一次性定时三种调度方式。
 * 通过 IPC 将创建请求发送给宿主机处理。
 */

import { CronExpressionParser } from 'cron-parser';

import type { ToolResult, ToolSpec } from '../../types.js';
import { getDefaultAgentRuntimeDeps } from '../../deps.js';
import { getContext } from '../../context.js';
import { log } from '../../io.js';
import { throwIfAborted } from '../../timeout.js';

/**
 * 校验调度参数的合法性。
 * 返回 null 表示校验通过，返回 ToolResult 表示校验失败。
 */
function validateSchedule(args: {
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
}): ToolResult | null {
  if (args.schedule_type === 'cron') {
    try {
      CronExpressionParser.parse(args.schedule_value);
      return null;
    } catch {
      return {
        output: `无效的 cron 表达式: "${args.schedule_value}"`,
        isError: true,
      };
    }
  }

  if (args.schedule_type === 'interval') {
    const milliseconds = parseInt(args.schedule_value, 10);
    if (Number.isNaN(milliseconds) || milliseconds <= 0) {
      return {
        output: `无效的 interval: "${args.schedule_value}"，必须是正整数毫秒值`,
        isError: true,
      };
    }

    return null;
  }

  if (Number.isNaN(new Date(args.schedule_value).getTime())) {
    return {
      output: `无效的时间戳: "${args.schedule_value}"`,
      isError: true,
    };
  }

  return null;
}

export const scheduleReminder: ToolSpec = {
  executionMode: 'serial',
  definition: {
    type: 'function',
    function: {
      name: 'schedule_reminder',
      description:
        '创建一次性或周期性提醒。cron 示例: "0 9 * * *"，interval 示例: "3600000"，once 示例: "2026-03-25T15:30:00"。',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '提醒到期时交给 agent 处理的任务描述',
          },
          schedule_type: {
            type: 'string',
            enum: ['cron', 'interval', 'once'],
            description: '调度类型',
          },
          schedule_value: {
            type: 'string',
            description: '具体调度值，格式取决于 schedule_type',
          },
          voice_text: {
            type: 'string',
            description: '提醒时发送给用户的文案',
          },
        },
        required: ['prompt', 'schedule_type', 'schedule_value'],
      },
    },
  },

  prompt: `## schedule_reminder — 创建提醒

为用户创建一次性或周期性的定时提醒。提醒到期时，系统会自动触发 agent 执行指定的任务。

### 调度类型说明

#### cron — 基于 cron 表达式的周期性提醒
- 格式：标准五段 cron 表达式（分 时 日 月 周）。
- 示例：
  - \`0 9 * * *\` — 每天早上 9 点
  - \`30 8 * * 1-5\` — 工作日早上 8:30
  - \`0 */2 * * *\` — 每 2 小时
  - \`0 9 1 * *\` — 每月 1 号早上 9 点

#### interval — 固定时间间隔的周期性提醒
- 格式：毫秒数（正整数字符串）。
- 示例：
  - \`3600000\` — 每 1 小时（60 * 60 * 1000）
  - \`86400000\` — 每 24 小时
  - \`1800000\` — 每 30 分钟

#### once — 一次性定时提醒
- 格式：ISO 8601 日期时间字符串。
- 示例：
  - \`2026-03-25T15:30:00\` — 指定日期时间
  - \`2026-04-01T09:00:00+08:00\` — 带时区偏移

### 参数说明
- **prompt**：提醒触发时 agent 要执行的任务描述。写清楚要做什么，agent 会按此描述行动。
- **schedule_value**：根据 schedule_type 使用对应的格式。
- **voice_text**（可选）：提醒触发时直接发给用户的文案。如果不设置，默认使用 prompt 内容。适合需要友好文案的场景（如"该喝水了~"）。

### 注意事项
- 创建成功后会返回提醒 ID（reminder-xxx），可用于后续管理（暂停、取消等）。
- cron 表达式和 interval 会持续触发，直到被暂停或取消。
- once 提醒执行一次后自动完成。
- 当用户提供的是自然语言时间描述时（如"每天早上9点"），需要你转换为对应格式。`,

  execute: async (args: Record<string, unknown>, options) => {
    const prompt = args.prompt as string;
    const scheduleType = args.schedule_type as 'cron' | 'interval' | 'once';
    const scheduleValue = args.schedule_value as string;
    const voiceText = args.voice_text as string | undefined;
    const deps = options?.runtimeDeps ?? getDefaultAgentRuntimeDeps();

    const validationResult = validateSchedule({
      schedule_type: scheduleType,
      schedule_value: scheduleValue,
    });
    if (validationResult) {
      return validationResult;
    }

    const accountId = getContext().accountId;
    const taskId = `reminder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    throwIfAborted(options?.signal, 'schedule_reminder 已取消');
    await deps.messageBus.pushTask(accountId, {
      type: 'schedule_reminder',
      taskId,
      accountId,
      prompt,
      schedule_type: scheduleType,
      schedule_value: scheduleValue,
      reminder_type: 'custom',
      voice_text: voiceText || prompt,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    log(
      `工具结果: schedule_reminder accountId=${accountId} taskId=${taskId} scheduleType=${scheduleType} scheduleValue=${scheduleValue}`,
    );

    return {
      output: `提醒已创建：${taskId} (${scheduleType}: ${scheduleValue})`,
    };
  },
};
