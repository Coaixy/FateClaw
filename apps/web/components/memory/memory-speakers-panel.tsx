'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import { RefreshCw, Save, Users } from 'lucide-react';
import type {
  MemoryScopeDto,
  MemorySubjectDto,
} from '@fateclaw/contracts/memory';

import { Button } from '@/components/ui/button';
import { memoryApi, type MemoryScopesData } from '@/features/memory/api';
import {
  createSpeakerBindingDraft,
  speakerBindingReducer,
} from '@/features/memory/speaker-binding';
import { ApiError } from '@/lib/http/client';
import { useI18n } from '@/lib/i18n';
import { MEMORY_CONTROL } from './memory-editor';

interface SpeakersProps {
  scopes: MemoryScopeDto[];
  subjects: MemorySubjectDto[];
  loading: boolean;
  error: string;
  disabled: boolean;
  onRefresh: () => Promise<MemoryScopesData | null>;
  onSaved: (scope: MemoryScopeDto) => void;
  onSelectScope: (id: string) => void;
}

export function MemorySpeakersPanel(props: SpeakersProps) {
  const { t, formatNumber } = useI18n();
  return (
    <details className="rounded-2xl border border-hairline bg-surface-card/50">
      <summary className="cursor-pointer px-4 py-4 text-[13px] font-medium sm:px-5">
        <Users size={14} className="mr-2 inline text-primary" />
        {t('memory.speakers.title')}
        <span
          className={`ml-2 text-[11px] font-normal ${props.error ? 'text-error' : 'text-muted'}`}
        >
          {props.error
            ? t('memory.speakers.loadFailed')
            : props.loading && !props.scopes.length
              ? t('memory.loading')
              : formatNumber(props.scopes.length)}
        </span>
      </summary>
      <div className="space-y-3 border-t border-hairline/60 px-4 pb-4 pt-3 sm:px-5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[11px] leading-5 text-muted">
            {t('memory.speakers.description')}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={props.loading}
            disabled={props.disabled}
            icon={<RefreshCw size={12} />}
            onClick={() => void props.onRefresh()}
          >
            {t('memory.refresh')}
          </Button>
        </div>
        {props.error && (
          <p role="alert" className="text-[12px] text-error">
            {props.error}
          </p>
        )}
        {!props.loading && !props.error && props.scopes.length === 0 && (
          <p className="py-3 text-[12px] text-muted">
            {t('memory.speakers.empty')}
          </p>
        )}
        <div className="divide-y divide-hairline/60">
          {props.scopes.map((scope) =>
            scope.channel === 'web' ? (
              <div
                key={scope.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3 text-[12px]"
              >
                <span>
                  {t('memory.speakers.web')} · {t('memory.self')}
                  <span className="ml-2 text-[11px] text-muted">
                    {t('memory.speakers.webFixed')}
                  </span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => props.onSelectScope(scope.id)}
                >
                  {t('memory.speakers.viewMemories')}
                </Button>
              </div>
            ) : (
              <SpeakerBindingRow
                key={scope.id}
                scope={scope}
                subjects={props.subjects}
                disabled={props.disabled}
                onRefresh={props.onRefresh}
                onSaved={props.onSaved}
                onSelectScope={props.onSelectScope}
              />
            ),
          )}
        </div>
      </div>
    </details>
  );
}

