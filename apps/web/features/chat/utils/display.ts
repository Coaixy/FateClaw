import type { Message } from '@/features/chat/api';
import { formatCoins } from '../../../lib/soft-currency';
import type { Locale } from '@/lib/i18n';

export const AUTO_SCROLL_THRESHOLD = 80;

export const PAIPAN_SKILLS = new Set([
  'bazi-paipan',
  'ziwei-paipan',
  'iching-paipan',
  'jingzhan-paipan',
  'meihua-paipan',
  'liuren-paipan',
  'qimen-paipan',
]);

export type MessageGroup = {
  label: string;
  date: string;
  messages: Message[];
};

export type ProgressMessage = Message & {
  metadata: {
    kind: 'progress' | 'tool_trace';
    stage?: string;
    workflow?: string;
    query_text?: string;
    tool_call_id?: string;
    tool_name?: string;
    tool_label?: string;
    tool_status?: 'running' | 'completed' | 'failed';
    tool_path?: string;
  };
};

function resolveIntlLocale(locale?: Locale): string {
  if (locale === 'zh-TW') {
    return 'zh-TW';
  }
  if (locale === 'en') {
    return 'en';
  }
  return 'zh-CN';
}

/**
 * 格式化聊天消息时间。
 *
 * @param ts 消息时间戳。
 * @param locale 当前前端展示语言；缺省时保持简中旧行为。
 * @returns 本地化后的小时分钟。
 */
