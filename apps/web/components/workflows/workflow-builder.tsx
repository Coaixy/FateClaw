'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronDown,
  ChevronUp,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { skillsApi } from '@/features/skills/api';
import {
  workflowsApi,
  type WorkflowDefinition,
  type WorkflowStepInput,
} from '@/features/workflows/api';
import { ApiError } from '@/lib/http/client';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

/** 可选术数(排盘步)。值为后端 skillDir,标签为卦师可读名。 */
const PAIPAN_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'bazi-paipan', label: '八字' },
  { value: 'ziwei-paipan', label: '紫微斗数' },
  { value: 'iching-paipan', label: '六爻' },
  { value: 'meihua-paipan', label: '梅花易数' },
  { value: 'liuren-paipan', label: '大六壬' },
  { value: 'qimen-paipan', label: '奇门遁甲' },
  { value: 'jingzhan-paipan', label: '经占' },
];

type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

interface DraftPaipanStep {
  key: string;
  id: string;
  type: 'paipan';
  title: string;
  pauseAfter: boolean;
  skill: string;
  inputDefaults: Record<string, unknown>;
}

interface DraftAiStep {
  key: string;
  id: string;
  type: 'ai';
  title: string;
  pauseAfter: boolean;
  promptTemplate: string;
  skillIds: string[];
  modelPolicy: {
    mode: 'system-default' | 'user-current';
    thinkingLevel: ThinkingLevel;
  };
}

type DraftStep = DraftPaipanStep | DraftAiStep;

/** 步骤可更新字段补丁(去掉 type/key 判别字段,避免两类步骤交叉时 type 冲突成 never)。 */
type StepPatch = Partial<Omit<DraftPaipanStep, 'type' | 'key'>> &
  Partial<Omit<DraftAiStep, 'type' | 'key'>>;

interface OwnSkill {
  id: string;
  name: string;
}

/** 生成稳定且仅含 [A-Za-z0-9] 的步骤 id(后端约定 stepId 不能含 '-')。 */
function newStepId(): string {
  return `s${Math.random().toString(36).slice(2, 9)}`;
}

