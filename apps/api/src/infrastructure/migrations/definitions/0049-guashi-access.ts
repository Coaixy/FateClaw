import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段：0049。
 *
 * 付费体系从三层 C 端会员（clarity/insight/deep）塌缩为单层"卦师使用权"。
 * 权益判断已在 entitlements 改为只看 membership.active（不分档），此迁移只负责套餐侧：
 * 复用 clarity 档改名定价并启用为唯一在售套餐，停用 insight/deep。
 */
export const guashiAccessMigrations: readonly DatabaseMigration[] = [
  {
    id: '0049_collapse_membership_to_guashi_access',
    description:
      '付费塌缩为单层"卦师使用权"：启用并改造 clarity 档，停用 insight/deep',
    async up(client) {
      // 复用 clarity 档作为唯一在售的"卦师使用权"：改名 + 定价 66 积分/月（1 积分=1 元，即 66 元）+ 启用。
      // 月度额度 300 万 token 供使用平台官方模型；BYOK（自配模型）不计费、不消耗额度。
      // ON CONFLICT 覆盖关键字段，确保无论 clarity 行是否已被代码 ensure 过都落到目标状态。
      await client.query(`
        INSERT INTO membership_config (
          id, enabled, name, monthly_price_coins, display_price_coins, monthly_allowance_units
        )
        VALUES ('fateclaw_clarity', true, '卦师使用权', 66, 66, 3000000)
        ON CONFLICT (id) DO UPDATE SET
          enabled = true,
          name = '卦师使用权',
          monthly_price_coins = 66,
          display_price_coins = 66,
          monthly_allowance_units = 3000000
      `);
      // 停用旧的 insight/deep 档：不再进入可订阅列表（getMembershipPlanConfigs 已按 enabled 过滤），
      // 但保留行用于识别存量会员的历史 plan_key。
      await client.query(`
        UPDATE membership_config
        SET enabled = false
        WHERE id IN ('fateclaw_insight', 'fateclaw_deep')
      `);
    },
  },
];
