'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  ChevronDown,
  Crown,
  Globe,
  Loader2,
  Search,
  Sparkles,
} from 'lucide-react';

import { BaguaRing } from '@/components/brand/brand-marks';
import { ArtifactDebug } from '@/components/chat/artifact-debug';
import { ArtifactRenderer } from '@/components/chat/artifact-renderer';
import { ChatLoadingState } from '@/components/chat/chat-loading-state';
import { CollapsibleMessage } from '@/components/chat/collapsible-message';
import { GuashiScriptCard } from '@/components/ai-chat/guashi-script-card';
import { MessageFooter } from '@/components/chat/message-footer';
import { Message } from '@/features/chat/api';
import type { ToolResultPreviewDto } from '@fateclaw/contracts/chat';
import { useI18n } from '@/lib/i18n';
import { sanitizeToolPath } from '@/features/chat/utils/tool-path';
import {
  PAIPAN_SKILLS,
  canHostToolTraceFooter,
  formatChatCostLabels,
  formatChatDuration,
  hasFinalAssistantAfterLatestUser,
  isKnowledgeTrajectoryMessage,
  isStreamingAssistantMessage,
  isThinkingMessage,
  isTrajectoryBlockMessage,
} from '@/features/chat/utils/display';
import { parseToolContext } from '@/features/chat/utils/tool-context';
import { splitFinalTurnMarker } from '@/features/chat/utils/markers';
import { parseGuashiScript } from '@/features/chat/utils/guashi-script';

type AiChatBillingNotice = 'arrears' | 'plus-required';

