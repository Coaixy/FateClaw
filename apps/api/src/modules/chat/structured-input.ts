import type { HistoryMessage } from '../../shared/token-budget.js';

export interface StructuredInput {
  userMessage: string;
  history: HistoryMessage[];
  userName: string;
  assistantName: string;
}

/**
 * 为 AI 对话（chat session）构建结构化输入。
 *
 * @param identity - 当前运行时身份与展示名。
 * @param userMessage - 用户本轮输入。
 * @param sessionId - chat_sessions.id；当前由 Pi session 文件维护连续上下文。
 * @param model - 本轮使用的模型名称。
 * @param contextWindowTokens - 模型上下文窗口；当前保留参数以便后续扩展预算策略。
 * @returns 发送给 Pi Runtime 的结构化输入。
 * @remarks AI 历史由 Pi session 文件负责，FateClaw DB 只保留业务展示副本。
 */
export async function buildStructuredInputForSession(
  identity: {
    runtimeId: string;
    userName: string;
    assistantName: string;
    soulAccountId?: string;
  },
  userMessage: string,
  sessionId: string,
  model: string,
  contextWindowTokens?: number,
): Promise<StructuredInput> {
  void sessionId;
  void model;
  void contextWindowTokens;
  return {
    userMessage,
    history: [],
    userName: identity.userName,
    assistantName: identity.assistantName,
  };
}
