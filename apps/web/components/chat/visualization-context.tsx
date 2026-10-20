'use client';

import { createContext, useContext } from 'react';
import { Loader2 } from 'lucide-react';
import { VISUALIZATION_ID } from '@fateclaw/contracts/visualization';
import type { SkillContextEntry } from '@/features/chat/api';
import { useI18n } from '@/lib/i18n';
import { ArtifactRenderer } from './artifact-renderer';

export const VisualizationContext = createContext<{
  entries: ReadonlyMap<string, SkillContextEntry>;
  pending: boolean;
}>({ entries: new Map(), pending: false });

export function VisualizationPlaceholder({ loading }: { loading: boolean }) {
  const { t } = useI18n();
  return (
    <div
      role="status"
      className="my-4 flex min-h-28 items-center justify-center gap-2 rounded-xl border border-hairline bg-surface-soft px-4 py-6 text-sm text-muted"
    >
      {loading && (
        <Loader2 size={17} className="animate-spin" aria-hidden="true" />
      )}
      {t(loading ? 'visualization.loading' : 'visualization.unavailable')}
    </div>
  );
}

export function VisualizationReference({ artifactId }: { artifactId: string }) {
  const { entries, pending } = useContext(VisualizationContext);
  const entry = VISUALIZATION_ID.test(artifactId)
    ? entries.get(artifactId)
    : undefined;
  return entry ? (
    <ArtifactRenderer entries={[entry]} />
  ) : (
    <VisualizationPlaceholder loading={pending} />
  );
}
