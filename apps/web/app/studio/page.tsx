'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Layers,
  ListChecks,
  Loader2,
  Plus,
  Puzzle,
  Search,
  Share2,
  ToggleLeft,
  ToggleRight,
  Upload,
  Users,
  X,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { BundleCard } from '@/components/skills/bundle-card';
import { BundleForm } from '@/components/skills/bundle-form';
import { OwnSkillCard } from '@/components/skills/own-skill-card';
import { SkillSkeleton } from '@/components/skills/skill-skeleton';
import { SubscribedBundleGroup } from '@/components/skills/subscribed-bundle-group';
import { SubscribedSkillCard } from '@/components/skills/subscribed-skill-card';
import {
  DEFAULT_SKILL_BUNDLE_LIMITS,
  type SkillBundle,
  type SubscribedSkill,
  type UserCustomSkill,
  skillsApi,
} from '@/features/skills/api';
import { useBundles } from '@/features/skills/hooks/use-bundles';
import { useUserSkills } from '@/features/skills/hooks/use-user-skills';
import {
  type SkillSubscriptionGroup,
  groupSubscribedSkills,
} from '@/features/skills/subscription-groups';
import {
  downloadSkillBundleZip,
  importSkillBundleFromZip,
} from '@/features/skills/skill-zip';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { useConfirm } from '@/lib/use-confirm';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

const STUDIO_LIST_PAGE_SIZE = 4;

// 三个列表区改为标签页展示;顺序与产品约定一致:订阅 → 捆绑包 → 我的技能
const STUDIO_TABS = [
  {
    key: 'subscribed' as const,
    labelKey: 'pages.studio.subscribedTitle',
    Icon: Share2,
  },
  {
    key: 'bundles' as const,
    labelKey: 'pages.studio.bundlesTitle',
    Icon: Layers,
  },
  {
    key: 'own' as const,
    labelKey: 'pages.studio.ownSkillsTitle',
    Icon: Puzzle,
  },
];
type StudioTabKey = (typeof STUDIO_TABS)[number]['key'];

type SubscribedListItem =
  | {
      type: 'bundle';
      key: string;
      group: SkillSubscriptionGroup;
    }
  | {
      type: 'skill';
      key: string;
      skill: SubscribedSkill;
    };

function normalizeSearch(value: string) {
  return value.trim().toLowerCase();
}

function matchesSearch(
  fields: Array<string | number | null | undefined>,
  query: string,
) {
  if (!query) return true;
  return fields.some((field) =>
    String(field ?? '').toLowerCase().includes(query),
  );
}

function paginateItems<T>(items: T[], page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const start = (currentPage - 1) * pageSize;
  return {
    currentPage,
    totalPages,
    items: items.slice(start, start + pageSize),
  };
}

/** 三个列表区(订阅 / 捆绑包 / 我的技能)的标识,用于复用搜索 + 分页 reducer。 */
type StudioListKey = 'subscription' | 'bundle' | 'skill';

/** 三个列表各自的搜索关键词与当前页码,合并为一个切片。 */
type StudioListsState = {
  subscriptionSearch: string;
  subscriptionPage: number;
  bundleSearch: string;
  bundlePage: number;
  skillSearch: string;
  skillPage: number;
};

type StudioListsAction =
  | { type: 'set-search'; list: StudioListKey; value: string }
  | { type: 'set-page'; list: StudioListKey; page: number };

const initialStudioLists: StudioListsState = {
  subscriptionSearch: '',
  subscriptionPage: 1,
  bundleSearch: '',
  bundlePage: 1,
  skillSearch: '',
  skillPage: 1,
};

/**
 * 列表搜索 / 分页 reducer。
 *
 * 关键点:set-search 在改写关键词的同时把对应列表页码重置回第 1 页,
 * 由此替代原先三个「搜索变更则重置页码」的 useEffect。
 */
function studioListsReducer(
  state: StudioListsState,
  action: StudioListsAction,
): StudioListsState {
  switch (action.type) {
    case 'set-search': {
      if (action.list === 'subscription')
        return {
          ...state,
          subscriptionSearch: action.value,
          subscriptionPage: 1,
        };
      if (action.list === 'bundle')
        return { ...state, bundleSearch: action.value, bundlePage: 1 };
      return { ...state, skillSearch: action.value, skillPage: 1 };
    }
    case 'set-page': {
      if (action.list === 'subscription')
        return { ...state, subscriptionPage: action.page };
      if (action.list === 'bundle')
        return { ...state, bundlePage: action.page };
      return { ...state, skillPage: action.page };
    }
    default:
      return state;
  }
}

/** 批量选择切片:我的技能 / 订阅技能各一套(模式开关 + 跨页选中 id 集),外加批量执行态。 */
type StudioSelectionState = {
  ownMode: boolean;
  ownIds: Set<string>;
  subMode: boolean;
  subIds: Set<string>;
  busy: boolean;
};

type StudioSelectionAction =
  | { type: 'enter-own' }
  | { type: 'exit-own' }
  | { type: 'enter-sub' }
  | { type: 'exit-sub' }
  | { type: 'toggle-own'; id: string }
  | { type: 'toggle-sub'; id: string }
  | { type: 'set-own-ids'; ids: Set<string> }
  | { type: 'set-sub-ids'; ids: Set<string> }
  | { type: 'set-busy'; value: boolean };

const initialStudioSelection: StudioSelectionState = {
  ownMode: false,
  ownIds: new Set(),
  subMode: false,
  subIds: new Set(),
  busy: false,
};

