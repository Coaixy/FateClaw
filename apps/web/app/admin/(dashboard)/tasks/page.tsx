'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { admin, AdminUser, AdminTask } from '@/lib/admin-api';
import {
  Loader2,
  Clock,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function scheduleLabel(type: string, value: string) {
  if (type === 'cron') return `Cron: ${value}`;
  if (type === 'interval') {
    const mins = Math.round(Number(value) / 60000);
    return mins >= 60 ? `每 ${(mins / 60).toFixed(1)} 小时` : `每 ${mins} 分钟`;
  }
  if (type === 'once') return '一次性';
  return `${type}: ${value}`;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active:
      'bg-[color-mix(in_srgb,var(--color-primary)_15%,transparent)] text-primary',
    paused:
      'bg-[color-mix(in_srgb,var(--color-warning)_15%,transparent)] text-warning',
    completed:
      'bg-surface-cream-strong text-muted',
  };
  const labels: Record<string, string> = {
    active: '运行中',
    paused: '已暂停',
    completed: '已完成',
  };

  return (
    <span
      className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${styles[status] || styles.completed}`}
    >
      {labels[status] || status}
    </span>
  );
}

function TaskRow({ task }: { task: AdminTask }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-hairline rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-cream-strong transition-colors cursor-pointer text-left"
      >
        {expanded ? (
          <ChevronDown
            size={14}
            className="text-muted shrink-0"
          />
        ) : (
          <ChevronRight
            size={14}
            className="text-muted shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-medium truncate max-w-[300px]">
              {task.prompt.slice(0, 80)}
              {task.prompt.length > 80 ? '...' : ''}
            </span>
            <StatusBadge status={task.status} />
            {task.reminder_type && (
              <span className="text-[10px] px-1 py-0.5 rounded bg-surface-cream-strong text-muted">
                {task.reminder_type}
              </span>
            )}
          </div>
          <div className="text-[12px] text-muted mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0">
            <span>{task.owner_phone || '未绑定手机号'}</span>
            <span>{task.account_name || task.account_id}</span>
            <span>
              {scheduleLabel(task.schedule_type, task.schedule_value)}
            </span>
          </div>
        </div>
        <div className="hidden sm:block text-[11px] text-muted shrink-0 text-right">
          <div>创建 {formatDate(task.created_at)}</div>
          {task.next_run && <div>下次 {formatDate(task.next_run)}</div>}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-hairline px-4 py-4 space-y-3 bg-surface-card">
          {/* Prompt */}
          <div>
            <div className="text-[11px] text-muted uppercase tracking-wider mb-1">
              Prompt
            </div>
            <div className="text-[13px] whitespace-pre-wrap break-words p-3 rounded-md bg-canvas border border-hairline">
              {task.prompt}
            </div>
          </div>

          {/* Details grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(
              [
                [
                  '调度类型',
                  scheduleLabel(task.schedule_type, task.schedule_value),
                ],
                ['状态', task.status],
                ['上次执行', formatDate(task.last_run)],
                ['下次执行', formatDate(task.next_run)],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                className="px-2.5 py-2 rounded-md bg-canvas border border-hairline"
              >
                <div className="text-[10px] text-muted">
                  {label}
                </div>
                <div className="text-[13px] font-medium mt-0.5 truncate">
                  {value}
                </div>
              </div>
            ))}
          </div>

          {/* Last result */}
          {task.last_result && (
            <div>
              <div className="text-[11px] text-muted uppercase tracking-wider mb-1">
                上次结果
              </div>
              <div className="text-[13px] whitespace-pre-wrap break-words p-3 rounded-md bg-canvas border border-hairline max-h-40 overflow-y-auto">
                {task.last_result}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AdminTasksContent() {
  const searchParams = useSearchParams();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [tasks, setTasks] = useState<AdminTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedUserId, setSelectedUserId] = useState(
    searchParams.get('user_id') || '',
  );
  const [selectedStatus, setSelectedStatus] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [u, t] = await Promise.all([
        admin.users(),
        admin.tasks({
          user_id: selectedUserId || undefined,
          status: selectedStatus || undefined,
        }),
      ]);
      setUsers(u);
      setTasks(t);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [selectedUserId, selectedStatus]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  return (
    <>
      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2
            size={20}
            className="animate-spin text-muted"
          />
        </div>
      ) : error ? (
        <div className="text-center py-20">
          <p className="text-[13px] text-error">{error}</p>
        </div>
      ) : (
        <>
          {/* Filters */}
          <div className="flex flex-col sm:flex-row gap-2 mb-4">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <Clock size={16} className="text-muted shrink-0" />
              <h2 className="text-lg font-semibold shrink-0">任务管理</h2>
              <span className="text-[12px] text-muted shrink-0">
                ({tasks.length})
              </span>
              <button
                onClick={loadData}
                className="p-1.5 rounded-md text-muted hover:text-ink transition-colors cursor-pointer"
                title="刷新"
              >
                <RefreshCw size={13} />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <select
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="h-8 px-2 rounded-md border border-hairline bg-canvas text-[13px] focus:outline-none cursor-pointer max-w-[180px]"
              >
                <option value="">全部用户</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.phone}
                  </option>
                ))}
              </select>

              <select
                value={selectedStatus}
                onChange={(e) => setSelectedStatus(e.target.value)}
                className="h-8 px-2 rounded-md border border-hairline bg-canvas text-[13px] focus:outline-none cursor-pointer"
              >
                <option value="">全部状态</option>
                <option value="active">运行中</option>
                <option value="paused">已暂停</option>
                <option value="completed">已完成</option>
              </select>
            </div>
          </div>

          {/* Tasks list */}
          {tasks.length === 0 ? (
            <div className="text-center py-16">
              <Clock
                size={24}
                className="mx-auto mb-2 text-muted"
              />
              <p className="text-[13px] text-muted">暂无任务</p>
            </div>
          ) : (
            <div className="space-y-2">
              {tasks.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

export default function AdminTasksPage() {
  return (
    <Suspense>
      <AdminTasksContent />
    </Suspense>
  );
}
