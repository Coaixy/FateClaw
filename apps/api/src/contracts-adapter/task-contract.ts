import type { TaskDto } from '@fateclaw/contracts/tasks';

import type { ScheduledTask } from '../shared/types.js';

/**
 * 定时任务对外 DTO。
 * 不透出 scheduler_locked_until / last_result 等内部调度细节。
 */
export function toTaskDto(task: ScheduledTask): TaskDto {
  return {
    id: task.id,
    account_id: task.account_id,
    prompt: task.prompt,
    schedule_type: task.schedule_type,
    schedule_value: task.schedule_value,
    reminder_type: task.reminder_type,
    voice_text: task.voice_text,
    next_run: task.next_run,
    last_run: task.last_run,
    status: task.status,
    created_at: task.created_at,
  };
}
