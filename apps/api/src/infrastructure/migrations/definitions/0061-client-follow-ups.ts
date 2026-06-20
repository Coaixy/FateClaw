import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段：0061。
 *
 * 客户跟进记录：卦师为客户追加时间线式跟进备注（一对多），用于复盘与持续服务跟踪。
 * 建 client_follow_ups 表（含软删除 deleted_at），归属卦师 user_id + 关联客户 client_id。
 * 只支持「追加 + 软删」，不做编辑，故不设 updated_at。
 */
export const clientFollowUpsMigrations: readonly DatabaseMigration[] = [
  {
    id: '0061_client_follow_ups',
    description: '增加客户跟进记录表（时间线备注）',
    async up(client) {
      // 跟进记录：归属卦师（user_id），关联客户（client_id），软删除复用 deleted_at。
      // 客户物理删除时级联清理跟进；软删客户场景由查询的 deleted_at 过滤兜底。
      await client.query(`
        CREATE TABLE IF NOT EXISTS client_follow_ups (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          client_id TEXT NOT NULL REFERENCES client_profiles(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at TIMESTAMPTZ
        )
      `);
      // 时间线按客户分组、创建时间倒序拉取，建部分索引只覆盖未删除记录。
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_client_follow_ups_client
          ON client_follow_ups(client_id, created_at DESC)
          WHERE deleted_at IS NULL
      `);
    },
  },
];
