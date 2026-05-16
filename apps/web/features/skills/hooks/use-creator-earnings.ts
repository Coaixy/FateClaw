'use client';

import { useMemo, useState } from 'react';

import { type CreatorEarningsMonthly } from '@/features/skills/api';

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function useCreatorEarnings() {
  const [earnings, setEarnings] = useState<CreatorEarningsMonthly[]>([]);

  const stats = useMemo(() => {
    const thisMonth = earnings.find((row) => row.year_month === currentYearMonth());
    const thisMonthNet = thisMonth?.net_points ?? 0;
    const lifetimeNet = earnings.reduce((sum, row) => sum + row.net_points, 0);
    return { thisMonthNet, lifetimeNet };
  }, [earnings]);

  return { earnings, setEarnings, stats };
}
