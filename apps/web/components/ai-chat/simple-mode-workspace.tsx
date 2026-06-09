'use client';

import { useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  CalendarClock,
  HelpCircle,
  Send,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  simpleWorkflowsApi,
  type SimpleWorkflowStartResponse,
} from '@/features/simple-workflows/api';
import { useToast } from '@/lib/use-toast';

type SimpleModePanel = 'home' | 'divination' | 'natal';

interface SimpleModeWorkspaceProps {
  disabled?: boolean;
  chatAvailable: boolean;
  onBack: () => void;
  onAuthRequired: (draft?: string) => void;
  onStarted: (result: SimpleWorkflowStartResponse) => void;
}

function fieldClassName() {
  return 'w-full rounded-xl border border-hairline bg-surface-card px-3 py-2.5 text-[13px] text-ink outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/15 disabled:opacity-50';
}

function textareaClassName() {
  return `${fieldClassName()} min-h-[92px] resize-none leading-6`;
}

function parseTimeValue(value: string): { hour: number; minute: number } {
  const [hourText = '0', minuteText = '0'] = value.split(':');
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  return {
    hour: Number.isInteger(hour) ? hour : 0,
    minute: Number.isInteger(minute) ? minute : 0,
  };
}

function SimpleModeCard({
  icon,
  title,
  description,
  action,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex min-h-[184px] flex-col justify-between rounded-2xl border border-hairline bg-[linear-gradient(180deg,rgba(255,255,255,0.055),rgba(255,255,255,0.018))] p-4 text-left transition-all duration-200 hover:border-primary/35 hover:bg-surface-cream-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-not-allowed disabled:opacity-45 sm:p-5"
    >
      <span className="flex items-start justify-between gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/12 text-primary">
          {icon}
        </span>
        <span className="rounded-full border border-hairline bg-surface-card px-2 py-0.5 text-[10px] font-medium text-muted">
          简易
        </span>
      </span>
      <span className="mt-5 block">
        <span className="block text-[18px] font-semibold tracking-tight text-ink">
          {title}
        </span>
        <span className="mt-2 block text-[12px] leading-5 text-muted">
          {description}
        </span>
      </span>
      <span className="mt-5 inline-flex items-center gap-1.5 text-[12px] font-semibold text-primary">
        {action}
        <Send
          size={13}
          className="transition-transform duration-200 group-hover:translate-x-0.5"
        />
      </span>
    </button>
  );
}

function SimpleModeHeader({
  title,
  onBack,
}: {
  title: string;
  onBack: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onBack}
        icon={<ArrowLeft size={14} />}
        className="rounded-lg px-2.5"
      >
        返回
      </Button>
      <h2 className="text-[16px] font-semibold tracking-tight text-ink">
        {title}
      </h2>
      <span className="h-8 w-[64px]" />
    </div>
  );
}

