import { InboxRequestResult, submitAiChatInboxRequest } from './ipc-worker.js';
import type { NewMessage } from '../shared/types.js';
import {
  type HistoryMessage,
  type SessionBoardContext,
} from '../shared/token-budget.js';
import type { EffectiveLlmRuntimeConfig } from '../modules/system/system-config.js';
import type { RuntimeEntitlementSnapshot } from '../modules/billing/entitlements.js';

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
  userMessageId?: string;
  requestId?: string;
  userName?: string;
  assistantName?: string;
  personaPrompt?: string;
  authorizedSkillIds?: string[];
  llmRuntime?: EffectiveLlmRuntimeConfig;
  entitlementSnapshot?: RuntimeEntitlementSnapshot;
  waitForResponse?: boolean;
  messageToPersist?: NewMessage;
}): Promise<InboxRequestResult> {
  return submitAiChatInboxRequest({
    accountId: input.accountId,
    userMessage: input.userMessage,
    inputKind: input.inputKind,
    pastedBoard: input.pastedBoard,
    history: input.history,
    sessionBoardContexts: input.sessionBoardContexts,
    sessionId: input.sessionId,
    userMessageId: input.userMessageId,
    requestId: input.requestId,
    userName: input.userName,
    assistantName: input.assistantName,
    personaPrompt: input.personaPrompt,
    authorizedSkillIds: input.authorizedSkillIds,
    llmRuntime: input.llmRuntime,
    entitlementSnapshot: input.entitlementSnapshot,
    waitForResponse: input.waitForResponse,
    messageToPersist: input.messageToPersist,
  });
}
