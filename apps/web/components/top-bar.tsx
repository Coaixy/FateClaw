'use client';

import { useEffect, useRef, useState } from 'react';
import { User as UserIcon, BadgeDollarSign } from 'lucide-react';

import { useAuth } from '@/features/auth/hooks/use-auth';
import { UsagePanel } from '@/components/billing/usage-panel';
import { UserMenuDropdown } from '@/components/user-menu-dropdown';
import { useBillingSnapshot } from '@/features/billing/hooks/use-billing-snapshot';
import { formatCents } from '@/lib/money';

function formatBalanceShort(cents: number): string {
  if (cents < 100_000) return formatCents(cents);
  return `软妹币 ${Math.round(cents / 100).toLocaleString()}`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.0+$/, '')}M`;
}

function AvatarBadge({ compact = false }: { compact?: boolean }) {
  const sizeClass = compact ? 'w-7 h-7' : 'w-9 h-9';
  const iconSize = compact ? 14 : 16;

  return (
    <div
      className={`${sizeClass} rounded-full bg-gradient-to-br from-primary/20 to-primary/10 border border-primary/25 text-primary flex items-center justify-center shrink-0`}
    >
      <UserIcon size={iconSize} strokeWidth={2} />
    </div>
  );
}

export function TopBar({
  compact = false,
  onLogout,
}: {
  compact?: boolean;
  onLogout: () => void;
}) {
  const { user } = useAuth();
  const { status, usage, refreshing, refresh } = useBillingSnapshot();
  const [menuOpen, setMenuOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen && !usageOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
      setUsageOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen, usageOpen]);

  if (!user) return null;

  const balanceCents = status?.available_cents ?? null;
  const dotColor = 'bg-primary';
  const todayTokens = usage
    ? formatTokens(
        (usage.today_input_tokens ?? 0) + (usage.today_output_tokens ?? 0),
      )
    : '—';
  const todayTokensLabel = compact
    ? `今 ${todayTokens}`
    : `今日 ${todayTokens}`;
  const balanceLabel =
    balanceCents === null
      ? '—'
      : compact
        ? formatBalanceShort(balanceCents)
        : formatCents(balanceCents);
  const pillPad = compact
    ? 'h-7 px-2 gap-1 text-[10px]'
    : 'h-9 px-3.5 gap-2 text-[12px]';

  return (
    <div ref={containerRef} className="flex min-w-0 items-center gap-2">
      {/* 计费胶囊：余额 + 今日 token */}
      <div className="relative min-w-0">
        <button
          onClick={() => {
            setUsageOpen((v) => !v);
            setMenuOpen(false);
          }}
          className={`inline-flex max-w-full items-center rounded-full border border-hairline/60 bg-surface-card/80 backdrop-blur-sm text-ink hover:border-primary/40 hover:bg-primary/10 transition-all cursor-pointer ${pillPad} ${usageOpen ? 'border-primary/50 bg-primary/10' : ''}`}
          aria-label={`${balanceCents === null ? '余额加载中' : `${formatCents(balanceCents)} 可用`}，今日 ${todayTokens}`}
          aria-expanded={usageOpen}
        >
          <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
          <span className="tabular-nums font-medium">{balanceLabel}</span>
          <span className="text-muted/60">·</span>
          <span className="inline-flex items-center gap-1 text-muted whitespace-nowrap">
            <BadgeDollarSign
              size={compact ? 10 : 12}
              className="text-primary"
            />
            <span className="tabular-nums">{todayTokensLabel}</span>
          </span>
        </button>
        {usageOpen && (
          <div className="absolute right-0 top-full mt-2 rounded-xl border border-hairline/60 bg-surface-card/95 backdrop-blur-xl shadow-xl overflow-hidden z-50 animate-scale-in">
            <UsagePanel
              status={status}
              usage={usage}
              refreshing={refreshing}
              onRefresh={refresh}
              onNavigate={() => setUsageOpen(false)}
            />
          </div>
        )}
      </div>

      {/* 头像 + 菜单 */}
      <div className="relative">
        <button
          onClick={() => {
            setMenuOpen((v) => !v);
            setUsageOpen(false);
          }}
          className="rounded-full cursor-pointer hover:border-primary/60 active:scale-95 transition-all"
          aria-label="个人菜单"
          aria-expanded={menuOpen}
        >
          <AvatarBadge compact={compact} />
        </button>

        {menuOpen && (
          <UserMenuDropdown
            user={{ phone: user.phone }}
            balanceLabel={
              balanceCents === null
                ? '加载中…'
                : `${formatCents(balanceCents)} 可用`
            }
            avatar={<AvatarBadge />}
            onNavigate={() => setMenuOpen(false)}
            onLogout={() => {
              setMenuOpen(false);
              onLogout();
            }}
          />
        )}
      </div>
    </div>
  );
}
