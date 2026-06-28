import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段：0066。
 *
 * 新建 user_api_keys 表：平台颁发给会员、用于程序化调用对外开放 API（/api/v1/*）的 API Key。
 * 与现有 system_secrets（存第三方 provider 的 BYOK 密钥、明文）完全不同——本表只存
 * 明文 key 的 sha256 哈希，绝不落明文，校验时用 key_hash 反查归属用户。
 *
 * 设计要点：
 *   - key 挂在 users(id) 上（登录主体即 user），随用户删除级联清理。
 *   - key_hash 唯一：鉴权中间件按 sha256(明文) 查这一列定位 key。
 *   - key_prefix + last_four 仅用于前端脱敏展示（如 fc_live_…ab12），不可据此还原明文。
 *   - status active/revoked：吊销为软状态，保留审计痕迹（revoked_at），不物理删除。
 *   - expires_at 可空：NULL 表示永不过期；非空则鉴权时校验未过期。
 *   - last_used_at：鉴权命中时节流更新（最多每分钟写一次），用于展示与清理判断。
 *
 * 幂等：CREATE TABLE/INDEX IF NOT EXISTS；全新库与重复执行均安全。
 * 注：每用户 key 数量上限不在 DB 约束，交由路由层常量校验，便于调整。
 */
export const userApiKeysMigrations: readonly DatabaseMigration[] = [
  {
    id: '0066_user_api_keys',
    description: '新建 user_api_keys 表：会员程序化调用对外开放 API 的 API Key（仅存哈希）',
    async up(client) {
      // 新建表内联外键与 CHECK 约束：CREATE TABLE IF NOT EXISTS 整体要么全建要么全跳，
      // 因此内联约束天然幂等，无需额外的 ensureForeignKey/ensureCheckConstraint。
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_api_keys (
          id           TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name         TEXT NOT NULL,
          key_prefix   TEXT NOT NULL,
          key_hash     TEXT NOT NULL UNIQUE,
          last_four    TEXT NOT NULL,
          status       TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'revoked')),
          expires_at   TIMESTAMPTZ,
          last_used_at TIMESTAMPTZ,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          revoked_at   TIMESTAMPTZ
        )
      `);

      // 按用户列出「有效」key 的部分索引：管理页 GET /api/api-keys 高频按 user_id 取
      // 未吊销的 key，过滤条件与查询一致，避免已吊销行进入索引。
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_api_keys_user_active
          ON user_api_keys (user_id)
          WHERE status = 'active'
      `);
    },
  },
];
