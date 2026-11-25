import {
  admitAiChatRequest,
  type ChatAdmissionState,
} from './ai-chat-admission.js';
import type { AgentInboxRequest } from '@fateclaw/contracts/agent';
import { logger } from '#infrastructure/logger';
import { getRedis } from '#infrastructure/redis';
import {
  markAgentRequestDispatched,
  persistAgentFailure,
  requestAgentCancellation,
} from '#infrastructure/repositories/agent-requests-repository';
import {
  ModelSelectionError,
  tryAcquireBenefitExecutionSlot,
} from '#infrastructure/repositories/benefit-repository';
import { settleBillingReservationDetailed } from '#modules/billing/plans';
import {
  AI_CHAT_REQUEST_TIMEOUT_MS as AI_CHAT_REQUEST_TIMEOUT,
  MAX_REQUEST_TIMEOUT_MS,
  SESSION_PROCESSING_LOCK_TTL_SECONDS,
} from '#shared/timeout-chain';
import { recordAgentTiming } from './agent-performance.js';
import {
  acquireAgentExecution,
  releaseGlobalAgentSlot,
} from './agent-scheduler.js';
import { processAiChatOutboxPayload } from './ipc-ai-chat-outbox-handler.js';
import {
  buildAiChatErrorResponsePayload,
  type InboxRequestResult,
  type PendingInboxRequest,
} from './ipc-payloads.js';
import { encodeRuntimeIpc } from './ipc-security.js';
import { releasePerUserMeteredSlotByRequestId } from './metered-request-slots.js';
import {
  releaseLocalAgentLeaseById,
  releaseLocalAgentLeaseForPending,
} from './request-agent-lease.js';
import type { AiChatSubmission } from './request-types.js';
import {
  claimOrRefreshSessionProcessingLock,
  releaseSessionProcessingLock,
} from './session-processing-lock.js';

const GLOBAL_AGENT_GATE_POLL_MS = 500;

async function enqueueInboxPayload(
  accountId: string,
  priority: 'member' | 'normal',
  payload: string,
) {
  const key =
    priority === 'member'
      ? `ipc:${accountId}:inbox:member`
      : `ipc:${accountId}:inbox`;
  await getRedis().lpush(
    key,
    encodeRuntimeIpc(accountId, key, payload, MAX_REQUEST_TIMEOUT_MS),
  );
}

