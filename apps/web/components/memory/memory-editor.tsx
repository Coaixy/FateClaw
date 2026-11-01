'use client';

import type {
  MemoryItemDto,
  MemoryKind,
  MemorySubjectDto,
} from '@fateclaw/contracts/memory';
import { Save } from 'lucide-react';

import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

export const MEMORY_KINDS: MemoryKind[] = [
  'fact',
  'preference',
  'event',
  'plan',
  'decision',
];
export const MEMORY_CONTROL =
  'min-h-10 w-full rounded-lg border border-hairline bg-canvas px-3 text-[13px] text-ink outline-none focus:border-primary/50 disabled:opacity-50';

export interface MemoryEditorDraft {
  item: MemoryItemDto | null;
  content: string;
  kind: MemoryKind;
  subjectId: string;
}

export function MemoryEditor({
  draft,
  latest,
  subjects,
  saving,
  error,
  onChange,
  onClose,
  onSave,
}: {
  draft: MemoryEditorDraft | null;
  latest: MemoryItemDto | undefined;
  subjects: MemorySubjectDto[];
  saving: boolean;
  error: string;
  onChange: (draft: MemoryEditorDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const title = t(draft?.item ? 'memory.editTitle' : 'memory.createTitle');
  return (
    <BottomSheet
      open={Boolean(draft)}
      onClose={onClose}
      closeOnOverlay={!saving}
      title={title}
      aria-label={title}
      footer={
        <div className="flex justify-end gap-2 px-4 py-3 sm:px-6">
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            {t('memory.cancel')}
          </Button>
          <Button
            loading={saving}
            disabled={!draft?.content.trim()}
            icon={<Save size={14} />}
            onClick={onSave}
          >
            {t('memory.save')}
          </Button>
        </div>
      }
    >
      {draft && (
        <form
          className="space-y-4 p-4 sm:p-6"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          {!draft.item && (
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1.5 text-[12px] text-muted">
                <span>{t('memory.subject')}</span>
                <select
                  className={MEMORY_CONTROL}
                  value={draft.subjectId}
                  disabled={saving}
                  onChange={(event) =>
                    onChange({ ...draft, subjectId: event.target.value })
                  }
                >
                  <option value="">{t('memory.self')}</option>
                  {subjects
                    .filter((subject) => subject.kind !== 'self')
                    .map((subject) => (
                      <option key={subject.id} value={subject.id}>
                        {subject.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="space-y-1.5 text-[12px] text-muted">
                <span>{t('memory.kind')}</span>
                <select
                  className={MEMORY_CONTROL}
                  value={draft.kind}
                  disabled={saving}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      kind: event.target.value as MemoryKind,
                    })
                  }
                >
                  {MEMORY_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`memory.kinds.${kind}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {draft.item && (
            <p className="text-[12px] text-muted">
              {draft.item.subject_name} · {t(`memory.kinds.${draft.item.kind}`)}
            </p>
          )}
          <label className="block space-y-1.5 text-[12px] text-muted">
            <span>{t('memory.content')}</span>
            <textarea
              autoFocus
              required
              rows={7}
              disabled={saving}
              className={`${MEMORY_CONTROL} resize-y py-3 leading-6`}
              value={draft.content}
              onChange={(event) =>
                onChange({ ...draft, content: event.target.value })
              }
              placeholder={t('memory.contentPlaceholder')}
            />
          </label>
          {error && (
            <div
              role="alert"
              className="space-y-2 rounded-lg border border-error/20 bg-error/5 p-3 text-[12px] text-error"
            >
              <p>{error}</p>
              {latest &&
                draft.item &&
                latest.revision !== draft.item.revision && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      onChange({
                        item: latest,
                        content: latest.content,
                        kind: latest.kind,
                        subjectId: latest.subject_id,
                      })
                    }
                  >
                    {t('memory.loadLatest')}
                  </Button>
                )}
            </div>
          )}
        </form>
      )}
    </BottomSheet>
  );
}
