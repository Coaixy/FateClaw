/**
 * 一次性运维脚本：存量老用户补偿。
 *
 * 背景：付费体系从三层 C 端会员塌缩为单层"卦师使用权"。存量有效会员已自动承接为卦师版
 * 权益（权益只看 membership.active、不分档）；此脚本额外按"剩余时间比例 × 真实订阅扣费"
 * 把已付会员费折算成站内积分余额退还，作为老用户补贴。
 *
 * 用法：
 *   tsx apps/api/src/scripts/grandfather-refund.ts --dry-run   仅预览，不写库
 *   tsx apps/api/src/scripts/grandfather-refund.ts             实际退还
 *
 * 幂等：已生成 legacy_membership_refund 流水的用户会被跳过，重复执行安全。
 */
import { getDbPool, initDatabase } from '../infrastructure/db.js';
import { insertWalletTransaction } from '../infrastructure/repositories/billing-repository.js';

/** 老用户补偿的钱包流水 kind，兼作幂等标记。 */
const REFUND_KIND = 'legacy_membership_refund';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  await initDatabase();
  const pool = getDbPool();

  // 当前仍有效的存量会员（无论旧档位）。
  const { rows: memberships } = await pool.query<{
    user_id: string;
    plan_key: string;
    current_period_start: string;
    current_period_end: string;
  }>(
    `SELECT user_id, plan_key, current_period_start, current_period_end
       FROM user_memberships
      WHERE status = 'active' AND current_period_end > NOW()`,
  );

  console.log(
    `[老用户补偿]${dryRun ? '（DRY-RUN 预览）' : ''} 命中有效会员 ${memberships.length} 个`,
  );

  let refundedCount = 0;
  let refundedCoins = 0;

  for (const m of memberships) {
    // 幂等：已补偿过则跳过。
    const { rows: already } = await pool.query(
      `SELECT 1 FROM wallet_transactions
        WHERE user_id = $1 AND kind = $2 LIMIT 1`,
      [m.user_id, REFUND_KIND],
    );
    if (already.length > 0) {
      console.log(`  - 跳过（已补偿）: ${m.user_id}`);
      continue;
    }

    // 真实订阅扣费：取最近一笔 membership_subscription 流水（金额为负，取绝对值）。
    // 基准取真实扣费 → 赠送/后台开通无付费者自然为 0、被跳过。
    const { rows: paidRows } = await pool.query<{ amount_coins: string }>(
      `SELECT amount_coins FROM wallet_transactions
        WHERE user_id = $1 AND kind = 'membership_subscription'
        ORDER BY created_at DESC LIMIT 1`,
      [m.user_id],
    );
    const paidCoins = paidRows[0]
      ? Math.abs(Number(paidRows[0].amount_coins))
      : 0;
    if (!(paidCoins > 0)) {
      console.log(`  - 跳过（无真实付费，疑似赠送/后台开通）: ${m.user_id}`);
      continue;
    }

    // 剩余时间比例。
    const start = new Date(m.current_period_start).getTime();
    const end = new Date(m.current_period_end).getTime();
    const now = Date.now();
    const ratio =
      end > start ? Math.max(0, Math.min(1, (end - now) / (end - start))) : 0;
    const refund = Math.round(paidCoins * ratio * 100) / 100;
    if (!(refund > 0)) {
      console.log(`  - 跳过（折算后为 0）: ${m.user_id}`);
      continue;
    }

    console.log(
      `  ${dryRun ? '· 预览' : '✓ 退还'} ${refund} 积分 → ${m.user_id} ` +
        `(${m.plan_key}, 实付 ${paidCoins}, 剩余 ${(ratio * 100).toFixed(0)}%)`,
    );
    refundedCount += 1;
    refundedCoins += refund;

    if (dryRun) continue;

    // 单用户一个事务：加 purchased_coins + 记补偿流水，失败回滚不影响其他用户。
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users SET purchased_coins = purchased_coins + $1 WHERE id = $2`,
        [refund, m.user_id],
      );
      await insertWalletTransaction(client, {
        userId: m.user_id,
        kind: REFUND_KIND,
        amountCoins: refund,
        balanceSource: 'purchased',
        note: `老用户补偿：${m.plan_key} 剩余 ${(ratio * 100).toFixed(0)}% 会员费折算退还`,
        metadata: {
          plan_key: m.plan_key,
          paid_coins: paidCoins,
          remaining_ratio: ratio,
          period_start: m.current_period_start,
          period_end: m.current_period_end,
        },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  ✗ 退还失败 ${m.user_id}:`, err);
    } finally {
      client.release();
    }
  }

  console.log(
    `[老用户补偿] 完成：${dryRun ? '预计' : '实际'}退还 ${refundedCount} 人，合计 ${Math.round(refundedCoins * 100) / 100} 积分`,
  );
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('[老用户补偿] 执行失败:', err);
  process.exit(1);
});