/** 在选中集里翻转某个 id,返回新集合(不可变更新)。 */
function toggleInSet(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** 批量选择 reducer:退出选择模式时一并清空对应选中集。 */
function studioSelectionReducer(
  state: StudioSelectionState,
  action: StudioSelectionAction,
): StudioSelectionState {
  switch (action.type) {
    case 'enter-own':
      return { ...state, ownMode: true };
    case 'exit-own':
      return { ...state, ownMode: false, ownIds: new Set() };
    case 'enter-sub':
      return { ...state, subMode: true };
    case 'exit-sub':
      return { ...state, subMode: false, subIds: new Set() };
    case 'toggle-own':
      return { ...state, ownIds: toggleInSet(state.ownIds, action.id) };
    case 'toggle-sub':
      return { ...state, subIds: toggleInSet(state.subIds, action.id) };
    case 'set-own-ids':
      return { ...state, ownIds: action.ids };
    case 'set-sub-ids':
      return { ...state, subIds: action.ids };
    case 'set-busy':
      return { ...state, busy: action.value };
    default:
      return state;
  }
}

/** 「已复制」指示切片:技能分享与捆绑包分享各一个,2 秒后自动清除。 */
type StudioCopiedState = {
  skillId: string | null;
  bundleId: string | null;
};

type StudioCopiedAction =
  | { type: 'set-skill'; id: string }
  | { type: 'clear-skill' }
  | { type: 'set-bundle'; id: string }
  | { type: 'clear-bundle' };

const initialStudioCopied: StudioCopiedState = {
  skillId: null,
  bundleId: null,
};

/** 复制指示 reducer。 */
function studioCopiedReducer(
  state: StudioCopiedState,
  action: StudioCopiedAction,
): StudioCopiedState {
  switch (action.type) {
    case 'set-skill':
      return { ...state, skillId: action.id };
    case 'clear-skill':
      return { ...state, skillId: null };
    case 'set-bundle':
      return { ...state, bundleId: action.id };
    case 'clear-bundle':
      return { ...state, bundleId: null };
    default:
      return state;
  }
}

export default function StudioPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { toast } = useToast();
  const { confirm: confirmDialog } = useConfirm();
  const { formatNumber, t } = useI18n();

  const [loading, setLoading] = useState(true);
  const [editingBundle, setEditingBundle] = useState<SkillBundle | null>(null);
  const [importingSkill, setImportingSkill] = useState(false);
  const [activeTab, setActiveTab] = useState<StudioTabKey>('subscribed');
  // skillLimits 仅在导入/导出事件处理器里读取,从不参与渲染,也不是任何 hook 依赖 → 用 ref 承载,避免无谓重渲染
  const skillLimitsRef = useRef(DEFAULT_SKILL_BUNDLE_LIMITS);

  // 三个列表的搜索 + 分页合并为一个切片;搜索变更时在 reducer 内重置页码(替代三个 useEffect)
  const [lists, dispatchLists] = useReducer(
    studioListsReducer,
    initialStudioLists,
  );
  const {
    subscriptionSearch,
    subscriptionPage,
    bundleSearch,
    bundlePage,
    skillSearch,
    skillPage,
  } = lists;

  // 批量选择(我的知识技能 / 订阅技能 各一套,跨页按 id 记录选中)与批量执行态合并为一个切片
  const [selection, dispatchSelection] = useReducer(
    studioSelectionReducer,
    initialStudioSelection,
  );
  const {
    ownMode: ownSelectionMode,
    ownIds: ownSelectedIds,
    subMode: subSelectionMode,
    subIds: subSelectedIds,
    busy: batchBusy,
  } = selection;

  // 「已复制」指示(技能分享 / 捆绑包分享各一个)
  const [copied, dispatchCopied] = useReducer(
    studioCopiedReducer,
    initialStudioCopied,
  );
  const { skillId: copiedId, bundleId: copiedBundleId } = copied;
  const notify = useCallback(
    (type: 'success' | 'error', message: string) => toast(type, message),
    [toast],
  );
  const userSkills = useUserSkills(notify);
  const bundlesState = useBundles(notify);
  const { ownSkills, subscribedSkills, loadUserSkills, applyUserSkills } =
    userSkills;
  const { bundles, loadBundles, setBundles } = bundlesState;

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    Promise.all([
      skillsApi.userList(),
      skillsApi.bundleList().catch(() => [] as SkillBundle[]),
      skillsApi.limits().catch(() => DEFAULT_SKILL_BUNDLE_LIMITS),
    ])
      .then(([s, b, limits]) => {
        if (cancelled) return;
        applyUserSkills(s);
        setBundles(Array.isArray(b) ? b : []);
        skillLimitsRef.current = limits;
      })
      .catch((err) => {
        if (cancelled) return;
        toast(
          'error',
          err instanceof Error ? err.message : t('pages.studio.loadFailed'),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyUserSkills, setBundles, toast, user]);

  const stats = useMemo(() => {
    const sharedCount = ownSkills.filter(
      (s) => s.visibility !== 'private',
    ).length;
    const totalSubs = ownSkills.reduce(
      (sum, s) => sum + (s.stat_subscriber_count ?? 0),
      0,
    );
    const bundleCount = bundles.length;
    return { sharedCount, totalSubs, bundleCount };
  }, [bundles.length, ownSkills]);

  const subscribedGroups = useMemo(
    () => groupSubscribedSkills(subscribedSkills),
    [subscribedSkills],
  );

  const subscribedItems = useMemo<SubscribedListItem[]>(
    () => [
      ...subscribedGroups.bundles.map((group) => ({
        type: 'bundle' as const,
        key: `bundle:${group.bundleId}`,
        group,
      })),
      ...subscribedGroups.direct.map((skill) => ({
        type: 'skill' as const,
        key: `skill:${skill.subscription_id}`,
        skill,
      })),
    ],
    [subscribedGroups],
  );

  const filteredSubscribedItems = useMemo(() => {
    const query = normalizeSearch(subscriptionSearch);
    return subscribedItems.filter((item) => {
      if (item.type === 'bundle') {
        return matchesSearch(
          [
            item.group.bundleName,
            ...item.group.skills.flatMap((skill) => [
              skill.skill_name,
              skill.description,
              skill.author_label,
            ]),
          ],
          query,
        );
      }

      return matchesSearch(
        [item.skill.skill_name, item.skill.description, item.skill.author_label],
        query,
      );
    });
  }, [subscribedItems, subscriptionSearch]);

  const filteredBundles = useMemo(() => {
    const query = normalizeSearch(bundleSearch);
    return bundles.filter((bundle) =>
      matchesSearch(
        [bundle.name, bundle.description, bundle.skill_ids.length],
        query,
      ),
    );
  }, [bundleSearch, bundles]);

  const filteredOwnSkills = useMemo(() => {
    const query = normalizeSearch(skillSearch);
    return ownSkills.filter((skill) =>
      matchesSearch(
        [
          skill.skill_name,
          skill.description,
          skill.content_length,
          skill.stat_subscriber_count,
        ],
        query,
      ),
    );
  }, [ownSkills, skillSearch]);

  const pagedSubscribedItems = useMemo(
    () =>
      paginateItems(
        filteredSubscribedItems,
        subscriptionPage,
        STUDIO_LIST_PAGE_SIZE,
      ),
    [filteredSubscribedItems, subscriptionPage],
  );
  const pagedBundles = useMemo(
    () => paginateItems(filteredBundles, bundlePage, STUDIO_LIST_PAGE_SIZE),
    [bundlePage, filteredBundles],
  );
  const pagedOwnSkills = useMemo(
    () => paginateItems(filteredOwnSkills, skillPage, STUDIO_LIST_PAGE_SIZE),
    [filteredOwnSkills, skillPage],
  );

  // 批量选择作用于「当前过滤结果全集」而非当前页,否则每页仅 4 项批量无意义
  const ownSelectableIds = useMemo(
    () => filteredOwnSkills.map((skill) => skill.id),
    [filteredOwnSkills],
  );
  // 订阅区混有 bundle 组与单技能,批量仅针对单技能(subscription_id)
  const subSelectableIds = useMemo(
    () =>
      filteredSubscribedItems.flatMap((item) =>
        item.type === 'skill' ? [item.skill.subscription_id] : [],
      ),
    [filteredSubscribedItems],
  );
  const hasSubscribedSkills = useMemo(
    () => subscribedItems.some((item) => item.type === 'skill'),
    [subscribedItems],
  );
  const allOwnSelected =
    ownSelectableIds.length > 0 &&
    ownSelectableIds.every((id) => ownSelectedIds.has(id));
  const allSubSelected =
    subSelectableIds.length > 0 &&
    subSelectableIds.every((id) => subSelectedIds.has(id));

  // 各标签页的计数徽标
  const tabCounts: Record<StudioTabKey, number> = {
    subscribed: subscribedSkills.length,
    bundles: bundles.length,
    own: ownSkills.length,
  };

  const runWithToast = async (
    fn: () => Promise<void>,
    fallbackMsg: string,
  ): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (err) {
      toast('error', err instanceof Error ? err.message : fallbackMsg);
      return false;
    }
  };

  const handleDelete = async (id: string) => {
    const ok = await confirmDialog({
      title: t('pages.studio.deleteSkillTitle'),
      message: t('pages.studio.deleteSkillMessage'),
      confirmLabel: t('pages.studio.delete'),
      variant: 'danger',
    });
    if (!ok) return;
    const success = await runWithToast(async () => {
      await skillsApi.userDelete(id);
      await loadUserSkills();
    }, t('pages.studio.deleteFailed'));
    if (success) toast('success', t('pages.studio.deleted'));
  };

  const handleImportSkillZip = async (file: File | undefined) => {
    if (!file) return;
    setImportingSkill(true);
    await runWithToast(async () => {
      const imported = await importSkillBundleFromZip(file, skillLimitsRef.current);
      await skillsApi.userCreate({
        skill_name: imported.skillName,
        files: imported.files,
      });
      await loadUserSkills();
      toast('success', t('pages.studio.skillZipImported'));
    }, t('pages.studio.importZipFailed'));
    setImportingSkill(false);
  };

  const handleExportSkillZip = (skill: UserCustomSkill) => {
    try {
      downloadSkillBundleZip(skill.skill_name, skill.files, skillLimitsRef.current);
    } catch (err) {
      toast(
        'error',
        err instanceof Error ? err.message : t('pages.studio.exportZipFailed'),
      );
    }
  };

  const handleToggle = async (id: string) => {
    await runWithToast(async () => {
      await skillsApi.userToggle(id);
      await loadUserSkills();
    }, t('pages.studio.toggleFailed'));
  };

  const handleShare = async (id: string) => {
    await runWithToast(async () => {
      const current = ownSkills.find((skill) => skill.id === id);
      let shareToken = current?.share_token ?? null;
      if (!shareToken) {
        const res = await skillsApi.share(id);
        shareToken = res.share_token;
        await loadUserSkills();
      }
      if (!shareToken) throw new Error(t('pages.studio.shareLinkMissing'));
      const url = `${window.location.origin}/skills/install?token=${encodeURIComponent(shareToken)}`;
      await navigator.clipboard.writeText(url);
      dispatchCopied({ type: 'set-skill', id });
      toast('success', t('pages.studio.privateLinkCopied'));
      setTimeout(() => dispatchCopied({ type: 'clear-skill' }), 2000);
    }, t('pages.studio.copyLinkFailed'));
  };

  const handleSkillAccessInvite = async (id: string) => {
    await runWithToast(async () => {
      const res = await skillsApi.accessInviteCreate({
        target_type: 'skill',
        target_id: id,
      });
      const url = `${window.location.origin}${res.install_url}`;
      await navigator.clipboard.writeText(url);
      toast('success', t('pages.studio.authorInviteCopied'));
    }, t('pages.studio.authorInviteFailed'));
  };

  const handleUnshare = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.unshare(id);
      await loadUserSkills();
    }, t('pages.studio.unshareFailed'));
    if (success) toast('success', t('pages.studio.unshared'));
  };

  const handlePublish = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.publish(id);
      await loadUserSkills();
    }, t('pages.studio.publishFailed'));
    if (success) toast('success', t('pages.studio.published'));
  };

  const handleUnpublish = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.unpublish(id);
      await loadUserSkills();
    }, t('pages.studio.unpublishFailed'));
    if (success) toast('success', t('pages.studio.unpublished'));
  };

  const handleSubscriptionToggle = async (subId: string) => {
    await runWithToast(async () => {
      await skillsApi.subscriptionToggle(subId);
      await loadUserSkills();
    }, t('pages.studio.toggleFailed'));
  };

  // —— 批量选择与批量启停 ——
  const toggleOwnSelect = (id: string) => {
    dispatchSelection({ type: 'toggle-own', id });
  };
  const toggleSubSelect = (id: string) => {
    dispatchSelection({ type: 'toggle-sub', id });
  };
  const exitOwnSelection = () => {
    dispatchSelection({ type: 'exit-own' });
  };
  const exitSubSelection = () => {
    dispatchSelection({ type: 'exit-sub' });
  };
  // 全选/取消:全选作用于当前过滤结果全集,取消则清空整个选择集
  const selectAllOwn = () => {
    dispatchSelection({
      type: 'set-own-ids',
      ids: allOwnSelected ? new Set() : new Set(ownSelectableIds),
    });
  };
  const selectAllSub = () => {
    dispatchSelection({
      type: 'set-sub-ids',
      ids: allSubSelected ? new Set() : new Set(subSelectableIds),
    });
  };

  // 批量启停:后端 /toggle 只能翻转,故前端只对「选中且当前状态 != 目标」的项调用,
  // 保证「批量启用/关闭」是幂等的目标态语义而非盲翻转。
  const batchToggleOwn = async (target: boolean) => {
    const targets = ownSkills.filter(
      (skill) => ownSelectedIds.has(skill.id) && skill.enabled !== target,
    );
    if (targets.length === 0) {
      toast('error', t('pages.studio.batchNoChange'));
      return;
    }
    dispatchSelection({ type: 'set-busy', value: true });
    const results = await Promise.allSettled(
      targets.map((skill) => skillsApi.userToggle(skill.id)),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    await loadUserSkills();
    dispatchSelection({ type: 'set-busy', value: false });
    exitOwnSelection();
    const done = targets.length - failed;
    if (failed === 0) {
      toast(
        'success',
        t(target ? 'pages.studio.batchEnabled' : 'pages.studio.batchDisabled', {
          count: formatNumber(done),
        }),
      );
    } else {
      toast(
        'error',
        t('pages.studio.batchPartial', {
          success: formatNumber(done),
          failed: formatNumber(failed),
        }),
      );
    }
  };
  const batchToggleSub = async (target: boolean) => {
    const targets = subscribedSkills.filter(
      (skill) =>
        subSelectedIds.has(skill.subscription_id) &&
        skill.subscription_enabled !== target,
    );
    if (targets.length === 0) {
      toast('error', t('pages.studio.batchNoChange'));
      return;
    }
    dispatchSelection({ type: 'set-busy', value: true });
    const results = await Promise.allSettled(
      targets.map((skill) =>
        skillsApi.subscriptionToggle(skill.subscription_id),
      ),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    await loadUserSkills();
    dispatchSelection({ type: 'set-busy', value: false });
    exitSubSelection();
    const done = targets.length - failed;
    if (failed === 0) {
      toast(
        'success',
        t(target ? 'pages.studio.batchEnabled' : 'pages.studio.batchDisabled', {
          count: formatNumber(done),
        }),
      );
    } else {
      toast(
        'error',
        t('pages.studio.batchPartial', {
          success: formatNumber(done),
          failed: formatNumber(failed),
        }),
      );
    }
  };

  const handleUnsubscribe = async (subId: string) => {
    const ok = await confirmDialog({
      title: t('pages.studio.unsubscribeTitle'),
      message: t('pages.studio.unsubscribeMessage'),
      confirmLabel: t('pages.studio.unsubscribeConfirm'),
      variant: 'danger',
    });
    if (!ok) return;
    const success = await runWithToast(async () => {
      await skillsApi.unsubscribe(subId);
      await loadUserSkills();
    }, t('pages.studio.unsubscribeFailed'));
    if (success) toast('success', t('pages.studio.unsubscribed'));
  };

  const handleBundleUnsubscribe = async (bundleId: string) => {
    const ok = await confirmDialog({
      title: t('pages.studio.bundleUnsubscribeTitle'),
      message: t('pages.studio.bundleUnsubscribeMessage'),
      confirmLabel: t('pages.studio.bundleUnsubscribeConfirm'),
      variant: 'danger',
    });
    if (!ok) return;
    const success = await runWithToast(async () => {
      await skillsApi.bundleUnsubscribe(bundleId);
      await loadUserSkills();
    }, t('pages.studio.bundleUnsubscribeFailed'));
    if (success) toast('success', t('pages.studio.bundleUnsubscribed'));
  };

  const handleBundleUpdate = async (
    data: Parameters<typeof skillsApi.bundleUpdate>[1],
  ) => {
    if (!editingBundle) return;
    await skillsApi.bundleUpdate(editingBundle.id, data);
    setEditingBundle(null);
    await loadBundles();
    toast('success', t('pages.studio.bundleUpdated'));
  };

  const handleBundleDelete = async (id: string) => {
    const ok = await confirmDialog({
      title: t('pages.studio.bundleDeleteTitle'),
      message: t('pages.studio.bundleDeleteMessage'),
      confirmLabel: t('pages.studio.delete'),
      variant: 'danger',
    });
    if (!ok) return;
    const success = await runWithToast(async () => {
      await skillsApi.bundleDelete(id);
      await loadBundles();
    }, t('pages.studio.deleteFailed'));
    if (success) toast('success', t('pages.studio.deleted'));
  };

  const handleBundleShare = async (id: string) => {
    await runWithToast(async () => {
      const current = bundles.find((bundle) => bundle.id === id);
      let bundleToken = current?.bundle_token ?? null;
      if (!bundleToken) {
        const res = await skillsApi.bundleShare(id);
        bundleToken = res.bundle_token;
        await loadBundles();
      }
      if (!bundleToken) throw new Error(t('pages.studio.shareLinkMissing'));
      const url = `${window.location.origin}/skills/bundle/install?token=${encodeURIComponent(bundleToken)}`;
      await navigator.clipboard.writeText(url);
      dispatchCopied({ type: 'set-bundle', id });
      toast('success', t('pages.studio.privateLinkCopied'));
      setTimeout(() => dispatchCopied({ type: 'clear-bundle' }), 2000);
    }, t('pages.studio.copyLinkFailed'));
  };

  const handleBundleAccessInvite = async (id: string) => {
    await runWithToast(async () => {
      const res = await skillsApi.accessInviteCreate({
        target_type: 'bundle',
        target_id: id,
      });
      const url = `${window.location.origin}${res.install_url}`;
      await navigator.clipboard.writeText(url);
      toast('success', t('pages.studio.authorInviteCopied'));
    }, t('pages.studio.authorInviteFailed'));
  };

  const handleBundleUnshare = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.bundleUnshare(id);
      await loadBundles();
    }, t('pages.studio.unshareFailed'));
    if (success) toast('success', t('pages.studio.unshared'));
  };

  const handleBundlePublish = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.bundlePublish(id);
      await loadBundles();
    }, t('pages.studio.publishFailed'));
    if (success) toast('success', t('pages.studio.published'));
  };

  const handleBundleUnpublish = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.bundleUnpublish(id);
      await loadBundles();
    }, t('pages.studio.unpublishFailed'));
    if (success) toast('success', t('pages.studio.unpublished'));
  };

  return (
    <AppShell>
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header */}
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div className="hidden lg:block">
            <h1 className="text-2xl font-bold tracking-tight">
              {t('pages.studio.title')}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {t('pages.studio.description')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-hairline bg-surface-card text-sm font-medium text-ink transition-colors ${
                importingSkill
                  ? 'cursor-not-allowed opacity-60'
                  : 'cursor-pointer hover:bg-surface-cream-strong'
              }`}
            >
              {importingSkill ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              {t('pages.studio.importSkill')}
              <input
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                disabled={importingSkill}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  void handleImportSkillZip(file);
                }}
              />
            </label>
            <Link
              href="/studio/bundles/new"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-hairline bg-surface-card text-sm font-medium text-ink transition-colors hover:bg-surface-cream-strong"
            >
              <Layers className="w-4 h-4" />
              {t('pages.studio.createBundle')}
            </Link>
            <Link
              href="/studio/skills/new"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" />
              {t('pages.studio.createSkill')}
            </Link>
          </div>
        </header>

        {/* Stat cards */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label={t('pages.studio.sharedSkills')}
            value={formatNumber(stats.sharedCount)}
            Icon={Puzzle}
            hint={t('pages.studio.sharedSkillsHint')}
          />
          <StatCard
            label={t('pages.studio.skillBundles')}
            value={formatNumber(stats.bundleCount)}
            Icon={Layers}
          />
          <StatCard
            label={t('pages.studio.totalSubscribers')}
            value={formatNumber(stats.totalSubs)}
            Icon={Users}
          />
          <StatCard
            label={t('pages.studio.ownSkills')}
            value={formatNumber(ownSkills.length)}
            Icon={BookOpen}
          />
        </section>

        {/* Tab 切换:三个列表区改为标签页,避免垂直堆叠过长 */}
        <div className="flex items-center gap-1 rounded-2xl border border-hairline bg-surface-card p-1">
          {STUDIO_TABS.map((tab) => {
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`flex flex-1 items-center justify-center gap-1.5 h-9 rounded-xl text-[12px] font-medium transition-colors sm:text-[13px] ${
                  active
                    ? 'bg-primary text-white shadow-sm'
                    : 'text-muted hover:bg-surface-cream-strong hover:text-ink'
                }`}
              >
                <tab.Icon size={14} className="shrink-0" />
                <span className="truncate">{t(tab.labelKey)}</span>
                {!loading && (
                  <span
                    className={`shrink-0 rounded-md px-1.5 text-[10px] tabular-nums ${
                      active ? 'bg-white/20' : 'bg-surface-cream-strong'
                    }`}
                  >
                    {formatNumber(tabCounts[tab.key])}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* 别人的订阅 */}
        {activeTab === 'subscribed' && (
        <section>
          <div className="flex items-start justify-between gap-3">
            <SectionTitle
              icon={Share2}
              title={t('pages.studio.subscribedTitle')}
              count={loading ? undefined : subscribedSkills.length}
              subtitle={t('pages.studio.subscribedSubtitle')}
            />
            {!loading && hasSubscribedSkills && !subSelectionMode && (
              <button
                type="button"
                onClick={() => dispatchSelection({ type: 'enter-sub' })}
                className="inline-flex shrink-0 items-center gap-1 px-2.5 py-1 rounded-md text-[11px] text-muted hover:text-ink hover:bg-surface-cream-strong transition-colors"
              >
                <ListChecks size={12} />
                {t('pages.studio.batchManage')}
              </button>
            )}
          </div>

          <div className="mt-5 space-y-3">
            {loading ? (
              <SkillSkeleton />
            ) : subscribedSkills.length === 0 ? (
              <div className="relative py-10 text-center rounded-2xl border border-dashed border-hairline overflow-hidden">
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgb(59_130_246/0.02),transparent_70%)] pointer-events-none" />
                <p className="relative text-[12px] text-muted opacity-60">
                  {t('pages.studio.subscribedEmpty')}
                </p>
              </div>
            ) : (
              <>
                <ListSearch
                  value={subscriptionSearch}
                  onChange={(value) =>
                    dispatchLists({
                      type: 'set-search',
                      list: 'subscription',
                      value,
                    })
                  }
                  placeholder={t('pages.studio.subscribedSearchPlaceholder')}
                />
                {subSelectionMode && (
                  <BatchActionBar
                    selectedCount={subSelectedIds.size}
                    totalCount={subSelectableIds.length}
                    allSelected={allSubSelected}
                    busy={batchBusy}
                    onSelectAll={selectAllSub}
                    onEnable={() => batchToggleSub(true)}
                    onDisable={() => batchToggleSub(false)}
                    onExit={exitSubSelection}
                    t={t}
                  />
                )}
                {filteredSubscribedItems.length === 0 ? (
                  <ListEmptyMessage
                    message={t('pages.studio.noSearchResults', {
                      query: subscriptionSearch.trim(),
                    })}
                  />
                ) : (
                  <>
                    <div className="space-y-3">
                      {pagedSubscribedItems.items.map((item) =>
                        item.type === 'bundle' ? (
                          <SubscribedBundleGroup
                            key={item.key}
                            group={item.group}
                            onUnsubscribeBundle={handleBundleUnsubscribe}
                          />
                        ) : (
                          <SubscribedSkillCard
                            key={item.key}
                            sk={item.skill}
                            onToggle={handleSubscriptionToggle}
                            onUnsubscribe={handleUnsubscribe}
                            selectionMode={subSelectionMode}
                            selected={subSelectedIds.has(
                              item.skill.subscription_id,
                            )}
                            onToggleSelect={toggleSubSelect}
                          />
                        ),
                      )}
                    </div>
                    <PaginationControls
                      currentPage={pagedSubscribedItems.currentPage}
                      totalPages={pagedSubscribedItems.totalPages}
                      totalItems={filteredSubscribedItems.length}
                      pageSize={STUDIO_LIST_PAGE_SIZE}
                      onPageChange={(page) =>
                        dispatchLists({
                          type: 'set-page',
                          list: 'subscription',
                          page,
                        })
                      }
                      formatNumber={formatNumber}
                      t={t}
                    />
                  </>
                )}
              </>
            )}
          </div>
        </section>
        )}

        {/* 我的捆绑包 */}
        {activeTab === 'bundles' && (
        <section>
          <div className="flex items-start justify-between gap-3">
            <SectionTitle
              icon={Layers}
              title={t('pages.studio.bundlesTitle')}
              count={loading ? undefined : bundles.length}
            />
            <Link
              href="/studio/bundles/new"
              className="inline-flex shrink-0 items-center gap-1 px-2.5 py-1 rounded-md text-[11px] text-muted hover:text-ink hover:bg-surface-cream-strong transition-colors"
            >
              <Plus size={12} />
              {t('pages.studio.newBundle')}
            </Link>
          </div>

          <div className="mt-5 space-y-3">
            {loading ? (
              <SkillSkeleton />
            ) : bundles.length === 0 ? (
              <div className="relative py-10 text-center rounded-2xl border border-dashed border-hairline overflow-hidden">
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,color-mix(in_srgb,var(--color-primary)_3%,transparent),transparent_70%)] pointer-events-none" />
                <p className="relative text-[12px] text-muted opacity-70">
                  {t('pages.studio.bundlesEmpty')}
                </p>
              </div>
            ) : (
              <>
                <ListSearch
                  value={bundleSearch}
                  onChange={(value) =>
                    dispatchLists({ type: 'set-search', list: 'bundle', value })
                  }
                  placeholder={t('pages.studio.bundlesSearchPlaceholder')}
                />
                {filteredBundles.length === 0 ? (
                  <ListEmptyMessage
                    message={t('pages.studio.noSearchResults', {
                      query: bundleSearch.trim(),
                    })}
                  />
                ) : (
                  <>
                    <div className="space-y-3">
                      {pagedBundles.items.map((b) => (
                        <BundleCard
                          key={b.id}
                          bundle={b}
                          copiedId={copiedBundleId}
                          onCopyLink={handleBundleShare}
                          onCopyInviteLink={handleBundleAccessInvite}
                          onUnshare={handleBundleUnshare}
                          onPublish={handleBundlePublish}
                          onUnpublish={handleBundleUnpublish}
                          onEdit={setEditingBundle}
                          onDelete={handleBundleDelete}
                        />
                      ))}
                    </div>
                    <PaginationControls
                      currentPage={pagedBundles.currentPage}
                      totalPages={pagedBundles.totalPages}
                      totalItems={filteredBundles.length}
                      pageSize={STUDIO_LIST_PAGE_SIZE}
                      onPageChange={(page) =>
                        dispatchLists({ type: 'set-page', list: 'bundle', page })
                      }
                      formatNumber={formatNumber}
                      t={t}
                    />
                  </>
                )}
              </>
            )}
          </div>
        </section>
        )}

        {/* 我的知识技能 */}
        {activeTab === 'own' && (
        <section>
          <div className="flex items-start justify-between gap-3">
            <SectionTitle
              icon={Puzzle}
              title={t('pages.studio.ownSkillsTitle')}
              count={loading ? undefined : ownSkills.length}
              subtitle={t('pages.studio.ownSkillsSubtitle')}
            />
            {!loading && ownSkills.length > 0 && !ownSelectionMode && (
              <button
                type="button"
                onClick={() => dispatchSelection({ type: 'enter-own' })}
                className="inline-flex shrink-0 items-center gap-1 px-2.5 py-1 rounded-md text-[11px] text-muted hover:text-ink hover:bg-surface-cream-strong transition-colors"
              >
                <ListChecks size={12} />
                {t('pages.studio.batchManage')}
              </button>
            )}
          </div>

          <div className="mt-5 space-y-3">
            {loading ? (
              <>
                <SkillSkeleton />
                <SkillSkeleton />
              </>
            ) : ownSkills.length === 0 ? (
              <div className="group relative overflow-hidden rounded-2xl border border-dashed border-hairline py-14 transition-all duration-300 hover:border-[color-mix(in_srgb,var(--color-primary)_50%,var(--color-hairline))]">
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,color-mix(in_srgb,var(--color-primary)_3%,transparent),transparent_70%)] pointer-events-none" />
                <div className="relative flex flex-col items-center text-center">
                  <div className="w-14 h-14 rounded-2xl bg-surface-card border border-hairline flex items-center justify-center mx-auto mb-4 group-hover:shadow-[0_0_20px_color-mix(in_srgb,var(--color-primary)_10%,transparent)] transition-shadow">
                    <BookOpen
                      size={20}
                      className="text-muted group-hover:text-primary transition-colors"
                    />
                  </div>
                  <p className="max-w-[18rem] text-[14px] text-muted font-medium group-hover:text-ink transition-colors">
                    {t('pages.studio.ownSkillsEmptyTitle')}
                  </p>
                  <p className="mt-1.5 max-w-[22rem] text-[12px] text-muted opacity-60">
                    {t('pages.studio.ownSkillsEmptyDescription')}
                  </p>
                  <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                    <Link
                      href="/studio/skills/new"
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-semibold text-white transition-opacity hover:opacity-90"
                    >
                      <Plus size={13} />
                      {t('pages.studio.newSkill')}
                    </Link>
                    <label
                      className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-hairline bg-surface-card px-3 text-[12px] font-semibold text-ink transition-colors ${
                        importingSkill
                          ? 'cursor-not-allowed opacity-60'
                          : 'cursor-pointer hover:bg-surface-cream-strong'
                      }`}
                    >
                      {importingSkill ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Upload size={13} />
                      )}
                      {t('pages.studio.importZip')}
                      <input
                        type="file"
                        accept=".zip,application/zip"
                        className="hidden"
                        disabled={importingSkill}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = '';
                          void handleImportSkillZip(file);
                        }}
                      />
                    </label>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <ListSearch
                  value={skillSearch}
                  onChange={(value) =>
                    dispatchLists({ type: 'set-search', list: 'skill', value })
                  }
                  placeholder={t('pages.studio.ownSkillsSearchPlaceholder')}
                />
                {ownSelectionMode && (
                  <BatchActionBar
                    selectedCount={ownSelectedIds.size}
                    totalCount={ownSelectableIds.length}
                    allSelected={allOwnSelected}
                    busy={batchBusy}
                    onSelectAll={selectAllOwn}
                    onEnable={() => batchToggleOwn(true)}
                    onDisable={() => batchToggleOwn(false)}
                    onExit={exitOwnSelection}
                    t={t}
                  />
                )}
                {filteredOwnSkills.length === 0 ? (
                  <ListEmptyMessage
                    message={t('pages.studio.noSearchResults', {
                      query: skillSearch.trim(),
                    })}
                  />
                ) : (
                  <>
                    <div className="space-y-3">
                      {pagedOwnSkills.items.map((sk) => (
                        <OwnSkillCard
                          key={sk.id}
                          sk={sk}
                          copiedId={copiedId}
                          onToggle={handleToggle}
                          onCopyLink={handleShare}
                          onCopyInviteLink={handleSkillAccessInvite}
                          onUnshare={handleUnshare}
                          onPublish={handlePublish}
                          onUnpublish={handleUnpublish}
                          onEdit={(skill) =>
                            router.push(
                              `/studio/skills/edit?skillId=${encodeURIComponent(skill.id)}`,
                            )
                          }
                          onExport={handleExportSkillZip}
                          onDelete={handleDelete}
                          selectionMode={ownSelectionMode}
                          selected={ownSelectedIds.has(sk.id)}
                          onToggleSelect={toggleOwnSelect}
                        />
                      ))}
                    </div>
                    <PaginationControls
                      currentPage={pagedOwnSkills.currentPage}
                      totalPages={pagedOwnSkills.totalPages}
                      totalItems={filteredOwnSkills.length}
                      pageSize={STUDIO_LIST_PAGE_SIZE}
                      onPageChange={(page) =>
                        dispatchLists({ type: 'set-page', list: 'skill', page })
                      }
                      formatNumber={formatNumber}
                      t={t}
                    />
                  </>
                )}
              </>
            )}
          </div>
        </section>
        )}
      </div>

      {/* Modals */}
      {editingBundle && (
        <BundleForm
          initial={editingBundle}
          ownSkills={ownSkills}
          onSave={handleBundleUpdate}
          onCancel={() => setEditingBundle(null)}
        />
      )}
    </AppShell>
  );
}

