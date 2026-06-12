'use client';

import { useState } from 'react';
import { Brain, MessageSquare } from 'lucide-react';

import { billingApi } from '@/features/billing/api';
import { DataManagementItem } from '@/components/settings/data-management/data-management-item';
import { DataManagementResetAll } from '@/components/settings/data-management/data-management-reset-all';
import type {
  ResetItem,
  ResetScope,
} from '@/components/settings/data-management/data-management-types';
import { useConfirm } from '@/lib/use-confirm';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

export function TabData() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const { t } = useI18n();
  const [resettingScope, setResettingScope] = useState<ResetScope | null>(null);

  const handleReset = async (scope: ResetScope) => {
    const labels: Record<ResetScope, string> = {
      all: t('pages.dataManagement.allData'),
      messages: t('pages.dataManagement.messagesData'),
      memories: t('pages.dataManagement.memoriesData'),
    };
    const ok = await confirm({
      title:
        scope === 'all'
          ? t('pages.dataManagement.resetAllData')
          : t('pages.dataManagement.clearData'),
      message: t('pages.dataManagement.confirmMessage', {
        target: labels[scope],
      }),
      confirmLabel:
        scope === 'all'
          ? t('pages.dataManagement.reset')
          : t('pages.dataManagement.clear'),
      variant: 'danger',
    });
    if (!ok) return;
    setResettingScope(scope);
    try {
      await billingApi.reset(scope);
      toast(
        'success',
        scope === 'all'
          ? t('pages.dataManagement.resetDone')
          : t('pages.dataManagement.clearDone', { target: labels[scope] }),
      );
    } catch (err) {
      toast(
        'error',
        err instanceof Error ? err.message : t('pages.dataManagement.failed'),
      );
    }
    setResettingScope(null);
  };

  const items: ResetItem[] = [
    {
      scope: 'messages',
      icon: MessageSquare,
      label: t('pages.dataManagement.messages'),
      desc: t('pages.dataManagement.messagesDescription'),
    },
    {
      scope: 'memories',
      icon: Brain,
      label: t('pages.dataManagement.memories'),
      desc: t('pages.dataManagement.memoriesDescription'),
    },
  ];

  return (
    <div className="relative rounded-xl border border-red-500/15 overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 80% 60% at 0% 100%, rgba(239,68,68,0.03), transparent 60%)',
        }}
      />

      {items.map(({ scope, icon: Icon, label, desc }, i) => (
        <div
          key={scope}
          className={`${
            i > 0 ? 'border-t border-hairline/50' : ''
          }`}
        >
          <DataManagementItem
            item={{ scope, icon: Icon, label, desc }}
            resettingScope={resettingScope}
        onReset={(nextScope) => void handleReset(nextScope)}
        clearLabel={t('pages.dataManagement.clear')}
      />
        </div>
      ))}

      <DataManagementResetAll
        resettingScope={resettingScope}
        onReset={(scope) => void handleReset(scope)}
        resetLabel={t('pages.dataManagement.reset')}
        title={t('pages.dataManagement.resetAll')}
        description={t('pages.dataManagement.resetAllDescription')}
      />
    </div>
  );
}
