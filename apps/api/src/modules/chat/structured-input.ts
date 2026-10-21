import type { HistoryMessage } from '@fateclaw/contracts/agent';
import { getUserSoulContent } from '#infrastructure/db';

export interface StructuredInput {
  userMessage: string;
  history: HistoryMessage[];
  userName: string;
  assistantName: string;
  /** 用户级 Soul 作为本轮人格覆盖层（卦师话术风格）；无 soul 时为 undefined。 */
  personaPrompt?: string;
}

/**
 * 为 AI 对话（chat session）构建结构化输入。
 *
 * @param identity - 当前运行时身份与展示名；soulUserId 为读取用户级 Soul 的平台用户 id。
 * @param userMessage - 用户本轮输入。
 * @param sessionId - chat_sessions.id；当前由 Pi session 文件维护连续上下文。
 * @param model - 本轮使用的模型名称。
 * @param contextWindowTokens - 模型上下文窗口；当前保留参数以便后续扩展预算策略。
 * @returns 发送给 Pi Runtime 的结构化输入，含按需读取的用户级 Soul 人格覆盖层。
 * @remarks AI 历史由 Pi session 文件负责，FateClaw DB 只保留业务展示副本。
 */
export async function buildStructuredInputForSession(
  identity: {
    runtimeId: string;
    userName: string;
    assistantName: string;
    soulUserId?: string;
  },
  userMessage: string,
  sessionId: string,
  model: string,
  contextWindowTokens?: number,
): Promise<StructuredInput> {
  void sessionId;
  void model;
  void contextWindowTokens;
  // 读取用户级 Soul 作为人格覆盖层（卦师话术风格）。soulUserId 是平台用户 id，
  // 直接查 users.soul_content；为空字符串时归一化为 undefined，避免注入空覆盖层。
  const personaPrompt = identity.soulUserId
    ? (await getUserSoulContent(identity.soulUserId)).trim() || undefined
    : undefined;
  return {
    userMessage,
    history: [],
    userName: identity.userName,
    assistantName: identity.assistantName,
    personaPrompt,
  };
}
