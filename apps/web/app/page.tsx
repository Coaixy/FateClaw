'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ArrowUp, Library, Sparkles, Users } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { BaguaRing, BrandSeal } from '@/components/brand/brand-marks';
import {
  PENDING_CHAT_INPUT_KEY,
  useChatSessions,
} from '@/features/chat/hooks/use-chat-sessions';
import { useI18n } from '@/lib/i18n';

/** 工作台「最近对话」区展示的会话条数上限。 */
const RECENT_SESSION_LIMIT = 5;

/**
 * 按当前小时返回时段问候语的 i18n key：5-12 点早上、12-18 点下午、其余晚上。
 */
function greetingKeyByHour(hour: number): string {
  if (hour >= 5 && hour < 12) return 'hub.greetingMorning';
  if (hour >= 12 && hour < 18) return 'hub.greetingAfternoon';
  return 'hub.greetingEvening';
}

/**
 * 主页工作台:Claude 式「时段问候 + 直接可打字的输入框」。
 * 输入内容经 PENDING_CHAT_INPUT_KEY(sessionStorage)带入 AI 对话页并回填到 composer;
 * 下方是技能开发/客户档案/命例库三个快捷入口和最近对话列表。
 */
export default function WorkspaceHubPage() {
  return (
    <AppShell>
      <HubContent />
    </AppShell>
  );
}

/**
 * 工作台正文。必须渲染在 AppShell 内,才能拿到 ChatSessionsProvider 的上下文。
 */
