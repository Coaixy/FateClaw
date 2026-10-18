import type { AgentRequestData } from '@fateclaw/contracts/agent';
import type { EffectiveLlmRuntimeConfig } from '#modules/system/system-config';
import type { RuntimeEntitlementSnapshot } from '#modules/billing/entitlements';
import type { NewMessage } from '#shared/types';

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
