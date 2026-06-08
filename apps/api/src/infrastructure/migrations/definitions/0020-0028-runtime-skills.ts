import type { DatabaseMigration } from '../types.js';
import { ensureCheckConstraint } from '../helpers.js';

/**
 * 数据库迁移分段：0020-0028。
 */
export const runtimeSkillMigrations: readonly DatabaseMigration[] = [
  {
    id: '0020_runtime_config',
    description: '增加 Agent 运行时后台配置',
    async up(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS runtime_config (
          id TEXT PRIMARY KEY DEFAULT 'default',
          agent_concurrency_limit INTEGER NOT NULL DEFAULT 10,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        INSERT INTO runtime_config (id)
        VALUES ('default')
        ON CONFLICT (id) DO NOTHING
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_runtime_config_agent_concurrency_limit_positive',
        tableName: 'runtime_config',
        expression: 'agent_concurrency_limit > 0',
        cleanupSql: `UPDATE runtime_config
                     SET agent_concurrency_limit = 10
                     WHERE agent_concurrency_limit <= 0`,
      });
    },
  },
  {
    id: '0021_wechat_chat_session_links',
    description: '增加微信 sender 与网页 AI Chat 会话接续映射',
    async up(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS wechat_chat_session_links (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          sender_hash TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (account_id, sender_hash)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_wechat_session_links_user_updated
          ON wechat_chat_session_links(user_id, updated_at DESC)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_wechat_session_links_session
          ON wechat_chat_session_links(session_id)
      `);
    },
  },
  {
    id: '0022_drop_scheduled_tasks',
    description: '下线定时任务与运行日志表',
    async up(client) {
      await client.query(`DROP TABLE IF EXISTS task_run_logs`);
      await client.query(`DROP TABLE IF EXISTS scheduled_tasks`);
    },
  },
  {
    id: '0023_skill_access_invites',
    description: '增加 Skill 私密授权链接 schema',
    async up(client) {
      await client.query(
        `ALTER TABLE user_skill_subscriptions ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'share'`,
      );
      await client.query(`DO $$
        BEGIN
          IF to_regclass('public.user_skill_subscription_bundle_sources') IS NOT NULL THEN
            UPDATE user_skill_subscriptions sub
            SET source_kind = 'bundle_share'
            WHERE sub.has_direct_source = false
              AND sub.source_kind = 'share'
              AND EXISTS (
                SELECT 1
                FROM user_skill_subscription_bundle_sources src
                WHERE src.subscription_id = sub.id
              );
          END IF;
        END $$;`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_access_invites (
          id TEXT PRIMARY KEY,
          creator_id TEXT NOT NULL REFERENCES users(id),
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          token TEXT NOT NULL UNIQUE,
          max_redemptions INTEGER NOT NULL DEFAULT 1,
          redeemed_count INTEGER NOT NULL DEFAULT 0,
          expires_at TIMESTAMPTZ DEFAULT NULL,
          revoked_at TIMESTAMPTZ DEFAULT NULL,
          note TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_skill_access_invites_creator_target
         ON skill_access_invites(creator_id, target_type, target_id, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_skill_access_invites_token
         ON skill_access_invites(token)`,
      );
      await ensureCheckConstraint(client, {
        constraintName: 'chk_user_skill_subscriptions_source_kind_valid',
        tableName: 'user_skill_subscriptions',
        expression: `source_kind IN ('share', 'bundle_share', 'invite', 'bundle_invite')`,
        cleanupSql: `UPDATE user_skill_subscriptions
                     SET source_kind = 'share'
                     WHERE source_kind NOT IN ('share', 'bundle_share', 'invite', 'bundle_invite')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_skill_access_invites_target_type_valid',
        tableName: 'skill_access_invites',
        expression: `target_type IN ('skill', 'bundle')`,
        cleanupSql: `UPDATE skill_access_invites
                     SET target_type = 'skill'
                     WHERE target_type NOT IN ('skill', 'bundle')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_skill_access_invites_redemptions_valid',
        tableName: 'skill_access_invites',
        expression: `max_redemptions > 0 AND redeemed_count >= 0 AND redeemed_count <= max_redemptions`,
        cleanupSql: `UPDATE skill_access_invites
                     SET max_redemptions = GREATEST(1, max_redemptions),
                         redeemed_count = LEAST(GREATEST(0, redeemed_count), GREATEST(1, max_redemptions))`,
      });
    },
  },
  {
    id: '0024_user_model_thinking_level',
    description: '增加用户模型选择的 Pi 思考等级偏好',
    async up(client) {
      await client.query(
        `ALTER TABLE user_model_selections
         ADD COLUMN IF NOT EXISTS thinking_level TEXT NOT NULL DEFAULT 'medium'`,
      );
      await ensureCheckConstraint(client, {
        constraintName: 'chk_user_model_selections_thinking_level_valid',
        tableName: 'user_model_selections',
        expression: `thinking_level IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh')`,
        cleanupSql: `UPDATE user_model_selections
                     SET thinking_level = 'medium'
                     WHERE thinking_level NOT IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh')`,
      });
    },
  },
  {
    id: '0025_local_agent_runtime_limits',
    description: '增加本地 agent-runtime 常驻进程上限与空闲回收配置',
    async up(client) {
      await client.query(`
        ALTER TABLE runtime_config
          ADD COLUMN IF NOT EXISTS local_agent_max_processes INTEGER NOT NULL DEFAULT 4,
          ADD COLUMN IF NOT EXISTS local_agent_idle_ttl_ms INTEGER NOT NULL DEFAULT 600000
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_runtime_config_local_agent_max_processes_range',
        tableName: 'runtime_config',
        expression: 'local_agent_max_processes BETWEEN 1 AND 100',
        cleanupSql: `UPDATE runtime_config
                     SET local_agent_max_processes = LEAST(GREATEST(local_agent_max_processes, 1), 100)
                     WHERE local_agent_max_processes < 1 OR local_agent_max_processes > 100`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_runtime_config_local_agent_idle_ttl_ms_range',
        tableName: 'runtime_config',
        expression: 'local_agent_idle_ttl_ms BETWEEN 30000 AND 86400000',
        cleanupSql: `UPDATE runtime_config
                     SET local_agent_idle_ttl_ms = LEAST(GREATEST(local_agent_idle_ttl_ms, 30000), 86400000)
                     WHERE local_agent_idle_ttl_ms < 30000 OR local_agent_idle_ttl_ms > 86400000`,
      });
    },
  },
  {
    id: '0026_pi_session_health_runtime_config',
    description: '增加 Pi session 健康维护后台配置',
    async up(client) {
      await client.query(`
        ALTER TABLE runtime_config
          ADD COLUMN IF NOT EXISTS pi_session_health_enabled BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS pi_session_inactive_cleanup_days INTEGER NOT NULL DEFAULT 30,
          ADD COLUMN IF NOT EXISTS pi_session_orphan_grace_days INTEGER NOT NULL DEFAULT 30
      `);
      await ensureCheckConstraint(client, {
        constraintName:
          'chk_runtime_config_pi_session_inactive_cleanup_days_range',
        tableName: 'runtime_config',
        expression: 'pi_session_inactive_cleanup_days BETWEEN 1 AND 3650',
        cleanupSql: `UPDATE runtime_config
                     SET pi_session_inactive_cleanup_days = LEAST(GREATEST(pi_session_inactive_cleanup_days, 1), 3650)
                     WHERE pi_session_inactive_cleanup_days < 1 OR pi_session_inactive_cleanup_days > 3650`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_runtime_config_pi_session_orphan_grace_days_range',
        tableName: 'runtime_config',
        expression: 'pi_session_orphan_grace_days BETWEEN 1 AND 3650',
        cleanupSql: `UPDATE runtime_config
                     SET pi_session_orphan_grace_days = LEAST(GREATEST(pi_session_orphan_grace_days, 1), 3650)
                     WHERE pi_session_orphan_grace_days < 1 OR pi_session_orphan_grace_days > 3650`,
      });
    },
  },
  {
    id: '0027_user_auth_token_version',
    description: '增加用户认证 token 版本以支持改密后旧 JWT 失效',
    async up(client) {
      await client.query(`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS auth_token_version INTEGER NOT NULL DEFAULT 0
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_users_auth_token_version_nonnegative',
        tableName: 'users',
        expression: 'auth_token_version >= 0',
        cleanupSql: `UPDATE users
                     SET auth_token_version = 0
                     WHERE auth_token_version < 0`,
      });
    },
  },
  {
    id: '0028_skill_bundle_runtime_limits',
    description: '增加用户 Skill Bundle 文件限制后台配置',
    async up(client) {
      await client.query(`
        ALTER TABLE runtime_config
          ADD COLUMN IF NOT EXISTS skill_bundle_max_files INTEGER NOT NULL DEFAULT 50,
          ADD COLUMN IF NOT EXISTS skill_bundle_max_file_chars INTEGER NOT NULL DEFAULT 100000,
          ADD COLUMN IF NOT EXISTS skill_bundle_max_total_chars INTEGER NOT NULL DEFAULT 500000,
          ADD COLUMN IF NOT EXISTS skill_bundle_max_zip_bytes INTEGER NOT NULL DEFAULT 8388608
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_runtime_config_skill_bundle_max_files_range',
        tableName: 'runtime_config',
        expression: 'skill_bundle_max_files BETWEEN 1 AND 500',
        cleanupSql: `UPDATE runtime_config
                     SET skill_bundle_max_files = LEAST(GREATEST(skill_bundle_max_files, 1), 500)
                     WHERE skill_bundle_max_files < 1 OR skill_bundle_max_files > 500`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_runtime_config_skill_bundle_max_file_chars_range',
        tableName: 'runtime_config',
        expression: 'skill_bundle_max_file_chars BETWEEN 1 AND 2000000',
        cleanupSql: `UPDATE runtime_config
                     SET skill_bundle_max_file_chars = LEAST(GREATEST(skill_bundle_max_file_chars, 1), 2000000)
                     WHERE skill_bundle_max_file_chars < 1 OR skill_bundle_max_file_chars > 2000000`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_runtime_config_skill_bundle_max_total_chars_range',
        tableName: 'runtime_config',
        expression: 'skill_bundle_max_total_chars BETWEEN 1 AND 10000000',
        cleanupSql: `UPDATE runtime_config
                     SET skill_bundle_max_total_chars = LEAST(GREATEST(skill_bundle_max_total_chars, 1), 10000000)
                     WHERE skill_bundle_max_total_chars < 1 OR skill_bundle_max_total_chars > 10000000`,
      });
      await ensureCheckConstraint(client, {
        constraintName:
          'chk_runtime_config_skill_bundle_total_chars_at_least_file_chars',
        tableName: 'runtime_config',
        expression: 'skill_bundle_max_total_chars >= skill_bundle_max_file_chars',
        cleanupSql: `UPDATE runtime_config
                     SET skill_bundle_max_total_chars = skill_bundle_max_file_chars
                     WHERE skill_bundle_max_total_chars < skill_bundle_max_file_chars`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_runtime_config_skill_bundle_max_zip_bytes_range',
        tableName: 'runtime_config',
        expression: 'skill_bundle_max_zip_bytes BETWEEN 1024 AND 104857600',
        cleanupSql: `UPDATE runtime_config
                     SET skill_bundle_max_zip_bytes = LEAST(GREATEST(skill_bundle_max_zip_bytes, 1024), 104857600)
                     WHERE skill_bundle_max_zip_bytes < 1024 OR skill_bundle_max_zip_bytes > 104857600`,
      });
    },
  },
];
