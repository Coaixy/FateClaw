'use client';

import Link from 'next/link';
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Copy,
  Crown,
  Globe,
  Loader2,
  Search,
} from 'lucide-react';

import { BaguaRing } from '@/components/brand/brand-marks';
import { ArtifactDebug } from '@/components/chat/artifact-debug';
import { ArtifactRenderer } from '@/components/chat/artifact-renderer';
import { ChatLoadingState } from '@/components/chat/chat-loading-state';
import { CollapsibleMessage } from '@/components/chat/collapsible-message';
import { MessageFooter } from '@/components/chat/message-footer';
import { Message } from '@/features/chat/api';
import type {
  ToolResultItemDto,
  ToolResultPreviewDto,
} from '@fateclaw/contracts/chat';
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

export const AiChatMessageList = memo(function AiChatMessageList({
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
  latestMessageNotice?: 'arrears' | null;
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
  const {
    rows,
    pendingTrajectory,
    hasStreamingAssistantMessage,
    hasThinkingMessage,
    hasCompletedAssistantTurn,
  } = useMemo(
    () => ({
      ...buildDisplayRows(messages),
      hasStreamingAssistantMessage: messages.some(isStreamingAssistantMessage),
      hasThinkingMessage: messages.some(isThinkingMessage),
      hasCompletedAssistantTurn: hasFinalAssistantAfterLatestUser(messages),
    }),
    [messages],
  );

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
            animationIndex={Math.min(index, 4)}
          />
        ),
      )}

      {rows.length > 0 && latestMessageNotice && (
        <LatestMessageBillingNotice containerRef={latestMessageNoticeRef} />
      )}

      {showStreamingTrajectory && (
        <StreamingTrajectory
          progressLabel={progressLabel}
          pendingTrajectory={pendingTrajectory}
        />
      )}

      {sending && replySlow && onRetry && <ReplySlowNotice onRetry={onRetry} />}
    </div>
  );
});

type DisplayRow = {
  message: Message;
  trajectory: Message[];
  trajectoryOnly?: boolean;
};

