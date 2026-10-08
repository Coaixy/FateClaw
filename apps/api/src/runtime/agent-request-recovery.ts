import { ensureLocalAgentRunning } from './local-runner.js';
import {
  renewAgentRequestLeases,
  takeRecoverableRequests,
  persistAgentFailure,
  interruptAgentRequest,
  acknowledgeAgentInterruption,
  type DurableRequest,
} from '../infrastructure/repositories/agent-requests-repository.js';
import { resolveUserLlmRuntime } from '../modules/system/system-config.js';
import {
  getPendingAiChatRequests,
  submitAiChatInboxRequest,
  releaseGlobalAgentSlot,
} from './ipc-worker.js';
import { processAiChatOutboxPayload } from './ipc-ai-chat-outbox-handler.js';
import { buildAiChatErrorResponsePayload } from './ipc-payloads.js';
import { logger } from '../infrastructure/logger.js';

let timer: NodeJS.Timeout | undefined;
let active: Promise<void> | undefined;
let stopping = false;

function failure(row: DurableRequest, unknown = false) {
  const payload = buildAiChatErrorResponsePayload({
    accountId: row.account_id,
    requestId: row.request_id,
    sessionId: row.session_id,
    userMessageId: row.user_message_id ?? undefined,
    ownerUserId: row.owner_user_id,
    publicErrorText: unknown
      ? 'The agent was interrupted. Please send your message again.'
      : 'This request could not be started. Please send your message again.',
    error: unknown
      ? 'Agent execution interrupted; outcome unknown'
      : 'Request expired, cancelled, or runtime configuration changed',
    reasonCode: 'agent_process_exited',
  });
  return unknown
    ? {
        ...payload,
        metadata: {
          ...(payload.metadata as Record<string, unknown>),
          synthetic_terminal: true,
        },
      }
    : payload;
}

async function deliver(row: DurableRequest, result: unknown): Promise<void> {
  await processAiChatOutboxPayload(
    result,
    row.account_id,
    getPendingAiChatRequests(),
  );
  await releaseGlobalAgentSlot(row.request_id);
}

export async function recoverAgentRequest(row: DurableRequest): Promise<void> {
  if (row.state === 'result_ready') {
    await deliver(row, row.result);
    return;
  }
  if (row.state === 'running' || row.state === 'interrupted') {
    // Starting the daemon replays local result files; it does not resubmit the model request.
    await ensureLocalAgentRunning(row.account_id);
    // An execution may have reached the provider. Retrying it would risk a second charge.
    const result = failure(row, true);
    if (await interruptAgentRequest(row.request_id, result)) {
      await deliver(row, result);
      await acknowledgeAgentInterruption(row.request_id);
    }
    return;
  }
  if (
    row.cancel_requested_at ||
    new Date(row.deadline_at).getTime() <= Date.now()
  ) {
    const result = await persistAgentFailure(row.request_id, failure(row));
    if (result) await deliver(row, result);
    return;
  }
  const current = await resolveUserLlmRuntime(row.owner_user_id);
  const identity = [
    'source',
    'modelConfigId',
    'piApi',
    'model',
    'providerKey',
    'authMode',
  ] as const;
  if (
    identity.some((key) => current[key] !== row.runtime[key]) ||
    (current.baseUrl || undefined) !== row.runtime.baseUrl
  ) {
    const result = await persistAgentFailure(row.request_id, failure(row));
    if (result) await deliver(row, result);
    return;
  }
  await releaseGlobalAgentSlot(row.request_id);
  await submitAiChatInboxRequest({
    ...row.input,
    requestId: row.request_id,
    accountId: row.account_id,
    sessionId: row.session_id,
    userMessageId: row.user_message_id ?? undefined,
    recoveryExecutionId: row.execution_id,
    recoveryDeadlineAt: new Date(row.deadline_at).toISOString(),
    llmRuntime: {
      ...current,
      ...row.runtime,
      secret: current.secret,
      baseUrl: row.runtime.baseUrl ?? null,
      contextWindowTokens:
        row.runtime.contextWindowTokens ?? current.contextWindowTokens,
      maxOutputTokens: row.runtime.maxOutputTokens ?? current.maxOutputTokens,
      thinkingLevel: current.thinkingLevel,
      inputTokenPricePerMillionCoins:
        row.runtime.inputTokenPricePerMillionCoins ?? 0,
      outputTokenPricePerMillionCoins:
        row.runtime.outputTokenPricePerMillionCoins ?? 0,
    },
    waitForResponse: false,
  });
}

export async function runAgentRequestRecoveryOnce(): Promise<void> {
  if (active) return active;
  active = (async () => {
    await renewAgentRequestLeases([...getPendingAiChatRequests().keys()]);
    for (let count = 0; count < 32 && !stopping; count += 1) {
      const [request] = await takeRecoverableRequests();
      if (!request) break;
      try {
        await recoverAgentRequest(request);
      } catch (err) {
        logger.error(
          { requestId: request.request_id, err },
          'Agent request recovery failed; retained for retry',
        );
      }
    }
  })();
  try {
    await active;
  } finally {
    active = undefined;
  }
}

export function startAgentRequestRecovery(): void {
  if (timer) return;
  stopping = false;
  let renewing = false;
  const tick = () => {
    // Lease renewal must not wait behind a slow recovery of another account.
    if (!renewing) {
      renewing = true;
      void renewAgentRequestLeases([...getPendingAiChatRequests().keys()])
        .catch((err) =>
          logger.error({ err }, 'Agent admission lease renewal failed'),
        )
        .finally(() => {
          renewing = false;
        });
    }
    void runAgentRequestRecoveryOnce().catch((err) =>
      logger.error({ err }, 'Agent request recovery scan failed'),
    );
  };
  timer = setInterval(tick, 10_000);
  timer.unref();
  tick();
}

export async function stopAgentRequestRecovery(): Promise<void> {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = undefined;
  await active;
}
