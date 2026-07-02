'use client';

import { Calendar, Smartphone, UserRound } from 'lucide-react';

import { useAuth } from '@/features/auth/hooks/use-auth';
import { useI18n } from '@/lib/i18n';

export function TabAccount() {
  const { user } = useAuth();
  const { formatDate, t } = useI18n();

  const rows = [
    {
      icon: Smartphone,
      label: t('pages.profile.phone'),
      value: user?.phone_masked ?? user?.phone ?? t('pages.profile.unbound'),
    },
    {
      icon: Calendar,
      label: t('pages.profile.registeredAt'),
      value: user?.created_at
        ? formatDate(user.created_at, { year: 'numeric', month: '2-digit', day: '2-digit' })
        : '-',
    },
  ];

  return (
    <section className="overflow-hidden rounded-xl border border-hairline">
      <div className="border-b border-hairline bg-surface-raised px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <UserRound size={14} className="text-muted" />
          <div>
            <p className="text-[12px] font-medium">
              {t('pages.profile.accountTitle')}
            </p>
            <p className="text-[10px] text-muted">
              {t('pages.profile.accountDescription')}
            </p>
          </div>
        </div>
      </div>

      <div className="bg-surface-raised px-4 py-3">
        <div className="overflow-hidden rounded-xl border border-hairline bg-canvas/36">
          {rows.map(({ icon: Icon, label, value }, i) => (
            <div
              key={label}
              className={`flex items-center justify-between gap-4 px-3.5 py-2.5 ${
                i > 0 ? 'border-t border-hairline' : ''
              }`}
            >
              <div className="flex items-center gap-2.5">
                <div className="flex h-[26px] w-[26px] items-center justify-center rounded-lg bg-surface-card/90">
                  <Icon size={13} className="text-muted" />
                </div>
                <span className="text-[11px] text-muted">
                  {label}
                </span>
              </div>
              <span className="text-[11px] font-medium text-right">
                {value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
