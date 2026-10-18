'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { clientProfilesApi } from '@/features/chat/client-profiles-api';
import { useI18n } from '@/lib/i18n';

export function SessionContextBar({
  clientId,
}: {
  clientId?: string | null;
}) {
  const { t } = useI18n();
  const [client, setClient] = useState<{ id: string; name: string } | null>(
    null,
  );
  useEffect(() => {
    let disposed = false;
    if (!clientId) return;
    void clientProfilesApi
      .get(clientId)
      .then((value) => {
        if (!disposed) setClient({ id: value.id, name: value.name });
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [clientId]);

  if (!clientId) return null;
  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl shrink-0 flex-wrap items-center gap-2 border-b border-hairline/60 px-2.5 pb-2 text-[12px] text-muted sm:px-3">
      <Link
        href={`/clients/detail?id=${encodeURIComponent(clientId)}`}
        className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-md px-2 hover:bg-surface-soft hover:text-ink"
      >
        <Users size={13} />
        <span className="truncate">
          {client?.id === clientId ? client.name : t('hub.clients')}
        </span>
      </Link>
    </div>
  );
}
