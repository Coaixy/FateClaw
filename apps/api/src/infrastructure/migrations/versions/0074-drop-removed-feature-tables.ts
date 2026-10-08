import type pg from 'pg';

import type { DatabaseMigration } from '../types.js';

/**
 * 删除三组已确认为「已删功能残留」的死表（2026-07-05 大扫除补充轮）。
 *
 * @remarks
 * 以下 9 张表在全仓代码中零引用（无任何 repository/service 读写），
 * 经维护者确认属于历史上已删除功能的残留，而非在建功能：
 * - 礼品码：`gift_code_redemptions` → `gift_codes`
 * - 邀请返利：`referral_reward_events` → `user_referrals` → `user_invite_codes`、
 *   `referral_config`（含种子的配置单例）
 * - 每日签到：`daily_sign_in_records` → `daily_sign_in_config`（含种子的配置单例）
 * - 技能点赞/点踩：`skill_reactions`
 *
 * DROP 按外键依赖顺序执行（子表先删）。指向这 9 张表的入边外键全部来自
 * 同批删除的表；它们对 users / user_custom_skills / balance_grants 只有出边外键，
 * 随表删除，不影响活跃表。
 *
 * 基线（0001）中的对应定义已同步移除：全新空库不会再建出这些表，
 * 本迁移在全新库上是 no-op（IF EXISTS），只对存量库真正执行 DROP。
 *
 * 编号说明：接 0073（死功能表清理首批）续号。
 */
export const dropRemovedFeatureTablesMigration: DatabaseMigration = {
  id: '0074_drop_removed_feature_tables',
  description: '删除已删功能残留表：礼品码/邀请返利/每日签到/技能点赞 共 9 张',
  up: async (client: pg.PoolClient): Promise<void> => {
    // 礼品码（redemptions 有指向 gift_codes 的外键，先删子表）
    await client.query('DROP TABLE IF EXISTS public.gift_code_redemptions');
    await client.query('DROP TABLE IF EXISTS public.gift_codes');
    // 邀请返利（reward_events → user_referrals → user_invite_codes 链式外键）
    await client.query('DROP TABLE IF EXISTS public.referral_reward_events');
    await client.query('DROP TABLE IF EXISTS public.user_referrals');
    await client.query('DROP TABLE IF EXISTS public.user_invite_codes');
    await client.query('DROP TABLE IF EXISTS public.referral_config');
    // 每日签到
    await client.query('DROP TABLE IF EXISTS public.daily_sign_in_records');
    await client.query('DROP TABLE IF EXISTS public.daily_sign_in_config');
    // 技能点赞/点踩
    await client.query('DROP TABLE IF EXISTS public.skill_reactions');
  },
};
