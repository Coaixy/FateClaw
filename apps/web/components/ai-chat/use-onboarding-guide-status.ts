'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';

import type { EnabledSkillSummary } from '@/components/ai-chat/paipan-skill-rail';
import {
  modelSettingsApi,
  type ModelSettingsOverview,
} from '@/features/model-settings/api';
import { skillsApi, type UserSkillsResponse } from '@/features/skills/api';

export type OnboardingGuideStep = 'welcome' | 'model' | 'skill' | 'done';

interface UseOnboardingGuideStatusOptions {
  enabled: boolean;
}

const GUIDE_DISMISSED_SESSION_KEY =
  'fateclaw:ai-chat:onboarding-guide-dismissed';
const GUIDE_STEP_SESSION_KEY = 'fateclaw:ai-chat:onboarding-guide-step';
const PRE_USE_NOTICE_TITLE_ID = 'pre-use-notice-title';
const COMPLIANCE_DIALOG_GRACE_MS = 240;

function readStoredStep(): OnboardingGuideStep | null {
  if (typeof window === 'undefined') return null;
  const value = window.sessionStorage.getItem(GUIDE_STEP_SESSION_KEY);
  return isGuideStep(value) ? value : null;
}

function isGuideStep(value: unknown): value is OnboardingGuideStep {
  return (
    value === 'welcome' ||
    value === 'model' ||
    value === 'skill' ||
    value === 'done'
  );
}

function writeStoredStep(step: OnboardingGuideStep) {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(GUIDE_STEP_SESSION_KEY, step);
}

function removeStoredStep() {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(GUIDE_STEP_SESSION_KEY);
}

function isGuideDismissed() {
  if (typeof window === 'undefined') return false;
  return window.sessionStorage.getItem(GUIDE_DISMISSED_SESSION_KEY) === '1';
}

function markGuideDismissed() {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(GUIDE_DISMISSED_SESSION_KEY, '1');
}

function clearGuideDismissed() {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(GUIDE_DISMISSED_SESSION_KEY);
}

function isResumeRequested() {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('guide') === 'resume';
}

function isPreUseNoticeOpen() {
  if (typeof document === 'undefined') return false;
  return Boolean(document.getElementById(PRE_USE_NOTICE_TITLE_ID));
}

function hasUsableOfficialSelection(data: ModelSettingsOverview | null) {
  const selectedId = data?.selection?.official_model_id;
  if (!selectedId || data?.selection?.source !== 'official') {
    return false;
  }
  return Boolean(
    data.official_models.some(
      (model) => model.id === selectedId && model.enabled && model.has_secret,
    ),
  );
}

function hasUsableCustomSelection(data: ModelSettingsOverview | null) {
  return Boolean(
    data?.selection?.source === 'custom' &&
      (!data.custom_model_membership_required ||
        data.custom_model_membership_entitled) &&
      data.custom?.model_name.trim() &&
      data.custom.has_secret,
  );
}

function getAvailableOfficialModelCount(data: ModelSettingsOverview | null) {
  return (
    data?.official_models.filter((model) => model.enabled && model.has_secret)
      .length ?? 0
  );
}

/**
 * 判断当前用户是否已经有可用于对话的模型。
 *
 * @param data 模型设置总览。
 * @returns 存在可用官方兜底、显式官方选择或可用自配模型时返回 true。
 */
export function hasUsableModelForGuide(data: ModelSettingsOverview | null) {
  return (
    hasUsableOfficialSelection(data) ||
    hasUsableCustomSelection(data) ||
    getAvailableOfficialModelCount(data) > 0
  );
}

/**
 * 从用户 Skill 响应里提取已启用、可进入 AI Chat 的 Skill 摘要。
 *
 * @param data 用户自有和订阅 Skill 响应。
 * @returns 已启用 Skill 摘要列表；未启用或仅安装的 Skill 会被排除。
 */
export function getEnabledSkillSummaries(
  data: UserSkillsResponse | null,
): EnabledSkillSummary[] {
  if (!data) return [];
  return [
    ...(data.own ?? [])
      .filter((skill) => skill.enabled)
      .map((skill) => ({
        id: skill.id,
        name: skill.skill_name,
        source: 'own' as const,
      })),
    ...(data.subscribed ?? [])
      .filter((skill) => skill.subscription_enabled)
      .map((skill) => ({
        id: skill.subscription_id,
        name: skill.skill_name,
        source: 'subscribed' as const,
      })),
  ];
}

function hasInstalledSkill(data: UserSkillsResponse | null) {
  return Boolean(
    data && (data.own?.length ?? 0) + (data.subscribed?.length ?? 0) > 0,
  );
}

