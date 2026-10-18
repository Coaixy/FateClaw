import type { AgentRequestData } from '@fateclaw/contracts/agent';
import type { EffectiveLlmRuntimeConfig } from '../modules/system/system-config.js';
import type { RuntimeEntitlementSnapshot } from '../modules/billing/entitlements.js';
import type { NewMessage } from '../shared/types.js';

export interface AiChatSubmission extends AgentRequestData {
  sessionId: string;
  userMessageId?: string;
  requestId?: string;
  llmRuntime?: EffectiveLlmRuntimeConfig;
  entitlementSnapshot?: RuntimeEntitlementSnapshot;
  waitForResponse?: boolean;
  messageToPersist?: NewMessage;
  recoveryExecutionId?: string;
  recoveryDeadlineAt?: string;
}
