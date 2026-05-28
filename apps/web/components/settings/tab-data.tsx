'use client';

import { useState } from 'react';
import { Brain, Clock, MessageSquare } from 'lucide-react';

import { billingApi } from '@/features/billing/api';
import { DataManagementItem } from '@/components/settings/data-management/data-management-item';
import { DataManagementResetAll } from '@/components/settings/data-management/data-management-reset-all';
import type {
  ResetItem,
  ResetScope,
} from '@/components/settings/data-management/data-management-types';
import { useConfirm } from '@/lib/use-confirm';
import { useToast } from '@/lib/use-toast';

export function TabData() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [resettingScope, setResettingScope] = useState<ResetScope | null>(null);

  const handleReset = async (scope: ResetScope) => {
    const labels: Record<ResetScope, string> = {
      all: '全部数据（消息、记忆、任务）',
      messages: '所有消息记录',
      memories: '所有账号的长期记忆',
      tasks: '所有定时任务及运行日志',
    };
    const ok = await confirm({
      title: scope === 'all' ? '重置全部数据' : '清除数据',
      message: `确定要清除${labels[scope]}吗？\n\n数据保留归档以满足审查要求。`,
      confirmLabel: scope === 'all' ? '重置' : '清除',
      variant: 'danger',
    });
    if (!ok) return;
    setResettingScope(scope);
    try {
      await billingApi.reset(scope);
      toast(
        'success',
        scope === 'all' ? '数据已重置' : `${labels[scope]}已清除`,
      );
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '操作失败');
    }
    setResettingScope(null);
  };

  const items: ResetItem[] = [
    {
      scope: 'messages',
      icon: MessageSquare,
      label: '消息记录',
      desc: '清除所有聊天消息历史',
    },
    {
      scope: 'memories',
      icon: Brain,
      label: '长期记忆',
      desc: '清除所有 Soul 记忆',
    },
    {
      scope: 'tasks',
      icon: Clock,
      label: '定时任务',
      desc: '清除任务及运行日志',
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
          />
        </div>
      ))}

      <DataManagementResetAll
        resettingScope={resettingScope}
        onReset={(scope) => void handleReset(scope)}
      />
    </div>
  );
}
