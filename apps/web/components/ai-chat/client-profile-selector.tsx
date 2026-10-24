'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Loader2, Plus, UserCheck, Users, X } from 'lucide-react';

import { ClientProfileForm } from '@/components/clients/client-profile-form';
import type {
  ClientProfile,
  ClientProfileUpsert,
} from '@/features/chat/client-profiles-api';
import { useClientProfiles } from '@/features/chat/hooks/use-client-profiles';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

/** 下拉中最多展示的最近客户数量，避免列表过长。 */
const RECENT_CLIENT_LIMIT = 8;

/** 拼出客户在下拉项中的生辰摘要，缺省生辰时返回空串。 */
function buildBirthSummary(profile: ClientProfile): string {
  if (!profile.solar_date) return '';
  if (typeof profile.hour === 'number') {
    return `${profile.solar_date} ${String(profile.hour).padStart(2, '0')}:${String(
      profile.minute ?? 0,
    ).padStart(2, '0')}`;
  }
  return profile.solar_date;
}

/**
 * 排盘表单顶部的客户选择器。
 *
 * 展示最近客户下拉与"新建客户"入口；选中客户后通过 `onSelect` 把客户档案回传给排盘弹层，
 * 由弹层负责预填生辰字段并在提交时携带 client_id。选择器自身只负责加载列表、维护选中态与建档。
 *
 * @param props.selectedClientId 当前选中的客户 id；为空表示未关联客户。
 * @param props.onSelect 选中（或清除）客户时的回调，传 null 表示取消关联。
 * @param props.autoSelectClientId 外部带入需自动选中的客户 id；列表加载到匹配档案后自动选中一次。
 * @returns 客户选择器与可选的建档抽屉。
 */
export function ClientProfileSelector({
  selectedClientId,
  onSelect,
  autoSelectClientId,
}: {
  selectedClientId: string | null;
  onSelect: (profile: ClientProfile | null) => void;
  autoSelectClientId?: string | null;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const notify = useCallback(
    (type: 'success' | 'error', message: string) => toast(type, message),
    [toast],
  );
  const { profiles, loading, loadProfiles, create } = useClientProfiles(notify);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    void loadProfiles().catch(() => {});
  }, [loadProfiles]);

  // 从外部（如客户卡片"发起排盘"）带入的客户：列表加载到匹配档案后自动选中一次，触发生辰预填。
  const autoSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoSelectClientId || autoSelectedRef.current === autoSelectClientId) {
      return;
    }
    if (selectedClientId === autoSelectClientId) {
      autoSelectedRef.current = autoSelectClientId;
      return;
    }
    const match = profiles.find((profile) => profile.id === autoSelectClientId);
    if (match) {
      autoSelectedRef.current = autoSelectClientId;
      onSelect(match);
    }
  }, [autoSelectClientId, profiles, selectedClientId, onSelect]);

  const selectedProfile =
    profiles.find((profile) => profile.id === selectedClientId) ?? null;
  const recentProfiles = profiles.slice(0, RECENT_CLIENT_LIMIT);

  const handlePick = (profile: ClientProfile) => {
    setPickerOpen(false);
    onSelect(profile);
  };

  const handleClear = () => {
    setPickerOpen(false);
    onSelect(null);
  };

  const handleCreate = async (data: ClientProfileUpsert) => {
    const created = await create(data);
    setFormOpen(false);
    toast('success', t('clients.toast.created'));
    // 建档后立即选中该客户，省去用户再次手动选择。
    onSelect(created);
  };

  return (
    <div className="min-w-0">
      <div className="relative">
        <button
          type="button"
          onClick={() => setPickerOpen((value) => !value)}
          className="inline-flex h-9 max-w-full items-center gap-1.5 rounded-lg px-2 text-left text-[12px] text-muted hover:bg-surface-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          title={
            selectedProfile
              ? `${t('clients.selector.label')}：${selectedProfile.name}`
              : undefined
          }
          aria-haspopup="listbox"
          aria-expanded={pickerOpen}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Users size={14} className="shrink-0 text-muted" />
            <span className="min-w-0 truncate">
              {selectedProfile
                ? selectedProfile.name
                : t('clients.selector.placeholder')}
            </span>
          </span>
          <ChevronDown
            size={14}
            className={`shrink-0 text-muted transition-transform duration-150 ${
              pickerOpen ? 'rotate-180 text-primary' : ''
            }`}
          />
        </button>

        {pickerOpen && (
          <div
            className="absolute right-0 top-full z-20 mt-1 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-hairline bg-canvas shadow-[0_14px_36px_rgba(0,0,0,0.16)]"
            role="listbox"
          >
            <div className="max-h-64 overflow-y-auto p-1.5">
              {selectedProfile && (
                <button
                  type="button"
                  onClick={handleClear}
                  className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink"
                >
                  <X size={13} className="shrink-0" />
                  {t('clients.selector.clear')}
                </button>
              )}

              {loading && profiles.length === 0 ? (
                <div className="flex items-center gap-2 px-2.5 py-3 text-[12px] text-muted">
                  <Loader2 size={13} className="animate-spin" />
                  {t('clients.selector.loading')}
                </div>
              ) : recentProfiles.length === 0 ? (
                <div className="px-2.5 py-3 text-[12px] text-muted">
                  {t('clients.selector.empty')}
                </div>
              ) : (
                recentProfiles.map((profile) => {
                  const selected = profile.id === selectedClientId;
                  const summary = buildBirthSummary(profile);
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => handlePick(profile)}
                      className={`flex min-h-9 w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                        selected
                          ? 'bg-primary/12 text-primary'
                          : 'text-ink hover:bg-surface-cream-strong'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {profile.name}
                          {profile.gender ? `（${profile.gender}）` : ''}
                        </span>
                        {summary && (
                          <span className="block truncate text-[11px] text-muted">
                            {summary}
                          </span>
                        )}
                      </span>
                      {selected && <UserCheck size={13} className="shrink-0" />}
                    </button>
                  );
                })
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                setPickerOpen(false);
                setFormOpen(true);
              }}
              className="flex min-h-10 w-full items-center gap-2 border-t border-hairline px-3 py-2 text-left text-[12px] font-medium text-primary transition-colors hover:bg-primary/8"
            >
              <Plus size={14} className="shrink-0" />
              {t('clients.selector.create')}
            </button>
          </div>
        )}
      </div>

      {formOpen && (
        <ClientProfileForm
          onSave={handleCreate}
          onCancel={() => setFormOpen(false)}
        />
      )}
    </div>
  );
}
