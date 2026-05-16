import type { AgentRuntimeDeps } from '../../deps.js';
import { getDefaultAgentRuntimeDeps } from '../../deps.js';

/**
 * 当前提醒列表：从 DB 查询活跃的定时任务（uncached）。
 */
export async function buildRemindersSection(
  accountId: string,
): Promise<string[]> {
  return buildRemindersSectionWithDeps(accountId, getDefaultAgentRuntimeDeps());
}

export async function buildRemindersSectionWithDeps(
  accountId: string,
  deps: AgentRuntimeDeps = getDefaultAgentRuntimeDeps(),
): Promise<string[]> {
  if (!accountId) return [];

  try {
    const tasks = await deps.taskStore.list(accountId);
    if (tasks.length === 0) return [];

    const lines: string[] = [];
    lines.push('', '## 当前提醒列表');
    for (const task of tasks) {
      const statusIcon =
        task.status === 'active'
          ? '✅'
          : task.status === 'paused'
            ? '⏸️'
            : '❌';
      lines.push(
        `- ${statusIcon} [${task.id}] ${task.prompt.slice(0, 60)} (${task.schedule_type}: ${task.schedule_value}) 下次: ${task.next_run || 'N/A'}`,
      );
    }
    return lines;
  } catch {
    return [];
  }
}
