'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, CheckCircle2, XCircle, FileText } from 'lucide-react';

import { admin, type AdminWithdrawal } from '@/lib/admin-api';

type StatusFilter =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'paid'
  | 'cancelled'
  | 'all';

function statusLabel(s: AdminWithdrawal['status']): string {
  return (
    {
      pending: '审核中',
      approved: '已批准',
      rejected: '已驳回',
      paid: '已打款',
      cancelled: '已取消',
    } as const
  )[s];
}

function statusColor(s: AdminWithdrawal['status']): string {
  return {
    pending: 'text-yellow-400',
    approved: 'text-blue-400',
    rejected: 'text-red-400',
    paid: 'text-success',
    cancelled: 'text-muted',
  }[s];
}

export default function AdminWithdrawalsPage() {
  const [rows, setRows] = useState<AdminWithdrawal[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>('pending');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await admin.listWithdrawals(
        filter === 'all' ? {} : { status: filter },
      );
      setRows(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="shrink-0 whitespace-nowrap text-base font-semibold tracking-tight">
          提现审核
        </h2>
        <div className="flex flex-wrap justify-end gap-1.5 text-[12px]">
          {(
            ['pending', 'approved', 'paid', 'rejected', 'all'] as StatusFilter[]
          ).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`shrink-0 whitespace-nowrap px-3 h-8 rounded-lg border transition-colors ${
                filter === f
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-hairline text-muted hover:text-ink'
              }`}
            >
              {f === 'all' ? '全部' : statusLabel(f as AdminWithdrawal['status'])}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="text-[12px] text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-hairline bg-surface-card py-16 text-center text-[13px] text-muted">
          暂无记录
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((wd) => (
            <WithdrawalCard key={wd.id} wd={wd} onChanged={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}

function WithdrawalCard({
  wd,
  onChanged,
}: {
  wd: AdminWithdrawal;
  onChanged: () => void;
}) {
  const [showActions, setShowActions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [approveForm, setApproveForm] = useState({
    tax_amount_yuan: '0',
    net_amount_yuan: wd.amount_yuan,
    platform_fee_points: 0,
    note: '',
  });
  const [rejectNote, setRejectNote] = useState('');
  const [proof, setProof] = useState('');
  const [err, setErr] = useState('');

  const handleApprove = async () => {
    setBusy(true);
    setErr('');
    try {
      await admin.approveWithdrawal(wd.id, {
        tax_amount_yuan: approveForm.tax_amount_yuan || '0',
        net_amount_yuan: approveForm.net_amount_yuan,
        platform_fee_points: Number(approveForm.platform_fee_points) || 0,
        note: approveForm.note || undefined,
      });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '失败');
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (!rejectNote.trim()) {
      setErr('必须填写驳回原因');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await admin.rejectWithdrawal(wd.id, { note: rejectNote });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '失败');
    } finally {
      setBusy(false);
    }
  };

  const handleMarkPaid = async () => {
    if (!proof.trim()) {
      setErr('必须填写付款凭证（如流水号或链接）');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await admin.markWithdrawalPaid(wd.id, { payment_proof: proof });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-hairline bg-surface-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-bold tabular-nums">
              {wd.amount_points.toLocaleString()} 积分
            </span>
            <span className="text-[12px] text-muted">
              ¥{wd.amount_yuan}
            </span>
            <span
              className={`shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase ${statusColor(
                wd.status,
              )}`}
            >
              {statusLabel(wd.status)}
            </span>
          </div>
          <div className="text-[11px] text-muted font-mono">
            {wd.id} · {new Date(wd.created_at).toLocaleString('zh-CN')}
          </div>
        </div>
        {(wd.status === 'pending' || wd.status === 'approved') && (
          <button
            onClick={() => setShowActions((v) => !v)}
            className="shrink-0 h-8 px-3 rounded-lg border border-hairline text-[12px] hover:bg-surface-cream-strong"
          >
            {showActions ? '收起' : '处理'}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 text-[12px]">
        <Field label="创作者" value={wd.creator_id} mono />
        <Field
          label="结算类型"
          value={wd.tax_type === 'company' ? '对公' : '个人'}
        />
        <Field label="户名" value={wd.account_name ?? '—'} />
        <Field label="银行" value={wd.bank_name ?? '—'} />
        <Field label="账号" value={wd.bank_account ?? '—'} mono />
        {wd.tax_type === 'personal' ? (
          <Field label="身份证" value={wd.id_number_masked ?? '—'} mono />
        ) : (
          <>
            <Field label="公司" value={wd.company_name ?? '—'} />
            <Field label="税号" value={wd.tax_id ?? '—'} mono />
          </>
        )}
        {wd.reviewed_at && (
          <Field
            label="审核时间"
            value={new Date(wd.reviewed_at).toLocaleString('zh-CN')}
          />
        )}
        {wd.review_note && <Field label="审核备注" value={wd.review_note} />}
      </div>

      {showActions && wd.status === 'pending' && (
        <div className="space-y-2 border-t border-hairline/50 pt-3">
          <div className="text-[11px] font-semibold text-muted">
            审核通过（确认税务/净打款后填入）
          </div>
          <div className="grid grid-cols-3 gap-2">
            <LabeledInput
              label="税费 (元)"
              value={approveForm.tax_amount_yuan}
              onChange={(v) =>
                setApproveForm({ ...approveForm, tax_amount_yuan: v })
              }
            />
            <LabeledInput
              label="实付 (元)"
              value={approveForm.net_amount_yuan}
              onChange={(v) =>
                setApproveForm({ ...approveForm, net_amount_yuan: v })
              }
            />
            <LabeledInput
              label="手续费 (积分)"
              value={String(approveForm.platform_fee_points)}
              onChange={(v) =>
                setApproveForm({
                  ...approveForm,
                  platform_fee_points: Number(v) || 0,
                })
              }
            />
          </div>
          <LabeledInput
            label="审核备注（可选）"
            value={approveForm.note}
            onChange={(v) => setApproveForm({ ...approveForm, note: v })}
          />
          <div className="flex gap-2">
            <button
              onClick={handleApprove}
              disabled={busy}
              className="flex-1 h-9 rounded-lg bg-success text-white text-[12px] font-semibold flex items-center justify-center gap-1.5 disabled:opacity-60"
            >
              <CheckCircle2 size={14} />
              通过并扣减积分
            </button>
          </div>

          <div className="border-t border-hairline/50 pt-3">
            <div className="text-[11px] font-semibold text-muted mb-2">
              驳回（必须填写原因）
            </div>
            <LabeledInput
              label="驳回原因"
              value={rejectNote}
              onChange={setRejectNote}
            />
            <button
              onClick={handleReject}
              disabled={busy}
              className="mt-2 w-full h-9 rounded-lg border border-red-500/40 text-red-400 text-[12px] font-semibold flex items-center justify-center gap-1.5 disabled:opacity-60"
            >
              <XCircle size={14} />
              驳回并解冻积分
            </button>
          </div>
        </div>
      )}

      {showActions && wd.status === 'approved' && (
        <div className="space-y-2 border-t border-hairline/50 pt-3">
          <div className="text-[11px] font-semibold text-muted">
            标记已打款（上传凭证 URL 或流水号）
          </div>
          <LabeledInput
            label="付款凭证"
            value={proof}
            onChange={setProof}
            placeholder="流水号或云存储链接"
          />
          <button
            onClick={handleMarkPaid}
            disabled={busy}
            className="w-full h-9 rounded-lg bg-primary text-white text-[12px] font-semibold flex items-center justify-center gap-1.5 disabled:opacity-60"
          >
            <FileText size={14} />
            标记已打款
          </button>
        </div>
      )}

      {err && (
        <div className="text-[11px] text-red-400 bg-red-500/10 rounded-lg px-2 py-1.5">
          {err}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] text-muted uppercase tracking-wider">
        {label}
      </div>
      <div
        className={`text-[12px] truncate ${mono ? 'font-mono' : 'font-medium'}`}
      >
        {value}
      </div>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] text-muted uppercase tracking-wider mb-1">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full h-9 px-3 rounded-lg border border-hairline bg-canvas text-[12px] placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
      />
    </label>
  );
}