function SpeakerBindingRow({
  scope,
  subjects,
  disabled,
  onRefresh,
  onSaved,
  onSelectScope,
}: Pick<
  SpeakersProps,
  'subjects' | 'disabled' | 'onRefresh' | 'onSaved' | 'onSelectScope'
> & { scope: MemoryScopeDto }) {
  const { t } = useI18n();
  const [draft, dispatch] = useReducer(
    speakerBindingReducer,
    scope,
    createSpeakerBindingDraft,
  );
  const [saving, setSaving] = useState(false);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const action = useRef<AbortController | null>(null);
  const options = subjects.filter(
    (subject) => subject.kind === 'self' || subject.kind === 'client',
  );
  const validSubject =
    draft.subjectId === null ||
    options.some((subject) => subject.id === draft.subjectId);
  const dirty =
    draft.displayName.trim() !== draft.base.display_name ||
    draft.subjectId !== draft.base.speaker_subject_id ||
    draft.shareMemory !== draft.base.share_subject_memory;
  const changedElsewhere =
    draft.base.binding_revision !== scope.binding_revision;
  const busy = disabled || saving || loadingLatest;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      action.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!dirty && !saving) dispatch({ type: 'reset', scope });
  }, [scope, dirty, saving]);

  const loadLatest = async () => {
    setLoadingLatest(true);
    const result = await onRefresh();
    if (!alive.current) return;
    const latest = result?.scopes.find(
      (candidate) => candidate.id === scope.id,
    );
    if (latest) {
      dispatch({ type: 'reset', scope: latest });
      setError('');
      setNotice('');
    }
    setLoadingLatest(false);
  };

  const save = async () => {
    if (
      busy ||
      action.current ||
      !dirty ||
      !draft.displayName.trim() ||
      !validSubject
    )
      return;
    const request = new AbortController();
    action.current = request;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const saved = await memoryApi.updateScopeBinding(
        scope.id,
        {
          display_name: draft.displayName.trim(),
          speaker_subject_id: draft.subjectId,
          share_subject_memory: Boolean(draft.subjectId && draft.shareMemory),
          revision: draft.base.binding_revision,
        },
        request.signal,
      );
      if (request.signal.aborted) return;
      dispatch({ type: 'reset', scope: saved });
      onSaved(saved);
      setNotice(t('memory.speakers.saved'));
    } catch (err) {
      if (request.signal.aborted) return;
      setError(
        err instanceof ApiError && err.status === 409
          ? t('memory.speakers.conflict')
          : err instanceof Error
            ? err.message
            : t('memory.actionFailed'),
      );
      if (err instanceof ApiError && err.status === 409) void onRefresh();
    } finally {
      action.current = null;
      if (alive.current) setSaving(false);
    }
  };

  return (
    <form
      className="space-y-3 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      aria-label={t('memory.speakers.editLabel', { name: scope.display_name })}
    >
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
        <span>{t('memory.speakers.wechat')}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onSelectScope(scope.id)}
        >
          {t('memory.speakers.viewMemories')}
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-[11px] text-muted">
          <span>{t('memory.speakers.name')}</span>
          <input
            className={MEMORY_CONTROL}
            value={draft.displayName}
            maxLength={120}
            required
            disabled={busy}
            onChange={(event) => {
              dispatch({ type: 'name', value: event.target.value });
              setNotice('');
            }}
          />
        </label>
        <label className="space-y-1.5 text-[11px] text-muted">
          <span>{t('memory.speakers.identity')}</span>
          <select
            className={MEMORY_CONTROL}
            value={draft.subjectId ?? ''}
            disabled={busy}
            onChange={(event) => {
              dispatch({ type: 'subject', value: event.target.value || null });
              setNotice('');
            }}
          >
            <option value="">{t('memory.speakers.unbound')}</option>
            {!validSubject && draft.subjectId && (
              <option value={draft.subjectId} disabled>
                {t('memory.speakers.subjectUnavailable')}
              </option>
            )}
            {options.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.kind === 'self' ? t('memory.self') : subject.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex items-start gap-2 text-[12px] leading-5">
        <input
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-primary"
          checked={draft.shareMemory}
          disabled={busy || !draft.subjectId || !validSubject}
          onChange={(event) => {
            dispatch({ type: 'share', value: event.target.checked });
            setNotice('');
          }}
        />
        <span>
          {t('memory.speakers.share')}
          <span className="mt-0.5 block text-[11px] text-muted">
            {t('memory.speakers.shareHint')}
          </span>
        </span>
      </label>
      {(error || changedElsewhere) && (
        <div role="alert" className="text-[12px] leading-5 text-error">
          <p>{error || t('memory.speakers.conflict')}</p>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="mt-2"
            loading={loadingLatest}
            disabled={saving}
            onClick={() => void loadLatest()}
          >
            {t('memory.loadLatest')}
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-[11px] text-success">
          {notice}
        </p>
      )}
      {dirty && (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              dispatch({ type: 'reset', scope });
              setError('');
              setNotice('');
            }}
          >
            {t('memory.cancel')}
          </Button>
          <Button
            type="submit"
            size="sm"
            icon={<Save size={12} />}
            loading={saving}
            disabled={
              busy ||
              !draft.displayName.trim() ||
              !validSubject ||
              changedElsewhere
            }
          >
            {t('memory.save')}
          </Button>
        </div>
      )}
    </form>
  );
}