function reactKey(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 把后端定义的步骤转成可编辑草稿(编辑模式用)。 */
function toDraft(workflow: WorkflowDefinition): DraftStep[] {
  return workflow.steps.map((step) => {
    if (step.type === 'paipan') {
      return {
        key: reactKey(),
        id: step.id,
        type: 'paipan',
        title: step.title,
        pauseAfter: step.pauseAfter,
        skill: step.skill,
        inputDefaults: step.inputDefaults ?? {},
      };
    }
    const mode =
      step.modelPolicy?.mode === 'user-current'
        ? 'user-current'
        : 'system-default';
    const thinkingLevel = (step.modelPolicy?.thinkingLevel ??
      'medium') as ThinkingLevel;
    return {
      key: reactKey(),
      id: step.id,
      type: 'ai',
      title: step.title,
      pauseAfter: step.pauseAfter,
      promptTemplate: step.promptTemplate,
      skillIds: step.skillIds ?? [],
      modelPolicy: { mode, thinkingLevel },
    };
  });
}

/**
 * 工作流搭建器:创建/编辑一个多步线性工作流。
 *
 * @param props.mode create=新建,edit=编辑。
 * @param props.workflowId 编辑模式下的工作流 id。
 * @param props.initial 编辑模式下的初始定义。
 */
export function WorkflowBuilder({
  mode,
  workflowId,
  initial,
}: {
  mode: 'create' | 'edit';
  workflowId?: string;
  initial?: WorkflowDefinition;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const { toast } = useToast();

  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [steps, setSteps] = useState<DraftStep[]>(
    initial ? toDraft(initial) : [],
  );
  const [ownSkills, setOwnSkills] = useState<OwnSkill[]>([]);
  const [saving, setSaving] = useState(false);

  // 拉取卦师自己的技能,供 AI 步绑定。
  useEffect(() => {
    let cancelled = false;
    skillsApi
      .userList()
      .then((res) => {
        if (cancelled) return;
        setOwnSkills(
          res.own
            .filter((skill) => skill.install_status === 'installed')
            .map((skill) => ({ id: skill.id, name: skill.skill_name })),
        );
      })
      .catch(() => {
        /* 技能拉取失败不阻断搭建,仅 AI 步无法绑定 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateStep = useCallback(
    (key: string, patch: StepPatch) => {
      setSteps((prev) =>
        prev.map((step) =>
          step.key === key ? ({ ...step, ...patch } as DraftStep) : step,
        ),
      );
    },
    [],
  );

  const addPaipanStep = useCallback(() => {
    setSteps((prev) => [
      ...prev,
      {
        key: reactKey(),
        id: newStepId(),
        type: 'paipan',
        title: '',
        pauseAfter: false,
        skill: '',
        inputDefaults: {},
      },
    ]);
  }, []);

  const addAiStep = useCallback(() => {
    setSteps((prev) => [
      ...prev,
      {
        key: reactKey(),
        id: newStepId(),
        type: 'ai',
        title: '',
        pauseAfter: true,
        promptTemplate: '',
        skillIds: [],
        modelPolicy: { mode: 'system-default', thinkingLevel: 'medium' },
      },
    ]);
  }, []);

  const removeStep = useCallback((key: string) => {
    setSteps((prev) => prev.filter((step) => step.key !== key));
  }, []);

  const moveStep = useCallback((index: number, delta: number) => {
    setSteps((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast('error', t('workflows.builder.errNeedName'));
      return;
    }
    if (steps.length === 0) {
      toast('error', t('workflows.builder.errNeedStep'));
      return;
    }
    for (const step of steps) {
      if (step.type === 'paipan' && !step.skill) {
        toast('error', t('workflows.builder.errPaipanSkill'));
        return;
      }
      if (step.type === 'ai' && !step.promptTemplate.trim()) {
        toast('error', t('workflows.builder.errAiPrompt'));
        return;
      }
    }

    // 草稿 → 上行 DTO(AI 步不带 skillSnapshotIds,由服务端保存时生成)。
    const payloadSteps: WorkflowStepInput[] = steps.map((step) => {
      const title = step.title.trim() || defaultStepTitle(step, t);
      if (step.type === 'paipan') {
        return {
          id: step.id,
          type: 'paipan',
          title,
          pauseAfter: step.pauseAfter,
          skill: step.skill,
          inputDefaults: step.inputDefaults,
        };
      }
      return {
        id: step.id,
        type: 'ai',
        title,
        pauseAfter: step.pauseAfter,
        promptTemplate: step.promptTemplate.trim(),
        skillIds: step.skillIds,
        modelPolicy: step.modelPolicy,
      };
    });

    setSaving(true);
    try {
      const payload = {
        name: trimmedName,
        description: description.trim(),
        steps: payloadSteps,
        enabled,
      };
      if (mode === 'edit' && workflowId) {
        await workflowsApi.update(workflowId, payload);
      } else {
        await workflowsApi.create(payload);
      }
      toast('success', t('workflows.builder.saved'));
      router.push('/workflows');
    } catch (error) {
      toast(
        'error',
        error instanceof ApiError ? error.message : t('workflows.loadError'),
      );
    } finally {
      setSaving(false);
    }
  }, [
    name,
    description,
    enabled,
    steps,
    mode,
    workflowId,
    router,
    t,
    toast,
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight text-ink">
          {mode === 'edit'
            ? t('workflows.builder.editTitle')
            : t('workflows.builder.newTitle')}
        </h1>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => router.push('/workflows')}>
            {t('workflows.builder.cancel')}
          </Button>
          <Button onClick={handleSave} loading={saving}>
            {t('workflows.builder.save')}
          </Button>
        </div>
      </header>

      {/* 基本信息 */}
      <section className="space-y-4 rounded-2xl border border-hairline bg-surface-card p-5">
        <Field label={t('workflows.builder.name')}>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('workflows.builder.namePlaceholder')}
            maxLength={60}
            className={inputClass}
          />
        </Field>
        <Field label={t('workflows.builder.description')}>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('workflows.builder.descriptionPlaceholder')}
            rows={2}
            maxLength={500}
            className={`${inputClass} resize-none`}
          />
        </Field>
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="h-4 w-4 accent-[var(--primary)]"
          />
          {t('workflows.builder.enabled')}
        </label>
      </section>

      {/* 步骤 */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">
            {t('workflows.builder.stepsTitle')}
          </h2>
          <div className="flex items-center gap-2">
            <button type="button" onClick={addPaipanStep} className={addBtnClass}>
              <Plus size={13} /> {t('workflows.builder.addPaipan')}
            </button>
            <button type="button" onClick={addAiStep} className={addBtnClass}>
              <Plus size={13} /> {t('workflows.builder.addAi')}
            </button>
          </div>
        </div>

        {steps.map((step, index) => (
          <StepCard
            key={step.key}
            step={step}
            index={index}
            total={steps.length}
            priorSteps={steps.slice(0, index)}
            ownSkills={ownSkills}
            onChange={(patch) => updateStep(step.key, patch)}
            onRemove={() => removeStep(step.key)}
            onMove={(delta) => moveStep(index, delta)}
          />
        ))}
      </section>
    </div>
  );
}

/** 步骤未命名时的兜底标题。 */
function defaultStepTitle(
  step: DraftStep,
  t: (key: string) => string,
): string {
  return step.type === 'paipan'
    ? t('workflows.builder.paipanBadge')
    : t('workflows.builder.aiBadge');
}

function StepCard({
  step,
  index,
  total,
  priorSteps,
  ownSkills,
  onChange,
  onRemove,
  onMove,
}: {
  step: DraftStep;
  index: number;
  total: number;
  priorSteps: DraftStep[];
  ownSkills: OwnSkill[];
  onChange: (patch: StepPatch) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="rounded-2xl border border-hairline bg-surface-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
            {index + 1}
          </span>
          <span
            className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
              step.type === 'paipan'
                ? 'bg-primary/10 text-primary'
                : 'bg-success/10 text-success'
            }`}
          >
            {step.type === 'paipan'
              ? t('workflows.builder.paipanBadge')
              : t('workflows.builder.aiBadge')}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label={t('workflows.builder.moveUp')}
            className={iconBtnClass}
          >
            <ChevronUp size={15} />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            aria-label={t('workflows.builder.moveDown')}
            className={iconBtnClass}
          >
            <ChevronDown size={15} />
          </button>
          <button
            type="button"
            onClick={onRemove}
            aria-label={t('workflows.builder.removeStep')}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-error/10 hover:text-error"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="mt-3 space-y-3">
        <input
          value={step.title}
          onChange={(event) => onChange({ title: event.target.value })}
          placeholder={t('workflows.builder.stepNamePlaceholder')}
          maxLength={60}
          className={inputClass}
        />

        {step.type === 'paipan' ? (
          <Field label={t('workflows.builder.skill')}>
            <select
              value={step.skill}
              onChange={(event) => onChange({ skill: event.target.value })}
              className={inputClass}
            >
              <option value="">—</option>
              {PAIPAN_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <AiStepFields
            step={step}
            priorSteps={priorSteps}
            ownSkills={ownSkills}
            onChange={onChange}
          />
        )}

        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted">
          <input
            type="checkbox"
            checked={step.pauseAfter}
            onChange={(event) => onChange({ pauseAfter: event.target.checked })}
            className="h-3.5 w-3.5 accent-[var(--primary)]"
          />
          {t('workflows.builder.pauseAfter')}
        </label>
      </div>
    </div>
  );
}

function AiStepFields({
  step,
  priorSteps,
  ownSkills,
  onChange,
}: {
  step: DraftAiStep;
  priorSteps: DraftStep[];
  ownSkills: OwnSkill[];
  onChange: (patch: StepPatch) => void;
}) {
  const { t } = useI18n();

  const insertRef = (token: string) => {
    const base = step.promptTemplate;
    const next = base && !base.endsWith('\n') ? `${base} ${token}` : `${base}${token}`;
    onChange({ promptTemplate: next });
  };

  const toggleSkill = (skillId: string) => {
    const has = step.skillIds.includes(skillId);
    onChange({
      skillIds: has
        ? step.skillIds.filter((id) => id !== skillId)
        : [...step.skillIds, skillId],
    });
  };

  return (
    <div className="space-y-3">
      <Field label={t('workflows.builder.prompt')}>
        <textarea
          value={step.promptTemplate}
          onChange={(event) => onChange({ promptTemplate: event.target.value })}
          placeholder={t('workflows.builder.promptPlaceholder')}
          rows={4}
          className={`${inputClass} resize-y`}
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted">
            {t('workflows.builder.refHint')}
          </span>
          <button type="button" onClick={() => insertRef('{{input.question}}')} className={chipClass}>
            {t('workflows.builder.refQuestion')}
          </button>
          {priorSteps.map((prior, priorIndex) => (
            <button
              key={prior.key}
              type="button"
              onClick={() => insertRef(`{{step.${prior.id}.output}}`)}
              className={chipClass}
            >
              {t('workflows.builder.refStep', {
                title: prior.title.trim() || `#${priorIndex + 1}`,
              })}
            </button>
          ))}
        </div>
      </Field>

      <Field label={t('workflows.builder.bindSkills')}>
        {ownSkills.length === 0 ? (
          <p className="text-[12px] text-muted">
            {t('workflows.builder.noOwnSkills')}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {ownSkills.map((skill) => {
              const active = step.skillIds.includes(skill.id);
              return (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => toggleSkill(skill.id)}
                  className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[12px] transition-colors ${
                    active
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-hairline bg-canvas text-muted hover:border-primary/30'
                  }`}
                >
                  <Sparkles size={11} />
                  {skill.name}
                </button>
              );
            })}
          </div>
        )}
        <p className="mt-1.5 text-[11px] text-muted/80">
          {t('workflows.builder.bindSkillsHint')}
        </p>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('workflows.builder.model')}>
          <select
            value={step.modelPolicy.mode}
            onChange={(event) =>
              onChange({
                modelPolicy: {
                  ...step.modelPolicy,
                  mode: event.target.value as DraftAiStep['modelPolicy']['mode'],
                },
              })
            }
            className={inputClass}
          >
            <option value="system-default">
              {t('workflows.builder.modelDefault')}
            </option>
            <option value="user-current">
              {t('workflows.builder.modelCurrent')}
            </option>
          </select>
        </Field>
        <Field label={t('workflows.builder.thinking')}>
          <select
            value={step.modelPolicy.thinkingLevel}
            onChange={(event) =>
              onChange({
                modelPolicy: {
                  ...step.modelPolicy,
                  thinkingLevel: event.target.value as ThinkingLevel,
                },
              })
            }
            className={inputClass}
          >
            <option value="off">{t('workflows.builder.thinkOff')}</option>
            <option value="low">{t('workflows.builder.thinkLow')}</option>
            <option value="medium">{t('workflows.builder.thinkMid')}</option>
            <option value="high">{t('workflows.builder.thinkHigh')}</option>
            <option value="xhigh">{t('workflows.builder.thinkXHigh')}</option>
          </select>
        </Field>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[12px] font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border border-hairline bg-canvas px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none';

const addBtnClass =
  'inline-flex items-center gap-1 rounded-lg border border-hairline bg-canvas px-2.5 py-1.5 text-[12px] font-medium text-muted hover:border-primary/30 hover:text-ink';

const iconBtnClass =
  'flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-surface-cream-strong hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent';

const chipClass =
  'inline-flex items-center rounded-full border border-primary/30 bg-primary/8 px-2 py-0.5 text-[11px] text-primary hover:bg-primary/15';
