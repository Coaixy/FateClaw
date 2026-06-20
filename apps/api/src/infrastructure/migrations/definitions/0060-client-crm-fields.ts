import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段：0060。
 *
 * 客户档案轻量 CRM 字段：为 client_profiles 增加 tags（自由标签数组）与 status（客户状态）。
 * 均为可空/带默认的增量列，不影响既有数据；status 取值 vip/follow_up/done，空表示未标记。
 */
export const clientCrmFieldsMigrations: readonly DatabaseMigration[] = [
  {
    id: '0060_client_crm_fields',
    description: '客户档案增加轻量 CRM 字段：标签 tags 与状态 status',
    async up(client) {
      // 自由标签：文本数组，默认空数组，便于卦师给客户打多标签。
      await client.query(`
        ALTER TABLE client_profiles
          ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'
      `);
      // 客户状态：vip/follow_up/done，可空表示未标记。
      await client.query(`
        ALTER TABLE client_profiles
          ADD COLUMN IF NOT EXISTS status TEXT
      `);
      // 按 (user_id, status) 过滤客户列表的部分索引，只覆盖在档记录。
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_client_profiles_user_status
          ON client_profiles(user_id, status)
          WHERE deleted_at IS NULL
      `);
    },
  },
];
