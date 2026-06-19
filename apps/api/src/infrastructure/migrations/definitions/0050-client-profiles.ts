import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段：0050。
 *
 * 客户档案功能：卦师为被算者（客户）建档，发起排盘时关联客户并用其生辰预填排盘输入。
 * 建 client_profiles 表（含软删除 deleted_at），并在 chat_sessions 上增加 client_id 外键，
 * 删除客户时把已关联会话的 client_id 置空（ON DELETE SET NULL），不级联删除历史会话。
 */
export const clientProfilesMigrations: readonly DatabaseMigration[] = [
  {
    id: '0050_client_profiles',
    description: '增加客户（被算者）档案表，并在会话上关联客户',
    async up(client) {
      // 客户档案：归属卦师（user_id），软删除复用 deleted_at。
      // gender 用文本存中文 '男'/'女'，与契约 ClientProfileDto 对齐；hour/minute 为可空整数生辰。
      await client.query(`
        CREATE TABLE IF NOT EXISTS client_profiles (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          gender TEXT,
          solar_date TEXT,
          hour INTEGER,
          minute INTEGER,
          birthplace TEXT,
          notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at TIMESTAMPTZ
        )
      `);
      // 列表查询按 user_id 过滤未删除档案，建部分索引只覆盖在档记录。
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_client_profiles_user
          ON client_profiles(user_id)
          WHERE deleted_at IS NULL
      `);
      // 同一卦师下未删除档案的姓名唯一，避免重复建档；软删除后允许同名重新建档。
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_client_profiles_user_name
          ON client_profiles(user_id, name)
          WHERE deleted_at IS NULL
      `);
      // 会话关联客户：删除客户后保留历史会话，仅把 client_id 置空。
      await client.query(`
        ALTER TABLE chat_sessions
          ADD COLUMN IF NOT EXISTS client_id TEXT
            REFERENCES client_profiles(id) ON DELETE SET NULL
      `);
      // 按 (user_id, client_id) 过滤“某客户的全部会话”，列表过滤用。
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_client
          ON chat_sessions(user_id, client_id)
      `);
    },
  },
];
