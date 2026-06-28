import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段：0067。
 *
 * 新建 open_sessions 表：对外开放 API（/api/v1/sessions）的「有状态会话」。
 * 调用方建会话时一次性传入 model / system(persona) / board / skills，拿到一个不可猜的
 * public sid（= 本表 id）；之后每轮只发 {sid, content}，历史与盘面由服务端记着、
 * 经 runtime 原生 resume 复原，无需重发完整消息。
 *
 * 设计要点：
 *   - id 为对外 public sid（sess_…），不可猜；与内部 runtime_session_id 分离，绝不外泄后者。
 *   - runtime_session_id 唯一：内部 pi 会话标识（openapi:<uuid>），只用于 dispatch，不对外暴露。
 *   - user_id 归属：所有读写都带 user_id 过滤，杜绝跨用户 resume；随用户删除级联清理。
 *   - api_key_id：创建来源 key（审计用，可空）；key 软吊销不删行，FK SET NULL 兜底。
 *   - persona_prompt / authorized_skill_ids / board：建会话时的「快照」，每轮从本行重建注入
 *     runtime（API 行为可复现，不随用户 Soul 等变动）。
 *   - status active/deleted：deleted 为软删（DELETE 端点用），保留痕迹不物理删除。
 *   - expires_at：滑动 TTL（建会话与每轮活动都顺延 30 天）；查询按 expires_at > NOW() 过滤，
 *     过期即视为不存在（不依赖 status，省去定时翻 expired 的 sweeper）。
 *
 * 幂等：CREATE TABLE/INDEX IF NOT EXISTS；全新库与重复执行均安全。
 */
export const openSessionsMigrations: readonly DatabaseMigration[] = [
  {
    id: '0067_open_sessions',
    description:
      '新建 open_sessions 表：对外开放 API 的 sid 有状态会话（建会话存快照，每轮服务端注入）',
    async up(client) {
      // 内联外键 / CHECK：CREATE TABLE IF NOT EXISTS 整体要么全建要么全跳，天然幂等。
      await client.query(`
        CREATE TABLE IF NOT EXISTS open_sessions (
          id                   TEXT PRIMARY KEY,
          user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          api_key_id           TEXT REFERENCES user_api_keys(id) ON DELETE SET NULL,
          runtime_session_id   TEXT NOT NULL UNIQUE,
          model_key            TEXT NOT NULL,
          thinking_level       TEXT,
          persona_prompt       TEXT,
          authorized_skill_ids JSONB,
          board                JSONB,
          status               TEXT NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'deleted')),
          created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_active_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at           TIMESTAMPTZ
        )
      `);

      // 按用户列「有效」会话的部分索引：归属校验 / 列表高频按 user_id 取未删会话，
      // 过滤条件与查询一致，避免已删行进入索引。
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_open_sessions_user_active
          ON open_sessions (user_id)
          WHERE status = 'active'
      `);
    },
  },
];