function StatCard({
  label,
  value,
  Icon,
  hint,
}: {
  label: string;
  value: string;
  Icon: React.ElementType;
  hint?: string;
}) {
  return (
    <div className="p-4 rounded-2xl border border-hairline bg-surface-card">
      <div className="flex items-center gap-2 mb-2 text-muted">
        <Icon className="w-4 h-4" />
        <span className="text-xs">{label}</span>
      </div>
      <p className="text-xl font-bold tracking-tight tabular-nums">{value}</p>
      {hint && (
        <p className="mt-0.5 text-[10px] text-muted">{hint}</p>
      )}
    </div>
  );
}

function ListSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <Search
        size={15}
        className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
      />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full h-10 pl-9 pr-3 rounded-xl border border-hairline bg-surface-card text-[13px] placeholder:text-muted focus:border-primary focus:outline-none transition-all"
      />
    </div>
  );
}

function ListEmptyMessage({ message }: { message: string }) {
  return (
    <div className="relative py-10 text-center rounded-2xl border border-dashed border-hairline overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,color-mix(in_srgb,var(--color-primary)_3%,transparent),transparent_70%)] pointer-events-none" />
      <div className="relative flex flex-col items-center gap-2">
        <Search size={18} className="text-muted/55" />
        <p className="text-[12px] text-muted opacity-70">{message}</p>
      </div>
    </div>
  );
}

