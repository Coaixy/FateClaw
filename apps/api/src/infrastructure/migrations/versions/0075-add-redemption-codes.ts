import type pg from 'pg';

import type { DatabaseMigration } from '#infrastructure/migrations/types';

/**
 * 新增卡密充值系统。
 *
 * @remarks
 * 背景：内置 epay 支付可能因维护等原因暂停，需要外置卡密充值渠道兜底。
 *
 * 新增表 redemption_codes：
 * - code: 卡密码（唯一索引，格式如 FATE-XXXX-XXXX）
 * - amount_coins: 固定面额（5/10/30/50/100 元对应积分）
 * - status: pending（未使用）/ redeemed（已兑换）/ expired（已过期）/ revoked（已撤销）
 * - redeemed_by / redeemed_at: 兑换者与兑换时间
 * - expires_at: 过期时间（可选，NULL 表示永久有效）
 * - batch_id: 批次标识（方便批量管理）
 * - note: 备注（用途、活动名称等）
 *
 * 约束：
 * - code 必须唯一且符合格式（大写字母数字组合）
 * - amount_coins 必须为正
 * - redeemed 状态必须有 redeemed_by 和 redeemed_at
 * - 已兑换的卡密不可再次使用（应用层保证）
 */
export const addRedemptionCodesMigration: DatabaseMigration = {
  id: '0075_add_redemption_codes',
  description: '新增卡密充值系统',

  async up(client: pg.PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE redemption_codes (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        amount_coins NUMERIC(14, 2) NOT NULL CHECK (amount_coins > 0),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'redeemed', 'expired', 'revoked')),
        batch_id TEXT,
        note TEXT,
        expires_at TIMESTAMPTZ,
        redeemed_by TEXT REFERENCES users(id),
        redeemed_at TIMESTAMPTZ,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_redemption_codes_redeemed_consistency
          CHECK (
            (status = 'redeemed' AND redeemed_by IS NOT NULL AND redeemed_at IS NOT NULL)
            OR (status != 'redeemed' AND redeemed_by IS NULL AND redeemed_at IS NULL)
          )
      );

      CREATE INDEX idx_redemption_codes_status ON redemption_codes(status);
      CREATE INDEX idx_redemption_codes_batch_id ON redemption_codes(batch_id);
      CREATE INDEX idx_redemption_codes_redeemed_by ON redemption_codes(redeemed_by);
      CREATE INDEX idx_redemption_codes_created_at ON redemption_codes(created_at DESC);

      COMMENT ON TABLE redemption_codes IS '卡密充值码';
      COMMENT ON COLUMN redemption_codes.code IS '卡密码（唯一，格式如 FATE-XXXX-XXXX）';
      COMMENT ON COLUMN redemption_codes.amount_coins IS '面额（积分）';
      COMMENT ON COLUMN redemption_codes.status IS '状态：pending 未使用 / redeemed 已兑换 / expired 已过期 / revoked 已撤销';
      COMMENT ON COLUMN redemption_codes.batch_id IS '批次标识';
      COMMENT ON COLUMN redemption_codes.expires_at IS '过期时间（NULL 表示永久有效）';
    `);
  },
};
