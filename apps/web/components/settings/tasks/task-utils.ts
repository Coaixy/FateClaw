import { CalendarClock, Repeat, Timer } from 'lucide-react';

import type { Task } from '@/features/tasks/api';

export function scheduleLabel(task: Task): string {
  if (task.schedule_type === 'once') return '一次性';
  if (task.schedule_type === 'cron') return task.schedule_value;
  const minutes = Math.round(parseInt(task.schedule_value, 10) / 60000);
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

export function scheduleIcon(task: Task) {
  if (task.schedule_type === 'once') return Timer;
  if (task.schedule_type === 'cron') return CalendarClock;
  return Repeat;
}

export function taskStatusConfig(status: string) {
  switch (status) {
    case 'active':
      return {
        label: '运行中',
        color: 'text-success',
        dot: 'bg-success',
        ping: true,
      };
    case 'paused':
      return {
        label: '已暂停',
        color: 'text-amber-400',
        dot: 'bg-amber-400',
        ping: false,
      };
    default:
      return {
        label: '已停止',
        color: 'text-muted',
        dot: 'bg-muted/40',
        ping: false,
      };
  }
}

export function formatRelativeTaskTime(ts: string) {
  const date = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export function formatFutureTaskTime(ts: string) {
  const date = new Date(ts);
  const now = new Date();
  const diff = date.getTime() - now.getTime();
  if (diff <= 0) return '即将执行';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  return date.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