function PaginationControls({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  formatNumber,
  t,
}: {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  formatNumber: (value: number) => string;
  t: (
    key: string,
    params?: Record<string, string | number | boolean | null | undefined>,
  ) => string;
}) {
  if (totalItems <= pageSize) return null;

  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalItems);

  return (
    <div className="flex flex-col items-center justify-between gap-2 rounded-2xl border border-hairline/60 bg-surface-card/60 px-3 py-2 sm:flex-row">
      <span className="text-[11px] text-muted tabular-nums">
        {t('pages.studio.paginationRange', {
          start: formatNumber(start),
          end: formatNumber(end),
          total: formatNumber(totalItems),
        })}
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1}
          className="inline-flex h-8 items-center gap-1 rounded-full px-3 text-[11px] text-muted transition-all hover:bg-surface-cream-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
        >
          <ChevronLeft size={13} />
          {t('pages.studio.previousPage')}
        </button>
        <span className="inline-flex h-8 min-w-14 items-center justify-center rounded-full bg-surface-cream-strong px-2 text-[11px] tabular-nums text-ink">
          {t('pages.studio.pageIndicator', {
            page: formatNumber(currentPage),
            total: formatNumber(totalPages),
          })}
        </span>
        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= totalPages}
          className="inline-flex h-8 items-center gap-1 rounded-full px-3 text-[11px] text-muted transition-all hover:bg-surface-cream-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
        >
          {t('pages.studio.nextPage')}
          <ChevronRight size={13} />
        </button>
      </div>
    </div>
  );
}

