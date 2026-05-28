import type { Message } from '@/features/chat/api';

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
    kind: 'progress';
    stage?: string;
    workflow?: string;
    query_text?: string;
  };
};

export function formatChatTime(ts: string) {
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
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

export function isFinalAssistantMessage(message: Message) {
  return Boolean(message.is_bot_message) && getMessageKind(message) === 'final';
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
  return message.metadata?.kind === 'progress';
}

export function getProgressStageLabel(stage?: string) {
  if (!stage) return '处理中';
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

export function filterProgressMessages(messages: Message[]) {
  return messages.filter(
    (message) => !isProgressMessage(message) || isKnowledgeTrajectoryMessage(message),
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
