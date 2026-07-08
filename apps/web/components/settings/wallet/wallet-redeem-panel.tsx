'use client';

import { useState } from 'react';
import { KeyRound, Loader2, Sparkles } from 'lucide-react';

import { billingApi } from '@/features/billing/api';
import { useI18n } from '@/lib/i18n';
import { formatCoins } from '@/lib/soft-currency';

/**
 * 卡密兑换面板：输入卡密码兑换积分，与在线支付平级作为充值中心的另一 Tab。
 *
 * 状态自洽——兑换中/成功态/错误文案都在内部 useState 维护，不与在线支付的
 * reducer 共享状态，避免两种支付流程的状态机互相污染。成功后调用 onChanged
 * 让外层刷新余额卡片，余额变化通过 billing 缓存清除即时反映。
 *
 * @param props.onChanged 兑换成功后的刷新回调，与 WalletRechargePanel 同名 prop 同义。
 */
export function WalletRedeemPanel({
  onChanged,
}: {
  onChanged: () => Promise<void> | void;
}) {
  const { locale, t } = useI18n();
  const [code, setCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [error, setError] = useState('');
  // 兑换成功时入账的面额，用于就地展示成功反馈；null 表示当前无成功态。
  const [redeemedAmount, setRedeemedAmount] = useState<number | null>(null);

  async function handleRedeem() {
    const trimmed = code.trim();
    if (!trimmed) {
      setError(t('pages.wallet.redeemEmpty'));
      return;
    }
    setRedeeming(true);
    setError('');
    setRedeemedAmount(null);
    try {
      const result = await billingApi.redeemCode({ code: trimmed });
      setRedeemedAmount(result.amountCoins);
      setCode('');
      await onChanged();
    } catch (err) {
      // 后端 400 响应里的 { error } 已被 requestJson 归一化成 err.message，
      // 这里直接展示（"已兑换/已过期/已撤销"等服务端给出的具体原因）。
      setError(err instanceof Error ? err.message : t('pages.wallet.redeemFailed'));
    } finally {
      setRedeeming(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted">
        <KeyRound size={13} />
        {t('pages.wallet.redeemHint')}
      </div>

      <div className="flex items-center rounded-xl border border-hairline bg-canvas px-3 focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/20">
        <input
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            // 输入即清错误与成功态，避免遗留旧反馈干扰新一轮兑换。
            if (error) setError('');
            if (redeemedAmount !== null) setRedeemedAmount(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !redeeming) {
              void handleRedeem();
            }
          }}
          placeholder={t('pages.wallet.redeemPlaceholder')}
          className="h-11 min-w-0 flex-1 bg-transparent font-mono text-[14px] font-medium tracking-wide outline-none"
        />
      </div>

      <button
        type="button"
        onClick={() => void handleRedeem()}
        disabled={redeeming}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[13px] font-semibold text-on-primary transition-colors hover:bg-primary-active disabled:opacity-50"
      >
        {redeeming ? (
          <Loader2 size={15} className="animate-spin" />
        ) : (
          <KeyRound size={15} />
        )}
        {t('pages.wallet.redeemAction')}
      </button>

      {error && (
        <div className="rounded-xl border border-error/30 bg-error/8 px-3 py-2 text-[12px] text-error">
          {error}
        </div>
      )}

      {redeemedAmount !== null && (
        <div className="flex items-center gap-1.5 rounded-xl border border-success/30 bg-success/8 px-3 py-2 text-[12px] text-success">
          <Sparkles size={13} />
          {t('pages.wallet.redeemSuccess', { amount: formatCoins(redeemedAmount, locale) })}
        </div>
      )}

      <div className="text-[10px] text-muted">{t('pages.wallet.redeemSafety')}</div>
    </div>
  );
}