export function submitAiChatRequest(
  input: AiChatSubmission,
  pendingAiChatRequests: Map<string, PendingInboxRequest>,
  addAccountListener: (accountId: string) => void,
): Promise<InboxRequestResult> {
  const requestId =
    input.requestId ??
    `aichat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAtMs = Date.now();
  const aiChatOutboxQueue = `ipc:${input.accountId}:ai-chat:outbox`;
  let acceptedEarly = false;
  let payloadQueued = false;
  let payloadEnqueueAttempted = false;
  const admission: ChatAdmissionState = {
    executionId: input.recoveryExecutionId,
    billingReservation: null,
  };
  const deadlineAtMs = input.recoveryDeadlineAt
    ? Date.parse(input.recoveryDeadlineAt)
    : startedAtMs + AI_CHAT_REQUEST_TIMEOUT;

  return new Promise<InboxRequestResult>((resolve, reject) => {
    void (async () => {
      let timeout: NodeJS.Timeout | null = null;
      let concurrencySlotId: string | undefined;
      let localAgentLeaseId: string | undefined;

      try {
        const result = await admitAiChatRequest(
          input,
          requestId,
          deadlineAtMs,
          admission,
        );
        if ('rejected' in result) {
          reject(new Error(result.rejected));
          return;
        }
        const { ownerUserId, priority, llmRuntime, executionId } = result;
        const { billingReservation } = admission;

        timeout = setTimeout(
          async () => {
            void requestAgentCancellation(requestId).catch((err) => {
              logger.error(
                { requestId, err },
                'Failed to persist request timeout cancellation',
              );
            });
            const pending = pendingAiChatRequests.get(requestId);
            pendingAiChatRequests.delete(requestId);
            // 清除当前请求持有的会话忙碌标记，避免误删后续请求的锁。
            void releaseSessionProcessingLock(input.sessionId, requestId).catch(
              () => {},
            );
            void releaseGlobalAgentSlot(
              pending?.concurrencySlotId ?? concurrencySlotId ?? requestId,
            );
            void releasePerUserMeteredSlotByRequestId(requestId);
            void releaseLocalAgentLeaseForPending(pending, {
              accountId: input.accountId,
              requestId,
              reason: 'timeout',
            });
            logger.error(
              {
                accountId: input.accountId,
                requestId,
                sessionId: input.sessionId,
              },
              'AI Chat 请求超时',
            );
            reject(new Error(`AI Chat 请求超时: ${requestId}`));
          },
          Math.max(1, deadlineAtMs - Date.now()),
        );

        pendingAiChatRequests.set(requestId, {
          accountId: input.accountId,
          ownerUserId,
          toUserId: undefined,
          contextToken: undefined,
          autoDeliver: false, // AI Chat 永远不发微信
          sessionId: input.sessionId,
          userMessageId: input.userMessageId,
          sessionProcessingRequestId: requestId,
          llmRuntime,
          billingReservation,
          startedAtMs,
          timings: [
            {
              type: 'agent_timing',
              stage: 'admission',
              durationMs: Date.now() - startedAtMs,
            },
          ],
          priority,
          concurrencySlotId,
          resolve,
          reject,
          timeout,
        });
        recordAgentTiming('admission', Date.now() - startedAtMs);
        if (input.waitForResponse === false) {
          acceptedEarly = true;
          resolve({ requestId, status: 'success', text: '' });
        }
        concurrencySlotId = await acquireAgentExecution({
          requestId,
          accountId: input.accountId,
          priority,
          deadlineAtMs,
          beforeGlobal: async () => {
            if (llmRuntime.poolKey === 'benefit') {
              while (!(await tryAcquireBenefitExecutionSlot(requestId))) {
                if (
                  !pendingAiChatRequests.has(requestId) ||
                  Date.now() >= deadlineAtMs
                )
                  throw new Error(
                    '免费服务繁忙，请稍后重试。本次未扣免费次数。',
                  );
                await new Promise<void>((done) =>
                  setTimeout(done, GLOBAL_AGENT_GATE_POLL_MS),
                );
              }
            }
          },
          onTiming: (stage, durationMs) => {
            recordAgentTiming(stage, durationMs);
            pendingAiChatRequests
              .get(requestId)
              ?.timings?.push({ type: 'agent_timing', stage, durationMs });
          },
          shouldContinue: () =>
            pendingAiChatRequests.has(requestId) && Date.now() < deadlineAtMs,
          onRuntimeReady: (leaseId, capacityToken) => {
            const pending = pendingAiChatRequests.get(requestId);
            if (!pending) return false;
            localAgentLeaseId = leaseId;
            pending.localAgentLeaseId = leaseId;
            pending.capacityToken = capacityToken;
            addAccountListener(input.accountId);
            return true;
          },
          onAcquired: (slotId) => {
            concurrencySlotId = slotId;
            const pending = pendingAiChatRequests.get(requestId);
            if (pending) pending.concurrencySlotId = slotId;
          },
        });
        if (!pendingAiChatRequests.has(requestId))
          throw new Error('请求已取消或超时');

        const envelope: AgentInboxRequest = {
          type: 'chat',
          requestId,
          executionId,
          accountId: input.accountId,
          userMessage: input.userMessage,
          inputKind: input.inputKind,
          pastedBoard: input.pastedBoard,
          history: input.history,
          sessionBoardContexts: input.sessionBoardContexts,
          piSessionBase: input.piSessionBase,
          acceptedAtMs: startedAtMs,
          sessionId: input.sessionId,
          userMessageId: input.userMessageId,
          ownerUserId,
          userName: input.userName,
          assistantName: input.assistantName,
          personaPrompt: input.personaPrompt,
          authorizedSkillIds: input.authorizedSkillIds,
          llmRuntime,
          timestamp: new Date().toISOString(),
          outboxQueue: aiChatOutboxQueue,
        };

        // chat-session-service 已用同一个 requestId 预抢占锁；这里仅续期自有锁，避免旧请求覆盖新 owner。
        const processingClaimed = await claimOrRefreshSessionProcessingLock(
          input.sessionId,
          requestId,
          SESSION_PROCESSING_LOCK_TTL_SECONDS, // 从超时链派生（API 超时 + 5 分钟缓冲）
        );
        if (!processingClaimed) {
          throw new Error('会话正在处理其他请求');
        }

        const pending = pendingAiChatRequests.get(requestId);
        if (!pending) {
          throw new Error('请求已取消或超时');
        }
        if (!(await markAgentRequestDispatched(requestId))) {
          throw new Error('Request cancelled, expired, or claimed by recovery');
        }
        payloadEnqueueAttempted = true;
        await enqueueInboxPayload(
          input.accountId,
          pending.priority ?? 'normal',
          JSON.stringify(envelope),
        );
        payloadQueued = true;
        logger.info(
          {
            accountId: input.accountId,
            requestId,
            sessionId: input.sessionId,
            outboxQueue: aiChatOutboxQueue,
            billingRecorded: Boolean(billingReservation),
            priority: pending.priority ?? 'normal',
            concurrencySlotId,
          },
          'AI Chat 请求已提交到 Redis',
        );
      } catch (err) {
        const {
          executionId,
          runtime: admissionRuntime,
          billingReservation,
        } = admission;
        let submissionFailure: unknown = null;
        if (
          err instanceof ModelSelectionError &&
          !executionId &&
          billingReservation &&
          admissionRuntime
        ) {
          // A selection conflict occurs before admission or dispatch; its zero-usage reservation can close immediately.
          try {
            await settleBillingReservationDetailed({
              requestId,
              runtime: admissionRuntime,
              promptTokens: 0,
              completionTokens: 0,
            });
          } catch (error) {
            logger.error(
              { requestId, err: error },
              'Failed to close undispatched billing reservation',
            );
          }
        }
        if (executionId && !payloadQueued) {
          submissionFailure = await persistAgentFailure(
            requestId,
            buildAiChatErrorResponsePayload({
              accountId: input.accountId,
              requestId,
              sessionId: input.sessionId,
              userMessageId: input.userMessageId,
              ownerUserId: input.entitlementSnapshot?.userId,
              publicErrorText: '抱歉，AI 服务暂时不可用',
              error: 'Request submission interrupted',
              reasonCode: 'submit_error',
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            }),
          ).catch((failure) =>
            logger.error(
              { requestId, err: failure },
              'Failed to persist submission failure',
            ),
          );
        }
        // 占用的 per-user metered 名额在任何失败分支都要释放,否则低余额用户会被永久卡住。
        await releasePerUserMeteredSlotByRequestId(requestId).catch(() => {});
        if (acceptedEarly && !payloadQueued) {
          if (!submissionFailure) {
            const pending = pendingAiChatRequests.get(requestId);
            if (!payloadEnqueueAttempted && pending) {
              if (pending.capacityToken)
                await releaseGlobalAgentSlot(
                  requestId,
                  pending.capacityToken,
                ).catch(() => {});
              await releaseLocalAgentLeaseForPending(pending, {
                accountId: input.accountId,
                requestId,
                reason: 'undispatched_submission_failure',
              });
              clearTimeout(pending.timeout);
              pendingAiChatRequests.delete(requestId);
            }
            return;
          }
          await releaseGlobalAgentSlot(concurrencySlotId ?? requestId);
          const pending = pendingAiChatRequests.get(requestId);
          if (pending) {
            await processAiChatOutboxPayload(
              submissionFailure,
              input.accountId,
              pendingAiChatRequests,
            ).catch((handlerErr) => {
              clearTimeout(pending.timeout);
              pendingAiChatRequests.delete(requestId);
              void releaseSessionProcessingLock(
                input.sessionId,
                requestId,
              ).catch(() => {});
              void releaseLocalAgentLeaseForPending(pending, {
                accountId: input.accountId,
                requestId,
                reason: 'submit_error_fallback',
              });
              logger.error(
                { accountId: input.accountId, requestId, err: handlerErr },
                'AI Chat 入队失败后的错误消息落库失败',
              );
            });
          }
          return;
        }
        if (timeout) {
          clearTimeout(timeout);
        }
        const pending = pendingAiChatRequests.get(requestId);
        pendingAiChatRequests.delete(requestId);
        void releaseSessionProcessingLock(input.sessionId, requestId).catch(
          () => {},
        );
        void releaseGlobalAgentSlot(concurrencySlotId ?? requestId);
        if (pending) {
          void releaseLocalAgentLeaseForPending(pending, {
            accountId: input.accountId,
            requestId,
            reason: 'submit_error',
          });
        } else {
          void releaseLocalAgentLeaseById(localAgentLeaseId, {
            accountId: input.accountId,
            requestId,
            reason: 'submit_error',
          });
        }
        reject(
          err instanceof Error
            ? err
            : new Error(`写入 Redis 收件箱失败: ${String(err)}`),
        );
      }
    })().catch(reject);
  });
}
