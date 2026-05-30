import { DailySignInWorkspace } from '@/components/settings/wallet/daily-sign-in-workspace';

/**
 * 每日签到路由页面。
 *
 * 将签到入口从钱包页拆出，便于在账户入口中和钱包并列访问。
 */
export default function DailySignInPage() {
  return <DailySignInWorkspace />;
}