function SectionTitle({
  icon: Icon,
  title,
  count,
  subtitle,
}: {
  icon: typeof Puzzle;
  title: string;
  count?: number;
  subtitle?: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-start gap-3 sm:gap-4">
      <div className="mt-0.5 hidden sm:flex w-8 h-8 rounded-xl bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] items-center justify-center shrink-0">
        <Icon size={14} className="text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 sm:gap-2.5">
          <h3 className="text-[14px] font-semibold tracking-tight">{title}</h3>
          {count !== undefined && (
            <span className="shrink-0 text-[11px] text-muted tabular-nums bg-surface-card px-1.5 py-0.5 rounded-md">
              {count}
            </span>
          )}
        </div>
        {subtitle && (
          <p className="mt-1 text-[12px] leading-relaxed text-muted opacity-80">
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 批量操作栏:进入选择模式后显示在搜索框下方。
 *
 * 提供全选/取消、批量启用、批量关闭、退出选择;启用/关闭按钮在执行中或
 * 未选中任何项时禁用。具体的「只对状态不符项 toggle」幂等逻辑在页面层处理。
 */
function BatchActionBar({
  selectedCount,
  totalCount,
  allSelected,
  busy,
  onSelectAll,
  onEnable,
  onDisable,
  onExit,
  t,
}: {
  selectedCount: number;
  totalCount: number;
  allSelected: boolean;
  busy: boolean;
  onSelectAll: () => void;
  onEnable: () => void;
  onDisable: () => void;
  onExit: () => void;
  t: (
    key: string,
    params?: Record<string, string | number | boolean | null | undefined>,
  ) => string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-primary/30 bg-[color-mix(in_srgb,var(--color-primary)_6%,var(--color-surface-card))] px-3 py-2">
      <button
        type="button"
        onClick={onSelectAll}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-hairline bg-surface-card px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-surface-cream-strong"
      >
        {allSelected
          ? t('pages.studio.batchClearAll')
          : t('pages.studio.batchSelectAll')}
      </button>
      <span className="text-[12px] text-muted tabular-nums">
        {t('pages.studio.batchSelected', {
          count: selectedCount,
          total: totalCount,
        })}
      </span>
      <div className="flex-1" />
      <button
        type="button"
        onClick={onEnable}
        disabled={busy || selectedCount === 0}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <ToggleRight size={14} />
        )}
        {t('pages.studio.batchEnable')}
      </button>
      <button
        type="button"
        onClick={onDisable}
        disabled={busy || selectedCount === 0}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-hairline bg-surface-card px-3 text-[12px] font-semibold text-ink transition-colors hover:bg-surface-cream-strong disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ToggleLeft size={14} />
        {t('pages.studio.batchDisable')}
      </button>
      <button
        type="button"
        onClick={onExit}
        disabled={busy}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink disabled:opacity-40"
        title={t('pages.studio.batchExit')}
        aria-label={t('pages.studio.batchExit')}
      >
        <X size={15} />
      </button>
    </div>
  );
}
