import { submitAiChatInboxRequest } from './ipc-worker.js';
import type { InboxRequestResult } from './ipc-payloads.js';
import type { AiChatSubmission } from './request-types.js';

/** AI Chat uses its own response queue and never sends a WeChat message. */
export async function dispatchAiChatPrompt(
  input: AiChatSubmission,
): Promise<InboxRequestResult> {
  return submitAiChatInboxRequest(input);
}