export function formatChatTime(ts: string, locale?: Locale) {
  return new Date(ts).toLocaleTimeString(resolveIntlLocale(locale), {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 将 AI 回复耗时格式化为聊天气泡下方的紧凑标签。
 *
 * @param value 后端写入 metadata.duration_ms 的毫秒数。
 * @returns 可直接展示的中文耗时标签；非法或缺失时返回 null。
 */
export function formatChatDuration(
  value: unknown,
  t?: (key: string, params?: Record<string, string | number>) => string,
): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }

  const prefix = t?.('format.chatDurationPrefix') ?? '耗时';
  if (value < 10_000) {
    return `${prefix} ${(value / 1000).toFixed(1)}s`;
  }

  const seconds = Math.round(value / 1000);
  if (seconds < 60) {
    return `${prefix} ${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${prefix} ${minutes}m ${remainingSeconds}s`
      : `${prefix} ${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? `${prefix} ${hours}h ${remainingMinutes}m`
    : `${prefix} ${hours}h`;
}

/**
 * 将 AI 回复计费明细格式化为聊天气泡下方的紧凑标签。
 *
 * @param metadata 后端写入消息 metadata 的计费明细。
 * @returns 可直接展示的中文积分标签列表；非法或缺失时返回空列表。
 */
export function formatChatCostLabels(
  metadata: unknown,
  locale?: Locale,
  t?: (key: string, params?: Record<string, string | number>) => string,
): string[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return [];
  }

  const data = metadata as {
    actual_charge_coins?: unknown;
    membership_covered_coins?: unknown;
  };
  const labels: string[] = [];

  if (
    typeof data.membership_covered_coins === 'number' &&
    Number.isFinite(data.membership_covered_coins) &&
    data.membership_covered_coins > 0
  ) {
    const coins = formatCoins(data.membership_covered_coins, locale);
    labels.push(
      t?.('format.membershipCovered', { coins }) ??
        `会员免费额度抵扣 ${coins}`,
    );
  }

  if (
    typeof data.actual_charge_coins === 'number' &&
    Number.isFinite(data.actual_charge_coins) &&
    data.actual_charge_coins >= 0
  ) {
    const coins = formatCoins(data.actual_charge_coins, locale);
    labels.push(t?.('format.walletCharged', { coins }) ?? `积分实扣 ${coins}`);
  }

  return labels;
}

/**
 * 将 AI 回复实际扣费金额格式化为聊天气泡下方的紧凑标签。
 *
 * @param value 后端写入 metadata.actual_charge_coins 的积分金额。
 * @returns 可直接展示的中文积分标签；非法或缺失时返回 null。
 */
export function formatChatCost(
  value: unknown,
  locale?: Locale,
  t?: (key: string, params?: Record<string, string | number>) => string,
): string | null {
  const labels = formatChatCostLabels(
    { actual_charge_coins: value },
    locale,
    t,
  );
  if (!labels[0]) {
    return null;
  }
  if (t) {
    return t('format.consumed', { coins: formatCoins(value as number, locale) });
  }
  return labels[0]?.replace('积分实扣', '消耗') ?? null;
}

export function formatRelativeDateLabel(
  ts: string,
  locale?: Locale,
  t?: (key: string, params?: Record<string, string | number>) => string,
) {
  const date = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / 86400000);

  if (days === 0) return t?.('format.today') ?? '今天';
  if (days === 1) return t?.('format.yesterday') ?? '昨天';
  if (days < 7) return t?.('format.daysAgoSpaced', { days }) ?? `${days} 天前`;

  return date.toLocaleDateString(resolveIntlLocale(locale), {
    month: 'long',
    day: 'numeric',
  });
}

export function groupMessagesByDate(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];

  for (const message of messages) {
    const date = message.timestamp.slice(0, 10);
    const lastGroup = groups[groups.length - 1];

    if (lastGroup && lastGroup.date === date) {
      lastGroup.messages.push(message);
      continue;
    }

    groups.push({
      label: formatRelativeDateLabel(message.timestamp),
      date,
      messages: [message],
    });
  }

  return groups;
}

function getMessageKind(message: Message) {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const kind = (metadata as Record<string, unknown>).kind;
  return typeof kind === 'string' ? kind : null;
}

export function isStreamingAssistantMessage(message: Message) {
  return (
    Boolean(message.is_bot_message) && getMessageKind(message) === 'streaming'
  );
}

export function isThinkingMessage(message: Message) {
  return Boolean(message.is_bot_message) && getMessageKind(message) === 'thinking';
}

export function isFinalAssistantMessage(message: Message) {
  const kind = getMessageKind(message);
  return (
    Boolean(message.is_bot_message) &&
    (kind === 'final' || kind === 'error')
  );
}

export function hasFinalAssistantAfterLatestUser(messages: Message[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!messages[index].is_bot_message) {
      return messages.slice(index + 1).some(isFinalAssistantMessage);
    }
  }

  return messages.some(isFinalAssistantMessage);
}

export function isProgressMessage(
  message: Message,
): message is ProgressMessage {
  return (
    message.metadata?.kind === 'progress' ||
    message.metadata?.kind === 'tool_trace'
  );
}

export function getProgressStageLabel(
  stage?: string,
  t?: (key: string, params?: Record<string, string | number>) => string,
) {
  if (!stage) return t?.('format.progressProcessing') ?? '处理中';
  if (stage.startsWith('tool_')) return t?.('format.progressReading') ?? '查阅';
  if (stage === 'knowledge_hit') {
    return t?.('format.progressKnowledgeHit') ?? '命中知识库';
  }
  if (stage === 'knowledge_retrieving') {
    return t?.('format.progressStartInterpret') ?? '开始解读';
  }
  if (stage === 'knowledge_section') {
    return t?.('format.progressKnowledgeSection') ?? '检索章节';
  }
  if (stage.startsWith('board_')) return t?.('format.progressPaipan') ?? '排盘';
  if (stage.startsWith('interpret_')) {
    return t?.('format.progressInterpret') ?? '解读';
  }
  if (stage.startsWith('general_')) return t?.('format.progressHandle') ?? '处理';
  return t?.('format.progressProcessing') ?? '处理中';
}

/** 知识检索轨迹 stage 集合：这些进度消息应在聊天流中实时展示。 */
const KNOWLEDGE_TRAJECTORY_STAGES = new Set([
  'knowledge_hit',
  'knowledge_retrieving',
  'knowledge_section',
]);

/** 是否为知识检索轨迹进度消息（应展示而非过滤）。 */
export function isKnowledgeTrajectoryMessage(message: Message): boolean {
  const stage = message.metadata?.stage;
  return (
    message.metadata?.kind === 'progress' &&
    typeof stage === 'string' &&
    KNOWLEDGE_TRAJECTORY_STAGES.has(stage)
  );
}

export function isToolTraceMessage(message: Message): boolean {
  return message.metadata?.kind === 'tool_trace';
}

function isHiddenDisplayMessage(message: Message): boolean {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return false;
  }

  // 直接排盘和简易模式都会写入一条只用于记录操作的用户消息；聊天流里保留盘面结果即可。
  return (
    !message.is_bot_message &&
    metadata.kind === 'board_request' &&
    (metadata.workflow === 'direct_paipan' ||
      metadata.workflow === 'simple_workflow')
  );
}

/**
 * 判断 tool trace 是否能挂到这条 AI 回复的底部。
 *
 * @param message 聊天消息。
 * @returns 只有真实 AI 回复可承载 tool footer；思考流、进度和重连提示不承载，避免流式状态把工具信息插到中间。
 */
export function canHostToolTraceFooter(message: Message): boolean {
  return (
    Boolean(message.is_bot_message) &&
    !isProgressMessage(message) &&
    !isThinkingMessage(message) &&
    message.metadata?.kind !== 'reconnecting'
  );
}

export function filterProgressMessages(messages: Message[]) {
  return messages.filter(
    (message) =>
      !isHiddenDisplayMessage(message) &&
      (!isProgressMessage(message) ||
        isKnowledgeTrajectoryMessage(message) ||
        isToolTraceMessage(message)),
  );
}

export function getLatestProgressLabel(
  messages: Message[],
  t?: (key: string, params?: Record<string, string | number>) => string,
) {
  const progressMessages = messages.filter(isProgressMessage);
  if (progressMessages.length === 0) return null;
  return getProgressStageLabel(
    progressMessages[progressMessages.length - 1].metadata.stage,
    t,
  );
}

export function isNearBottom(element: HTMLDivElement) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <=
    AUTO_SCROLL_THRESHOLD
  );
}

export function areMessagesEqual(previous: Message[], next: Message[]) {
  if (previous.length !== next.length) return false;

  for (let index = 0; index < previous.length; index += 1) {
    if (
      previous[index].id !== next[index].id ||
      previous[index].content !== next[index].content ||
      previous[index].timestamp !== next[index].timestamp ||
      previous[index].tool_context !== next[index].tool_context
    ) {
      return false;
    }
  }

  return true;
}
