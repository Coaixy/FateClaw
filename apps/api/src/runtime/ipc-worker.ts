/**
 * IPC 工作线程：Redis BRPOP 监听 + 收件箱请求管理。
 * 具体的 outbox / tasks 消息处理逻辑拆分到各自的 handler 模块。
 */

import { Redis } from 'ioredis';

import { getUserByAccountId, getUserById } from '../infrastructure/db.js';
import { processOutboxPayload } from './ipc-outbox-handler.js';
import { processAiChatOutboxPayload } from './ipc-ai-chat-outbox-handler.js';

/** Agent 请求超时时间（默认 30 分钟） */
const AGENT_REQUEST_TIMEOUT = parseInt(
  process.env.AGENT_REQUEST_TIMEOUT || '1800000',
  10,
);
import {
  InboxRequestResult,
  type LlmRuntimeSnapshot,
  PendingInboxRequest,
} from './ipc-payloads.js';
import { processTaskPayload } from './ipc-task-handler.js';
import { logger } from '../infrastructure/logger.js';
import type { BillingReservation } from '../modules/billing/plans.js';
import {
  releaseBillingReservation,
  reserveBillingForRequest,
} from '../modules/billing/plans.js';
import { getRedis } from '../infrastructure/redis.js';
import {
  resolveUserLlmRuntime,
  type EffectiveLlmRuntimeConfig,
} from '../modules/system/system-config.js';
import { FREE_WECHAT_UNSUPPORTED_MESSAGE } from '../modules/account/account-service.js';
import { getUserIdFromWebChatRuntimeId } from '../modules/chat/web-chat-runtime.js';
import type { User } from '../shared/types.js';
import type {
  ActiveBoardContext,
  HistoryMessage,
} from '../shared/token-budget.js';

type ChatInputKind = 'normal' | 'user_pasted_board';

interface UserPastedBoardInput {
  category: string;
  content: string;
  question: string;
}

export type { InboxRequestResult } from './ipc-payloads.js';

async function resolveLlmRuntimeSnapshot(
  userId: string,
): Promise<LlmRuntimeSnapshot> {
  const runtime = await resolveUserLlmRuntime(userId);
  return llmRuntimeToSnapshot(runtime);
}

function llmRuntimeToSnapshot(
  runtime: EffectiveLlmRuntimeConfig,
): LlmRuntimeSnapshot {
  return {
    source: runtime.source,
    billingMode: runtime.billingMode,
    modelConfigId: runtime.modelConfigId,
    provider: runtime.providerType,
    model: runtime.model,
    contextWindowTokens: runtime.contextWindowTokens,
    maxOutputTokens: runtime.maxOutputTokens,
    apiKey: runtime.secret,
    baseUrl: runtime.baseUrl || undefined,
    authMode: runtime.authMode,
    providerKey: runtime.providerKey,
    inputTokenPricePerMillionPoints: runtime.inputTokenPricePerMillionPoints,
    outputTokenPricePerMillionPoints: runtime.outputTokenPricePerMillionPoints,
  };
}

let ipcWorkerRunning = false;
const pendingInboxRequests = new Map<string, PendingInboxRequest>();
/** AI Chat 专属的 pending 请求 Map（完全隔离） */
const pendingAiChatRequests = new Map<string, PendingInboxRequest>();
const accountListeners = new Map<string, { running: boolean; redis: Redis }>();

async function getOwnerByRuntimeId(
  runtimeId: string,
): Promise<User | undefined> {
  const webUserId = getUserIdFromWebChatRuntimeId(runtimeId);
  return webUserId ? getUserById(webUserId) : getUserByAccountId(runtimeId);
}

/**
 * 为单个 account 启动 BRPOP 监听协程。
 */
