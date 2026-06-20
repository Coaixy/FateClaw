import { redirect } from 'next/navigation';

/**
 * 旧钱包路由：已合并进「订阅与计费」单页，统一重定向到 /membership。
 */
export default function WalletPage() {
  redirect('/membership');
}
