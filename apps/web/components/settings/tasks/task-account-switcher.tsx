import type { Account } from '@/features/accounts/api';

export function TaskAccountSwitcher({
  accounts,
  selectedAccount,
  onSelect,
}: {
  accounts: Account[];
  selectedAccount: string;
  onSelect: (accountId: string) => void;
}) {
  if (accounts.length <= 1) return null;

  return (
    <div
      className="flex gap-1.5 overflow-x-auto"
      style={{ scrollbarWidth: 'none' }}
    >
      {accounts.map((account) => {
        const active = account.id === selectedAccount;
        return (
          <button
            key={account.id}
            onClick={() => onSelect(account.id)}
            className={`shrink-0 h-8 px-3 rounded-lg text-[12px] font-medium transition-all duration-150 cursor-pointer ${
              active
                ? 'bg-surface-cream-strong text-ink'
                : 'text-muted hover:text-ink hover:bg-surface-card'
            }`}
          >
            {account.name}
          </button>
        );
      })}
    </div>
  );
}