/**
 * 根据当前模型、Skill、恢复参数和存储步骤推导启动向导应展示的步骤。
 *
 * @param args 当前向导上下文。
 * @returns 应展示的启动向导步骤。
 */
export function resolveGuideStep({
  storedStep,
  resumeRequested,
  modelReady,
  skillReady,
  modelError,
  skillError,
}: {
  storedStep: OnboardingGuideStep | null;
  resumeRequested: boolean;
  modelReady: boolean;
  skillReady: boolean;
  modelError: string;
  skillError: string;
}): OnboardingGuideStep {
  if (modelReady && skillReady) {
    return resumeRequested || storedStep ? 'done' : 'welcome';
  }

  if (modelError || !modelReady) {
    if (storedStep === 'welcome' && !resumeRequested && !skillReady) {
      return 'welcome';
    }
    return storedStep === 'welcome' && !resumeRequested ? 'welcome' : 'model';
  }

  if (skillError || !skillReady) {
    return 'skill';
  }

  return 'welcome';
}

/**
 * 启动向导的两路数据拉取状态：模型总览与用户 Skill 各自的 data/loading/error，
 * 随同一次 refresh 整体翻转。用 reducer 把「开始拉取」「拉取结算」「清空」各收敛成一次
 * dispatch，避免一个 effect 内连发多次 setState 造成级联重渲染。
 */
interface GuideFetchState {
  modelOverview: ModelSettingsOverview | null;
  userSkills: UserSkillsResponse | null;
  modelLoading: boolean;
  skillLoading: boolean;
  modelError: string;
  skillError: string;
}

type GuideFetchAction =
  | { type: 'reset' }
  | { type: 'load-start' }
  | {
      type: 'load-settled';
      modelResult: PromiseSettledResult<ModelSettingsOverview>;
      skillResult: PromiseSettledResult<UserSkillsResponse>;
    };

const INITIAL_GUIDE_FETCH_STATE: GuideFetchState = {
  modelOverview: null,
  userSkills: null,
  modelLoading: false,
  skillLoading: false,
  modelError: '',
  skillError: '',
};

function guideFetchReducer(
  state: GuideFetchState,
  action: GuideFetchAction,
): GuideFetchState {
  switch (action.type) {
    case 'reset':
      return INITIAL_GUIDE_FETCH_STATE;
    case 'load-start':
      return {
        ...state,
        modelLoading: true,
        skillLoading: true,
        modelError: '',
        skillError: '',
      };
    case 'load-settled': {
      const { modelResult, skillResult } = action;
      return {
        modelOverview:
          modelResult.status === 'fulfilled' ? modelResult.value : null,
        modelError:
          modelResult.status === 'fulfilled'
            ? ''
            : modelResult.reason instanceof Error
              ? modelResult.reason.message
              : '暂时无法读取官方模型',
        userSkills:
          skillResult.status === 'fulfilled' ? skillResult.value : null,
        skillError:
          skillResult.status === 'fulfilled'
            ? ''
            : skillResult.reason instanceof Error
              ? skillResult.reason.message
              : 'Skill 市场暂时不可用',
        modelLoading: false,
        skillLoading: false,
      };
    }
  }
}

/**
 * 启动向导弹层的呈现状态：是否打开（open）与当前步骤（step）始终一起决定弹层外观，
 * 用 reducer 把「设步骤」「打开」「关闭」「直达完成」等转换收敛成单次 dispatch，
 * 避免 setStep + setOpen 在同一 effect 内级联重渲染。
 */
interface GuidePresentationState {
  open: boolean;
  step: OnboardingGuideStep;
}

type GuidePresentationAction =
  | { type: 'set-step'; step: OnboardingGuideStep }
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'show-done' }
  | { type: 'open-at'; step: OnboardingGuideStep };

function guidePresentationReducer(
  state: GuidePresentationState,
  action: GuidePresentationAction,
): GuidePresentationState {
  switch (action.type) {
    case 'set-step':
      return { ...state, step: action.step };
    case 'open':
      return { ...state, open: true };
    case 'close':
      return { ...state, open: false };
    case 'show-done':
      return { open: true, step: 'done' };
    case 'open-at':
      return { open: true, step: action.step };
  }
}

/**
 * 读取 AI Chat 启动向导所需的模型、Skill 与 session 状态。
 *
 * @param options 控制是否发起状态检查；通常只在已登录且 AI Chat 可用时启用。
 * @returns 启动向导弹层、空状态入口和 Skill 摘要需要的派生状态与操作。
 */
