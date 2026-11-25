import type { LlmRuntimeSnapshot } from '@fateclaw/contracts/agent';
import { LOW_BALANCE_CONCURRENCY_THRESHOLD_COINS } from '#infrastructure/config';
import { getUserByAccountId, getUserById } from '#infrastructure/db';
import { logger } from '#infrastructure/logger';
import { admitAgentRequest } from '#infrastructure/repositories/agent-requests-repository';
import {
  getRuntimeEntitlementSnapshot,
  type RuntimeEntitlementSnapshot,
} from '#modules/billing/entitlements';
import {
  applyNonMemberPricingMarkup,
  reserveBillingForRequest,
  type BillingReservation,
} from '#modules/billing/plans';
import { getUserIdFromWebChatRuntimeId } from '#modules/chat/web-chat-runtime';
import {
  resolveUserLlmRuntime,
  type EffectiveLlmRuntimeConfig,
} from '#modules/system/system-config';
import type { User } from '#shared/types';
import {
  LOW_BALANCE_CONCURRENCY_MESSAGE,
  tryAcquirePerUserMeteredSlot,
} from './metered-request-slots.js';
import type { AiChatSubmission } from './request-types.js';

export interface ChatAdmissionState {
  billingReservation: BillingReservation | null;
  executionId?: string;
  runtime?: LlmRuntimeSnapshot;
}

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
    poolKey: runtime.poolKey,
    poolRevision: runtime.poolRevision,
    benefitPolicy: runtime.benefitPolicy,
    benefitRequestId: runtime.benefitRequestId,
    source: runtime.source,
    billingMode: runtime.billingMode,
    modelConfigId: runtime.modelConfigId,
    piApi: runtime.piApi,
    model: runtime.model,
    contextWindowTokens: runtime.contextWindowTokens,
    maxOutputTokens: runtime.maxOutputTokens,
    thinkingLevel: runtime.thinkingLevel,
    apiKey: runtime.secret,
    baseUrl: runtime.baseUrl || undefined,
    authMode: runtime.authMode,
    providerKey: runtime.providerKey,
    poolNodes: runtime.poolNodes,
    inputTokenPricePerMillionCoins: runtime.inputTokenPricePerMillionCoins,
    outputTokenPricePerMillionCoins: runtime.outputTokenPricePerMillionCoins,
  };
}

function resolveInboxPriority(
  entitlement: RuntimeEntitlementSnapshot,
): 'member' | 'normal' {
  return entitlement.hasPriorityQueue ? 'member' : 'normal';
}

function entitlementMetadata(snapshot: RuntimeEntitlementSnapshot) {
  return {
    membershipActive: snapshot.membershipActive,
    availableCoins: snapshot.wallet.availableCoins,
    wallet: {
      purchased_coins: snapshot.wallet.purchasedCoins,
      bonus_coins: snapshot.wallet.bonusCoins,
      reserved_coins: snapshot.wallet.reservedCoins,
      inArrears: snapshot.wallet.inArrears,
    },
  };
}

async function getOwnerByRuntimeId(
  runtimeId: string,
): Promise<User | undefined> {
  const webUserId = getUserIdFromWebChatRuntimeId(runtimeId);
  return webUserId ? getUserById(webUserId) : getUserByAccountId(runtimeId);
}

export async function admitAiChatRequest(
  input: AiChatSubmission,
  requestId: string,
  deadlineAtMs: number,
  state: ChatAdmissionState,
) {
  const ownerUserId =
    input.entitlementSnapshot?.userId ??
    (await getOwnerByRuntimeId(input.accountId))?.id;
  if (!ownerUserId) {
    // 未绑定平台用户的账号不应消费 token：拒绝并明确日志，避免无追踪计费泄漏。
    logger.warn(
      { accountId: input.accountId, kind: 'ai-chat' },
      '收件箱请求被拒绝：账号未绑定到平台用户',
    );
    return { rejected: '账号未绑定平台用户，无法处理 AI 请求' } as const;
  }
  const baseRuntime = input.llmRuntime
    ? llmRuntimeToSnapshot(input.llmRuntime)
    : await resolveLlmRuntimeSnapshot(ownerUserId);
  if (baseRuntime.poolKey === 'benefit')
    baseRuntime.benefitRequestId = requestId;
  const entitlement =
    input.entitlementSnapshot ??
    (await getRuntimeEntitlementSnapshot(ownerUserId));
  // 非会员专家模式加价：把官方模型 token 单价烙进快照，贯穿 reserve/settle/recover。
  const llmRuntime = applyNonMemberPricingMarkup(
    baseRuntime,
    entitlement.membershipActive,
  );

  state.runtime = llmRuntime;
  // per-user 余额感知并发门：低余额用户同一时刻只允许 1 个 metered 请求在跑，
  // 封住「多 session 并发把余额刷成大额欠费」的白嫖。健康余额用户不进入此门。
  // 置于一切资源分配（预留/定时器/pending/槽位）之前——被拒时无需任何清理。
  if (
    llmRuntime.billingMode === 'metered' &&
    entitlement.wallet.availableCoins < LOW_BALANCE_CONCURRENCY_THRESHOLD_COINS
  ) {
    const slotAcquired = await tryAcquirePerUserMeteredSlot({
      userId: ownerUserId,
      requestId,
      limit: 1,
    });
    if (!slotAcquired) {
      logger.info(
        {
          accountId: input.accountId,
          ownerUserId,
          requestId,
          availableCoins: entitlement.wallet.availableCoins,
        },
        'AI Chat 低余额用户已有 metered 请求在跑，拒绝并发新请求',
      );
      return { rejected: LOW_BALANCE_CONCURRENCY_MESSAGE } as const;
    }
  }

  state.billingReservation = await reserveBillingForRequest({
    userId: ownerUserId,
    requestId,
    runtime: llmRuntime,
    entitlementSnapshot: entitlementMetadata(entitlement),
  });
  const priority = resolveInboxPriority(entitlement);
  state.executionId ??= await admitAgentRequest({
    input: { ...input, entitlementSnapshot: entitlement },
    requestId,
    ownerUserId,
    runtime: baseRuntime,
    deadlineAt: deadlineAtMs,
  });
  return { ownerUserId, llmRuntime, priority, executionId: state.executionId };
}
