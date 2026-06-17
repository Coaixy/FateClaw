'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  admin,
  type AdminAboutLedgerEntry,
  type AdminAboutLedgerEntryDraft,
  type AdminAboutLedgerEntryType,
} from '@/lib/admin-api';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Landmark,
  Loader2,
  Pencil,
  Plus,
  ReceiptText,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { useConfirm } from '@/lib/use-confirm';

interface LedgerFormState {
  entryType: AdminAboutLedgerEntryType;
  occurredAt: string;
  content: string;
  amountYuan: string;
}

const ENTRY_TYPE_OPTIONS: Array<{
  value: AdminAboutLedgerEntryType;
  label: string;
}> = [
  { value: 'income', label: '收入' },
  { value: 'expense', label: '支出' },
];

function dateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createEmptyForm(): LedgerFormState {
  return {
    entryType: 'expense',
    occurredAt: dateInputValue(new Date()),
    content: '',
    amountYuan: '',
  };
}

function formatMoneyYuan(value: number) {
  return `${value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} 元`;
}

function formatDateOnly(value: string) {
  const [year, month, day] = value.split('-');
  if (!year || !month || !day) return value;
  return `${year}.${month}.${day}`;
}

function entryTypeLabel(type: AdminAboutLedgerEntryType) {
  return type === 'income' ? '收入' : '支出';
}