async function listenForAccount(accountId: string): Promise<void> {
  const redis = getRedis().duplicate();
  const listener = { running: true, redis };
  accountListeners.set(accountId, listener);

  logger.info({ accountId }, '启动 Redis IPC 监听');

  try {
    while (listener.running) {
      const result = await redis.brpop(
        `ipc:${accountId}:outbox`,
        `ipc:${accountId}:ai-chat:outbox`, // AI Chat 专属队列
        `ipc:${accountId}:tasks`,
        1, // 1s 超时，允许优雅退出
      );

      if (!result) continue;

      const [queue, raw] = result;

      try {
        const payload = JSON.parse(raw) as unknown;
        if (queue.endsWith(':ai-chat:outbox')) {
          // AI Chat 专属队列：永远不发微信
          await processAiChatOutboxPayload(
            payload,
            accountId,
            pendingAiChatRequests,
          );
        } else if (queue.endsWith(':outbox')) {
          await processOutboxPayload(payload, accountId, pendingInboxRequests);
        } else {
          await processTaskPayload(payload, accountId);
        }
      } catch (error) {
        logger.error(
          { accountId, queue, err: error },
          '处理 Redis IPC 消息失败',
        );

        // 兜底：如果 outbox response 处理失败且 pending 仍未被 resolve，在此清理
        if (queue.endsWith(':outbox')) {
          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            const requestId =
              typeof parsed.requestId === 'string'
                ? parsed.requestId
                : undefined;
            if (requestId) {
              // 根据队列类型选择对应的 pending Map
              const pendingMap = queue.endsWith(':ai-chat:outbox')
                ? pendingAiChatRequests
                : pendingInboxRequests;
              const pending = pendingMap.get(requestId);
              if (pending) {
                clearTimeout(pending.timeout);
                pendingMap.delete(requestId);
                const errorMsg =
                  error instanceof Error ? error.message : String(error);
                logger.warn(
                  { accountId, requestId },
                  '兜底 reject 未完成的 pending 请求',
                );
                pending.reject(new Error(`outbox 处理失败: ${errorMsg}`));
              }
            }
          } catch {
            // JSON 已经在上面成功解析过，这里不应失败，但保险起见忽略
          }
        }
      }
    }
  } finally {
    await redis.quit();
    accountListeners.delete(accountId);
    logger.info({ accountId }, 'Redis IPC 监听已停止');
  }
}

