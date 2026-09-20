import { getDbPool } from '../infrastructure/db-pool.js';
/**
 * 计费兜底扫描任务（billing sweeper）。
 *
 * 正常结算依赖 API 进程内存里的 pending（携带 runtime 价格）：请求被取消、超时、
 * 或进程重启导致 pending 丢失时，settle 被跳过，预留行永久停在 charge_state='pending'，
 * 对应已真实消耗的 Token 永不入账（漏收）。reconcileStaleBillingReservations 只处理
 * hold_state='held' 的历史冻结，对新预留（恒为 'none'）空转，无法兜底。
 *
 * 本任务按 charge_state 维度兜底：
 * - 预留已有对话日志（请求确已结束并上报 usage）→ 按日志里的真实 usage 结算（取消/丢 pending 都靠它补收）。
 * Durable results with actual usage can settle before user-message delivery.
 * Durable requests without known usage remain pending for late results.
 * Legacy reservations without a durable request still use the historical lost threshold.
 * - 其余（年龄不足或无日志但未超丢失阈值）→ 跳过，可能仍在途。
 *
 * settleUserModelChargeCoins 以 charge_state 幂等，本任务与正常结算并发安全：谁先结算谁生效，
 * 另一方读到 'charged' 即短路，且双方用的是同一份响应 usage（日志由响应落库），金额一致。
 */

import {
  getConversationLogByRequestId,
  listStalePendingReservations,
} from '../infrastructure/db.js';
import { sendOpsAlert } from '../infrastructure/alerts.js';
import { logger } from '../infrastructure/logger.js';
import { recoverStalePendingReservation } from '../modules/billing/plans.js';
import {
  normalizeRuntimeTokenUsage,
  type RuntimeTokenUsageInput,
} from './token-usage.js';

/** 扫描运行间隔：每 10 分钟一次。 */
const BILLING_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 最小处理年龄：只碰创建超过此时长的预留。
 * 正常结算在响应到达后毫秒级完成，留足缓冲避免与在途/刚完成的请求抢结算（虽幂等但减少无谓写）。
 */
const BILLING_SWEEP_MIN_AGE_MS = 5 * 60 * 1000;

/**
 * 丢失阈值：无对话日志且创建超过此时长的预留视为彻底丢失（usage 不可恢复），按 0 关账。
 * 取值远大于 AGENT_REQUEST_TIMEOUT（默认 30 分钟），确保不会把仍在途的请求误判为丢失。
 */
const BILLING_SWEEP_LOST_MS = 2 * 60 * 60 * 1000;

/** 单批处理上限。 */
const BILLING_SWEEP_BATCH = 100;

let sweepTimer: NodeJS.Timeout | null = null;

/**
 * 从对话日志安全提取 Token 用量。
 *
 * @param usage conversation_logs.usage（jsonb，已解析为对象或 null）。
 * @returns 归一化后的真实用量；无日志或字段缺失时各项为 0。
 */
function extractUsageFromLog(usage: unknown): {
  promptTokens: number;
  completionTokens: number;
} {
  const normalized = normalizeRuntimeTokenUsage(
    (usage ?? undefined) as RuntimeTokenUsageInput | undefined,
  );
  return {
    promptTokens: normalized.promptTokens,
    completionTokens: normalized.completionTokens,
  };
}

/**
 * 跑一轮兜底扫描。错误逐条吞掉，单条失败不影响其余预留。
 */