function HubContent() {
  const { t, formatDate } = useI18n();
  // 清空选中会话 → ChatSessionsProvider 自动跳转 /ai-chat 开新对话
  const { sessions, setSelectedSession } = useChatSessions();
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const recentSessions = useMemo(
    () =>
      [...sessions]
        .sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        )
        .slice(0, RECENT_SESSION_LIMIT),
    [sessions],
  );

  // 时段问候必须在挂载后取本地时间:静态导出的预渲染 HTML 若在渲染期读时钟,
  // 会与客户端首屏不一致导致 hydration 报错(同 use-chat-sessions 对 Date.now 的约束)。
  const [greetingKey, setGreetingKey] = useState('');
  useEffect(() => {
    setGreetingKey(greetingKeyByHour(new Date().getHours()));
  }, []);
  // 未就绪时用不换行空格占位,保持行高避免布局跳动。
  const greeting = greetingKey ? t(greetingKey) : ' ';

  /** 把草稿写入跨页通道并跳转 AI 对话页;ai-chat workspace 挂载后会回填到输入框。 */
  const startChatWithDraft = () => {
    const text = draft.trim();
    if (!text) {
      composerRef.current?.focus();
      return;
    }
    window.sessionStorage.setItem(PENDING_CHAT_INPUT_KEY, text);
    setSelectedSession('');
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文输入法组词中的 Enter 不能触发提交(isComposing 守卫)。
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      startChatWithDraft();
    }
  };

  return (
    <div className="relative mx-auto max-w-2xl">
      {/* 先天八卦环:问候区背后的环形卦符线描,命理身份的核心图形(极低透明度,不抢内容)。 */}
      <BaguaRing className="pointer-events-none absolute left-1/2 top-[-72px] h-[360px] w-[360px] -translate-x-1/2 text-primary opacity-[0.09]" />

      {/* 时段问候:文字方印 + 衬线大字,页面的仪式感起点 */}
      <div className="relative mt-4 text-center sm:mt-10">
        <BrandSeal className="mx-auto mb-5 h-12 w-12 shadow-sm" />
        <h1 className="text-4xl font-semibold tracking-tight text-ink sm:text-[42px] sm:leading-tight">
          {greeting}
        </h1>
      </div>

      {/* 输入框:浮起层白卡+暖调阴影,页面唯一的主角卡;提交即建新会话并带草稿跳转 ai-chat */}
      <div className="relative mt-7 rounded-2xl border border-hairline bg-surface-raised p-3.5 shadow-raised transition-colors focus-within:border-primary/50 sm:mt-9">
        <textarea
          ref={composerRef}
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder={t('hub.askPlaceholder')}
          className="max-h-40 w-full resize-none bg-transparent px-1.5 pt-1 text-[15px] leading-relaxed text-ink placeholder:text-muted-soft focus:outline-none"
          aria-label={t('hub.newChat')}
        />
        <div className="flex items-center justify-between pt-1">
          <span className="px-1.5 text-[11px] text-muted-soft select-none">
            {t('hub.composerHint')}
          </span>
          <button
            type="button"
            onClick={startChatWithDraft}
            disabled={!draft.trim()}
            className="btn-tactile-primary flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl text-on-primary transition-all active:scale-95 disabled:cursor-default disabled:bg-primary-disabled disabled:text-muted-soft"
            aria-label={t('hub.newChat')}
          >
            <ArrowUp size={17} strokeWidth={2.2} />
          </button>
        </div>
      </div>

      {/* 快捷入口:三张实体小卡(tactile 质感),与输入框主卡形成主次两级 */}
      <div className="relative mt-5 grid grid-cols-3 gap-2.5 sm:gap-3">
        <QuickCard
          href="/studio"
          icon={<Sparkles size={17} strokeWidth={1.8} />}
          label={t('hub.studio')}
        />
        <QuickCard
          href="/clients"
          icon={<Users size={17} strokeWidth={1.8} />}
          label={t('hub.clients')}
        />
        <QuickCard
          href="/bazi-cases"
          icon={<Library size={17} strokeWidth={1.8} />}
          label="八字命例库"
        />
      </div>

      {recentSessions.length > 0 && (
        // 与上方「问候+输入框」组拉开大间距,形成亲疏分组:输入区是一组,历史记录是另一组。
        <section className="mt-14 sm:mt-16">
          {/* 古籍栏线式标签:朱砂短竖条起头 */}
          <h2 className="flex items-center gap-2 px-1 text-[12px] font-semibold uppercase tracking-wide text-muted/80">
            <span className="h-3.5 w-[3px] rounded-full bg-primary" aria-hidden="true" />
            {t('hub.recentChats')}
          </h2>
          {/* 浮起层白卡容器 + 轻分隔线,行 hover 显背景 */}
          <div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-2xl border border-hairline bg-surface-raised">
            {recentSessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => setSelectedSession(session.id)}
                className="flex w-full items-center gap-3 border-l-2 border-transparent px-4 py-3 text-left transition-colors hover:border-primary hover:bg-surface-soft/60"
              >
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
                  {session.title}
                </span>
                <span className="shrink-0 text-[12px] tabular-nums text-muted/70">
                  {formatRecentTime(session.updated_at, t, formatDate)}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * 快捷入口小卡:图标 + 标题的实体按键卡(tactile 质感),
 * 作为输入框主卡之下的次级层,hover 时边框显主色并轻微上浮。
 */
function QuickCard({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="btn-tactile group flex flex-col items-center gap-2 rounded-xl border border-hairline bg-surface-raised px-2 py-3.5 transition-all hover:-translate-y-0.5 hover:border-primary/40 sm:flex-row sm:justify-center sm:py-3"
    >
      <span className="text-primary">{icon}</span>
      <span className="text-[12.5px] font-medium text-body group-hover:text-ink sm:text-[13px]">
        {label}
      </span>
    </Link>
  );
}

/**
 * 把会话更新时间格式化成「今天/昨天/N 天前/月日」相对文案。
 * 复用 sidebar 已有的三语键,保持站内一致。
 */
function formatRecentTime(
  ts: string,
  t: (key: string, params?: Record<string, string | number>) => string,
  formatDate: (
    value: string | number | Date,
    options?: Intl.DateTimeFormatOptions,
  ) => string,
): string {
  const date = new Date(ts);
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days === 0) return t('sidebar.today');
  if (days === 1) return t('sidebar.yesterday');
  if (days < 7) return t('sidebar.daysAgo', { days });
  return formatDate(date, { month: 'short', day: 'numeric' });
}