export function submitInboxRequest(input: {
  accountId: string;
  type: 'chat' | 'task';
  userMessage: string;
  history: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp?: string;
  }>;
  toUserId?: string;
  contextToken?: string;
  autoDeliver?: boolean;
  sessionId?: string;
  userName?: string;
  assistantName?: string;
  llmRuntime?: EffectiveLlmRuntimeConfig;
}): Promise<InboxRequestResult> {
  const requestId = `inbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise<InboxRequestResult>((resolve, reject) => {
    void (async () => {
      let timeout: NodeJS.Timeout | null = null;
      let billingReservation: BillingReservation | null = null;

      try {
        const owner = await getOwnerByRuntimeId(input.accountId);
        if (!owner?.id) {
          // 未绑定平台用户的账号不应消费 token：拒绝并明确日志，避免无追踪计费泄漏。
          logger.warn(
            { accountId: input.accountId, type: input.type },
            '收件箱请求被拒绝：账号未绑定到平台用户',
          );
          reject(new Error('账号未绑定平台用户，无法处理 AI 请求'));
          return;
        }
        if (input.autoDeliver ?? true) {
          reject(new Error(FREE_WECHAT_UNSUPPORTED_MESSAGE));
          return;
        }
        const llmRuntime = input.llmRuntime
          ? llmRuntimeToSnapshot(input.llmRuntime)
          : await resolveLlmRuntimeSnapshot(owner.id);
        billingReservation = await reserveBillingForRequest({
          userId: owner.id,
          requestId,
          runtime: llmRuntime,
        });

        timeout = setTimeout(async () => {
          // 超时时清除会话忙碌标记
          const pending = pendingInboxRequests.get(requestId);
          const sessionId = pending?.sessionId;
          pendingInboxRequests.delete(requestId);
          if (sessionId) {
            void getRedis()
              .del(`session:processing:${sessionId}`)
              .catch(() => {});
          }
          logger.error(
            { accountId: input.accountId, requestId, type: input.type },
            '收件箱请求超时',
          );
          try {
            await releaseBillingReservation(
              billingReservation,
              '请求超时，释放预扣额度',
            );
          } catch (err) {
            logger.error({ requestId, err }, '超时后释放预扣额度失败');
          }
          reject(new Error(`收件箱请求超时: ${requestId}`));
        }, AGENT_REQUEST_TIMEOUT);

        pendingInboxRequests.set(requestId, {
          accountId: input.accountId,
          ownerUserId: owner.id,
          toUserId: input.toUserId,
          contextToken: input.contextToken,
          autoDeliver: input.autoDeliver ?? true,
          sessionId: input.sessionId,
          llmRuntime,
          billingReservation,
          resolve,
          reject,
          timeout,
        });

        const payload = JSON.stringify({
          type: input.type,
          requestId,
          accountId: input.accountId,
          userMessage: input.userMessage,
          history: input.history,
          sessionId: input.sessionId,
          userName: input.userName,
          assistantName: input.assistantName,
          llmRuntime,
          timestamp: new Date().toISOString(),
        });

        // 写入会话忙碌标记（35 分钟 TTL，比 agent 超时 30min 多 5min 做缓冲）
        if (input.sessionId) {
          await getRedis().set(
            `session:processing:${input.sessionId}`,
            requestId,
            'EX',
            2100,
          );
        }

        await getRedis().lpush(`ipc:${input.accountId}:inbox`, payload);
        logger.info(
          {
            accountId: input.accountId,
            requestId,
            type: input.type,
            autoDeliver: input.autoDeliver ?? true,
            toUserId: input.toUserId,
            reservedPoints: billingReservation?.reservedPoints ?? 0,
          },
          '已提交收件箱请求到 Redis',
        );
      } catch (err) {
        if (timeout) {
          clearTimeout(timeout);
        }
        pendingInboxRequests.delete(requestId);
        try {
          await releaseBillingReservation(
            billingReservation,
            '请求未成功入队，释放预扣额度',
          );
        } catch (releaseErr) {
          logger.error(
            { requestId, err: releaseErr },
            '入队失败后释放预扣额度失败',
          );
        }
        reject(
          err instanceof Error
            ? err
            : new Error(`写入 Redis 收件箱失败: ${String(err)}`),
        );
      }
    })();
  });
}

export function startIpcWorker(enabledAccountIds: string[]): void {
  if (ipcWorkerRunning) {
    logger.debug('IPC 工作线程已在运行，跳过重复启动');
    return;
  }

  ipcWorkerRunning = true;
  logger.info(
    { accounts: enabledAccountIds.length },
    'Redis IPC 工作线程已启动',
  );

  for (const accountId of enabledAccountIds) {
    listenForAccount(accountId).catch((err) => {
      logger.error({ accountId, err }, 'Redis IPC 监听异常退出');
    });
  }
}

export function addAccountListener(accountId: string): void {
  if (accountListeners.has(accountId)) {
    logger.debug({ accountId }, 'Redis IPC 监听已存在，跳过');
    return;
  }
  listenForAccount(accountId).catch((err) => {
    logger.error({ accountId, err }, 'Redis IPC 监听异常退出');
  });
}

export function removeAccountListener(accountId: string): void {
  const listener = accountListeners.get(accountId);
  if (listener) {
    listener.running = false;
    logger.info({ accountId }, '正在停止 Redis IPC 监听');
  }
}

export function _resetIpcWorkerForTests(): void {
  for (const pending of pendingInboxRequests.values()) {
    clearTimeout(pending.timeout);
  }
  pendingInboxRequests.clear();
  for (const pending of pendingAiChatRequests.values()) {
    clearTimeout(pending.timeout);
  }
  pendingAiChatRequests.clear();
  for (const listener of accountListeners.values()) {
    listener.running = false;
  }
  accountListeners.clear();
  ipcWorkerRunning = false;
}

/** AI Chat 请求超时时间（默认 30 分钟） */
const AI_CHAT_REQUEST_TIMEOUT = parseInt(
  process.env.AI_CHAT_REQUEST_TIMEOUT || '1800000',
  10,
);

/**
 * AI Chat 专属的入队函数。
 * 响应写入 `ipc:{accountId}:ai-chat:outbox`，永远不发微信。
 */
export function submitAiChatInboxRequest(input: {
  accountId: string;
  userMessage: string;
  inputKind?: ChatInputKind;
  pastedBoard?: UserPastedBoardInput;
  history: HistoryMessage[];
  activeBoardContext?: ActiveBoardContext;
  sessionId: string;
  userName?: string;
  assistantName?: string;
  personaPrompt?: string;
  llmRuntime?: EffectiveLlmRuntimeConfig;
}): Promise<InboxRequestResult> {
  const requestId = `aichat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const aiChatOutboxQueue = `ipc:${input.accountId}:ai-chat:outbox`;

  return new Promise<InboxRequestResult>((resolve, reject) => {
    void (async () => {
      let timeout: NodeJS.Timeout | null = null;
      let billingReservation: BillingReservation | null = null;

      try {
        const owner = await getOwnerByRuntimeId(input.accountId);
        if (!owner?.id) {
          // 未绑定平台用户的账号不应消费 token：拒绝并明确日志，避免无追踪计费泄漏。
          logger.warn(
            { accountId: input.accountId, kind: 'ai-chat' },
            '收件箱请求被拒绝：账号未绑定到平台用户',
          );
          reject(new Error('账号未绑定平台用户，无法处理 AI 请求'));
          return;
        }
        const llmRuntime = input.llmRuntime
          ? llmRuntimeToSnapshot(input.llmRuntime)
          : await resolveLlmRuntimeSnapshot(owner.id);
        billingReservation = await reserveBillingForRequest({
          userId: owner.id,
          requestId,
          runtime: llmRuntime,
        });

        timeout = setTimeout(async () => {
          pendingAiChatRequests.delete(requestId);
          // 清除会话忙碌标记
          void getRedis()
            .del(`session:processing:${input.sessionId}`)
            .catch(() => {});
          logger.error(
            {
              accountId: input.accountId,
              requestId,
              sessionId: input.sessionId,
            },
            'AI Chat 请求超时',
          );
          try {
            await releaseBillingReservation(
              billingReservation,
              '请求超时，释放预扣额度',
            );
          } catch (err) {
            logger.error({ requestId, err }, '超时后释放预扣额度失败');
          }
          reject(new Error(`AI Chat 请求超时: ${requestId}`));
        }, AI_CHAT_REQUEST_TIMEOUT);

        pendingAiChatRequests.set(requestId, {
          accountId: input.accountId,
          ownerUserId: owner.id,
          toUserId: undefined,
          contextToken: undefined,
          autoDeliver: false, // AI Chat 永远不发微信
          sessionId: input.sessionId,
          llmRuntime,
          billingReservation,
          resolve,
          reject,
          timeout,
        });

        const payload = JSON.stringify({
          type: 'chat',
          requestId,
          accountId: input.accountId,
          userMessage: input.userMessage,
          inputKind: input.inputKind,
          pastedBoard: input.pastedBoard,
          history: input.history,
          activeBoardContext: input.activeBoardContext,
          sessionId: input.sessionId,
          userName: input.userName,
          assistantName: input.assistantName,
          personaPrompt: input.personaPrompt,
          llmRuntime,
          timestamp: new Date().toISOString(),
          outboxQueue: aiChatOutboxQueue, // 指定响应队列
        });

        // 写入会话忙碌标记
        await getRedis().set(
          `session:processing:${input.sessionId}`,
          requestId,
          'EX',
          2100, // 35 分钟 TTL
        );

        await getRedis().lpush(`ipc:${input.accountId}:inbox`, payload);
        logger.info(
          {
            accountId: input.accountId,
            requestId,
            sessionId: input.sessionId,
            outboxQueue: aiChatOutboxQueue,
            reservedPoints: billingReservation?.reservedPoints ?? 0,
          },
          'AI Chat 请求已提交到 Redis',
        );
      } catch (err) {
        if (timeout) {
          clearTimeout(timeout);
        }
        pendingAiChatRequests.delete(requestId);
        try {
          await releaseBillingReservation(
            billingReservation,
            '请求未成功入队，释放预扣额度',
          );
        } catch (releaseErr) {
          logger.error(
            { requestId, err: releaseErr },
            '入队失败后释放预扣额度失败',
          );
        }
        reject(
          err instanceof Error
            ? err
            : new Error(`写入 Redis 收件箱失败: ${String(err)}`),
        );
      }
    })();
  });
}