function toDraft(form: LedgerFormState): AdminAboutLedgerEntryDraft | null {
  const amount = Number(form.amountYuan);
  const content = form.content.trim();
  if (!form.occurredAt || !content || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  return {
    entry_type: form.entryType,
    occurred_at: form.occurredAt,
    content,
    amount_yuan: Math.round(amount * 100) / 100,
  };
}

function SummaryMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof ArrowUpRight;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface-card px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-[12px] text-muted">
        <Icon size={13} />
        <span>{label}</span>
      </div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function EntryTypeBadge({ type }: { type: AdminAboutLedgerEntryType }) {
  const isIncome = type === 'income';
  return (
    <span
      className={`inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[12px] font-medium ${
        isIncome
          ? 'border-emerald-500/25 bg-emerald-500/8 text-emerald-700'
          : 'border-rose-500/25 bg-rose-500/8 text-rose-700'
      }`}
    >
      {isIncome ? <ArrowUpRight size={12} /> : <ArrowDownLeft size={12} />}
      {entryTypeLabel(type)}
    </span>
  );
}

/**
 * 关于页面收支流水后台管理页。
 *
 * 管理员可维护公开展示的收入、支出、时间、内容与数额。
 */
export default function AdminAboutLedgerPage() {
  const { confirm } = useConfirm();
  const [entries, setEntries] = useState<AdminAboutLedgerEntry[]>([]);
  const [form, setForm] = useState<LedgerFormState>(() => createEmptyForm());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const summary = useMemo(() => {
    return entries.reduce(
      (acc, entry) => {
        if (entry.entry_type === 'income') {
          acc.income += entry.amount_yuan;
        } else {
          acc.expense += entry.amount_yuan;
        }
        return acc;
      },
      { income: 0, expense: 0 },
    );
  }, [entries]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await admin.aboutLedger();
      setEntries(data.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setForm(createEmptyForm());
    setMessage('');
  }, []);

  const startEdit = useCallback((entry: AdminAboutLedgerEntry) => {
    setEditingId(entry.id);
    setForm({
      entryType: entry.entry_type,
      occurredAt: entry.occurred_at,
      content: entry.content,
      amountYuan: String(entry.amount_yuan),
    });
    setMessage('');
    setError('');
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setMessage('');

    const draft = toDraft(form);
    if (!draft) {
      setError('请完整填写时间、内容和大于 0 的数额');
      return;
    }

    setBusyId('save');
    try {
      if (editingId) {
        await admin.updateAboutLedgerEntry(editingId, draft);
        setMessage('收支记录已更新');
      } else {
        await admin.createAboutLedgerEntry(draft);
        setMessage('收支记录已新增');
      }
      setEditingId(null);
      setForm(createEmptyForm());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusyId('');
    }
  };

  const handleDelete = async (entry: AdminAboutLedgerEntry) => {
    const confirmed = await confirm({
      title: '删除收支记录',
      message: `确定删除「${entry.content}」吗？\n\n该记录会从关于页面公开收支流水中移除，删除后无法恢复。`,
      confirmLabel: '删除',
      variant: 'danger',
    });
    if (!confirmed) return;

    setBusyId(entry.id);
    setError('');
    setMessage('');
    try {
      await admin.deleteAboutLedgerEntry(entry.id);
      if (editingId === entry.id) {
        resetForm();
      }
      setMessage('收支记录已删除');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusyId('');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 size={20} className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Landmark size={16} className="text-muted" />
            <h2 className="text-lg font-semibold">关于页收支</h2>
          </div>
          <p className="mt-1 text-[13px] leading-6 text-muted">
            维护关于页面公开展示的收入与支出流水。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex h-10 cursor-pointer items-center gap-2 self-start rounded-lg border border-hairline px-3 text-[13px] text-muted hover:text-ink"
          title="刷新"
        >
          <RefreshCw size={13} />
          刷新
        </button>
      </div>

      {(error || message) && (
        <div
          className={`rounded-lg border px-4 py-3 text-[13px] ${
            error
              ? 'border-error/30 bg-error/8 text-error'
              : 'border-emerald-500/30 bg-emerald-500/8 text-emerald-700'
          }`}
        >
          {error || message}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-3">
        <SummaryMetric
          icon={ArrowUpRight}
          label="收入合计"
          value={formatMoneyYuan(summary.income)}
        />
        <SummaryMetric
          icon={ArrowDownLeft}
          label="支出合计"
          value={formatMoneyYuan(summary.expense)}
        />
        <SummaryMetric
          icon={ReceiptText}
          label="结余"
          value={formatMoneyYuan(summary.income - summary.expense)}
        />
      </div>

      <section className="rounded-xl border border-hairline bg-surface-card p-4">
        <div className="mb-3 flex items-center gap-2">
          {editingId ? (
            <Pencil size={14} className="text-muted" />
          ) : (
            <Plus size={14} className="text-muted" />
          )}
          <h3 className="text-[14px] font-semibold">
            {editingId ? '编辑收支记录' : '新增收支记录'}
          </h3>
        </div>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="grid gap-3 lg:grid-cols-[120px_150px_minmax(220px,1fr)_150px_auto] lg:items-end"
        >
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">类型</span>
            <select
              value={form.entryType}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  entryType: event.target.value as AdminAboutLedgerEntryType,
                }))
              }
              className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
            >
              {ENTRY_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">时间</span>
            <input
              type="date"
              value={form.occurredAt}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  occurredAt: event.target.value,
                }))
              }
              className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
            />
          </label>

          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">内容</span>
            <input
              type="text"
              value={form.content}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  content: event.target.value,
                }))
              }
              placeholder="例如：服务器成本"
              className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
            />
          </label>

          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">数额</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={form.amountYuan}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  amountYuan: event.target.value,
                }))
              }
              placeholder="0.00"
              className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
            />
          </label>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busyId === 'save'}
              className="inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-on-primary transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busyId === 'save' ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Save size={13} />
              )}
              保存
            </button>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                className="inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-hairline px-3 text-[13px] text-muted hover:text-ink"
              >
                <X size={13} />
                取消
              </button>
            )}
          </div>
        </form>
      </section>

      <section className="overflow-hidden rounded-xl border border-hairline bg-surface-card">
        <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
          <ReceiptText size={14} className="text-muted" />
          <h3 className="text-[14px] font-semibold">收支流水</h3>
          <span className="text-[12px] text-muted">{entries.length} 条</span>
        </div>

        {entries.length === 0 ? (
          <div className="px-4 py-12 text-center text-[13px] text-muted">
            暂无收支记录
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead className="border-b border-hairline text-[12px] text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">类型</th>
                  <th className="px-4 py-2.5 font-medium">时间</th>
                  <th className="px-4 py-2.5 font-medium">内容</th>
                  <th className="px-4 py-2.5 text-right font-medium">数额</th>
                  <th className="px-4 py-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-b border-hairline/60 last:border-0"
                  >
                    <td className="px-4 py-3">
                      <EntryTypeBadge type={entry.entry_type} />
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted">
                      {formatDateOnly(entry.occurred_at)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="max-w-[360px] whitespace-normal break-words text-ink">
                        {entry.content}
                      </div>
                    </td>
                    <td
                      className={`px-4 py-3 text-right font-semibold tabular-nums ${
                        entry.entry_type === 'income'
                          ? 'text-emerald-700'
                          : 'text-rose-700'
                      }`}
                    >
                      {formatMoneyYuan(entry.amount_yuan)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => startEdit(entry)}
                          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-hairline px-2.5 text-[12px] text-muted hover:text-ink"
                        >
                          <Pencil size={12} />
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(entry)}
                          disabled={busyId === entry.id}
                          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-error/30 px-2.5 text-[12px] text-error transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {busyId === entry.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Trash2 size={12} />
                          )}
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
