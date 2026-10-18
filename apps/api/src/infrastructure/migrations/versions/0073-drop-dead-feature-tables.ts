import type pg from 'pg';

import type { DatabaseMigration } from '#infrastructure/migrations/types';

/**
 * 删除两组已无任何代码接线的死功能表（2026-07-05 大扫除）。
 *
 * @remarks
 * - `simple_workflow_presets`：「简易模式 workflow」的预置配置表。该功能的
 *   API 路由、快照写入、运行时授权管道与前后端 UI 已全部拔除
 *   （代码侧清理见同批 commit），全仓无任何读写方，仅剩此表。
 * - `ai_chat_free_daily_usage` / `ai_chat_free_quota_config` /
 *   `ai_chat_professional_daily_usage`：非会员「免费额度/专业额度」限次机制的
 *   计数与配置表。2026-06-29 非会员专家模式改为「1.5 倍加价」放开后，
 *   限次代码已删除，这三张表成为残留。
 *
 * 四张表相互无外键；`ai_chat_*_daily_usage` 仅有指向 users 的出边外键，
 * 随表一并删除。基线（0001）中的对应定义已同步移除，全新空库不会再建出
 * 这些表——本迁移在全新库上是 no-op（IF EXISTS），只对存量库真正执行 DROP。
 *
 * 编号说明：接 0072（孤儿 bundle 订阅回收）续号。
 */
export const dropDeadFeatureTablesMigration: DatabaseMigration = {
  id: '0073_drop_dead_feature_tables',
  description:
    '删除死功能表：simple_workflow_presets 与 ai_chat 免费/专业额度三表',
  up: async (client: pg.PoolClient): Promise<void> => {
    // 简易模式 workflow 预置表（功能已整链路拔除）
    await client.query('DROP TABLE IF EXISTS public.simple_workflow_presets');
    // 非会员免费/专业额度限次表（2026-06-29 改 1.5 倍加价后废弃）
    await client.query('DROP TABLE IF EXISTS public.ai_chat_free_daily_usage');
    await client.query('DROP TABLE IF EXISTS public.ai_chat_free_quota_config');
    await client.query(
      'DROP TABLE IF EXISTS public.ai_chat_professional_daily_usage',
    );
  },
};
