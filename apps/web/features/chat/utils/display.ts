import type { Message } from '@/features/chat/api';
import { formatCoins } from '../../../lib/soft-currency';

export const AUTO_SCROLL_THRESHOLD = 80;

export const PAIPAN_SKILLS = new Set([
  'bazi-paipan',
  'ziwei-paipan',
  'iching-paipan',
  'jingzhan-paipan',
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

export function formatChatTime(ts: string) {
  return new Date(ts).toLocaleTimeString('zh-CN', {
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
export function formatChatDuration(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }

  if (value < 10_000) {
    return `耗时 ${(value / 1000).toFixed(1)}s`;
  }

  const seconds = Math.round(value / 1000);
  if (seconds < 60) {
    return `耗时 ${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `耗时 ${minutes}m ${remainingSeconds}s`
      : `耗时 ${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? `耗时 ${hours}h ${remainingMinutes}m`
    : `耗时 ${hours}h`;
}

/**
 * 将 AI 回复计费明细格式化为聊天气泡下方的紧凑标签。
 *
 * @param metadata 后端写入消息 metadata 的计费明细。
 * @returns 可直接展示的中文软妹币标签列表；非法或缺失时返回空列表。
 */
export function formatChatCostLabels(metadata: unknown): string[] {
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
    labels.push(`会员抵扣 ${formatCoins(data.membership_covered_coins)}`);
  }

  if (
    typeof data.actual_charge_coins === 'number' &&
    Number.isFinite(data.actual_charge_coins) &&
    data.actual_charge_coins >= 0
  ) {
    labels.push(`钱包实扣 ${formatCoins(data.actual_charge_coins)}`);
  }

  return labels;
}

/**
 * 将 AI 回复实际扣费金额格式化为聊天气泡下方的紧凑标签。
 *
 * @param value 后端写入 metadata.actual_charge_coins 的软妹币金额。
 * @returns 可直接展示的中文软妹币标签；非法或缺失时返回 null。
 */
export function formatChatCost(value: unknown): string | null {
  const labels = formatChatCostLabels({ actual_charge_coins: value });
  return labels[0]?.replace('钱包实扣', '消耗') ?? null;
}

export function formatRelativeDateLabel(ts: string) {
  const date = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / 86400000);

  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;

  return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
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

export function getProgressStageLabel(stage?: string) {
  if (!stage) return '处理中';
  if (stage.startsWith('tool_')) return '查阅';
  if (stage === 'knowledge_hit') return '命中知识库';
  if (stage === 'knowledge_retrieving') return '开始解读';
  if (stage === 'knowledge_section') return '检索章节';
  if (stage.startsWith('board_')) return '排盘';
  if (stage.startsWith('interpret_')) return '解读';
  if (stage.startsWith('general_')) return '处理';
  return '处理中';
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
      !isProgressMessage(message) ||
      isKnowledgeTrajectoryMessage(message) ||
      isToolTraceMessage(message),
  );
}

export function getLatestProgressLabel(messages: Message[]) {
  const progressMessages = messages.filter(isProgressMessage);
  if (progressMessages.length === 0) return null;
  return getProgressStageLabel(
    progressMessages[progressMessages.length - 1].metadata.stage,
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
