/**
 * 一次性运维脚本：存量老用户补偿。
 *
 * ⚠️ 已于会员单层化迁移后执行完毕（运营确认）。请勿再次运行——虽有幂等保护
 *    （已生成 legacy_membership_refund 流水的用户会被跳过），但它不属于常规流程，
 *    仅作历史归档保留，便于审计退款口径。
 *
 * 背景：付费体系从三层 C 端会员塌缩为单层"卦师使用权"。存量有效会员已自动承接为卦师版
 * 权益（权益只看 membership.active、不分档）；此脚本额外按"剩余额度比例 × 真实订阅扣费"
 * 把未消费的会员额度对应的费用折算成站内积分余额退还，作为老用户补贴。
 *
 * 口径：会员核心价值是月度 AI 额度，已消费的额度视为已享受、不退；只退当期未用完的额度部分。
 *   退款 = 真实订阅扣费 × (当期 allowance_units − used_units) / allowance_units。
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

  // 当前仍有效的存量会员（无论旧档位）。一个用户可能有多条 active 会员行（升级后旧行未失效），
  // 而补贴按用户唯一发放、退款又全按 user_id 聚合计算（实付/额度均按 user_id 查），故用 DISTINCT ON
  // 去重到每人一行（取 period_end 最新者），避免 dry-run 把同一人重复计数，并保证口径确定可复现。
  const { rows: memberships } = await pool.query<{
    user_id: string;
    plan_key: string;
    current_period_start: string;
    current_period_end: string;
  }>(
    `SELECT DISTINCT ON (user_id)
            user_id, plan_key, current_period_start, current_period_end
       FROM user_memberships
      WHERE status = 'active' AND current_period_end > NOW()
      ORDER BY user_id, current_period_end DESC`,
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

    // 当期月度额度：取 now 落在区间内的 allowance 行。
    const { rows: allowanceRows } = await pool.query<{
      allowance_units: string;
      used_units: string;
    }>(
      `SELECT allowance_units, used_units FROM membership_allowances
        WHERE user_id = $1 AND NOW() >= period_start AND NOW() < period_end
        ORDER BY period_start DESC LIMIT 1`,
      [m.user_id],
    );
    const allowanceUnits = allowanceRows[0]
      ? Number(allowanceRows[0].allowance_units)
      : 0;
    const usedUnits = allowanceRows[0] ? Number(allowanceRows[0].used_units) : 0;
    if (!(allowanceUnits > 0)) {
      // 无月度额度档（理论上不该出现；防御性跳过，避免 0/0）。
      console.log(`  - 跳过（当期无月度额度，无法按额度折算）: ${m.user_id}`);
      continue;
    }

    // 剩余额度比例 = (额度 − 已用) / 额度，夹在 [0,1]。
    const ratio = Math.max(
      0,
      Math.min(1, (allowanceUnits - usedUnits) / allowanceUnits),
    );
    const refund = Math.round(paidCoins * ratio * 100) / 100;
    if (!(refund > 0)) {
      console.log(`  - 跳过（额度已用尽，折算为 0）: ${m.user_id}`);
      continue;
    }

    console.log(
      `  ${dryRun ? '· 预览' : '✓ 退还'} ${refund} 积分 → ${m.user_id} ` +
        `(${m.plan_key}, 实付 ${paidCoins}, 剩余额度 ${(ratio * 100).toFixed(0)}%)`,
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
        note: `老用户补偿：${m.plan_key} 剩余额度 ${(ratio * 100).toFixed(0)}% 会员费折算退还`,
        metadata: {
          plan_key: m.plan_key,
          paid_coins: paidCoins,
          allowance_units: allowanceUnits,
          used_units: usedUnits,
          remaining_allowance_ratio: ratio,
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
