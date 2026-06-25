import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段：0065。
 *
 * 历史数据归一：把 0064 早期版本回填的术数「门类名」收敛到广义用途桶「术数」。
 *
 * 背景：0064 最初按「术数门类」回填，存量技能被标成 六爻/八字/紫微 等具体门类名；
 * 之后顶层分类改为广义用途桶（术数/角色扮演/分析/写作…，见 contracts 的
 * SKILL_CATEGORIES），这些门类名不再属于白名单，会被 discover 的分类筛选过滤掉。
 * 由于 0064 在部分库已记录为「已应用」，改其代码不会重跑，故另起 0065 修正存量。
 *
 * 做法：把所有历史术数门类名一律改为 '术数'。门类名清单内联固定（取自最初的
 * category-aliases.json 标准值），保持迁移自包含、不随应用常量演进而改变。
 *
 * 幂等：仅命中仍为旧门类名的行；全新库（0064 已直接回填到 '术数'/'通用'）无匹配，空操作。
 */
export const skillCategoryDivinationBucketMigrations: readonly DatabaseMigration[] =
  [
    {
      id: '0065_skill_category_methods_to_divination',
      description: '历史术数门类名归一到广义用途桶「术数」',
      async up(client) {
        await client.query(`
          UPDATE user_custom_skills
             SET category = '术数'
           WHERE category IN (
             '六爻', '经占', '八字', '紫微', '奇门', '梅花', '大六壬', '小六壬',
             '风水', '周易', '测字', '择日', '铁板神数', '玄空', '相术', '手相',
             '姓名学', '占星', '塔罗', '生命灵数', '人类图', '数字能量'
           )
        `);
      },
    },
  ];