export async function runBillingSweepOnce(): Promise<void> {
  const now = Date.now();
  const staleBeforeIso = new Date(now - BILLING_SWEEP_MIN_AGE_MS).toISOString();
  const lostBeforeMs = now - BILLING_SWEEP_LOST_MS;

  let reservations;
  try {
    reservations = await listStalePendingReservations(
      staleBeforeIso,
      BILLING_SWEEP_BATCH,
    );
  } catch (err) {
    logger.warn({ err }, '计费兜底扫描：查询陈旧预留失败');
    return;
  }

  let settledWithUsage = 0;
  let closedAsLost = 0;
  let skipped = 0;

  for (const reservation of reservations) {
    try {
      const log = await getConversationLogByRequestId(reservation.request_id);
      if (log) {
        // 有对话日志 → 请求确已结束并上报了 usage，按真实用量补结算（usage 可能为 0）。
        const usage = extractUsageFromLog(log.usage);
        const result = await recoverStalePendingReservation({
          requestId: reservation.request_id,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
        });
        if (result) {
          settledWithUsage++;
          logger.info(
            {
              requestId: reservation.request_id,
              userId: reservation.user_id,
              actualChargeCoins: result.actualChargeCoins,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
            },
            '计费兜底扫描：按对话日志真实用量补结算陈旧预留',
          );
        }
        continue;
      }

      // A durable execution without final usage may still report late. Zero-closing
      // its reservation would make actual consumption impossible to settle later.
      const durable = await getDbPool().query(
        'SELECT state,result FROM agent_requests WHERE request_id=$1 LIMIT 1',
        [reservation.request_id],
      );
      if (durable.rowCount) {
        const row = durable.rows[0];
        const result = row?.result as
          | {
              metadata?: { synthetic_terminal?: unknown };
              usage?: RuntimeTokenUsageInput;
            }
          | null
          | undefined;
        const actualUsage = result?.usage;
        const hasKnownUsage =
          actualUsage &&
          ['promptTokens', 'completionTokens', 'totalTokens'].some((key) => {
            const value = actualUsage[key as keyof RuntimeTokenUsageInput];
            return (
              typeof value === 'number' && Number.isFinite(value) && value >= 0
            );
          });
        if (
          ['result_ready', 'completed'].includes(row?.state) &&
          result?.metadata?.synthetic_terminal !== true &&
          hasKnownUsage
        ) {
          // Model consumption is chargeable even if the user-message transaction failed.
          const usage = extractUsageFromLog(actualUsage);
          const settled = await recoverStalePendingReservation({
            requestId: reservation.request_id,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
          });
          if (settled) settledWithUsage++;
          continue;
        }
        skipped++;
        continue;
      }

      const createdAtMs = new Date(reservation.created_at).getTime();
      if (Number.isFinite(createdAtMs) && createdAtMs < lostBeforeMs) {
        // 无对话日志且超过丢失阈值 → usage 不可恢复，按 0 关账收尾。
        await recoverStalePendingReservation({
          requestId: reservation.request_id,
          promptTokens: 0,
          completionTokens: 0,
        });
        closedAsLost++;
        logger.warn(
          {
            requestId: reservation.request_id,
            userId: reservation.user_id,
            createdAt: reservation.created_at,
          },
          '计费兜底扫描：无对话日志且超期，按 0 关账收尾悬挂预留',
        );
        continue;
      }

      skipped++;
    } catch (err) {
      logger.warn(
        { requestId: reservation.request_id, err },
        '计费兜底扫描：单条预留兜底结算失败',
      );
    }
  }

  if (settledWithUsage > 0 || closedAsLost > 0) {
    logger.info(
      {
        scanned: reservations.length,
        settledWithUsage,
        closedAsLost,
        skipped,
      },
      '计费兜底扫描完成',
    );
    // 按 0 关账 = 真实消耗的 token 永久漏收，属于需要人工关注的异常（可能意味着
    // conversation_logs 落库链路出了问题），升级为运维告警。
    if (closedAsLost > 0) {
      void sendOpsAlert({
        kind: 'billing_reservation_lost',
        title: '计费兜底扫描发现无法恢复的预留，已按 0 关账',
        detail: `本轮按 0 关账 ${closedAsLost} 条（无对话日志且超过丢失阈值），存在漏收`,
        context: {
          closedAsLost,
          settledWithUsage,
          scanned: reservations.length,
        },
      });
    }
  } else {
    logger.debug(
      { scanned: reservations.length, skipped },
      '计费兜底扫描：本轮无需兜底结算的预留',
    );
  }
}

/**
 * 启动计费兜底扫描后台任务。
 * - 启动时立即跑一次（覆盖"进程重启遗留 pending 预留"的场景）
 * - 之后每 10 分钟跑一次
 */
export function startBillingSweepWorker(): void {
  if (sweepTimer) {
    logger.warn('计费兜底扫描任务已在运行，跳过重复启动');
    return;
  }
  logger.info(
    {
      intervalMs: BILLING_SWEEP_INTERVAL_MS,
      minAgeMs: BILLING_SWEEP_MIN_AGE_MS,
      lostMs: BILLING_SWEEP_LOST_MS,
    },
    '启动计费兜底扫描后台任务',
  );
  runBillingSweepOnce().catch(() => {
    /* 错误已在 runBillingSweepOnce 内部 logger.warn */
  });
  sweepTimer = setInterval(() => {
    runBillingSweepOnce().catch(() => {
      /* 同上 */
    });
  }, BILLING_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

/** 停止计费兜底扫描任务，用于测试或优雅关闭。 */
export function stopBillingSweepWorker(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
