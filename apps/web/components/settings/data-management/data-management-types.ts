import type { MessageSquare } from 'lucide-react';

export type ResetScope = 'all' | 'messages' | 'memories' | 'tasks' | 'skills';

export type ResetItem = {
  scope: Exclude<ResetScope, 'all'>;
  icon: typeof MessageSquare;
  label: string;
  desc: string;
};
