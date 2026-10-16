import { redirect } from 'next/navigation';

/** Preserve the wallet entry point by opening the balance and top-up tab. */
export default function WalletPage() {
  redirect('/membership#recharge');
}
