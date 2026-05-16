/**
 * 定时任务域跨端契约。
 */

export type TaskScheduleType = 'cron' | 'interval' | 'once';

export type TaskReminderType =
  | 'medicine'
  | 'exercise'
  | 'water'
  | 'custom'
  | null;

export type TaskStatus = 'active' | 'paused' | 'completed';

export interface TaskDto {
  id: string;
  account_id: string;
  prompt: string;
  schedule_type: TaskScheduleType;
  schedule_value: string;
  reminder_type: TaskReminderType;
  voice_text: string | null;
  next_run: string | null;
  last_run: string | null;
  status: TaskStatus;
  created_at: string;
}
