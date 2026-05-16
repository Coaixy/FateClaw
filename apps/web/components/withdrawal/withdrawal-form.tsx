import { Loader2 } from 'lucide-react';

type TaxType = 'personal' | 'company';

export type WithdrawalFormState = {
  amountPoints: string;
  bankName: string;
  bankAccount: string;
  accountName: string;
  idNumber: string;
  taxType: TaxType;
  companyName: string;
  taxId: string;
};

export function WithdrawalForm({
  values,
  error,
  success,
  submitting,
  onSubmit,
  onChange,
}: {
  values: WithdrawalFormState;
  error: string | null;
  success: string | null;
  submitting: boolean;
  onSubmit: (event: React.FormEvent) => void;
  onChange: <K extends keyof WithdrawalFormState>(
    key: K,
    value: WithdrawalFormState[K],
  ) => void;
}) {
  return (
    <section className="rounded-2xl border border-hairline bg-surface-card p-5">
      <h3 className="text-[13px] font-semibold mb-4">发起提现申请</h3>
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label="提现积分数量">
          <input
            type="number"
            value={values.amountPoints}
            onChange={(event) => onChange('amountPoints', event.target.value)}
            placeholder="至少 100 积分 = 1 元"
            className="w-full h-10 px-3 rounded-lg border border-hairline bg-canvas text-sm placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            min={100}
          />
          {values.amountPoints && (
            <div className="text-[10px] text-muted mt-0.5">
              ≈ ¥{(Number(values.amountPoints || 0) / 100).toFixed(2)}
            </div>
          )}
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="结算类型">
            <select
              value={values.taxType}
              onChange={(event) => onChange('taxType', event.target.value as TaxType)}
              className="w-full h-10 px-3 rounded-lg border border-hairline bg-canvas text-sm placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="personal">个人（劳务报酬）</option>
              <option value="company">对公（开发票）</option>
            </select>
          </Field>
          <Field label="开户银行">
            <input
              value={values.bankName}
              onChange={(event) => onChange('bankName', event.target.value)}
              placeholder="如 招商银行"
              className="w-full h-10 px-3 rounded-lg border border-hairline bg-canvas text-sm placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </Field>
        </div>

        <Field label="银行账号">
          <input
            value={values.bankAccount}
            onChange={(event) => onChange('bankAccount', event.target.value)}
            className="w-full h-10 px-3 rounded-lg border border-hairline bg-canvas text-sm placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </Field>

        <Field label="户名 / 公司名称">
          <input
            value={values.accountName}
            onChange={(event) => onChange('accountName', event.target.value)}
            className="w-full h-10 px-3 rounded-lg border border-hairline bg-canvas text-sm placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </Field>

        {values.taxType === 'personal' ? (
          <Field label="身份证号">
            <input
              value={values.idNumber}
              onChange={(event) => onChange('idNumber', event.target.value)}
              className="w-full h-10 px-3 rounded-lg border border-hairline bg-canvas text-sm placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              placeholder="用于税务备案，加密存储"
            />
          </Field>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="公司名称">
              <input
                value={values.companyName}
                onChange={(event) => onChange('companyName', event.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-hairline bg-canvas text-sm placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </Field>
            <Field label="统一社会信用代码">
              <input
                value={values.taxId}
                onChange={(event) => onChange('taxId', event.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-hairline bg-canvas text-sm placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </Field>
          </div>
        )}

        {error && (
          <div className="text-[12px] text-red-400 bg-red-500/10 rounded-lg px-3 py-2 leading-relaxed whitespace-pre-wrap break-words">
            {error}
          </div>
        )}
        {success && (
          <div className="text-[12px] text-success bg-success/10 rounded-lg px-3 py-2 leading-relaxed whitespace-pre-wrap break-words">
            {success}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full h-10 rounded-xl bg-primary text-white text-[13px] font-semibold disabled:opacity-60"
        >
          {submitting ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 size={14} className="animate-spin" />
              提交中…
            </span>
          ) : (
            '提交申请'
          )}
        </button>
      </form>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-[11px] font-medium text-muted leading-relaxed break-words">
        {label}
      </span>
      {children}
    </label>
  );
}