/** Keep process messages with the next reply so streaming updates share one disclosure. */
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
      pending.push(message);
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
  containerRef,
}: {
  containerRef: React.Ref<HTMLDivElement>;
}) {
  const { t } = useI18n();

  return (
    <div
      ref={containerRef}
      className="max-w-2xl mx-auto flex justify-start animate-message-in"
    >
      <div className="flex min-w-0 max-w-[88%] flex-col items-start sm:max-w-[78%]">
        <div
          role="status"
          aria-live="polite"
          className="max-w-full rounded-xl border border-error/25 bg-error/8 px-3 py-2 text-error shadow-sm"
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
                {t('aiChat.messageList.billingNoticeArrearsTitle')}
              </p>
              <p className="mt-0.5 text-[12px] leading-5 text-ink/70">
                {t('aiChat.messageList.billingNoticeArrearsDescription')}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Link
                  href="/membership"
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-medium text-on-primary shadow-sm transition-colors hover:bg-primary-active"
                >
                  <Crown size={12} aria-hidden="true" />
                  {t('aiChat.messageList.membershipCenter')}
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

interface AiChatMessageRowProps {
  message: Message;
  trajectory: Message[];
  animationIndex: number;
}

function areMessageRowsEqual(
  previous: AiChatMessageRowProps,
  next: AiChatMessageRowProps,
): boolean {
  return (
    previous.message === next.message &&
    previous.animationIndex === next.animationIndex &&
    previous.trajectory.length === next.trajectory.length &&
    previous.trajectory.every(
      (message, index) => message === next.trajectory[index],
    )
  );
}

const AiChatMessageRow = memo(function AiChatMessageRow({
  message,
  trajectory,
  animationIndex,
}: AiChatMessageRowProps) {
  const { locale, t } = useI18n();
  const isBot = !!message.is_bot_message;
  const isStreaming = isStreamingAssistantMessage(message);
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
  const durationLabel = isBot
    ? formatChatDuration(messageMetadata?.duration_ms, t)
    : null;
  const costLabels = isBot
    ? messageMetadata?.pool_key === 'benefit'
      ? [
          t(
            messageMetadata.benefit_status === 'released'
              ? 'modelChoice.refunded'
              : 'modelChoice.freeReply',
          ),
        ]
      : formatChatCostLabels(messageMetadata, locale, t)
    : [];
  const toolContext = isBot ? parseToolContext(message.tool_context) : [];
  const hasChart =
    isBot && toolContext.some((entry) => PAIPAN_SKILLS.has(entry.skill));
  const showWalletRecovery =
    isErrorMessage && shouldShowWalletRecovery(displayContent);
  // Final replies settle any tool status still marked as running.
  const trajectoryNode =
    isBot && trajectory.length > 0 ? (
      <TrajectoryTimeline blocks={trajectory} completed={isFinalMessage} />
    ) : null;
  const messageColumnClass = isBot
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
      <div className={`flex min-w-0 flex-col ${messageColumnClass}`}>
        {trajectoryNode && <div className="mb-2 w-full">{trajectoryNode}</div>}

        <div className="group relative max-w-full">
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
            <CollapsibleMessage
              content={displayContent}
              isBot={isBot}
              isStreaming={isStreaming}
            />
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
        {isBot && !isErrorMessage && !isStreaming && displayContent.trim() && (
          <CopyAnswerButton content={displayContent} />
        )}
      </div>
    </div>
  );
}, areMessageRowsEqual);

function CopyAnswerButton({ content }: { content: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'failed'>(
    'idle',
  );

  useEffect(() => setState('idle'), [content]);

  const copyAnswer = async () => {
    setState('copying');
    try {
      await navigator.clipboard.writeText(content);
      setState('copied');
    } catch {
      setState('failed');
    }
  };

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={copyAnswer}
        disabled={state === 'copying'}
        aria-label={t('aiChat.messageList.copyAnswer')}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-1.5 text-[11px] text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-50"
      >
        {state === 'copied' ? (
          <CheckCircle2 size={12} aria-hidden="true" />
        ) : (
          <Copy size={12} aria-hidden="true" />
        )}
        {t(
          state === 'copied'
            ? 'aiChat.messageList.answerCopied'
            : 'aiChat.messageList.copyAnswer',
        )}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === 'copied' ? t('aiChat.messageList.answerCopied') : ''}
      </span>
      {state === 'failed' && (
        <p role="alert" className="text-[11px] text-error">
          {t('artifact.copyFailed')}
        </p>
      )}
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
    rawStatus === 'running' ||
    rawStatus === 'completed' ||
    rawStatus === 'failed'
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
      typeof metadata?.query_text === 'string'
        ? metadata.query_text
        : undefined,
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

const TrajectoryTimeline = memo(
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
  },
  (previous, next) =>
    previous.completed === next.completed &&
    previous.blocks.length === next.blocks.length &&
    previous.blocks.every((block, index) => block === next.blocks[index]),
);

/** The canvas masks the timeline behind each step icon. */
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
      className={`absolute -left-[24px] top-1 flex h-4 w-4 items-center justify-center bg-canvas ${toneClass}`}
    >
      {children}
    </span>
  );
}

