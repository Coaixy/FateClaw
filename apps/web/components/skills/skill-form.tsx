'use client';

import type { ComponentType, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import {
  BadgeCheck,
  BookText,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  FileText,
  Gauge,
  Lightbulb,
  ListChecks,
  Loader2,
  Route,
  Wand2,
  XCircle,
} from 'lucide-react';

import {
  USER_SKILL_CATEGORIES,
  SkillUsageMode,
  UserCustomSkill,
} from '@/features/skills/api';
import { SkillContentEditor } from '@/components/skills/skill-content-editor';
import { SkillContentPreview } from '@/components/skills/skill-content-preview';
import { useConfirm } from '@/lib/use-confirm';
import { BottomSheet } from '@/components/ui/bottom-sheet';

const SKILL_USAGE_OPTIONS: Array<{
  value: SkillUsageMode;
  shortLabel: string;
  label: string;
  desc: string;
  color: 'emerald' | 'red';
}> = [
  {
    value: 'reference_only',
    shortLabel: '参考',
    label: '参考知识',
    desc: '仅在需要时补充，不会强制覆盖默认解读。',
    color: 'emerald',
  },
  {
    value: 'force_injected',
    shortLabel: '强规则',
    label: '强规则',
    desc: '命中后全文注入，解读必须体现其中规则与口径。',
    color: 'red',
  },
];

type SkillFormStepId = 'basic' | 'routing' | 'content' | 'review';

const SKILL_FORM_STEPS: Array<{
  id: SkillFormStepId;
  label: string;
  title: string;
  desc: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}> = [
  {
    id: 'basic',
    label: '基础信息',
    title: '先说清技能是什么',
    desc: '名称和描述先把这个技能的用途讲清楚。',
    icon: BookText,
  },
  {
    id: 'routing',
    label: '匹配与使用',
    title: '再确认它怎么匹配和使用',
    desc: '适用术数、关键词和使用方式会影响技能被调用后的处理策略。',
    icon: Route,
  },
  {
    id: 'content',
    label: '知识内容',
    title: '补上真正可复用的规则',
    desc: '用章节、流程和示例把经验沉淀成稳定内容。',
    icon: FileText,
  },
  {
    id: 'review',
    label: '检查发布',
    title: '最后扫一遍再创建',
    desc: '确认关键信息、结构质量和正文预览。',
    icon: ClipboardCheck,
  },
];

const REFERENCE_SKILL_SKELETON = `# 技能主题

## 适用场景
- 这个技能适合解决什么问题
- 用户通常会怎么提问

## 核心判断框架
Step 1：先判断哪类情境适用
- ...

Step 2：提炼本题最关键的判断点
- ...

Step 3：组织输出结构
- 先说结论
- 再说依据
- 最后给建议

## 分章节知识
## 主题总论
- ...

## 关键判断
- ...

## 常见误区 / 边界
- ...

## 常见追问
Q: ...
A: ...`;

const FORCE_INJECTED_SKILL_SKELETON = `# 强规则主题

## 适用问题
- 哪类问题一旦命中，必须优先按这套规则解释

## 解读流程
Step 1：先判断...
- ...

Step 2：再检查...
- ...

Step 3：最后输出...
- ...

## 必须体现
- 结论里必须提到什么
- 必须遵守什么判断顺序

## 禁忌与边界
- 不要怎样误判
- 哪些情况必须明确说明不适用`;

const KEYWORD_EXAMPLE_MAP: Record<string, string[]> = {
  通用: ['财运', '事业', '婚姻', '健康'],
  八字: ['财运', '事业', '婚姻', '流年'],
  紫微: ['财帛宫', '事业宫', '夫妻宫', '大限'],
  六爻: ['财运', '求财时机', '破财', '官运'],
  奇门: ['求财', '合作', '项目', '时机'],
  梅花: ['应期', '财运', '成败', '人际'],
  塔罗: ['感情', '复合', '事业', '选择'],
  占星: ['事业', '感情', '财富', '行运'],
};

function getDisplayCategory(category?: string | null): string {
  return category && category !== '通用' ? category : '';
}

function getRecommendedSkeleton(mode: SkillUsageMode): string {
  return mode === 'force_injected'
    ? FORCE_INJECTED_SKILL_SKELETON
    : REFERENCE_SKILL_SKELETON;
}

function getUsageWritingTips(mode: SkillUsageMode): string[] {
  if (mode === 'force_injected') {
    return [
      '只保留必须遵守的流程、边界和口径，不要堆太多背景知识。',
      '优先写“先判断什么，再判断什么”，让模型能直接照着走。',
      '章节建议少而硬，尽量 3 到 5 段内讲清主线。',
    ];
  }

  return [
    '把大知识拆成多个 ## 章节，方便后续按需检索。',
    '每个章节开头就点题，最好第一句就说明这一章回答什么问题。',
    '适合收纳长知识、专题问答、案例边界和补充说明。',
  ];
}

function getQualitySummary(passCount: number, total: number): {
  label: string;
  desc: string;
  tone: 'red' | 'amber' | 'emerald';
} {
  if (passCount >= total) {
    return {
      label: '已经成型',
      desc: '结构完整，已经具备可发布的雏形。',
      tone: 'emerald',
    };
  }
  if (passCount >= Math.ceil(total * 0.66)) {
    return {
      label: '继续打磨',
      desc: '主框架已经在了，再补充规则细节和示例就会更稳。',
      tone: 'amber',
    };
  }
  return {
    label: '先补骨架',
    desc: '先把用途、关键词和章节结构写清，会比直接堆内容更有效。',
    tone: 'red',
  };
}

function GuideCard({
  icon: Icon,
  title,
  children,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-hairline bg-canvas/65 p-4">
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)]">
          <Icon size={15} className="text-primary" />
        </div>
        {title}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export type SkillFormData = {
  skill_name: string;
  description: string;
  content: string;
  category: string;
  usage_mode: SkillUsageMode;
  match_keywords: string[];
};

export function SkillForm({
  initial,
  onSave,
  onCancel,
  variant = 'sheet',
  flow = 'full',
  categorySuggestions,
}: {
  initial?: UserCustomSkill;
  onSave: (data: SkillFormData) => Promise<void>;
  onCancel: () => void;
  variant?: 'sheet' | 'page';
  flow?: 'full' | 'stepped';
  categorySuggestions?: readonly string[];
}) {
  const { confirm: confirmDialog } = useConfirm();
  const [name, setName] = useState(initial?.skill_name || '');
  const [desc, setDesc] = useState(initial?.description || '');
  const [content, setContent] = useState(initial?.content || '');
  const [category, setCategory] = useState(getDisplayCategory(initial?.category));
  const [usageMode, setUsageMode] = useState<SkillUsageMode>(
    initial?.usage_mode || 'reference_only',
  );
  const [keywordsText, setKeywordsText] = useState(
    (initial?.match_keywords || []).join('、'),
  );
  const [activeStep, setActiveStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const categoryOptions = categorySuggestions ?? USER_SKILL_CATEGORIES;
  const normalizedKeywords = useMemo(
    () =>
      keywordsText
        .split(/[、,，\s]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    [keywordsText],
  );
  const contentMetrics = useMemo(() => {
    const headingCount = (content.match(/^##\s+/gm) || []).length;
    const stepCount = (content.match(/^Step\s+\d+/gim) || []).length;
    const qaCount = (content.match(/^Q:\s+/gm) || []).length;
    const bulletCount = (content.match(/^- /gm) || []).length;
    const hasMustRule = /必须|不要|禁忌|注意事项/.test(content);
    const hasScenario = /适用场景|适用问题|用户问题/.test(content);
    return {
      headingCount,
      stepCount,
      qaCount,
      bulletCount,
      hasMustRule,
      hasScenario,
    };
  }, [content]);
  const keywordExamples = useMemo(() => {
    const examples =
      KEYWORD_EXAMPLE_MAP[category || '通用'] || KEYWORD_EXAMPLE_MAP['通用'];
    return examples.filter((item) => !normalizedKeywords.includes(item)).slice(0, 4);
  }, [category, normalizedKeywords]);
  const qualityChecks = useMemo(() => {
    const checks = [
      {
        label: '名称聚焦到一个清晰主题',
        pass: name.trim().length >= 4,
        hint: '推荐用“术数 + 问题”或“流派 + 用途”命名，例如“六爻财运判断”。',
      },
      {
        label: '描述说明用途和目标用户',
        pass: desc.trim().length >= 12,
        hint: '一句话说清这个 skill 解决什么问题，避免只写“知识库”。',
      },
      {
        label: '关键词覆盖用户问题意图',
        pass:
          normalizedKeywords.length >=
          (usageMode === 'force_injected' ? 1 : 2),
        hint: '除了术数词，再补财运、事业、婚恋这类意图词。',
      },
      {
        label: '内容拆成可复用结构',
        pass:
          usageMode === 'force_injected'
            ? contentMetrics.headingCount >= 2 ||
              contentMetrics.stepCount >= 2
            : contentMetrics.headingCount >= 3 ||
              contentMetrics.stepCount >= 2,
        hint:
          usageMode === 'force_injected'
            ? '强规则建议至少有“适用问题 + 流程/边界”两类章节。'
            : '参考知识建议至少拆成 3 个 ## 章节，方便后续检索。',
      },
      {
        label: '包含标准口径或边界提示',
        pass:
          contentMetrics.qaCount > 0 ||
          contentMetrics.hasMustRule ||
          /例如|示例|常见追问/.test(content),
        hint: '补一两个示例问答，或明确必须体现 / 不要误判的规则。',
      },
    ] as const;
    return checks;
  }, [
    content,
    contentMetrics,
    desc,
    name,
    normalizedKeywords.length,
    usageMode,
  ]);
  const qualityPassCount = qualityChecks.filter((item) => item.pass).length;
  const qualitySummary = getQualitySummary(
    qualityPassCount,
    qualityChecks.length,
  );
  const recommendedSkeleton = useMemo(
    () => getRecommendedSkeleton(usageMode),
    [usageMode],
  );
  const usageWritingTips = useMemo(
    () => getUsageWritingTips(usageMode),
    [usageMode],
  );
  const contentHealthNotes = useMemo(() => {
    const notes: string[] = [];
    if (usageMode === 'force_injected' && content.length > 2500) {
      notes.push('当前是强规则模式，正文偏长。建议只保留流程、口径和禁忌，把背景知识放到参考知识里。');
    }
    if (usageMode === 'reference_only' && contentMetrics.headingCount < 3) {
      notes.push('参考知识最好拆成更多 ## 章节，模型后续检索时会更容易命中。');
    }
    if (!contentMetrics.hasScenario) {
      notes.push('内容里最好出现“适用场景 / 适用问题 / 用户问题”之一，帮助模型知道这份 skill 何时生效。');
    }
    return notes;
  }, [content.length, contentMetrics, usageMode]);
  const isSteppedPage = variant === 'page' && flow === 'stepped';
  const currentStep = SKILL_FORM_STEPS[activeStep] ?? SKILL_FORM_STEPS[0];
  const isLastStep = activeStep === SKILL_FORM_STEPS.length - 1;
  const stepCheckGroups = useMemo(
    () => ({
      basic: qualityChecks.slice(0, 2),
      routing: [
        {
          label: '使用方式已经确认',
          pass: Boolean(usageMode),
          hint: '参考知识适合补充资料，强规则适合必须遵守的判断流程。',
        },
        qualityChecks[2],
      ],
      content: [
        {
          label: '正文不是空草稿',
          pass: content.trim().length > 0,
          hint: '至少先放入适用场景、判断流程和边界，再逐步扩写。',
        },
        qualityChecks[3],
        qualityChecks[4],
      ],
      review: qualityChecks,
    }),
    [content, qualityChecks, usageMode],
  );
  const shouldShowSection = (stepId: SkillFormStepId) =>
    !isSteppedPage || currentStep.id === stepId;

  // 是否有未保存的修改（相对于 initial）
  const isDirty = useMemo(() => {
    const src = {
      skill_name: initial?.skill_name || '',
      description: initial?.description || '',
      content: initial?.content || '',
      category: getDisplayCategory(initial?.category),
      usage_mode: initial?.usage_mode || 'reference_only',
      keywords: (initial?.match_keywords || []).join('、'),
    };
    return (
      name !== src.skill_name ||
      desc !== src.description ||
      content !== src.content ||
      category !== src.category ||
      usageMode !== src.usage_mode ||
      keywordsText !== src.keywords
    );
  }, [
    name,
    desc,
    content,
    category,
    usageMode,
    keywordsText,
    initial,
  ]);

  // ──────────────────────────────────────────────────────────
  // Learning Mode · 决策点 A
  // 用户已修改了字段（isDirty=true）但点击遮罩/ESC/关闭按钮时，该怎么处理？
  //
  // 请在下面 5-10 行内实现 handleCloseAttempt。至少 3 种策略可选：
  //   1. 直接关闭（激进，信任用户）—
  //        if (!isDirty) return onCancel(); onCancel();  // 永远直接关
  //   2. confirm 二次确认（保守）— 使用已导入的 confirmDialog:
  //        const ok = await confirmDialog({
  //          title: '放弃未保存的修改？',
  //          message: '你改过的内容将会丢失。',
  //          confirmLabel: '放弃',
  //          variant: 'danger',
  //        });
  //        if (ok) onCancel();
  //   3. 混合：文本内容 >100 字才提示；短内容直接关（省心）
  //
  // 这是典型的"数据安全 vs 交互流畅"权衡，选哪种影响所有创建/编辑技能用户。
  //
  // 当前默认：策略 2（confirm 二次确认）—— 可按你的偏好替换。
  // ──────────────────────────────────────────────────────────
  const handleCloseAttempt = async () => {
    if (!isDirty || saving) {
      onCancel();
      return;
    }
    const ok = await confirmDialog({
      title: '放弃未保存的修改？',
      message: '你改过的内容将会丢失。',
      confirmLabel: '放弃',
      cancelLabel: '继续编辑',
      variant: 'danger',
    });
    if (ok) onCancel();
  };

  const handleApplyRecommendedSkeleton = async () => {
    if (content.trim()) {
      const ok = await confirmDialog({
        title: '覆盖当前内容？',
        message: '推荐骨架会替换当前正文内容，建议先确认是否需要保留已有草稿。',
        confirmLabel: '替换',
        cancelLabel: '取消',
      });
      if (!ok) return;
    }
    setContent(recommendedSkeleton);
  };

  const handleSelectStep = (index: number) => {
    setError('');
    setActiveStep(index);
  };

  const handleStepForward = () => {
    if (currentStep.id === 'basic' && !name.trim()) {
      setError('先输入技能名称，再进入下一步');
      return;
    }

    setError('');
    setActiveStep((prev) => Math.min(prev + 1, SKILL_FORM_STEPS.length - 1));
  };

  const handleStepBack = () => {
    setError('');
    setActiveStep((prev) => Math.max(prev - 1, 0));
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError('请输入技能名称');
      setActiveStep(0);
      return;
    }

    setSaving(true);
    setError('');
    try {
      await onSave({
        skill_name: name.trim(),
        description: desc.trim(),
        content: content,
        category: category.trim() || '通用',
        usage_mode: usageMode,
        match_keywords: normalizedKeywords,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full h-11 px-3.5 rounded-xl border border-hairline bg-canvas text-[13px] placeholder:text-muted focus:border-primary focus:ring-2 focus:ring-primary/15 focus:outline-none focus:shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-primary)_8%,transparent)] transition-all duration-200';

  const guideSidebar = (
    <div className="space-y-4">
      <GuideCard icon={Gauge} title="实时质量评估">
        <div className="rounded-2xl border border-hairline bg-surface-card p-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-[13px] font-semibold">{qualitySummary.label}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted">
                {qualitySummary.desc}
              </p>
            </div>
            <div
              className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                qualitySummary.tone === 'emerald'
                  ? 'bg-emerald-500/12 text-emerald-400'
                  : qualitySummary.tone === 'amber'
                    ? 'bg-amber-500/12 text-amber-400'
                    : 'bg-red-500/12 text-red-400'
              }`}
            >
              {qualityPassCount}/{qualityChecks.length}
            </div>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-cream-strong">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                qualitySummary.tone === 'emerald'
                  ? 'bg-emerald-400'
                  : qualitySummary.tone === 'amber'
                    ? 'bg-amber-400'
                    : 'bg-red-400'
              }`}
              style={{
                width: `${(qualityPassCount / qualityChecks.length) * 100}%`,
              }}
            />
          </div>
        </div>
        <div className="mt-3 space-y-2">
          {qualityChecks.map((item) => (
            <div
              key={item.label}
              className="rounded-xl border border-hairline bg-surface-card px-3 py-2.5"
            >
              <div className="flex items-start gap-2">
                <div
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                    item.pass
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : 'bg-surface-cream-strong text-muted'
                  }`}
                >
                  {item.pass ? <BadgeCheck size={12} /> : <Check size={12} />}
                </div>
                <div>
                  <p className="text-[12px] font-medium">{item.label}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">
                    {item.hint}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </GuideCard>

      <GuideCard icon={ListChecks} title="当前模式怎么写更好">
        <div className="rounded-2xl border border-hairline bg-surface-card px-3 py-3">
          <p className="text-[12px] font-medium">
            {usageMode === 'force_injected' ? '强规则写法' : '参考知识写法'}
          </p>
          <div className="mt-2 space-y-2 text-[11px] leading-relaxed text-muted">
            {usageWritingTips.map((tip) => (
              <p key={tip}>{tip}</p>
            ))}
          </div>
        </div>
        {contentHealthNotes.length > 0 && (
          <div className="mt-3 rounded-2xl border border-amber-500/20 bg-amber-500/8 px-3 py-3">
            <p className="text-[12px] font-medium text-amber-300">当前内容提醒</p>
            <div className="mt-2 space-y-2 text-[11px] leading-relaxed text-amber-100/85">
              {contentHealthNotes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          </div>
        )}
      </GuideCard>

      <GuideCard icon={Wand2} title="推荐骨架">
        <div className="rounded-2xl border border-hairline bg-surface-card px-3 py-3">
          <p className="text-[11px] leading-relaxed text-muted">
            推荐先用骨架搭出场景、流程和边界，再补具体规则或案例，成品会稳定很多。
          </p>
          <button
            type="button"
            onClick={handleApplyRecommendedSkeleton}
            className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-hairline px-3 text-[12px] font-medium text-ink transition-colors hover:bg-surface-cream-strong sm:w-auto"
          >
            <Wand2 size={13} />
            插入推荐骨架
          </button>
          <pre className="mt-3 overflow-x-auto rounded-xl bg-canvas/70 p-3 text-[10px] leading-relaxed text-muted">
            <code>{recommendedSkeleton}</code>
          </pre>
        </div>
      </GuideCard>

      <GuideCard icon={Lightbulb} title="关键词与结构建议">
        <div className="rounded-2xl border border-hairline bg-surface-card px-3 py-3">
          <p className="text-[12px] font-medium">推荐补充的关键词</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {keywordExamples.length > 0 ? (
              keywordExamples.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() =>
                    setKeywordsText((prev) =>
                      prev.trim() ? `${prev}、${item}` : item,
                    )
                  }
                  className="whitespace-nowrap rounded-full border border-hairline bg-canvas/70 px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-ink"
                >
                  {item}
                </button>
              ))
            ) : (
              <span className="text-[11px] text-muted">
                当前关键词已经覆盖得不错了，可以再检查是否补齐了用户提问意图。
              </span>
            )}
          </div>
          <div className="mt-3 rounded-xl bg-canvas/70 px-3 py-2.5 text-[11px] leading-relaxed text-muted">
            当前结构：{contentMetrics.headingCount} 个二级标题 ·{' '}
            {contentMetrics.stepCount} 个步骤段 · {contentMetrics.qaCount} 个
            问答示例 · {contentMetrics.bulletCount} 条要点
          </div>
        </div>
      </GuideCard>

      <GuideCard icon={BookText} title="常见误区">
        <div className="space-y-2 text-[11px] leading-relaxed text-muted">
          <div className="rounded-xl border border-hairline bg-surface-card px-3 py-2.5">
            只写一大段背景介绍，不拆 ## 章节。这样模型后续检索时很容易漏读重点。
          </div>
          <div className="rounded-xl border border-hairline bg-surface-card px-3 py-2.5">
            关键词只写“六爻、八字”这类术数词，没写“财运、事业、婚恋”这些问题意图。
          </div>
          <div className="rounded-xl border border-hairline bg-surface-card px-3 py-2.5">
            强规则模式写成整本手册。强规则应该短、硬、可执行，把长知识留给参考知识。
          </div>
        </div>
      </GuideCard>
    </div>
  );

  const stepSidebar = (
    <div className="space-y-4">
      {currentStep.id === 'basic' && (
        <GuideCard icon={Lightbulb} title="这一步怎么写">
          <div className="space-y-2 text-[11px] leading-relaxed text-muted">
            <p className="rounded-xl border border-hairline bg-surface-card px-3 py-2.5">
              名称尽量像“六爻财运判断”这样，一眼看出术数类型和问题场景。
            </p>
            <p className="rounded-xl border border-hairline bg-surface-card px-3 py-2.5">
              描述写清“适合谁、解决什么问题、输出什么帮助”，后续匹配会更稳。
            </p>
          </div>
        </GuideCard>
      )}

      {currentStep.id === 'routing' && (
        <GuideCard icon={ListChecks} title="关键词建议">
          <div className="rounded-2xl border border-hairline bg-surface-card px-3 py-3">
            <p className="text-[11px] leading-relaxed text-muted">
              适用术数决定大方向，关键词负责覆盖用户真实会说出口的主题词。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {keywordExamples.length > 0 ? (
                keywordExamples.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() =>
                      setKeywordsText((prev) =>
                        prev.trim() ? `${prev}、${item}` : item,
                      )
                    }
                    className="whitespace-nowrap rounded-full border border-hairline bg-canvas/70 px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-ink"
                  >
                    {item}
                  </button>
                ))
              ) : (
                <span className="text-[11px] text-muted">
                  当前关键词已经覆盖得不错了。
                </span>
              )}
            </div>
          </div>
        </GuideCard>
      )}
    </div>
  );

  const footer = (
    <div className="flex flex-col gap-2.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-6 sm:py-4">
      <button
        onClick={handleCloseAttempt}
        className="h-12 w-full whitespace-nowrap rounded-xl border border-hairline px-4 text-[13px] text-muted transition-all duration-200 cursor-pointer active:bg-surface-cream-strong sm:h-10 sm:w-auto sm:px-5 sm:hover:bg-surface-cream-strong sm:hover:text-ink"
      >
        取消
      </button>
      <button
        onClick={handleSubmit}
        disabled={saving}
        className="flex h-12 w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-primary px-4 text-[13px] font-medium text-white transition-all duration-300 cursor-pointer active:opacity-80 disabled:opacity-50 sm:h-10 sm:w-auto sm:px-6 sm:hover:shadow-[0_4px_20px_color-mix(in_srgb,var(--color-primary)_35%,transparent)]"
      >
        {saving && <Loader2 size={14} className="animate-spin" />}
        {initial ? '保存' : '创建'}
      </button>
    </div>
  );

  const stepFooter = (
    <div className="flex flex-col gap-2.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-4">
      <button
        type="button"
        onClick={handleCloseAttempt}
        className="h-12 w-full whitespace-nowrap rounded-xl border border-hairline px-4 text-[13px] text-muted transition-all duration-200 hover:bg-surface-cream-strong hover:text-ink sm:h-10 sm:w-auto"
      >
        取消
      </button>
      <div className="grid grid-cols-2 gap-2.5 sm:flex sm:gap-3">
        <button
          type="button"
          onClick={handleStepBack}
          disabled={activeStep === 0 || saving}
          className="flex h-12 min-w-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-hairline px-4 text-[13px] text-muted transition-all duration-200 hover:bg-surface-cream-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-45 sm:h-10 sm:px-5"
        >
          <ChevronLeft size={14} />
          上一步
        </button>
        <button
          type="button"
          onClick={isLastStep ? handleSubmit : handleStepForward}
          disabled={saving}
          className="flex h-12 min-w-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-primary px-4 text-[13px] font-medium text-white transition-all duration-300 hover:shadow-[0_4px_20px_color-mix(in_srgb,var(--color-primary)_35%,transparent)] disabled:cursor-not-allowed disabled:opacity-50 sm:h-10 sm:px-6"
        >
          {saving ? (
            <Loader2 size={14} className="animate-spin" />
          ) : isLastStep ? (
            <ClipboardCheck size={14} />
          ) : (
            <ChevronRight size={14} />
          )}
          {isLastStep ? (initial ? '保存技能' : '创建技能') : '下一步'}
        </button>
      </div>
    </div>
  );

  const CurrentStepIcon = currentStep.icon;
  const showStepSidebar = currentStep.id === 'basic' || currentStep.id === 'routing';

  const body = (
    <div className="px-4 py-4 sm:px-6 sm:py-5">
      {error && (
        <div
          className="text-[12px] text-red-400 bg-red-400/10 border border-red-400/20 px-4 py-3 rounded-xl flex items-center gap-2.5 mb-5"
          role="alert"
        >
          <div className="w-6 h-6 rounded-lg bg-red-400/15 flex items-center justify-center shrink-0">
            <XCircle size={14} />
          </div>
          {error}
        </div>
      )}

      {variant !== 'page' && (
        <div className="mb-5 rounded-2xl border border-hairline bg-canvas/65 p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <Gauge size={15} className="text-primary" />
            实时质量评估
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            {qualitySummary.desc}
          </p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-cream-strong">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                qualitySummary.tone === 'emerald'
                  ? 'bg-emerald-400'
                  : qualitySummary.tone === 'amber'
                    ? 'bg-amber-400'
                    : 'bg-red-400'
              }`}
              style={{
                width: `${(qualityPassCount / qualityChecks.length) * 100}%`,
              }}
            />
          </div>
          <div className="mt-3 grid gap-2">
            {qualityChecks.slice(0, 3).map((item) => (
              <div key={item.label} className="text-[11px] text-muted">
                {item.pass ? '已满足' : '待补足'} · {item.label}
              </div>
            ))}
          </div>
        </div>
      )}

      {shouldShowSection('basic') && (
      <div className="mb-5 sm:mb-6">
        <div className="flex items-center gap-2 mb-3 sm:mb-4">
          <div className="w-1 h-4 rounded-full bg-primary" />
          <span className="text-[11px] sm:text-[12px] font-semibold text-ink uppercase tracking-wider">
            基础信息
          </span>
        </div>
        <div className="space-y-3 sm:space-y-4">
          <div>
            <label className="text-[11px] sm:text-[12px] font-medium text-muted mb-1.5 sm:mb-2 flex items-center gap-1.5">
              名称 <span className="text-red-400">*</span>
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={50}
              placeholder="例如：咖啡知识库"
              autoFocus
              className={inputClass}
            />
            <div className="flex justify-end items-center mt-1">
              <span className="text-[10px] text-muted tabular-nums">
                {name.length}/50
              </span>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-muted/80">
              好的命名最好同时交代术数范围和主题，例如“六爻财运判断”“紫微婚恋边界”。
            </p>
          </div>

          <div>
            <label className="text-[11px] sm:text-[12px] font-medium text-muted mb-1.5 sm:mb-2 block">
              描述
            </label>
            <input
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              maxLength={200}
              placeholder="一句话描述这个知识库的用途"
              className={inputClass}
            />
            <p className="mt-1 text-[10px] leading-relaxed text-muted/80">
              推荐写法：这个 skill 适合谁，在什么问题下使用，最终能给出什么判断或帮助。
            </p>
          </div>
        </div>
      </div>
      )}

      {shouldShowSection('routing') && (
      <div className="mb-5 sm:mb-6">
        <div className="flex items-center gap-2 mb-3 sm:mb-4">
          <div className="w-1 h-4 rounded-full bg-amber-400" />
          <span className="text-[11px] sm:text-[12px] font-semibold text-ink uppercase tracking-wider">
            匹配与使用
          </span>
        </div>
        <div className="space-y-3 sm:space-y-4">
          <div>
            <label className="text-[11px] sm:text-[12px] font-medium text-muted mb-1.5 sm:mb-2 block">
              适用术数（可选）
            </label>
            <input
              list="skill-category-suggestions"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="不选则通用，可直接输入术数类型"
              className={inputClass}
            />
            <datalist id="skill-category-suggestions">
              {categoryOptions.map((cat) => (
                <option key={cat} value={cat} />
              ))}
            </datalist>
            <p className="mt-1 text-[10px] leading-relaxed text-muted/80">
              留空会按通用技能处理；候选项只作建议，其他类别可以直接手动输入。
            </p>
          </div>

          <div>
            <label className="text-[11px] sm:text-[12px] font-medium text-muted mb-1.5 sm:mb-2 block">
              使用方式
            </label>
            <div className="flex gap-2 sm:hidden overflow-x-auto pb-1 -mx-1 px-1 scrollbar-hide">
              {SKILL_USAGE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setUsageMode(opt.value as SkillUsageMode)}
                  className={`shrink-0 h-10 px-4 rounded-xl border text-[12px] font-medium transition-all duration-200 cursor-pointer active:scale-95 ${
                    usageMode === opt.value
                      ? 'text-white'
                      : 'border-hairline text-muted'
                  }`}
                  style={
                    usageMode === opt.value
                      ? {
                          borderColor: 'transparent',
                          backgroundColor:
                            opt.color === 'emerald'
                              ? 'rgb(16 185 129)'
                              : 'rgb(239 68 68)',
                        }
                      : {}
                  }
                >
                  {opt.shortLabel}
                </button>
              ))}
            </div>
            <div className="hidden sm:grid grid-cols-1 gap-2">
              {SKILL_USAGE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setUsageMode(opt.value as SkillUsageMode)}
                  className={`w-full p-3 rounded-xl border text-left transition-all duration-200 cursor-pointer ${
                    usageMode === opt.value
                      ? ''
                      : 'border-hairline hover:border-hairline hover:bg-surface-cream-strong'
                  }`}
                  style={
                    usageMode === opt.value
                      ? {
                          borderColor:
                            opt.color === 'emerald'
                              ? 'rgb(52 211 153 / 0.5)'
                              : 'rgb(248 113 113 / 0.5)',
                          backgroundColor:
                            opt.color === 'emerald'
                              ? 'rgb(16 185 129 / 0.08)'
                              : 'rgb(239 68 68 / 0.08)',
                        }
                      : {}
                  }
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[12px] font-medium">
                        {opt.label}
                      </span>
                      <span className="text-[11px] text-muted ml-2">
                        {opt.desc}
                      </span>
                    </div>
                    {usageMode === opt.value && (
                      <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                        <Check size={12} className="text-white" />
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[11px] sm:text-[12px] font-medium text-muted mb-1.5 sm:mb-2 block">
              匹配关键词
            </label>
            <input
              value={keywordsText}
              onChange={(e) => setKeywordsText(e.target.value)}
              placeholder="用顿号分隔，如：六爻、动爻"
              className={inputClass}
            />
            <p className="mt-1 text-[10px] leading-relaxed text-muted/80">
              关键词别只写术数词，最好同时覆盖用户会问的主题词，例如“财运、事业、婚恋、应期”。
            </p>
          </div>
        </div>
      </div>
      )}

      {shouldShowSection('content') && (
      <div>
        <div className="flex items-center gap-2 mb-3 sm:mb-4">
          <div className="w-1 h-4 rounded-full bg-blue-400" />
          <span className="text-[11px] sm:text-[12px] font-semibold text-ink uppercase tracking-wider">
            知识内容
          </span>
        </div>
        <div>
          <div className="flex items-center gap-1.5 sm:gap-2 mb-2.5 sm:mb-3 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-hide">
            <button
              type="button"
              onClick={handleApplyRecommendedSkeleton}
              className="inline-flex shrink-0 h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-hairline px-3 text-[11px] text-muted transition-all duration-200 cursor-pointer active:bg-surface-cream-strong sm:h-7 sm:hover:border-primary sm:hover:bg-primary/5 sm:hover:text-ink"
            >
              <Wand2 size={12} />
              插入推荐骨架
            </button>
          </div>
          <SkillContentEditor
            content={content}
            onChange={setContent}
            skillName={name.trim()}
          />
          <div className="flex justify-end items-center mt-1.5">
            <span className="text-[10px] text-muted tabular-nums font-medium">
              {content.length.toLocaleString()} / 30,000
            </span>
          </div>
        </div>
      </div>
      )}

      {isSteppedPage && shouldShowSection('review') && (
        <div>
          <div className="flex items-center gap-2 mb-3 sm:mb-4">
            <div className="w-1 h-4 rounded-full bg-emerald-400" />
            <span className="text-[11px] sm:text-[12px] font-semibold text-ink uppercase tracking-wider">
              检查发布
            </span>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-2xl border border-hairline bg-canvas/65 p-4">
              <p className="text-[13px] font-semibold">基础信息</p>
              <dl className="mt-3 space-y-2 text-[12px] leading-relaxed">
                <div>
                  <dt className="text-muted">名称</dt>
                  <dd className="mt-0.5 break-words text-ink">
                    {name.trim() || '还没有填写'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">描述</dt>
                  <dd className="mt-0.5 break-words text-ink">
                    {desc.trim() || '还没有填写'}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="rounded-2xl border border-hairline bg-canvas/65 p-4">
              <p className="text-[13px] font-semibold">匹配与使用</p>
              <dl className="mt-3 space-y-2 text-[12px] leading-relaxed">
                <div>
                  <dt className="text-muted">适用术数</dt>
                  <dd className="mt-0.5 break-words text-ink">
                    {category.trim() || '未选择（按通用处理）'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">使用方式</dt>
                  <dd className="mt-0.5 text-ink">
                    {usageMode === 'force_injected' ? '强规则' : '参考知识'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">匹配关键词</dt>
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {normalizedKeywords.length > 0 ? (
                      normalizedKeywords.map((item) => (
                        <span
                          key={item}
                          className="rounded-full border border-hairline bg-surface-card px-2 py-0.5 text-[11px] text-muted"
                        >
                          {item}
                        </span>
                      ))
                    ) : (
                      <span className="text-ink">还没有填写</span>
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-hairline bg-canvas/65 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-[13px] font-semibold">正文预览</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted">
                  当前结构：{contentMetrics.headingCount} 个二级标题 ·{' '}
                  {contentMetrics.stepCount} 个步骤段 · {contentMetrics.qaCount}{' '}
                  个问答示例
                </p>
              </div>
              <span className="text-[10px] tabular-nums text-muted">
                {content.length.toLocaleString()} / 30,000
              </span>
            </div>
            <SkillContentPreview content={content} />
          </div>
        </div>
      )}
    </div>
  );

  if (isSteppedPage) {
    return (
      <div className="overflow-hidden rounded-[28px] border border-hairline bg-surface-card shadow-[0_24px_80px_color-mix(in_srgb,var(--color-ink)_10%,transparent)]">
        <div className="border-b border-hairline px-4 py-4 sm:px-6 sm:py-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted">
                Astro Skill Lab
              </p>
              <div className="mt-2 flex items-center gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)]">
                  <CurrentStepIcon size={16} className="text-primary" />
                </div>
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold tracking-tight">
                    {currentStep.title}
                  </h2>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-muted sm:text-[13px]">
                    第 {activeStep + 1} / {SKILL_FORM_STEPS.length} 步 ·{' '}
                    {currentStep.desc}
                  </p>
                </div>
              </div>
            </div>
            <div className="min-w-[180px]">
              <div className="flex items-center justify-between text-[11px] text-muted">
                <span>整体完成度</span>
                <span>
                  {qualityPassCount}/{qualityChecks.length}
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-cream-strong">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    qualitySummary.tone === 'emerald'
                      ? 'bg-emerald-400'
                      : qualitySummary.tone === 'amber'
                        ? 'bg-amber-400'
                        : 'bg-red-400'
                  }`}
                  style={{
                    width: `${(qualityPassCount / qualityChecks.length) * 100}%`,
                  }}
                />
              </div>
            </div>
          </div>

          <div className="mt-4 flex gap-2 overflow-x-auto pb-1 scrollbar-hide snap-x snap-mandatory">
            {SKILL_FORM_STEPS.map((step, index) => {
              const Icon = step.icon;
              const checks = stepCheckGroups[step.id];
              const passCount = checks.filter((item) => item.pass).length;
              const active = currentStep.id === step.id;

              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => handleSelectStep(index)}
                  aria-current={active ? 'step' : undefined}
                  className={`flex min-w-[136px] snap-start items-center gap-2 rounded-2xl border px-3 py-2.5 text-left transition-all duration-200 sm:min-w-[150px] ${
                    active
                      ? 'border-primary bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] text-ink'
                      : 'border-hairline text-muted hover:bg-surface-cream-strong hover:text-ink'
                  }`}
                >
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
                      active
                        ? 'bg-primary text-white'
                        : 'bg-canvas text-muted'
                    }`}
                  >
                    <Icon size={15} />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-[12px] font-medium">{step.label}</p>
                    <p className="mt-0.5 text-[10px] tabular-nums opacity-80">
                      {passCount}/{checks.length} 已完成
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        <div
          className={
            showStepSidebar
              ? 'lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-6 lg:px-6 lg:py-5'
              : 'lg:px-6 lg:py-5'
          }
        >
          <div>{body}</div>
          {showStepSidebar && (
            <aside className="mt-5 px-4 pb-5 sm:px-6 lg:mt-0 lg:sticky lg:top-6 lg:self-start lg:px-0 lg:pb-0">
              {stepSidebar}
            </aside>
          )}
        </div>
        <div className="border-t border-hairline bg-[color-mix(in_srgb,var(--color-surface-card)_70%,var(--color-canvas))]">
          {stepFooter}
        </div>
      </div>
    );
  }

  if (variant === 'page') {
    return (
      <div className="overflow-hidden rounded-[28px] border border-hairline bg-surface-card shadow-[0_24px_80px_color-mix(in_srgb,var(--color-ink)_10%,transparent)]">
        <div className="border-b border-hairline px-5 py-5 sm:px-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted">
            Astro Skill Lab
          </p>
          <h2 className="mt-2 text-lg font-semibold tracking-tight">
            {initial ? '编辑术数技能' : '开发术数技能'}
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            用更完整的页面完成术数定位、触发路由和解读内容配置。
          </p>
        </div>
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-6 lg:px-6 lg:py-5">
          <div>{body}</div>
          <aside className="mt-5 lg:mt-0 lg:sticky lg:top-6 lg:self-start">
            {guideSidebar}
          </aside>
        </div>
        <div className="border-t border-hairline bg-[color-mix(in_srgb,var(--color-surface-card)_70%,var(--color-canvas))]">
          {footer}
        </div>
      </div>
    );
  }

  return (
    <BottomSheet
      open
      onClose={handleCloseAttempt}
      variant="fullscreen-sheet"
      size="md"
      title={initial ? '编辑知识库' : '创建知识库'}
      aria-label={initial ? '编辑技能' : '创建技能'}
      footer={footer}
    >
      {body}
    </BottomSheet>
  );
}