export function AiChatMessageList({
  messages,
  loading,
  sending,
  progressLabel,
  replySlow,
  onRetry,
  selectedSession,
  switchingSession,
  showCenteredComposer,
  latestMessageNotice,
  loadingOlder,
  composer,
  emptyStateTitle,
  emptyStateDescription,
  emptyStateHint,
  emptyStateFrameClassName,
  emptyStateMaxWidthClassName,
}: {
  messages: Message[];
  loading: boolean;
  sending: boolean;
  progressLabel: string | null;
  /** WS 长时间静默时为 true，驱动"回复较慢"提示 + 重试入口。 */
  replySlow?: boolean;
  onRetry?: () => void;
  selectedSession: string;
  switchingSession: boolean;
  showCenteredComposer: boolean;
  latestMessageNotice?: AiChatBillingNotice | null;
  loadingOlder?: boolean;
  composer: React.ReactNode;
  emptyStateTitle?: string;
  emptyStateDescription?: string;
  emptyStateHint?: string;
  emptyStateFrameClassName?: string;
  emptyStateMaxWidthClassName?: string;
}) {
  const { t } = useI18n();
  const latestMessageNoticeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!latestMessageNotice) return;

    const frame = window.requestAnimationFrame(() => {
      latestMessageNoticeRef.current?.scrollIntoView({ block: 'nearest' });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [latestMessageNotice]);

  if (showCenteredComposer) {
    const title = emptyStateTitle ?? t('aiChat.empty.defaultTitle');
    const description =
      emptyStateDescription ?? t('aiChat.empty.defaultDescription');
    const hint =
      emptyStateHint ??
      (selectedSession
        ? t('aiChat.empty.selectedHint')
        : t('aiChat.empty.newHint'));

    return (
      <div
        className={`flex h-full flex-col items-center px-3 ${
          emptyStateFrameClassName ?? 'justify-center'
        }`}
      >
        <div
          className={`w-full ${emptyStateMaxWidthClassName ?? 'max-w-xl'} flex flex-col items-center gap-3.5`}
        >
          {/* 空态图形对齐首页:同款先天八卦环,建立跨页面统一的品牌图形语言。 */}
          <BaguaRing className="mb-2 h-24 w-24 text-primary opacity-[0.22]" />
          {(title || description) && (
            <div className="text-center space-y-1">
              {title && (
                <h1 className="font-display text-[22px] sm:text-[26px] lg:text-[28px] font-semibold tracking-tight text-ink">
                  {title}
                </h1>
              )}
              {description && (
                <p className="text-[12px] sm:text-[13px] text-muted">
                  {description}
                </p>
              )}
            </div>
          )}
          <div className="w-full">{composer}</div>
          {hint && (
            <p className="text-center text-[10px] sm:text-[11px] text-muted/50 select-none">
              {hint}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (loading && messages.length === 0 && !sending) {
    return <ChatLoadingState count={3} />;
  }

  if (switchingSession) {
    return <ChatLoadingState count={4} />;
  }

  const { rows, pendingTrajectory } = buildDisplayRows(messages);
  const hasStreamingAssistantMessage = messages.some(
    isStreamingAssistantMessage,
  );
  const hasThinkingMessage = messages.some(isThinkingMessage);
  const hasCompletedAssistantTurn = hasFinalAssistantAfterLatestUser(messages);
  // 回答正文还没开始流式输出时，把"挂起的过程时间线 + 思考中"作为流式态展示；
  // 一旦回答开始流式（streaming 消息成为 host），过程块会上移挂到回答上方，此处不再显示。
  const showStreamingTrajectory =
    !hasCompletedAssistantTurn &&
    sending &&
    !hasStreamingAssistantMessage &&
    (pendingTrajectory.length > 0 || !hasThinkingMessage);

  return (
    <div className="px-1.5 lg:px-3 space-y-2.5 lg:space-y-3">
      {loadingOlder && (
        <div className="flex justify-center py-1.5">
          <Loader2 size={15} className="animate-spin text-muted" />
        </div>
      )}
      {rows.map((row, index) =>
        row.trajectoryOnly ? (
          <div
            key={row.message.id}
            className="max-w-2xl mx-auto flex justify-start animate-message-in"
          >
            <div className="flex min-w-0 max-w-[88%] flex-col items-start sm:max-w-[78%]">
              <TrajectoryTimeline blocks={row.trajectory} completed />
            </div>
          </div>
        ) : (
          <AiChatMessageRow
            key={row.message.id}
            message={row.message}
            trajectory={row.trajectory}
            animationIndex={index}
          />
        ),
      )}

      {rows.length > 0 && latestMessageNotice && (
        <LatestMessageBillingNotice
          notice={latestMessageNotice}
          containerRef={latestMessageNoticeRef}
        />
      )}

      {showStreamingTrajectory && (
        <StreamingTrajectory
          progressLabel={progressLabel}
          pendingTrajectory={pendingTrajectory}
        />
      )}

      {sending && replySlow && onRetry && (
        <ReplySlowNotice onRetry={onRetry} />
      )}
    </div>
  );
}

type DisplayRow = {
  message: Message;
  trajectory: Message[];
  trajectoryOnly?: boolean;
};

/**
 * 把扁平消息列表按 assistant 回合归并：思考 / 工具调用 / 知识检索这些「过程块」
 * 收束到紧随其后的真实回答上方，渲染为左侧穿插时间线（Claude web 风格）。
 *
 * @returns rows 为可渲染行；pendingTrajectory 为尾部尚未等到回答的过程块（流式态用）。
 */
function buildDisplayRows(messages: Message[]) {
  const rows: DisplayRow[] = [];
  let pending: Message[] = [];

  // 极少数情况下过程块后面直接来了用户消息（没有回答），单独成一行避免丢失。
  const flushPendingAsRow = () => {
    if (pending.length === 0) return;
    rows.push({
      message: pending[pending.length - 1],
      trajectory: pending,
      trajectoryOnly: true,
    });
    pending = [];
  };

  for (const message of messages) {
    if (message.is_bot_message && isTrajectoryBlockMessage(message)) {
      pending = [...pending, message];
      continue;
    }

    if (!message.is_bot_message) {
      flushPendingAsRow();
      rows.push({ message, trajectory: [] });
      continue;
    }

    // 真实 AI 回答：把它上方累积的过程块挂上来。
    const canHost = canHostToolTraceFooter(message);
    rows.push({ message, trajectory: canHost ? pending : [] });
    if (canHost) {
      pending = [];
    }
  }

  return { rows, pendingTrajectory: pending };
}

function LatestMessageBillingNotice({
  notice,
  containerRef,
}: {
  notice: AiChatBillingNotice;
  containerRef: React.Ref<HTMLDivElement>;
}) {
  const { t } = useI18n();
  const isArrears = notice === 'arrears';
  const titleKey = isArrears
    ? 'aiChat.messageList.billingNoticeArrearsTitle'
    : 'aiChat.messageList.billingNoticePlusTitle';
  const descriptionKey = isArrears
    ? 'aiChat.messageList.billingNoticeArrearsDescription'
    : 'aiChat.messageList.billingNoticePlusDescription';

  return (
    <div
      ref={containerRef}
      className="max-w-2xl mx-auto flex justify-start animate-message-in"
    >
      <div className="flex min-w-0 max-w-[88%] flex-col items-start sm:max-w-[78%]">
        <div
          role="status"
          aria-live="polite"
          className={`max-w-full rounded-xl border px-3 py-2 shadow-sm ${
            isArrears
              ? 'border-error/25 bg-error/8 text-error'
              : 'border-primary/25 bg-primary/8 text-primary'
          }`}
        >
          <div className="flex items-start gap-2">
            <AlertCircle
              size={15}
              strokeWidth={1.8}
              aria-hidden="true"
              className="mt-1 shrink-0"
            />
            <div className="min-w-0">
              <p className="text-[12px] font-semibold leading-5">
                {t(titleKey)}
              </p>
              <p className="mt-0.5 text-[12px] leading-5 text-ink/70">
                {t(descriptionKey)}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Link
                  href="/membership"
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-medium text-on-primary shadow-sm transition-colors hover:bg-primary-active"
                >
                  <Crown size={12} aria-hidden="true" />
                  {t(
                    isArrears
                      ? 'aiChat.messageList.membershipCenter'
                      : 'aiChat.messageList.openPlus',
                  )}
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function shouldShowWalletRecovery(content: string) {
  return /余额已欠费|积分已欠费|充值后继续使用|补充积分后继续使用|余额不足|积分不足|欠费/.test(
    content,
  );
}

function AiChatMessageRow({
  message,
  trajectory,
  animationIndex,
}: {
  message: Message;
  trajectory: Message[];
  animationIndex: number;
}) {
  const { locale, t } = useI18n();
  const isBot = !!message.is_bot_message;
  const messageMetadata =
    !!message.metadata &&
    typeof message.metadata === 'object' &&
    !Array.isArray(message.metadata)
      ? message.metadata
      : null;
  const isErrorMessage = isBot && messageMetadata?.kind === 'error';
  const isFinalMessage = messageMetadata?.kind === 'final' || isErrorMessage;
  const { body: displayContent } = isBot
    ? splitFinalTurnMarker(message.content)
    : { body: message.content };
  // 话术稿分节卡片:仅对「最终解读」消息尝试解析;命中才渲染卡片,否则回退普通 Markdown
  // (普通追问/澄清类回复不套卡片)。
  const guashiScript =
    isBot && isFinalMessage && !isErrorMessage
      ? parseGuashiScript(displayContent)
      : null;
  const durationLabel = isBot
    ? formatChatDuration(messageMetadata?.duration_ms, t)
    : null;
  const costLabels = isBot ? formatChatCostLabels(messageMetadata, locale, t) : [];
  const toolContext = isBot ? parseToolContext(message.tool_context) : [];
  const hasChart =
    isBot && toolContext.some((entry) => PAIPAN_SKILLS.has(entry.skill));
  const showWalletRecovery =
    isErrorMessage && shouldShowWalletRecovery(displayContent);
  // 过程时间线展示在回答上方（Claude web 风格）；回答为最终态时把仍在「运行中」的工具收尾。
  const trajectoryNode =
    isBot && trajectory.length > 0 ? (
      <TrajectoryTimeline blocks={trajectory} completed={isFinalMessage} />
    ) : null;
  const messageColumnClass = guashiScript
    ? 'w-full max-w-full items-stretch sm:max-w-[92%]'
    : isBot
      ? 'max-w-[88%] items-start sm:max-w-[78%]'
      : 'max-w-[88%] items-end sm:max-w-[74%]';

  if (hasChart && !isFinalMessage) {
    return (
      <div
        className="w-full max-w-6xl mx-auto animate-message-in"
        style={{ animationDelay: `${Math.min(animationIndex * 50, 200)}ms` }}
      >
        {trajectoryNode && <div className="mb-2">{trajectoryNode}</div>}
        <ArtifactRenderer entries={toolContext} />
        <ArtifactDebug entries={toolContext} />
        <MessageFooter
          isBot={isBot}
          durationLabel={durationLabel}
          costLabels={costLabels}
        />
      </div>
    );
  }

  return (
    <div
      className={`max-w-2xl mx-auto flex animate-message-in ${
        isBot ? 'justify-start' : 'justify-end'
      }`}
      style={{ animationDelay: `${Math.min(animationIndex * 50, 200)}ms` }}
    >
      <div
        className={`flex min-w-0 flex-col ${messageColumnClass}`}
      >
        {trajectoryNode && <div className="mb-2 w-full">{trajectoryNode}</div>}

        <div
          className={`group relative max-w-full ${
            guashiScript ? 'w-full' : ''
          }`}
        >
          <div
            role={isErrorMessage ? 'alert' : undefined}
            className={`rounded-xl px-3.5 py-2.5 text-[14px] leading-7 transition-shadow duration-200 ${
              isBot
                ? isErrorMessage
                  ? 'border border-error/30 bg-error/8 text-error shadow-sm'
                  : 'bg-surface-card border border-hairline shadow-sm hover:shadow-md'
                : 'bg-surface-dark text-on-dark shadow-sm'
            }`}
          >
            {guashiScript ? (
              <GuashiScriptCard script={guashiScript} />
            ) : (
              <CollapsibleMessage content={displayContent} isBot={isBot} />
            )}
          </div>
          {showWalletRecovery ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Link
                href="/membership"
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-medium text-on-primary shadow-sm transition-colors hover:bg-primary-active"
              >
                <Crown size={12} />
                {t('aiChat.messageList.membershipCenter')}
              </Link>
            </div>
          ) : null}
        </div>

        {isBot && !isFinalMessage && toolContext.length > 0 && (
          <div className="w-full max-w-full sm:max-w-[90%] mt-1">
            <ArtifactRenderer entries={toolContext} />
            <ArtifactDebug entries={toolContext} />
          </div>
        )}

        <MessageFooter
          isBot={isBot}
          durationLabel={durationLabel}
          costLabels={costLabels}
        />
      </div>
    </div>
  );
}

type ToolTraceStatus = 'running' | 'completed' | 'failed' | undefined;

type TrajectoryNode =
  | { id: string; type: 'thinking'; content: string }
  | {
      id: string;
      type: 'tool';
      label: string;
      query?: string;
      path?: string;
      status: ToolTraceStatus;
      result?: ToolResultPreviewDto | null;
    }
  | { id: string; type: 'knowledge'; text: string; stage?: string };

function readMetadataRecord(message: Message): Record<string, unknown> | null {
  return message.metadata &&
    typeof message.metadata === 'object' &&
    !Array.isArray(message.metadata)
    ? (message.metadata as Record<string, unknown>)
    : null;
}

/** 把一条过程消息解析成时间线节点视图模型。 */
function readTrajectoryNode(message: Message): TrajectoryNode {
  const metadata = readMetadataRecord(message);

  if (isThinkingMessage(message)) {
    return { id: message.id, type: 'thinking', content: message.content };
  }

  if (isKnowledgeTrajectoryMessage(message)) {
    return {
      id: message.id,
      type: 'knowledge',
      text: message.content,
      stage: typeof metadata?.stage === 'string' ? metadata.stage : undefined,
    };
  }

  const rawStatus = metadata?.tool_status;
  const status: ToolTraceStatus =
    rawStatus === 'running' || rawStatus === 'completed' || rawStatus === 'failed'
      ? rawStatus
      : undefined;
  const result =
    metadata?.tool_result &&
    typeof metadata.tool_result === 'object' &&
    !Array.isArray(metadata.tool_result)
      ? (metadata.tool_result as ToolResultPreviewDto)
      : null;

  return {
    id: message.id,
    type: 'tool',
    label:
      (typeof metadata?.tool_name === 'string' && metadata.tool_name) ||
      (typeof metadata?.tool_label === 'string' && metadata.tool_label) ||
      'tool',
    query:
      typeof metadata?.query_text === 'string' ? metadata.query_text : undefined,
    path:
      typeof metadata?.tool_path === 'string'
        ? sanitizeToolPath(metadata.tool_path)
        : undefined,
    status,
    result,
  };
}

/**
 * assistant 回合的过程时间线：左侧竖线 + 图标节点，思考/工具/检索按时序穿插。
 *
 * @param blocks 过程消息（思考 / 工具调用 / 知识检索），保持原始顺序。
 * @param completed 回答已是最终态时，把仍标记「运行中」的工具按完成展示。
 */
type ThinkingNode = Extract<TrajectoryNode, { type: 'thinking' }>;
type TrajectoryChildNode = Exclude<TrajectoryNode, { type: 'thinking' }>;
type TrajectoryGroup = {
  thinking: ThinkingNode | null;
  children: TrajectoryChildNode[];
};

/**
 * 按思考分组：每个思考块是一组的父级，其后的工具/检索作为子内容挂在该思考下
 * （层级上思考 > 工具）。思考之前出现的工具/检索归入一个无思考头的组，平铺在顶层。
 */
function groupTrajectoryNodes(nodes: TrajectoryNode[]): TrajectoryGroup[] {
  const groups: TrajectoryGroup[] = [];
  let current: TrajectoryGroup | null = null;
  for (const node of nodes) {
    if (node.type === 'thinking') {
      current = { thinking: node, children: [] };
      groups.push(current);
    } else {
      if (!current) {
        current = { thinking: null, children: [] };
        groups.push(current);
      }
      current.children.push(node);
    }
  }
  return groups;
}

/** 渲染一个子节点（工具调用 / 知识检索）。 */
function renderTrajectoryChild(node: TrajectoryChildNode, completed: boolean) {
  if (node.type === 'knowledge') {
    return <KnowledgeNode key={node.id} text={node.text} stage={node.stage} />;
  }
  return <ToolNode key={node.id} node={node} completed={completed} />;
}

function TrajectoryTimeline({
  blocks,
  completed = false,
}: {
  blocks: Message[];
  completed?: boolean;
}) {
  return (
    <TrajectoryProcessGroup
      nodes={blocks.map(readTrajectoryNode)}
      completed={completed}
    />
  );
}

/** 时间线左侧的图标圆点，覆盖在竖线上。 */
function TimelineBullet({
  children,
  tone = 'muted',
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'primary' | 'error';
}) {
  const toneClass =
    tone === 'primary'
      ? 'text-primary'
      : tone === 'error'
        ? 'text-error'
        : 'text-muted-soft';
  return (
    <span
      aria-hidden="true"
      className={`absolute -left-[23px] top-0 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-hairline bg-surface-card ${toneClass}`}
    >
      {children}
    </span>
  );
}

/**
 * 将一轮回复中的思考、工具调用和知识检索合并进同一个折叠框。
 *
 * @param props.nodes 按消息顺序排列的全部过程节点。
 * @param props.completed 回答是否已结束；结束后把残留的运行中状态按完成展示。
 * @returns 默认收起、可整体展开的思考与执行过程框。
 */
function TrajectoryProcessGroup({
  nodes,
  completed,
}: {
  nodes: TrajectoryNode[];
  completed: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const groups = groupTrajectoryNodes(nodes);
  const toolNodes = nodes.filter(
    (node): node is Extract<TrajectoryNode, { type: 'tool' }> =>
      node.type === 'tool',
  );
  const hasFailed = toolNodes.some((node) => node.status === 'failed');

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-hairline/70 bg-surface-soft">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-all hover:border-primary/30 hover:bg-surface-card hover:shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
      >
        <span className="flex min-w-0 items-center gap-2">
          {!completed ? (
            <Sparkles
              size={14}
              strokeWidth={1.8}
              className="shrink-0 animate-pulse text-primary"
              aria-hidden="true"
            />
          ) : hasFailed ? (
            <AlertCircle
              size={14}
              strokeWidth={1.8}
              className="shrink-0 text-error"
              aria-hidden="true"
            />
          ) : (
            <CheckCircle2
              size={14}
              strokeWidth={1.8}
              className="shrink-0 text-primary"
              aria-hidden="true"
            />
          )}
          <span className="truncate text-[12px] font-medium text-muted transition-colors group-hover:text-ink">
            {t('aiChat.messageList.processTrace')}
          </span>
          <span className="shrink-0 text-[11px] text-muted-soft/70">
            · {t('aiChat.messageList.processStepCount', {
              count: nodes.length,
            })}
          </span>
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.8}
          className={`shrink-0 text-muted-soft transition-transform duration-200 group-hover:text-ink ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>

      {expanded && (
        <div className="flex flex-col gap-3 px-3 pb-3 pt-1">
          {groups.map((group, index) => (
            <div
              key={group.thinking?.id ?? group.children[0]?.id ?? index}
              className="flex flex-col gap-3"
            >
              {group.thinking && (
                <div className="whitespace-pre-wrap break-words rounded-md bg-canvas/80 p-3 font-mono text-[12px] leading-relaxed text-muted">
                  {group.thinking.content.trim() ||
                    t('aiChat.messageList.thinkingFallback')}
                </div>
              )}
              {group.children.length > 0 && (
                <div className="relative flex flex-col gap-2.5 border-l border-hairline/60 pl-4">
                  {group.children.map((child) =>
                    renderTrajectoryChild(child, completed),
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 知识检索轨迹节点。 */
function KnowledgeNode({ text, stage }: { text: string; stage?: string }) {
  const isHit = stage === 'knowledge_hit';
  return (
    <div className="relative">
      <TimelineBullet tone={isHit ? 'primary' : 'muted'}>
        <Search size={11} strokeWidth={1.8} />
      </TimelineBullet>
      <span
        className={`text-[12px] leading-6 ${
          isHit ? 'font-medium text-primary' : 'text-muted'
        }`}
      >
        {text}
      </span>
    </div>
  );
}

// 这些工具有友好中文标签（见 i18n aiChat.messageList.toolLabels）；未知工具回退裸名。
const FRIENDLY_TOOL_NAMES = new Set([
  'grep',
  'read',
  'read_soul',
  'edit_soul',
  'reverse_ganzhi',
  'get_ganzhi_by_datetime',
  'get_current_time',
  'get_session_board',
]);

/** 老数据可能把原始 JSON 包装存进了 text，遇到 JSON 直接不展示，避免脏卡片。 */
function looksLikeRawJson(value: string): boolean {
  return /^\s*[{[]/.test(value);
}

/** 工具调用节点：标题 + 结果计数 + 来源列表（无结果数据时降级为简化行）。 */
function ToolNode({
  node,
  completed,
}: {
  node: Extract<TrajectoryNode, { type: 'tool' }>;
  completed: boolean;
}) {
  const { t } = useI18n();
  const status =
    completed && node.status === 'running' ? 'completed' : node.status;
  const result = node.result ?? undefined;
  const friendlyLabel = FRIENDLY_TOOL_NAMES.has(node.label)
    ? t(`aiChat.messageList.toolLabels.${node.label}`)
    : node.label;
  const title = node.query || result?.query || friendlyLabel;
  const items = result?.items ?? [];
  const count =
    typeof result?.count === 'number'
      ? result.count
      : items.length > 0
        ? items.length
        : undefined;

  const tone = status === 'failed' ? 'error' : status === 'running' ? 'primary' : 'muted';

  return (
    <div className="relative">
      <TimelineBullet tone={tone}>
        {status === 'running' ? (
          <Loader2 size={11} className="animate-spin" />
        ) : status === 'failed' ? (
          <AlertCircle size={11} strokeWidth={1.8} />
        ) : (
          <Globe size={11} strokeWidth={1.8} />
        )}
      </TimelineBullet>

      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[12px] leading-6 text-ink">
          {title}
        </span>
        {typeof count === 'number' && (
          <span className="shrink-0 text-[11px] text-muted-soft">
            {t('aiChat.messageList.resultsCount', { count })}
          </span>
        )}
      </div>

      {node.path && !node.query && (
        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-soft">
          {node.path}
        </div>
      )}

      {items.length > 0 ? (
        <div className="mt-1.5 max-h-44 overflow-y-auto rounded-lg border border-hairline bg-surface-card/60">
          {items.map((item, index) => (
            <div
              key={`${node.id}-${index}`}
              className="flex items-center justify-between gap-3 border-b border-hairline/60 px-2.5 py-1.5 last:border-b-0"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Globe
                  size={12}
                  strokeWidth={1.8}
                  className="shrink-0 text-muted-soft"
                  aria-hidden="true"
                />
                <span className="min-w-0 truncate text-[12px] text-ink">
                  {item.title}
                </span>
              </span>
              {item.domain && (
                <span className="shrink-0 truncate text-[11px] text-muted-soft">
                  {item.domain}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : result?.text && !looksLikeRawJson(result.text) ? (
        <div className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[11px] leading-5 text-muted">
          {result.text}
        </div>
      ) : null}
    </div>
  );
}

/** 流式态：回答还没开始输出时，展示已累积的过程时间线 + "正在回复"提示。 */
function StreamingTrajectory({
  progressLabel,
  pendingTrajectory,
}: {
  progressLabel: string | null;
  pendingTrajectory: Message[];
}) {
  const { t } = useI18n();
  const statusLabel = progressLabel
    ? t('aiChat.messageList.progressSuffix', { label: progressLabel })
    : t('aiChat.messageList.aiReplying');

  return (
    <div className="max-w-2xl mx-auto flex justify-start animate-message-in">
      <div className="flex min-w-0 max-w-[88%] flex-col items-start gap-2 sm:max-w-[78%]">
        {pendingTrajectory.length > 0 && (
          <TrajectoryTimeline blocks={pendingTrajectory} />
        )}
        <div className="flex items-center gap-2 text-[12px] leading-6 text-muted">
          <div className="flex items-center gap-1" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="w-1 h-1 rounded-full bg-primary animate-thinking-dot"
                style={{ animationDelay: `${index * 0.2}s` }}
              />
            ))}
          </div>
          <span>{statusLabel}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * WS 长时间静默时的兜底提示：不管当前是"过程时间线还没结束"还是"已经开始流式
 * 吐字但中途卡住"，只要还在等待中且长时间没有新事件，都会出现，视觉上参照
 * LatestMessageBillingNotice（同一个内嵌提示条 + 操作按钮结构）。
 */
function ReplySlowNotice({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();

  return (
    <div className="max-w-2xl mx-auto flex justify-start animate-message-in">
      <div className="flex min-w-0 max-w-[88%] flex-col items-start sm:max-w-[78%]">
        <div
          role="status"
          aria-live="polite"
          className="max-w-full rounded-xl border border-hairline bg-surface-card/60 px-3 py-2 shadow-sm"
        >
          <div className="flex items-start gap-2">
            <AlertCircle
              size={15}
              strokeWidth={1.8}
              aria-hidden="true"
              className="mt-1 shrink-0 text-muted-soft"
            />
            <div className="min-w-0">
              <p className="text-[12px] leading-5 text-ink/70">
                {t('aiChat.messageList.replySlowNotice')}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onRetry}
                  className="inline-flex h-8 items-center justify-center rounded-lg bg-primary px-3 text-[12px] font-medium text-on-primary shadow-sm transition-colors hover:bg-primary-active"
                >
                  {t('aiChat.messageList.resend')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