export function useOnboardingGuideStatus({
  enabled,
}: UseOnboardingGuideStatusOptions) {
  const [{ open, step }, dispatchPresentation] = useReducer(
    guidePresentationReducer,
    { open: false, step: 'welcome' },
  );
  const [
    { modelOverview, userSkills, modelLoading, skillLoading, modelError, skillError },
    dispatchFetch,
  ] = useReducer(guideFetchReducer, INITIAL_GUIDE_FETCH_STATE);
  const [complianceReady, setComplianceReady] = useState(false);
  const [resumeRequested, setResumeRequested] = useState(false);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    dispatchFetch({ type: 'load-start' });

    const [modelResult, skillResult] = await Promise.allSettled([
      modelSettingsApi.overview(),
      skillsApi.userList(),
    ]);

    if (requestIdRef.current !== requestId) return;

    dispatchFetch({ type: 'load-settled', modelResult, skillResult });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      dispatchPresentation({ type: 'close' });
      dispatchFetch({ type: 'reset' });
      return;
    }

    setResumeRequested(isResumeRequested());
    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      setComplianceReady(false);
      return;
    }

    let graceTimerDone = false;
    const updateComplianceReady = () => {
      setComplianceReady(graceTimerDone && !isPreUseNoticeOpen());
    };
    const timeoutId = window.setTimeout(() => {
      graceTimerDone = true;
      updateComplianceReady();
    }, COMPLIANCE_DIALOG_GRACE_MS);
    const observer = new MutationObserver(updateComplianceReady);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      window.clearTimeout(timeoutId);
      observer.disconnect();
    };
  }, [enabled]);

  const availableOfficialModelCount =
    getAvailableOfficialModelCount(modelOverview);
  const modelReady = hasUsableModelForGuide(modelOverview);
  const skillReady = getEnabledSkillSummaries(userSkills).length > 0;
  const hasAnyInstalledSkill = hasInstalledSkill(userSkills);
  const enabledSkills = useMemo(
    () => getEnabledSkillSummaries(userSkills),
    [userSkills],
  );
  const settled = !modelLoading && !skillLoading;
  const shouldContinue =
    enabled &&
    settled &&
    Boolean(modelError || skillError || !modelReady || !skillReady);

  useEffect(() => {
    if (!enabled || !settled) return;

    const nextStep = resolveGuideStep({
      storedStep: readStoredStep(),
      resumeRequested,
      modelReady,
      skillReady,
      modelError,
      skillError,
    });
    dispatchPresentation({ type: 'set-step', step: nextStep });
  }, [
    enabled,
    settled,
    resumeRequested,
    modelReady,
    skillReady,
    modelError,
    skillError,
  ]);

  useEffect(() => {
    if (!enabled || !settled || !complianceReady) return;

    if (isGuideDismissed()) {
      return;
    }

    const storedStep = readStoredStep();
    const shouldShowDone =
      modelReady && skillReady && (resumeRequested || storedStep);
    if (shouldShowDone) {
      dispatchPresentation({ type: 'show-done' });
      return;
    }

    if (!shouldContinue) {
      return;
    }

    dispatchPresentation({ type: 'open' });
  }, [
    enabled,
    settled,
    complianceReady,
    resumeRequested,
    modelReady,
    skillReady,
    shouldContinue,
  ]);

  const saveStep = useCallback((nextStep: OnboardingGuideStep) => {
    writeStoredStep(nextStep);
    dispatchPresentation({ type: 'set-step', step: nextStep });
  }, []);

  const openGuide = useCallback(() => {
    clearGuideDismissed();
    const nextStep = resolveGuideStep({
      storedStep: readStoredStep(),
      resumeRequested: true,
      modelReady,
      skillReady,
      modelError,
      skillError,
    });
    writeStoredStep(nextStep);
    dispatchPresentation({ type: 'open-at', step: nextStep });
  }, [modelReady, skillReady, modelError, skillError]);

  const dismissGuide = useCallback(() => {
    markGuideDismissed();
    dispatchPresentation({ type: 'close' });
  }, []);

  const completeGuide = useCallback(() => {
    markGuideDismissed();
    removeStoredStep();
    dispatchPresentation({ type: 'close' });
  }, []);

  return {
    open,
    step,
    modelReady,
    skillReady,
    modelLoading,
    skillLoading,
    modelError,
    skillError,
    availableOfficialModelCount,
    hasAnyInstalledSkill,
    enabledSkills,
    enabledSkillsLoading: skillLoading,
    shouldShowContinueEntry: shouldContinue,
    saveStep,
    openGuide,
    dismissGuide,
    completeGuide,
    refresh,
  };
}
