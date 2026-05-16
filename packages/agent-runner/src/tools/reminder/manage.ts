/**
 * manage_reminder 工具 — 暂停、恢复或取消一个提醒。
 *
 * 先检查提醒快照中是否存在目标提醒，
 * 然后通过 IPC 将管理操作发送给宿主机执行。
 */

import type { ToolSpec } from '../../types.js';
import { getDefaultAgentRuntimeDeps } from '../../deps.js';
import { getContext } from '../../context.js';
import { log } from '../../io.js';
import { throwIfAborted } from '../../timeout.js';

export const manageReminder: ToolSpec = {
  executionMode: 'serial',
  definition: {
    type: 'function',
    function: {
      name: 'manage_reminder',
      description:
        '暂停、恢复或取消一个提醒。建议先调用 list_reminders 确认提醒 ID 存在。',
      parameters: {
        type: 'object',
        properties: {
          reminder_id: { type: 'string', description: '提醒 ID' },
          action: {
            type: 'string',
            enum: ['pause', 'resume', 'cancel'],
            description: '要执行的动作',
          },
        },
        required: ['reminder_id', 'action'],
      },
    },
  },

  prompt: `## manage_reminder — 管理提醒

对已有的提醒执行暂停、恢复或取消操作。

### 操作说明
- **pause**：暂停一个活跃的提醒。暂停后提醒不会触发，但不会被删除，可以稍后恢复。
- **resume**：恢复一个已暂停的提醒。恢复后提醒恢复正常的调度触发。
- **cancel**：永久取消一个提醒。取消后不可恢复，如需相同提醒需要重新创建。

### 使用流程
1. **先调用 list_reminders** 获取最新的提醒列表和 ID。
2. 确认目标提醒的 ID 后，再调用 manage_reminder 执行操作。
3. 如果用户描述的是提醒内容而非 ID，需要先通过 list_reminders 找到对应的 ID。

### 注意事项
- reminder_id 必须是精确匹配的提醒 ID，不支持模糊匹配。
- 如果 ID 不存在，会返回错误提示。
- 操作通过 IPC 发送给宿主机异步执行，返回成功只表示请求已提交。`,

  execute: async (args: Record<string, unknown>, options) => {
    const reminderId = args.reminder_id as string;
    const action = args.action as 'pause' | 'resume' | 'cancel';
    const accountId = getContext().accountId;
    const deps = options?.runtimeDeps ?? getDefaultAgentRuntimeDeps();

    // 先检查 DB 中是否存在该提醒
    try {
      const tasks = await deps.taskStore.list(accountId);
      const target = tasks.find((t) => t.id === reminderId);
      if (!target) {
        return {
          output: `未找到提醒 ${reminderId}，请先调用 list_reminders 确认 ID。`,
          isError: true,
        };
      }
    } catch {
      // 查询失败不阻断操作
    }

    throwIfAborted(options?.signal, 'manage_reminder 已取消');
    await deps.messageBus.pushTask(accountId, {
      type: `${action}_reminder`,
      taskId: reminderId,
      accountId,
      timestamp: new Date().toISOString(),
    });

    log(
      `工具结果: manage_reminder accountId=${accountId} reminderId=${reminderId} action=${action}`,
    );

    return {
      output: `已提交提醒操作：${reminderId} -> ${action}`,
    };
  },
};
