import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';

import { RechargeResultWorkspace } from '@/components/settings/wallet/recharge-result/recharge-result-workspace';

function RechargeResultFallback() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-6">
      <div className="flex items-center gap-3 rounded-xl border border-hairline bg-surface-card px-5 py-4 text-[13px] text-muted shadow-sm">
        <Loader2 size={16} className="animate-spin" />
        正在打开充值结果...
      </div>
    </div>
  );
}

/**
 * 充值支付完成后的前端返回页。
 *
 * @returns 包含查询参数读取能力的充值结果通知页面。
 */
export default function WalletRechargeResultPage() {
  return (
    <Suspense fallback={<RechargeResultFallback />}>
      <RechargeResultWorkspace />
    </Suspense>
  );
}
