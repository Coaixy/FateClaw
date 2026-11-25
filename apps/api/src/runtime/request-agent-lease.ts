import { logger } from '#infrastructure/logger';
import type { PendingInboxRequest } from './ipc-payloads.js';
import { releaseLocalAgent } from './local-runner.js';

export async function releaseLocalAgentLeaseForPending(
  pending: PendingInboxRequest | undefined,
  context: { accountId?: string; requestId?: string; reason: string },
): Promise<void> {
  if (!pending?.localAgentLeaseId) return;
  await releaseLocalAgent(pending.localAgentLeaseId).catch((err) => {
    logger.warn(
      {
        accountId: context.accountId ?? pending.accountId,
        requestId: context.requestId,
        reason: context.reason,
        err,
      },
      '释放本地 agent-runtime 租约失败',
    );
  });
}

export async function releaseLocalAgentLeaseById(
  leaseId: string | undefined,
  context: { accountId?: string; requestId?: string; reason: string },
): Promise<void> {
  if (!leaseId) return;
  await releaseLocalAgent(leaseId).catch((err) => {
    logger.warn(
      {
        accountId: context.accountId,
        leaseId,
        requestId: context.requestId,
        reason: context.reason,
        err,
      },
      '释放本地 agent-runtime 租约失败',
    );
  });
}
