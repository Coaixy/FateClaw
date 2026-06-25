import type { DatabaseMigration } from '../types.js';
import { normalizeCategory } from '../../../modules/skills/category-map.js';

/**
 * 数据库迁移分段：0064。
 *
 * 为 user_custom_skills 加广义用途分类维度（顶层桶：术数/角色扮演/分析/写作…，
 * 见 contracts 的 SKILL_CATEGORIES）。仅单列 category，不带回 match_keywords/
 * trigger_hint 等初版已废弃的路由元数据：
 *   - 加 category TEXT NOT NULL DEFAULT '通用'：兜底值表示未归类。
 *   - 重建市场列表部分索引 idx_ucs_market_category_listing：按 (分类, 热度, 时间)
 *     服务 discover 的按类筛选；0003 迁移此前已 DROP 该孤儿索引，此处重建。
 *   - 回填存量：用 normalizeCategory 判定术数关键词，命中即归入「术数」桶；其余
 *     用途（角色扮演/分析…）关键词无法可靠识别，保留默认 '通用'，待作者手选。
 *
 * 幂等：回填仅触碰仍为默认 '通用' 的行；重复执行或全新库（无存量行）均为空操作。
 * 分类白名单的唯一事实源在 contracts 的 SKILL_CATEGORIES；此处不加 DB CHECK 约束，
 * 校验交由服务/契约层负责，增删用途桶无需再发迁移。
 * 注：迁移用字面量 '术数' 而非引应用常量，保持自包含、不随应用逻辑演进而改变。
 */
export const skillCategoryMigrations: readonly DatabaseMigration[] = [
  {
    id: '0064_skill_category',
    description:
      '加 user_custom_skills.category 用途分类列 + 市场分类索引 + 术数关键词回填术数桶',
    async up(client) {
      // 加列：兜底默认 '通用'，存量行先全部落到该默认值，随后回填覆盖命中项。
      await client.query(`
        ALTER TABLE user_custom_skills
          ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '通用'
      `);

      // 市场按 (分类, 热度倒序, 时间倒序) 列表的部分索引，只覆盖在售（shared 且未删）技能，
      // 过滤条件与既有 idx_ucs_market_listing 保持一致，避免无效行进入索引。
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_ucs_market_category_listing
          ON user_custom_skills(category, stat_subscriber_count DESC, created_at DESC)
          WHERE deleted_at IS NULL AND visibility = 'shared'
      `);

      // 回填：对仍为默认 '通用' 的存量技能，用「名称 + 描述」判定是否术数。
      // 命中术数关键词即归入「术数」桶；非术数用途无法靠关键词可靠识别，保留 '通用'。
      // 技能表规模小（每用户≤30），逐行按 id 精确更新可接受，避免批量误伤。
      const pending = await client.query(
        `SELECT id, skill_name, description
           FROM user_custom_skills
          WHERE category = '通用' AND deleted_at IS NULL`,
      );
      for (const row of pending.rows as Array<{
        id: string;
        skill_name: string;
        description: string | null;
      }>) {
        const isDivination = normalizeCategory(
          `${row.skill_name} ${row.description ?? ''}`,
        );
        if (isDivination) {
          await client.query(
            `UPDATE user_custom_skills SET category = '术数' WHERE id = $1`,
            [row.id],
          );
        }
      }
    },
  },
];