function TrajectoryProcessGroup({
  nodes,
  completed,
}: {
  nodes: TrajectoryNode[];
  completed: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const groups = groupTrajectoryNodes(nodes);
  const toolNodes = nodes.filter(
    (node): node is Extract<TrajectoryNode, { type: 'tool' }> =>
      node.type === 'tool',
  );
  const hasFailed = toolNodes.some((node) => node.status === 'failed');

  return (
    <div className="min-w-0 w-full">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((value) => !value)}
        className="inline-flex min-h-8 max-w-full cursor-pointer items-center gap-1.5 rounded-sm py-1 text-left text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
      >
        {hasFailed && (
          <AlertCircle
            size={13}
            strokeWidth={1.8}
            className="shrink-0 text-error"
            aria-label={t('aiChat.messageList.toolStatusFailed')}
          />
        )}
        <span className="truncate text-[12px] font-medium">
          {t('aiChat.messageList.processTrace')}
        </span>
        <span className="shrink-0 text-[11px] text-muted-soft">
          ·{' '}
          {t('aiChat.messageList.processStepCount', {
            count: nodes.length,
          })}
        </span>
        <ChevronRight
          size={13}
          strokeWidth={1.8}
          aria-hidden="true"
          className={`shrink-0 text-muted-soft transition-transform duration-200 motion-reduce:transition-none ${
            expanded ? 'rotate-90' : ''
          }`}
        />
      </button>

      <div id={detailsId} hidden={!expanded}>
        {expanded && (
          <div className="mb-1 ml-1.5 mt-1 flex flex-col gap-3 border-l border-hairline/70 pl-4">
            {groups.map((group, index) => (
              <div
                key={group.thinking?.id ?? group.children[0]?.id ?? index}
                className="flex min-w-0 flex-col gap-2"
              >
                {group.thinking && (
                  <p className="whitespace-pre-wrap break-words text-[12px] leading-6 text-muted">
                    {group.thinking.content.trim() ||
                      t('aiChat.messageList.thinkingFallback')}
                  </p>
                )}
                {group.children.length > 0 && (
                  <div className="flex min-w-0 flex-col gap-2.5">
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

  const tone =
    status === 'failed' ? 'error' : status === 'running' ? 'primary' : 'muted';

  return (
    <div className="relative">
      <TimelineBullet tone={tone}>
        {status === 'running' ? (
          <Loader2 size={11} className="animate-spin" />
        ) : status === 'failed' ? (
          <AlertCircle size={11} strokeWidth={1.8} />
        ) : status === 'completed' ? (
          <CheckCircle2 size={11} strokeWidth={1.8} />
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
        <ToolResultSources items={items} />
      ) : result?.text && !looksLikeRawJson(result.text) ? (
        <div className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[11px] leading-5 text-muted">
          {result.text}
        </div>
      ) : null}
    </div>
  );
}

export const ToolResultSources = memo(function ToolResultSources({
  items,
}: {
  items: ToolResultItemDto[];
}) {
  return (
    <div className="mt-1.5 max-h-44 overflow-y-auto rounded-lg border border-hairline bg-surface-card/60">
      {items.map((item, index) => {
        let url: URL | null = null;
        try {
          const parsed = new URL(item.url ?? '');
          if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            url = parsed;
          }
        } catch {
          // A source without an absolute web URL remains readable as plain text.
        }
        const content = (
          <>
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
            {(url?.hostname || item.domain) && (
              <span className="shrink-0 truncate text-[11px] text-muted-soft">
                {url?.hostname || item.domain}
              </span>
            )}
          </>
        );
        const rowClassName =
          'flex items-center justify-between gap-3 border-b border-hairline/60 px-2.5 py-1.5 last:border-b-0';

        return url ? (
          <a
            key={index}
            href={url.href}
            target="_blank"
            rel="noopener noreferrer"
            className={`${rowClassName} hover:bg-surface-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30`}
          >
            {content}
          </a>
        ) : (
          <div key={index} className={rowClassName}>
            {content}
          </div>
        );
      })}
    </div>
  );
});

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
      <div className="flex min-w-0 max-w-[88%] flex-col items-start gap-1 sm:max-w-[78%]">
        {pendingTrajectory.length > 0 && (
          <TrajectoryTimeline blocks={pendingTrajectory} />
        )}
        <div
          role="status"
          className="flex min-h-6 items-center gap-2 text-[12px] leading-6 text-muted"
        >
          <Loader2
            size={12}
            strokeWidth={1.8}
            className="shrink-0 animate-spin text-primary motion-reduce:animate-none"
            aria-hidden="true"
          />
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
