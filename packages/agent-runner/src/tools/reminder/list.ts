/**
 * list_reminders 工具 — 获取最新的提醒列表。
 *
 * 从数据库直接查询当前所有提醒。
 */

import type { ToolSpec } from '../../types.js';
import { getDefaultAgentRuntimeDeps } from '../../deps.js';
import { getContext } from '../../context.js';

export const listReminders: ToolSpec = {
  executionMode: 'parallel',
  definition: {
    type: 'function',
    function: {
      name: 'list_reminders',
      description:
        '刷新并获取最新的提醒列表。system prompt 中已包含提醒快照，仅在需要确认最新状态时调用此工具。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },

  prompt: `## list_reminders — 查看提醒列表

获取当前账号的所有提醒及其最新状态。

### 使用场景
- 用户问"我有哪些提醒""我设了什么闹钟"等。
- 在管理提醒之前（暂停/取消），先确认提醒 ID 和当前状态。
- system prompt 中已包含提醒快照，但如果用户刚刚创建或修改了提醒，可以调用此工具获取刷新后的快照。

### 返回内容
每条提醒包含：
- **ID**：提醒的唯一标识，用于后续 manage_reminder 操作。
- **描述**：提醒的任务描述（prompt 的前 60 个字符）。
- **调度信息**：schedule_type 和 schedule_value。
- **状态**：active（活跃）、paused（暂停）等。
- **下次触发时间**：预计的下一次执行时间。

### 注意事项
- 如果没有任何提醒，会返回"当前没有已设置的提醒"。`,

  execute: async (_args: Record<string, unknown>, options) => {
    const accountId = getContext().accountId;
    const deps = options?.runtimeDeps ?? getDefaultAgentRuntimeDeps();

    try {
      const tasks = await deps.taskStore.list(accountId);

      if (tasks.length === 0) {
        return { output: '当前没有已设置的提醒。' };
      }

      const formatted = tasks
        .map(
          (task) =>
            `- [${task.id}] ${task.prompt.slice(0, 60)} (${task.schedule_type}: ${task.schedule_value}) status=${task.status} next=${task.next_run || 'N/A'}`,
        )
        .join('\n');

      return { output: `当前提醒列表：\n${formatted}` };
    } catch (error) {
      return {
        output: `读取提醒失败: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};
