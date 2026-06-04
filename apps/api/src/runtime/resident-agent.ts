import {
  addAccountListener,
  InboxRequestResult,
  submitAiChatInboxRequest,
  submitInboxRequest,
} from './ipc-worker.js';
import { ensureLocalAgentRunning } from './local-runner.js';
import {
  type HistoryMessage,
  type SessionBoardContext,
} from '../shared/token-budget.js';
import type { EffectiveLlmRuntimeConfig } from '../modules/system/system-config.js';

type ChatInputKind = 'normal' | 'user_pasted_board';

interface UserPastedBoardInput {
  category: string;
  content: string;
  question: string;
}

/**
 * AI Chat 专属分发函数。
 * 响应写入隔离队列，永远不发微信。
 */
export async function dispatchAiChatPrompt(input: {
  accountId: string;
  userMessage: string;
  inputKind?: ChatInputKind;
  pastedBoard?: UserPastedBoardInput;
  history: HistoryMessage[];
  sessionBoardContexts?: SessionBoardContext[];
  sessionId: string;
  requestId?: string;
  userName?: string;
  assistantName?: string;
  personaPrompt?: string;
  llmRuntime?: EffectiveLlmRuntimeConfig;
}): Promise<InboxRequestResult> {
  await ensureLocalAgentRunning(input.accountId);
  addAccountListener(input.accountId);

  return submitAiChatInboxRequest({
    accountId: input.accountId,
    userMessage: input.userMessage,
    inputKind: input.inputKind,
    pastedBoard: input.pastedBoard,
    history: input.history,
    sessionBoardContexts: input.sessionBoardContexts,
    sessionId: input.sessionId,
    requestId: input.requestId,
    userName: input.userName,
    assistantName: input.assistantName,
    personaPrompt: input.personaPrompt,
    llmRuntime: input.llmRuntime,
  });
}

export async function dispatchResidentPrompt(input: {
  accountId: string;
  type: 'chat' | 'task';
  userMessage: string;
  history: HistoryMessage[];
  toUserId?: string;
  contextToken?: string;
  autoDeliver?: boolean;
  sessionId?: string;
  userName?: string;
  assistantName?: string;
  llmRuntime?: EffectiveLlmRuntimeConfig;
}): Promise<InboxRequestResult> {
  await ensureLocalAgentRunning(input.accountId);

  return submitInboxRequest({
    accountId: input.accountId,
    type: input.type,
    userMessage: input.userMessage,
    history: input.history,
    toUserId: input.toUserId,
    contextToken: input.contextToken,
    autoDeliver: input.autoDeliver,
    sessionId: input.sessionId,
    userName: input.userName,
    assistantName: input.assistantName,
    llmRuntime: input.llmRuntime,
  });
}
