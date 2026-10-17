'use client';

import { AppShell } from '@/components/app-shell';
import { InvitationsWorkspace } from '@/components/invitations/invitations-workspace';
import { useAuth } from '@/features/auth/hooks/use-auth';

export default function InvitationsPage() {
  const { user } = useAuth();

  return (
    <AppShell>
      <InvitationsWorkspace key={user?.id} />
    </AppShell>
  );
}
