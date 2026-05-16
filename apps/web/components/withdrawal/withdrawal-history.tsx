import type { CreatorWithdrawal } from '@/features/skills/api';

function statusBadge(status: CreatorWithdrawal['status']) {
  switch (status) {
    case 'pending':
      return { label: '审核中', className: 'bg-yellow-500/15 text-yellow-400' };
    case 'approved':
      return { label: '已批准', className: 'bg-blue-500/15 text-blue-400' };
    case 'paid':
      return {
        label: '已打款',
        className: 'bg-success/15 text-success',
      };
    case 'rejected':
      return { label: '已驳回', className: 'bg-red-500/15 text-red-400' };
    case 'cancelled':
      return {
        label: '已取消',
        className: 'bg-muted/15 text-muted',
      };
  }
}

export function WithdrawalHistory({
  records,
}: {
  records: CreatorWithdrawal[];
}) {
  return (
    <section className="rounded-2xl border border-hairline bg-surface-card overflow-hidden">
      <div className="px-4 py-3 border-b border-hairline/50 text-[13px] font-semibold">
        历史提现
      </div>
      {records.length === 0 ? (
        <div className="py-10 text-center text-[13px] text-muted">
          暂无提现记录
        </div>
      ) : (
        <div className="divide-y divide-hairline/50">
          {records.map((record) => {
            const badge = statusBadge(record.status);
            return (
              <div key={record.id} className="px-4 py-3 space-y-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-[13px] font-bold tabular-nums">
                      {record.amount_points.toLocaleString()} 积分
                    </span>
                    <span className="text-[11px] text-muted">
                      ¥{record.amount_yuan}
                    </span>
                  </div>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                </div>
                <div className="text-[10px] text-muted font-mono">
                  {new Date(record.created_at).toLocaleString('zh-CN')}
                </div>
                {record.review_note && (
                  <div className="text-[11px] text-muted leading-relaxed whitespace-pre-wrap break-words">
                    审核备注：{record.review_note}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
