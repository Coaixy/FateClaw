'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Landmark,
  Loader2,
  NotebookText,
  ReceiptText,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import {
  aboutApi,
  type PublicAboutLedgerEntry,
  type PublicAboutLedgerEntryType,
} from '@/features/about/api';

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

function ledgerTypeLabel(type: PublicAboutLedgerEntryType) {
  return type === 'income' ? '收入' : '支出';
}

function SummaryCard({
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
      <div className="text-xl font-semibold tabular-nums text-ink">{value}</div>
    </div>
  );
}

function LedgerSection({
  type,
  entries,
}: {
  type: PublicAboutLedgerEntryType;
  entries: PublicAboutLedgerEntry[];
}) {
  const isIncome = type === 'income';
  const Icon = isIncome ? ArrowUpRight : ArrowDownLeft;
  return (
    <section className="overflow-hidden rounded-xl border border-hairline bg-surface-card">
      <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon
            size={14}
            className={isIncome ? 'text-emerald-700' : 'text-rose-700'}
          />
          <h2 className="text-[14px] font-semibold">
            {ledgerTypeLabel(type)}
          </h2>
        </div>
        <span className="text-[12px] text-muted">{entries.length} 条</span>
      </div>

      {entries.length === 0 ? (
        <div className="px-4 py-8 text-center text-[13px] text-muted">
          暂无记录
        </div>
      ) : (
        <div className="divide-y divide-hairline/60">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="grid gap-2 px-4 py-3 sm:grid-cols-[104px_minmax(0,1fr)_132px] sm:items-center"
            >
              <div className="text-[12px] tabular-nums text-muted">
                {formatDateOnly(entry.occurred_at)}
              </div>
              <div className="min-w-0 text-[13px] leading-6 text-ink">
                {entry.content}
              </div>
              <div
                className={`text-[13px] font-semibold tabular-nums sm:text-right ${
                  isIncome ? 'text-emerald-700' : 'text-rose-700'
                }`}
              >
                {formatMoneyYuan(entry.amount_yuan)}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * 关于页面客户端内容。
 *
 * 从公开接口读取后台维护的收支流水，并按收入、支出分别展示。
 */
export function AboutClient() {
  const [entries, setEntries] = useState<PublicAboutLedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await aboutApi.ledger();
      setEntries(data.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : '收支记录暂时无法加载');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    return entries.reduce(
      (acc, entry) => {
        acc[entry.entry_type].push(entry);
        if (entry.entry_type === 'income') {
          acc.incomeTotal += entry.amount_yuan;
        } else {
          acc.expenseTotal += entry.amount_yuan;
        }
        return acc;
      },
      {
        income: [] as PublicAboutLedgerEntry[],
        expense: [] as PublicAboutLedgerEntry[],
        incomeTotal: 0,
        expenseTotal: 0,
      },
    );
  }, [entries]);

  return (
    <AppShell requireAuth={false}>
      <div className="space-y-5">
        <section className="relative overflow-hidden rounded-xl border border-hairline bg-surface-card shadow-[0_10px_28px_rgba(15,23,42,0.04)]">
          <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_31px,color-mix(in_srgb,var(--color-hairline)_55%,transparent)_32px)] bg-[size:100%_32px] opacity-70" />
          <div className="absolute bottom-0 left-8 top-0 w-px bg-error/25 sm:left-11" />

          <div className="relative space-y-6 px-5 py-5 pl-12 sm:px-7 sm:py-7 sm:pl-16">
            <div>
              <div className="flex items-center gap-2 text-[12px] font-semibold text-primary">
                <NotebookText size={14} />
                公开记事本
              </div>
              <h1 className="mt-2 text-2xl font-semibold text-ink">
                FateClaw·守义AI
              </h1>
            </div>

            <div className="space-y-4 text-[14px] leading-7 text-ink/85">
              <p>
                FateClaw·守义AI 致力于以现代方式弘扬中国优良传统文化瑰宝，八字命理、奇门遁甲、六爻纳甲等皆为中华先民的智慧结晶。
              </p>
              <p>
                本站为非盈利性质，收费部分覆盖服务器与 AI 算力等运营成本后，结余将用于支持中国公益事业。
              </p>
            </div>
          </div>
        </section>

        {loading ? (
          <div className="flex justify-center rounded-xl border border-hairline bg-surface-card py-12">
            <Loader2 size={20} className="animate-spin text-muted" />
          </div>
        ) : error ? (
          <div className="rounded-xl border border-error/30 bg-error/8 px-4 py-4 text-[13px] text-error">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => void load()}
                className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-md border border-error/30 px-3 text-[13px]"
              >
                <RefreshCw size={13} />
                重试
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              <SummaryCard
                icon={ArrowUpRight}
                label="收入合计"
                value={formatMoneyYuan(grouped.incomeTotal)}
              />
              <SummaryCard
                icon={ArrowDownLeft}
                label="支出合计"
                value={formatMoneyYuan(grouped.expenseTotal)}
              />
              <SummaryCard
                icon={ReceiptText}
                label="当前结余"
                value={formatMoneyYuan(
                  grouped.incomeTotal - grouped.expenseTotal,
                )}
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <LedgerSection type="income" entries={grouped.income} />
              <LedgerSection type="expense" entries={grouped.expense} />
            </div>
          </>
        )}

        <section className="rounded-xl border border-hairline bg-surface-card p-4">
          <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-ink">
            <ShieldAlert size={15} className="text-primary" />
            娱乐参考声明
          </div>
          <p className="text-[13px] leading-6 text-muted">
            站内所有 AI 输出仅供娱乐参考，不构成任何人生、健康、财务、婚恋等决策建议。开心第一，命运在己。
          </p>
        </section>

        <div className="flex items-center gap-2 text-[11px] text-muted/75">
          <Landmark size={13} />
          <span>以现代工具记录传统文化、运营成本与公益初心。</span>
        </div>
      </div>
    </AppShell>
  );
}
