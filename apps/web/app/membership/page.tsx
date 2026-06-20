import { MembershipWorkspace } from '@/components/settings/membership/membership-workspace';

/**
 * 「订阅与计费」路由页面（合并自旧会员中心与钱包）。
 *
 * @returns 订阅、剩余额度、充值与交易流水合并工作区。
 */
export default function MembershipPage() {
  return <MembershipWorkspace />;
}
