import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段:0052。
 *
 * 补齐会员单层塌缩:0049 停用了 insight/deep,但漏了更早的两条遗留配置行——
 * `default`(旧 Plus)与 `fateclaw_pro`(旧 Pro)。它们不在 canonical key 集
 * (MEMBERSHIP_PLAN_KEYS = clarity/insight/deep),本就进不了可订阅列表
 * (getMembershipPlanConfigs 按这三个 key 取并按 enabled 过滤),但仍 enabled,
 * 导致 membership_config 表面上还有多个在售档,数据不干净、易误导后台。
 * 这里一并停用,使配置真正只剩单层「卦师使用权」(clarity)在售。
 * 与 0049 一致:保留行不删除,以兼容存量会员/历史识别。
 */
export const disableLegacyPlusProMigrations: readonly DatabaseMigration[] = [
  {
    id: '0052_disable_legacy_plus_pro_membership_plans',
    description: '停用遗留 Plus(default)/Pro(fateclaw_pro)会员配置,补齐单层塌缩',
    async up(client) {
      await client.query(`
        UPDATE membership_config
        SET enabled = false
        WHERE id IN ('default', 'fateclaw_pro')
      `);
    },
  },
];
