import { ChevronDown, Loader2, Trash2 } from 'lucide-react';

import type { Task } from '@/features/tasks/api';
import {
  formatFutureTaskTime,
  formatRelativeTaskTime,
  scheduleIcon,
  scheduleLabel,
  taskStatusConfig,
} from '@/components/settings/tasks/task-utils';

export function TaskRow({
  task,
  expanded,
  deleting,
  onToggle,
  onDelete,
}: {
  task: Task;
  expanded: boolean;
  deleting: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const status = taskStatusConfig(task.status);
  const ScheduleIcon = scheduleIcon(task);

  return (
    <div className="bg-surface-card">
      <div
        className="flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-surface-cream-strong transition-colors duration-100 cursor-pointer"
        onClick={onToggle}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="relative flex h-2 w-2 shrink-0">
            {status.ping && (
              <span
                className={`animate-ping absolute inline-flex h-full w-full rounded-full ${status.dot} opacity-40`}
              />
            )}
            <span
              className={`relative inline-flex rounded-full h-2 w-2 ${status.dot}`}
            />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium truncate">{task.prompt}</p>
            <div className="flex items-center gap-2 mt-1">
              <span className="inline-flex items-center gap-1 text-[11px] text-muted bg-canvas/50 border border-hairline px-2 py-0.5 rounded-full">
                <ScheduleIcon size={10} />
                {scheduleLabel(task)}
              </span>
              {task.next_run && task.status === 'active' && (
                <span className="text-[11px] text-muted">
                  {formatFutureTaskTime(task.next_run)}
                </span>
              )}
            </div>
          </div>
        </div>
        <ChevronDown
          size={14}
          className={`text-muted shrink-0 transition-transform duration-200 ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </div>

      {expanded && (
        <div className="px-5 pb-4 border-t border-hairline">
          <div className="mt-3 mb-3 px-3 py-2.5 rounded-lg bg-canvas/50 border border-hairline">
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words">
              {task.prompt}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-2 mb-3">
            <TaskMeta
              label="状态"
              value={status.label}
              className={status.color}
            />
            <TaskMeta
              label="类型"
              value={
                task.schedule_type === 'once'
                  ? '一次性'
                  : task.schedule_type === 'cron'
                    ? '定时'
                    : '间隔'
              }
            />
            {task.last_run && (
              <TaskMeta
                label="上次执行"
                value={formatRelativeTaskTime(task.last_run)}
              />
            )}
            <TaskMeta
              label="创建时间"
              value={formatRelativeTaskTime(task.created_at)}
            />
          </div>

          <div className="flex justify-end">
            <button
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
              disabled={deleting}
              className="flex items-center gap-1 h-7 px-2.5 rounded-md text-[12px] font-medium text-muted hover:text-red-400 border border-transparent hover:border-red-500/20 hover:bg-red-500/5 disabled:opacity-30 transition-all duration-150 cursor-pointer"
            >
              {deleting ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Trash2 size={12} />
              )}
              删除任务
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TaskMeta({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-muted">{label}</span>
      <span className={`text-[11px] ${className ?? ''}`}>{value}</span>
    </div>
  );
}