export function SimpleModeWorkspace({
  disabled,
  chatAvailable,
  onBack,
  onAuthRequired,
  onStarted,
}: SimpleModeWorkspaceProps) {
  const { toast } = useToast();
  const [panel, setPanel] = useState<SimpleModePanel>('home');
  const [submitting, setSubmitting] = useState(false);
  const [question, setQuestion] = useState('');
  const [background, setBackground] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [birthTime, setBirthTime] = useState('08:00');
  const [gender, setGender] = useState<'男' | '女' | ''>('');
  const [questionDirection, setQuestionDirection] = useState('');

  const submitDivination = async () => {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) {
      toast('error', '请先写下你想问的事情');
      return;
    }
    if (!chatAvailable) {
      onAuthRequired(normalizedQuestion);
      return;
    }
    setSubmitting(true);
    try {
      const result = await simpleWorkflowsApi.start({
        kind: 'divination',
        question: normalizedQuestion,
        background: background.trim() || undefined,
      });
      if (result.warning) {
        toast('error', result.warning);
      }
      onStarted(result);
    } catch (error) {
      toast(
        'error',
        error instanceof Error ? error.message : '简易占卜启动失败',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const submitNatal = async () => {
    const direction = questionDirection.trim();
    if (!birthDate) {
      toast('error', '请填写有效的公历出生日期');
      return;
    }
    if (!gender) {
      toast('error', '请选择性别');
      return;
    }
    if (!direction) {
      toast('error', '请填写想看的问题方向');
      return;
    }
    if (!chatAvailable) {
      onAuthRequired(direction);
      return;
    }
    const time = parseTimeValue(birthTime);
    setSubmitting(true);
    try {
      const result = await simpleWorkflowsApi.start({
        kind: 'natal',
        solarDate: birthDate,
        hour: time.hour,
        minute: time.minute,
        gender,
        questionDirection: direction,
      });
      if (result.warning) {
        toast('error', result.warning);
      }
      onStarted(result);
    } catch (error) {
      toast(
        'error',
        error instanceof Error ? error.message : '简易命理启动失败',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (panel === 'divination') {
    return (
      <div className="space-y-3">
        <SimpleModeHeader title="占卜问事" onBack={() => setPanel('home')} />
        <div className="rounded-2xl border border-hairline bg-surface-card/65 p-4 shadow-sm sm:p-5">
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-ink">
                问题
              </span>
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                disabled={disabled || submitting}
                placeholder="例如：我该不该换工作？"
                className={textareaClassName()}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-ink">
                背景补充
              </span>
              <textarea
                value={background}
                onChange={(event) => setBackground(event.target.value)}
                disabled={disabled || submitting}
                placeholder="可简单写下当前处境、时间范围或纠结点"
                className={textareaClassName()}
              />
            </label>
            <Button
              type="button"
              size="lg"
              loading={submitting}
              disabled={disabled}
              onClick={() => void submitDivination()}
              icon={<Send size={15} />}
              className="w-full rounded-xl"
            >
              立即起卦
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (panel === 'natal') {
    return (
      <div className="space-y-3">
        <SimpleModeHeader title="命理分析" onBack={() => setPanel('home')} />
        <div className="rounded-2xl border border-hairline bg-surface-card/65 p-4 shadow-sm sm:p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-ink">
                出生日期
              </span>
              <input
                type="date"
                value={birthDate}
                onChange={(event) => setBirthDate(event.target.value)}
                disabled={disabled || submitting}
                className={fieldClassName()}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-ink">
                出生时间
              </span>
              <input
                type="time"
                value={birthTime}
                onChange={(event) => setBirthTime(event.target.value)}
                disabled={disabled || submitting}
                className={fieldClassName()}
              />
            </label>
          </div>

          <div className="mt-3">
            <span className="mb-1.5 block text-[12px] font-medium text-ink">
              性别
            </span>
            <div className="grid grid-cols-2 gap-2">
              {(['男', '女'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setGender(item)}
                  disabled={disabled || submitting}
                  className={`h-10 rounded-xl border text-[13px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-45 ${
                    gender === item
                      ? 'border-primary/45 bg-primary/12 text-primary'
                      : 'border-hairline bg-surface-card text-ink hover:border-primary/35'
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <label className="mt-3 block">
            <span className="mb-1.5 block text-[12px] font-medium text-ink">
              问题方向
            </span>
            <textarea
              value={questionDirection}
              onChange={(event) => setQuestionDirection(event.target.value)}
              disabled={disabled || submitting}
              placeholder="例如：事业方向、感情模式、近年运势"
              className={textareaClassName()}
            />
          </label>

          <Button
            type="button"
            size="lg"
            loading={submitting}
            disabled={disabled}
            onClick={() => void submitNatal()}
            icon={<Send size={15} />}
            className="mt-4 w-full rounded-xl"
          >
            开始分析
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <SimpleModeHeader title="简易模式" onBack={onBack} />
      <div className="grid gap-2.5 sm:grid-cols-2">
        <SimpleModeCard
          icon={<HelpCircle size={19} />}
          title="占卜问事"
          description="单件事、近期选择、关系走向和工作决策。"
          action="进入占卜"
          disabled={disabled || submitting}
          onClick={() => setPanel('divination')}
        />
        <SimpleModeCard
          icon={<CalendarClock size={19} />}
          title="命理分析"
          description="长期性格、事业方向、关系模式和人生阶段。"
          action="进入命理"
          disabled={disabled || submitting}
          onClick={() => setPanel('natal')}
        />
      </div>
    </div>
  );
}
