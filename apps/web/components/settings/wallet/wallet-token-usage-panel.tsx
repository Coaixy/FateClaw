import type { DailyUsageRow } from '@/features/billing/api';

function formatTokenCount(value: number): string {
  return value.toLocaleString();
}

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export function WalletTokenUsagePanel({
  dailyUsage,
}: {
  dailyUsage: DailyUsageRow[];
}) {
  return (
    <section className="rounded-2xl border border-hairline bg-surface-card overflow-hidden">
      <div className="px-4 py-3 border-b border-hairline/60">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="text-[13px] font-semibold text-ink">
              Token 使用明细
            </h3>
            <p className="text-[11px] text-muted mt-0.5">
              自定义模型和官方模型都会记录真实返回的 Token 用量
            </p>
          </div>
          <span className="text-[10px] text-muted tabular-nums">
            {dailyUsage.length.toLocaleString()} 天记录
          </span>
        </div>
      </div>

      {dailyUsage.length === 0 ? (
        <div className="py-12 text-center text-[13px] text-muted">
          暂无 Token 使用记录
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left">
            <thead>
              <tr className="border-b border-hairline/50 text-[10px] uppercase tracking-wider text-muted">
                <th className="px-4 py-2.5 font-semibold">日期</th>
                <th className="px-3 py-2.5 font-semibold text-right">消息</th>
                <th className="px-3 py-2.5 font-semibold text-right">
                  输入 Token
                </th>
                <th className="px-3 py-2.5 font-semibold text-right">
                  输出 Token
                </th>
                <th className="px-4 py-2.5 font-semibold text-right">
                  合计
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline/50">
              {dailyUsage.map((row) => (
                <tr
                  key={row.date}
                  className="text-[12px] text-ink"
                >
                  <td className="px-4 py-3 font-medium whitespace-nowrap">
                    {formatDate(row.date)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted">
                    {formatTokenCount(row.msg_count)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {formatTokenCount(row.input_tokens)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {formatTokenCount(row.output_tokens)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold">
                    {formatTokenCount(row.total_tokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
